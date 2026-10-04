// A Ui2ApiContext backed by a local wigolo daemon.
//
// Principle: the parts of recipe execution that are *web work* — reading the page
// through a real browser with auth reuse + anti-bot handling, extracting
// structured data from the rendered UI — are delegated to wigolo over loopback
// HTTP. wigolo's code is never imported or vendored here, so ui2api stays MIT and
// AGPL obligations stay with the daemon process.
//
// What maps where:
//   dom.click / dom.type / dom.waitFor  -> wigolo fetch(url, { actions })
//                                          (each call reloads the site the way an
//                                          API call hits its endpoint; the
//                                          returned page markdown is the result)
//   dom.extract                          -> wigolo extract (selector mode), with
//                                          a full-page markdown fallback
//   replay (captured network call)       -> plain Node fetch + the saved session
//                                          cookies, same-origin SSRF-guarded. No
//                                          browser process involved at all.
//   call (live window.<root> JS)         -> lazy native Playwright page (wigolo
//                                          has no arbitrary in-page JS execution)
//
// Resilience: the wigolo daemon's browser tier is a heavyweight engine that may
// be unavailable or unstable in a given environment (sandboxed VMs, restricted
// containers; chromium may refuse to launch). Browser-required operations try
// the daemon FIRST, and on a wigolo chromium failure fall back to a lazy native
// Playwright page for that single operation — logged once, never silent. Reads
// and replays never need a browser at all.

import { readFileSync, writeFileSync } from "node:fs";
import { launchBrowser, sessionPath, defaultSitesDir } from "../runtime/browser.js";
import { sameOrigin } from "../runtime/ssrf.js";
import { analyse } from "../analyzer/explore.js";
import {
  wigoloFetch,
  wigoloExtract,
  ensureWigoloDaemon,
  type WigoloFetchInput,
  type WigoloFetchOutput,
  WigoloAction,
} from "../runtime/wigolo.js";
import type { Ui2ApiContext, HubConfig, Logger, ToolDefinition, ToolHandler, AnalyseOpts } from "./types.js";

export interface ContextDeps {
  baseUrl: string;
  logger?: Logger;
  dataDir?: string;
  authRequired?: boolean;
}

type ToolEntry = { def: ToolDefinition; handler: ToolHandler };

const RESULT_MARKDOWN_CAP = 8000;

// wigolo surfaces chromium-death failures through messages like this; matching
// them lets us degrade gracefully instead of failing the whole tool call.
const WIGOLO_BROWSER_DOWN =
  /Target page, context or browser has been closed|browser has been closed|browser\.newContext|browserContext\.newPage|browser\.launch|Browser may have crashed|ECONNREFUSED|connection refused|fetch failed/i;

function cap(s: string): string {
  return s.length > RESULT_MARKDOWN_CAP ? s.slice(0, RESULT_MARKDOWN_CAP) : s;
}

function pageMarkdown(out: WigoloFetchOutput): string {
  return cap(out?.markdown ?? "");
}

