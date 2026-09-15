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
      logger.warn && logger.warn(`[wigolo-engine] daemon unavailable (${e.message}); ${op} -> native browser`);
      return;
    });
    try {
      return await viaWigolo();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (WIGOLO_BROWSER_DOWN.test(msg)) {
        logger.warn && logger.warn(`[wigolo-engine] wigolo browser tier down (${msg.slice(0, 120)}); ${op} -> native browser`);
        return viaNative(await getNativePage());
      }
      throw err;
    }
  }

  // Drive the analyzed page through wigolo's browser engine in ONE call: load
  // the site, apply the recorded interaction, return the resulting page.
  function domFetch(actions: WigoloAction[], extra: Partial<WigoloFetchInput> = {}): Promise<WigoloFetchOutput> {
    return wigoloFetch({
      url: baseUrl,
      render_js: "auto",
      use_auth: useAuth,
      force_refresh: true,
      actions,
      ...extra,
    });
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
            return out.action_results?.find((r) => r.type === "paste")?.output ?? { ok: true };
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
            return out.action_results?.find((r) => r.type === "keys")?.output ?? { ok: true };
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
  };
  return ctx;
}