// A fetch answer that reports a FAILURE is not a successful blank page. The
// daemon can answer HTTP 200 whose payload carries the failure (a challenge
// shell renders to near-empty markdown), and `wigoloRequest` only throws on
// !res.ok or an `{ok:...}` envelope (src/runtime/wigolo.ts) — so an unread
// field here reads as "the page was empty" and a challenged page passes for a
// successful read. The project's rule (AGENTS.md, "WHEN A SITE CHALLENGES YOU
// — reach for WIGOLO") is that a blocked page stays a refusal with the NAMED
// reason, so refuse by name instead of returning "".
//
// WHICH signals count is decided by the daemon's own shapes, not guessed:
//   - `error` / `error_reason` — the StageError shape (wigolo src/types.ts).
//   - `challenge_class` with NO clearing `solve_method` — the honest-block shape
//     (router.ts always pairs a block with `solve_method: null`), i.e. no rung
//     cleared the wall. A challenge_class that DOES carry a solve_method is a
//     challenge the ladder CLEARED (browser-pool.ts sets both together on the
//     success return), so that page is real content and must not be refused.
//   - `solve_method` and `http_status` alone are NOT triggers: solve_method
//     names the rung that cleared a challenge (not a failure), and wigolo
//     deliberately serves HTML 4xx landing pages (a 404 docs page is useful
//     content, src/tools/fetch.ts). Both only appear in the NAMED reason, after
//     another signal has already failed.
//
// Only these declared fields are read, and only their values — no other payload
// key (no header, cookie or token field) is echoed, so no credential can ride
// along in the message.
function refuseIfFailedFetch(out: WigoloFetchOutput | null | undefined, label: string): void {
  const text = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s === "" ? null : s;
  };
  const challengeClass = text(out?.challenge_class);
  const solveMethod = text(out?.solve_method);
  // A challenge class with no solve method = no rung cleared the wall.
  const blockedChallenge = challengeClass !== null && solveMethod === null;
  const error = text(out?.error);
  const errorReason = text(out?.error_reason);
  const httpStatus = typeof out?.http_status === "number" && out.http_status >= 400 ? `http ${out.http_status}` : null;
  if (error === null && errorReason === null && !blockedChallenge) return;

  // Named by the upstream field, most specific first. solve_method is spelled
  // out when it is the honest null: "no rung cleared it" IS the reason.
  const parts = [
    error ?? errorReason ?? (blockedChallenge ? "blocked_by_challenge" : null),
    error !== null && errorReason !== null ? errorReason : null,
    challengeClass !== null ? `challenge_class=${challengeClass}` : null,
    blockedChallenge && solveMethod === null ? "solve_method=null (no rung cleared it)" : null,
    httpStatus,
  ].filter((p): p is string => p !== null);

  // The "wigolo refused " prefix is this repo's marker for a refusal that must
  // NOT be degraded into a native-browser retry (withBrowserFallback re-throws
  // it by name): a challenge is a policy refusal, not a flaky browser tier, and
  // the native page would answer "" — the silent blank this guard exists to kill.
  throw new Error(`wigolo refused ${label}: ${parts.join("; ")}`);
}

// A SUCCESSFUL fetch is not proof that the ACTION ran. The daemon answers
// HTTP 200 for a page it read fine while an individual action was skipped (the
// selector matched nothing), dropped by a version skew, or never attempted — so
// `action_results` can come back with no entry for the action we asked for.
// Reading that absence as `{ ok: true }` is a FABRICATED SUCCESS: the caller
// goes on believing the text was pasted or the keys were pressed when nothing
// happened, which is the one thing this project forbids outright (AGENTS.md,
// "no fabricated traffic"). The native tier beside it is honest — it reports
// `{insertedChars}` / `{pressed}` — and two tiers disagreeing about whether the
// input landed is exactly the drift this guard removes.
//
// So the absence is a REFUSAL naming the action, shaped like every other refusal
// in this file (`wigolo refused <label>: <reason>`) so `withBrowserFallback`
// re-throws it by name instead of degrading it into a native retry that would
// answer a different shape for the same call. An entry whose `output` is empty
// is the same absence: no output is not evidence the input landed.
function requireActionOutput<T = unknown>(out: WigoloFetchOutput, type: string, label: string): T {
  const entry = out?.action_results?.find((r) => r.type === type);
  if (entry && entry.output !== undefined && entry.output !== null) return entry.output as T;
  throw new Error(
    `wigolo refused ${label}: no usable "${type}" action_result in the daemon answer (the entry is missing or its output is empty) — the selector may have matched nothing, the action may have been skipped, or the daemon may be version-skewed; a missing action result is NOT evidence the action ran, so this is refused rather than answered with an invented success`
  );
}

// Defence in depth behind the runtime's loopback-only daemon gate
// (`src/runtime/wigolo.ts`): a daemon answer must describe the site we asked
// about. A cross-origin `url`/`source_url` means the answer was NOT read off
// the site — serving it verbatim would be a fabricated result, which this
// project forbids outright, so it is refused by name instead.
const WIGOLO_REFUSAL = /wigolo refused /;

function assertAnswerOrigin(answerUrl: unknown, baseUrl: string, label: string): void {
  if (typeof answerUrl !== "string" || answerUrl === "") return; // daemon reported nothing to compare
  let expected: string;
  try {
    expected = new URL(baseUrl).origin;
  } catch {
    return; // baseUrl is not absolute; the runtime gate already vetted the base
  }
  let got: string;
  try {
    got = new URL(answerUrl).origin;
  } catch {
    throw new Error(`SSRF guard: wigolo ${label} url ${answerUrl} is unparseable — refused`);
  }
  if (got !== expected) {
    throw new Error(
      `SSRF guard: wigolo ${label} url ${got} is cross-origin for ${expected} — refused (a page answer must be read off the site itself, never returned by the daemon)`
    );
  }
}

// Parse a constrained DOM-extract expression ("text <sel>", "attr <sel> <attr>",
// "json <sel>"). Null when the syntax is not supported.
function parseExtract(extract: string): { sel: string; kind: string; arg: string | null } | null {
  const m = extract.trim().match(/^(text|attr|json)\s+(\S+)(?:\s+(\S+))?$/);
  if (!m) return null;
  const kind = m[1];
  const sel = m[2];
  const arg = m[3] ?? null;
  if (kind === "attr" && arg === null) return null;
  return { sel, kind, arg };
}

export function createWigoloContext(config: HubConfig, deps: ContextDeps): Ui2ApiContext & { tools: Map<string, ToolEntry> } {
  const logger: Logger = deps.logger ?? console;
  const tools = new Map<string, ToolEntry>();
  const dataDir = deps.dataDir ?? defaultSitesDir();
  const baseUrl = (() => {
    try {
      return new URL(deps.baseUrl).href;
    } catch {
      return deps.baseUrl;
    }
  })();
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return "unknown";
    }
  })();
  const useAuth = process.env.UI2API_WIGOLO_USE_AUTH === "0" ? false : (deps.authRequired ?? false);

  // --- lazy native-browser page: only for live `call()` and browser-tier fallback ---
  let page: any = null;
  async function getNativePage(): Promise<any> {
    if (page) return page;
    const browser = await launchBrowser();
    const ctx = await browser.newContext();
    try {
      const c = JSON.parse(readFileSync(sessionPath(dataDir, host), "utf8"));
      if (Array.isArray(c)) await ctx.addCookies(c);
    } catch {}
    page = await ctx.newPage();
    await page.goto(baseUrl, { waitUntil: "load", timeout: 30000 });
    return page;
  }

  // Prefer the wigolo daemon; when it is unreachable OR its chromium is down,
  // execute a browser-required operation on the native page instead, logging
  // the degradation once. Returns { value }.
  async function withBrowserFallback<T>(viaWigolo: () => Promise<T>, viaNative: (page: any) => Promise<T>, op: string): Promise<T> {
    await ensureWigoloDaemon().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      // A security refusal (non-loopback base, bad forwarded knob) is NOT a
      // "daemon is flaky" condition: degrading to the native browser would
      // hide the refusal and keep going. Re-throw it by name instead.
      if (WIGOLO_REFUSAL.test(msg)) throw e;
      logger.warn && logger.warn(`[wigolo-engine] daemon unavailable (${msg}); ${op} -> native browser`);
      return;
    });
    try {
      return await viaWigolo();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A refusal is a verdict, not a flaky browser tier: degrading it would
      // re-answer the question on the native page and hand back "" (or the
      // interstitial's own body text) — the silent blank the refusal exists to
      // prevent. Re-thrown by name, exactly as the daemon-unavailable path above.
      if (WIGOLO_REFUSAL.test(msg)) throw err;
      if (WIGOLO_BROWSER_DOWN.test(msg)) {
        logger.warn && logger.warn(`[wigolo-engine] wigolo browser tier down (${msg.slice(0, 120)}); ${op} -> native browser`);
        return viaNative(await getNativePage());
      }
      throw err;
    }
  }

  // Drive the analyzed page through wigolo's browser engine in ONE call: load
  // the site, apply the recorded interaction, return the resulting page.
  async function domFetch(actions: WigoloAction[], extra: Partial<WigoloFetchInput> = {}): Promise<WigoloFetchOutput> {
    const out = await wigoloFetch({
      url: baseUrl,
      render_js: "auto",
      use_auth: useAuth,
      force_refresh: true,
      actions,
      ...extra,
    });
    assertAnswerOrigin(out?.url, baseUrl, "fetch answer");
    refuseIfFailedFetch(out, "fetch answer");
    return out;
  }

  const ctx: Ui2ApiContext & { tools: Map<string, ToolEntry> } = {
    config,
    logger,
    tools,
    registerTool(def, handler) {
      if (tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
      tools.set(def.name, { def, handler });
    },
    async analyse(url, opts?: AnalyseOpts) {
      return analyse(url, { root: opts?.root, outDir: opts?.outDir, llm: opts?.llm, maxTasks: opts?.maxTasks });
    },
    async replay(req) {
      const resolved = req.url.startsWith("http") ? req.url : new URL(req.url, baseUrl).toString();
      if (!sameOrigin(resolved, baseUrl)) throw new Error(`SSRF guard: replay ${resolved} cross-origin`);
      // Replay is a captured API call — emit it as a plain HTTP call carrying the
      // saved session cookies. No browser process involved.
      const cookies = (() => {
        try {
          const c = JSON.parse(readFileSync(sessionPath(dataDir, host), "utf8"));
          return Array.isArray(c) ? c : [];
        } catch {
          return [];
        }
      })();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cookies.length) {
        headers.cookie = cookies.map((c) => `${encodeURIComponent(c.name)}=${encodeURIComponent(c.value ?? "")}`).join("; ");
      }
      const resp = await fetch(resolved, {
        method: (req.method ?? "GET").toUpperCase(),
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
      return await resp.text();
    },
    async call(target, args) {
      const p = await getNativePage();
      return p.evaluate(
        (a: { target: string; args: unknown[] }) => {
          let fn: any = window;
          for (const part of a.target.split(".")) fn = fn[part];
          return fn(...a.args);
        },
        { target, args }
      );
    },
    session: {
      async load(loadHost) {
        try {
          return JSON.parse(readFileSync(sessionPath(dataDir, loadHost), "utf8"));
        } catch {
          return [];
        }
      },
      async save(saveHost, cookies) {
        writeFileSync(sessionPath(dataDir, saveHost), JSON.stringify(cookies));
      },
    },
    http: {
      async fetch(url, init) {
        if (!sameOrigin(url, baseUrl)) throw new Error(`SSRF guard: http ${url} cross-origin`);
        return fetch(url, init);
      },
    },
    dom: {
      async click(sel) {
        return withBrowserFallback<string>(
          async () => pageMarkdown(await domFetch([{ type: "click", selector: sel }])),
          async (p) => {
            await p.locator(sel).first().click({ timeout: 5000 });
            return "";
          },
          "dom.click"
        );
      },
      async type(sel, text) {
        return withBrowserFallback<string>(
          async () => pageMarkdown(await domFetch([{ type: "type", selector: sel, text: String(text) }])),
          async (p) => {
            // Trusted input (CDP Input.insertText), not Playwright fill() — fill
            // fabricates a synthetic JS value-set that looks automated to the site.
            await p.locator(sel).first().focus();
            await p.keyboard.insertText(String(text));
            return "";
          },
          "dom.type"
        );
      },
      async waitFor(sel, timeoutMs = 5000) {
        return withBrowserFallback<string>(
          async () => pageMarkdown(await domFetch([{ type: "wait_for", selector: sel, timeout: timeoutMs }])),
          async (p) => {
            await p.locator(sel).first().waitFor({ timeout: timeoutMs });
            return "";
          },
          "dom.waitFor"
        );
      },
      async extract(expr) {
        const parsed = parseExtract(expr);
        if (parsed && (parsed.kind === "text" || parsed.kind === "json")) {
          const read = await withBrowserFallback<unknown>(
            async () => {
              await ensureWigoloDaemon();
              const out = await wigoloExtract({ url: baseUrl, mode: "selector", css_selector: parsed.sel, execution_mode: "default" });
              assertAnswerOrigin(out?.source_url, baseUrl, "extract answer");
              if (out && !out.error && typeof out.data === "string" && out.data !== "") return out.data;
              if (out && !out.error && Array.isArray(out.data) && out.data.length) return out.data[0];
              return null;
            },
            async (p) => {
              return p.evaluate(
                ({ sel }: { sel: string }) => {
                  const el = document.querySelector(sel);
                  return el ? (el as HTMLElement).innerText : null;
                },
                { sel: parsed.sel }
              );
            },
            "dom.extract"
          );
          if (read !== null && read !== "" ) return read;
        }
        if (parsed && parsed.kind === "attr") {
          // Attribute values aren't part of markdown; keep the lazy native page.
          const p = await getNativePage();
          return p.evaluate(
            ({ sel, arg }: { sel: string; arg: string }) => {
              const el = document.querySelector(sel);
              return el ? el.getAttribute(arg) : null;
            },
            { sel: parsed.sel, arg: parsed.arg as string }
          );
        }
        // Unsupported syntax or a selector that returned nothing — fall back to a
        // full-page read (wigolo browser-rendered markdown, else page text).
        return withBrowserFallback<string>(
          async () => pageMarkdown(await domFetch([])),
          async (p) => cap((await p.evaluate(() => document.body.innerText)) as string),
          "dom.extract-full"
        );
      },
      // JS-level primitives — map straight to wigolo's js-level actions
      // (paste / keys / capture / status), with a native-browser fallback that
      // plays the same keyboard/paste events when the wigolo browser tier is down.
      async paste(sel, text) {
        return withBrowserFallback<unknown>(
          async () => {
            const out = await domFetch([{ type: "paste", selector: sel, text: String(text) }]);
            return requireActionOutput(out, "paste", "paste into " + sel);
          },
          async (p) => {
            await p.locator(sel).first().focus();
            await p.keyboard.insertText(String(text));
            await p.evaluate(({ sel, payload }: { sel: string; payload: string }) => {
              const el = document.querySelector(sel);
              if (!(el instanceof HTMLElement)) return false;
              const dt = new DataTransfer();
              dt.setData("text/plain", payload);
              el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
              return true;
            }, { sel, payload: String(text) });
            return { insertedChars: String(text).length };
          },
          "dom.paste"
        );
      },
      async press(sel, keys) {
        return withBrowserFallback<unknown>(
          async () => {
            const out = await domFetch([{ type: "keys", selector: sel ?? undefined, keys }]);
            return requireActionOutput(out, "keys", "press keys " + keys);
          },
          async (p) => {
            if (sel) await p.locator(sel).first().focus();
            for (const k of keys) await p.keyboard.press(k);
            return { pressed: keys };
          },
          "dom.press"
        );
      },
      async capture(sel, untilMs = 4000) {
        return withBrowserFallback<unknown>(
          async () => {
            const out = await domFetch([{ type: "capture", selector: sel, untilMs }]);
            return out.action_results?.find((r) => r.type === "capture")?.output ?? null;
          },
          async (p) =>
            p.evaluate(async ({ sel, budgetMs }: { sel: string; budgetMs: number }) => {
              const target = document.querySelector(sel) as HTMLElement | null;
              if (!target) throw new Error(`capture: selector not found: ${sel}`);
              const chunks: Array<{ t: number; text: string; delta?: string }> = [];
              const mo = new MutationObserver(() => {
                const text = target.innerText;
                chunks.push({ t: Date.now(), text: text.slice(0, 400) });
              });
              mo.observe(target, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
              const t0 = Date.now();
              while (Date.now() - t0 < budgetMs) await new Promise((r) => setTimeout(r, 120));
              mo.disconnect();
              for (let i = 1; i < chunks.length; i++) chunks[i].delta = chunks[i].text.slice(chunks[i - 1].text.length);
              return {
                text: target.innerText,
                chunks,
                chunkCount: chunks.length,
                url: location.href,
                title: document.title,
                readyState: document.readyState,
              };
            }, { sel, budgetMs: untilMs }),
          "dom.capture"
        );
      },
      // Stable-wait read: poll until the answer text stops growing for stableMs
      // (or the budget expires). Reuses the native browser loop when wigolo's
      // agent can't capture — same result shape as the native dom.awaitAnswer.
      async awaitAnswer(sel, opts = {}) {
        const { timeoutMs = 30000, stableMs = 1800, pollMs = 400 } = opts as { timeoutMs?: number; stableMs?: number; pollMs?: number };
        return withBrowserFallback<{ text: string; chunkCount: number; url: string; title: string; doneReason: "stable" | "timeout" | "empty" }>(
          async () => {
            const out = await domFetch([{ type: "capture", selector: sel, untilMs: timeoutMs }]);
            const captured = out.action_results?.find((r) => r.type === "capture")?.output as
              | { text?: string; chunkCount?: number; url?: string; title?: string }
              | undefined;
            return {
              text: captured?.text ?? "",
              chunkCount: captured?.chunkCount ?? 0,
              url: captured?.url ?? "",
              title: captured?.title ?? "",
              doneReason: captured?.text ? "stable" : "timeout",
            };
          },
          async (p) => {
            const read = () =>
              p.evaluate((selector: string) => {
                const els = document.querySelectorAll(selector);
                let best = "";
                for (const el of els) {
                  const t = (el as HTMLElement).innerText ?? "";
                  if (t.length > best.length) best = t;
                }
                return (best || "").trim();
              }, sel);
            const t0 = Date.now();
            let last = "";
            let lastChange = 0;
            let maxText = "";
            let chunkCount = 0;
            let doneReason: "stable" | "timeout" | "empty" = "timeout";
            while (Date.now() - t0 < timeoutMs) {
              const cur = (await read()) as string;
              chunkCount++;
              if (cur.length > maxText.length) maxText = cur;
              if (cur !== last) {
                last = cur;
                lastChange = Date.now();
              } else if (cur && Date.now() - lastChange >= stableMs) {
                doneReason = "stable";
                break;
              }
              await new Promise((r) => setTimeout(r, pollMs));
            }
            const text = maxText.trim();
            if (doneReason === "timeout" && !text) doneReason = "empty";
            const meta = (await p.evaluate(() => ({ url: location.href, title: document.title }))) as { url: string; title: string };
            return { text, chunkCount, url: meta.url, title: meta.title, doneReason };
          },
          "dom.awaitAnswer"
        );
      },
      async status(sel) {
        return withBrowserFallback<unknown>(
          async () => {
            const out = await domFetch(sel ? [{ type: "status", selector: sel }] : [{ type: "status" }]);
            return out.action_results?.find((r) => r.type === "status")?.output ?? null;
          },
          async (p) =>
            p.evaluate(({ sel }: { sel?: string }) => {
              const target = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
              return {
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                bodyTextLength: (document.body?.innerText ?? "").length,
                targetText: target ? target.innerText.slice(0, 200) : undefined,
              };
            }, { sel }),
          "dom.status"
        );
      },
    },
    // Wigolo-native contexts own their browser lifecycle via wigoloFetch;
    // a no-op keeps the (optional) contract intact for typed callers.
    async close() {},
  };
  return ctx;
}