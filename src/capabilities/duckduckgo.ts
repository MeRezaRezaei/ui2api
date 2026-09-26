// Duckduckgo capability runner — the LIVE, honest reporter for DuckDuckGo AI
// Chat (duck.ai). This package is ANONYMOUS-capable (manifest auth.anonymous,
// profile loginRequired:false): NO session capture is needed for chat, so this
// runner NEVER short-circuits to login-gated (that would be a fabricated
// excuse for an anonymous site). Each capability is dispatched through its
// real implementation where proven, and honestly reports the measured blocker
// otherwise (GOAL 13, fold #19, 2026-09-22 — before that fold the whole
// surface was wrongly gated as login-required).
//
// Capability dispatch (GOAL 15, 2026-09-23 — all five previously wire-mapped
// capabilities are now VERIFIED live; see capabilities/duckduckgo/CAPABILITIES.md §9):
//   duckduckgo_chat          -> UI path, live-verified 2026-09-22 (headed,
//                                Xvfb): composer textarea, Enter to send,
//                                FIRST-send consent wall ("By clicking
//                                'Continue' you agree to our Privacy Policy
//                                and Terms of Service") is dismissed by
//                                clicking its Continue button, then the
//                                composer is re-focused and Enter pressed
//                                again; the streamed assistant answer is read
//                                OFF THE PAGE. The site's own JS performs the
//                                VQD preflight + POST /duckchat/v1/chat SSE
//                                (wire observed 200 on the live proof) — no
//                                synthetic request ever leaves the browser.
//                                Model marker on the answer bubble is read
//                                (e.g. "GPT-5.6 Luna").
//   duckduckgo_model_picker  -> REAL: click the composer model chip (text
//                                "5.6 Luna", w≈100 h≈32, no aria) -> panel
//                                [role='menu'][aria-label='Choose a model']
//                                (w≈280) -> rows [role='menuitemradio'] with
//                                data-testid="model-picker-row-<id>",
//                                aria-checked="true" on the active model,
//                                name+note text. Live-verified 2026-09-23
//                                (models seen: GPT-5.6 Luna* checked, GPT-5.4
//                                mini, Claude Haiku 4.5, Mistral Small 4,
//                                gpt-oss 120B, …). Post-chat composer hides the
//                                chip -> New Chat retry.
//   duckduckgo_web_search    -> REAL: composer "Tools" button (text "Tools")
//                                -> tools popover row "Web Search / Source
//                                answers from the web" -> composer chip
//                                button[aria-label='Remove Web Search']
//                                appears (read-back); disabling clicks that
//                                chip. Failed toggles are reported honestly,
//                                never synthesized. Live-verified 2026-09-23:
//                                chat after enable drove a REAL WebSearch
//                                tool-invocation (5 citations in IDB).
//   duckduckgo_file_upload   -> REAL: composer input[type='file'] (accept
//                                "image/png,image/jpeg,image/webp,image/gif,
//                                application/pdf,.pdf"); setInputFiles ->
//                                attachment chip button[aria-label^='Remove
//                                image '] (read-back). Live-verified 2026-09-23.
//   duckduckgo_reasoning     -> REAL: button[aria-label='Reasoning mode'] (text
//                                "Fast"/"Reasoning") -> popover rows
//                                [role='menuitemradio'] "Reasoning Takes longer
//                                to respond" / "Fast Answers right away";
//                                selecting flips the button text (read-back).
//                                Live-verified 2026-09-23: Fast<->Reasoning both
//                                flip; "Extended" is NOT offered for the
//                                free-tier GPT-5.6 Luna (measured limit,
//                                reported honestly).
//   duckduckgo_chat_history  -> REAL: IndexedDB "savedAIChatData" (v6) stores
//                                saved-chats / pre-canonical-chats read via
//                                page.evaluate (the site's own storage), keyed
//                                by chatId with title, model, messages[]. The
//                                sidebar (input[aria-label='Search chats'],
//                                per-row button[aria-label='Delete Chat'])
//                                corroborates. A fresh anonymous context starts
//                                empty (site creates the DB on first chat);
//                                optional args.sendProbe drives ONE real probe
//                                chat (site's own JS) so the read returns rows.
//                                Live-verified 2026-09-23.
//
// Anti-bot: no Cloudflare wall on the page (CAPABILITIES.md §8); the chat POST
// may raise ERR_CHALLENGE under abuse signals — the site's OWN JS handles the
// VQD canvas fingerprint challenge inside the page, so driving the UI is the
// only posture that keeps anonymous chat working (same principle as the
// signed-in sites: never send a request the page didn't make itself).
import { resolvedHeadless, launchBrowser } from "../runtime/browser.js";
import { makeDomPrimitives } from "../runtime/dom-primitives.js";
import { attachPayload, attachRefusal, validateAttachRequest } from "../runtime/file-attach.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface DuckduckgoCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** Identity-keyed account (email or vault slug); accepted for API parity, unused (anonymous site). */
  account?: string;
}

export interface DuckduckgoCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  note?: string;
}

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return resolvedHeadless();
}

/** The side-chat consent wall's agree button (live-verified 2026-09-22). */
const CONSENT_WALL_BUTTON = "button:has-text('Continue')";

const ATTACH_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf";

// IndexedDB read for duckduckgo_chat_history, kept as a STRING so swc never
// transforms it (a named recursive arrow inside page.evaluate would get the
// __name helper injected and crash with "ReferenceError: __name is not
// defined" — measured). Runs as an IIFE expression that returns a Promise;
// Playwright awaits Promises that evaluate() resolves to.
const READ_SAVED_CHATS_JS =
  '(async () => {' +
  "  const result = { stores: [], chats: [], watchdog: false };" +
  "  const guard = setTimeout(() => { result.watchdog = true; return result; }, 12000);" +
  "  const settle = (v) => { clearTimeout(guard); return v; };" +
  "  try {" +
  "    const open = indexedDB.open('savedAIChatData');" +
  "    open.onerror = () => { clearTimeout(guard); return settle(result); };" +
  "    open.onsuccess = () => {" +
  "      const db = open.result;" +
  "      result.stores = Array.from(db.objectStoreNames);" +
  "      const wanted = ['saved-chats', 'pre-canonical-chats'].filter((s) => result.stores.includes(s));" +
  "      const rows = [];" +
  "      if (wanted.length === 0) { try { db.close(); } catch (e) {} return settle(result); }" +
  "      const drain = (i) => {" +
  "        if (i >= wanted.length) { try { db.close(); } catch (e) {} result.chats = rows; return settle(result); }" +
  "        const s = wanted[i];" +
  "        try {" +
  "          const tx = db.transaction(s, 'readonly');" +
  "          const get = tx.objectStore(s).getAll();" +
  "          get.onsuccess = () => {" +
  "            for (const row of (get.result || [])) {" +
  "              const rid = String(row.chatId || row.id || '');" +
  "              if (rid === '__metadata__' && !row.title && !row.model) continue;" +
  "              rows.push({ id: rid, title: String(row.title || ''), " +
  "                model: String(row.model || ''), reasoningMode: row.reasoningMode, " +
  "                pinned: Boolean(row.pinned), " +
  "                messageCount: Array.isArray(row.messages) ? row.messages.length : 0, " +
  "                lastEdit: row.lastEdit });" +
  "            }" +
  "            drain(i + 1);" +
  "          };" +
  "          get.onerror = () => drain(i + 1);" +
  "        } catch (e) { drain(i + 1); }" +
  "      };" +
  "      drain(0);" +
  "      return undefined;" +
  "    };" +
  "  } catch (e) { clearTimeout(guard); return settle(result); }" +
  "  await new Promise((r) => setTimeout(r, 13000));" +
  "  return result;" +
  "})()";

// Sidebar DOM corroboration for duckduckgo_chat_history — also a STRING for
// the same swc __name reason: untyped top-level arrows are safe, but any
// statement-transformed arrow risks the helper injection.
const READ_SIDEBAR_JS =
  "(() => {" +
  "  const out = { searchInput: false, deleteRows: 0, rows: [] };" +
  "  out.searchInput = !!document.querySelector(\"input[aria-label='Search chats']\");" +
  "  const dels = Array.from(document.querySelectorAll(\"button[aria-label='Delete Chat']\"));" +
  "  out.deleteRows = dels.length;" +
  "  for (const el of dels) {" +
  "    let p = el.parentElement;" +
  "    for (let i = 0; i < 5 && p; i++) {" +
  "      const t = (p.innerText || '').replace(/\\s+/g, ' ').trim();" +
  "      if (t && t.length < 80) { out.rows.push(String(t.split('·')[0] || t).trim().slice(0, 40)); break; }" +
  "      p = p.parentElement;" +
  "    }" +
  "  }" +
  "  return out;" +
  "})()";

// GOAL 88: the old MIME_BY_EXT table (extension → caller-facing mimeType) is
// GONE. A declared extension/name/mimeType never decides what a payload is —
// the shared validator sniffs the real bytes (src/runtime/file-attach.ts) and
// refuses any name that disagrees with the sniff.

export class DuckduckgoCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: DuckduckgoCapabilityOptions = {}) {
    this.browser = opts.browser;
    this.ownsBrowser = !opts.browser;
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.headless = opts.headless ?? headlessDefault();
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await launchBrowser(3, { headless: this.headless });
    this.ownsBrowser = true;
    return this.browser;
  }

  // Fresh incognito context pointed at duck.ai/chat. NO session injection —
  // the site is anonymous; an empty context is exactly what the site expects.
  // Headless light mode drops images/fonts/media (same as ChatDriver) so the
  // page loads fast on constrained hosts.
  private async openPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: this.headless ? { width: 1280, height: 900 } : null,
    });
    if (this.headless) {
      await context.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (t === "image" || t === "font" || t === "media") return route.abort();
        return route.continue();
      });
    }
    const page = await context.newPage();
    await page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    return page;
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<DuckduckgoCapabilityResult> {
    switch (capability) {
      case "duckduckgo_chat":
        return this.chat(args);
      case "duckduckgo_model_picker":
        return this.modelPicker();
      case "duckduckgo_web_search":
        return this.webSearch(args);
      case "duckduckgo_file_upload":
        return this.fileUpload(args);
      case "duckduckgo_reasoning":
        return this.reasoning(args);
      case "duckduckgo_chat_history":
        return this.chatHistory(args);
      default:
        return { capability, ok: false, data: undefined, error: `unknown duckduckgo capability: ${capability}` };
    }
  }

  // --- duckduckgo_chat: the UI path (live-verified 2026-09-22, headed Xvfb) ---
  //
  // Flow proven on the wire: type prompt into the composer textarea -> Enter.
  // The FIRST send is blocked by the site's consent wall ("By clicking
  // 'Continue' you agree to our Privacy Policy and Terms of Service") — its
  // Continue button is clicked, the composer re-focused, and Enter pressed
  // again. The site's own JS then runs GET /duckchat/v1/status (VQD) +
  // POST /duckchat/v1/chat (SSE) and renders the streamed answer; we read the
  // answer off the page until it stops growing (awaitAnswer). No synthetic
  // request is ever sent.
  private async chat(args: Record<string, unknown>): Promise<DuckduckgoCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return { capability: "duckduckgo_chat", ok: false, data: undefined, error: "prompt is required" };
    const t0 = Date.now();
    const page = await this.openPage();
    const dom = makeDomPrimitives(() => Promise.resolve(page));
    try {
      await page.waitForSelector("textarea", { timeout: 20000 });
      const composer = this.profile.composer[0];
      await dom.type(composer, prompt);
      await page.waitForTimeout(60 + Math.floor(Math.random() * 120));
      await dom.press(composer, ["Enter"]);
      await page.waitForTimeout(1800);
      // Consent wall on FIRST send (live-verified): click Continue, re-focus the
      // composer, and send again — exactly what a human does.
      const wall = await page.locator(CONSENT_WALL_BUTTON).first().isVisible({ timeout: 1500 }).catch(() => false);
      if (wall) {
        await page.locator(CONSENT_WALL_BUTTON).first().click({ timeout: 3000 });
        await page.waitForTimeout(700 + Math.floor(Math.random() * 400));
        await dom.press(composer, ["Enter"]);
      }
      const answerSel = this.profile.answer.join(", ") || "body";
      const observed = await dom.awaitAnswer(answerSel, {
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : this.profile.captureMs,
        stableMs: this.profile.stableMs,
      });
      // The assistant bubble's innerText is "<model chip>\n\n<answer>\n\n2nd opinion"
      // (first line = active model, last block = the cite/compare footer — both are
      // page chrome, not the model's answer). Clean them for the caller.
      let raw = (observed.text ?? "").trim();
      let model: string | undefined;
      const lines = raw.split("\n").map((l) => l.trim());
      while (lines.length && !lines[0]) lines.shift();
      if (lines.length && lines[0] && !/[?.,!]$/.test(lines[0]) && lines.length > 1) {
        model = lines.shift(); // first non-empty line is the model chip
        while (lines.length && !lines[0]) lines.shift();
      }
      // The chip reads a streaming label ("Generating response"/"Stop generating")
      // while the stream runs; only report a REAL model from a settled bubble.
      if (model && /generating|stop generating|thinking/i.test(model)) {
        await page.waitForTimeout(1500);
        model = await page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return "";
          const first = ((el as HTMLElement).innerText || "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
          return /generating|stop generating|thinking/i.test(first) ? "" : first;
        }, this.profile.answer[0] ?? "[id*='assistant-message']");
        if (!model) model = undefined;
      }
      raw = lines.join("\n").trim();
      raw = raw.replace(/\n*2nd opinion\s*$/, "").trim();
      if (!raw) {
        return {
          capability: "duckduckgo_chat",
          ok: false,
          method: "ui.page-read",
          latencyMs: Date.now() - t0,
          data: undefined,
          error:
            "no answer appeared on duckduckgo — either ERR_CHALLENGE (abuse signal) or the consent wall " +
            "re-blocked; honest on-page read returned empty",
        };
      }
      return {
        capability: "duckduckgo_chat",
        ok: true,
        method: "ui.page-read",
        latencyMs: Date.now() - t0,
        data: { answer: raw, model, chunkCount: observed.chunkCount, doneReason: observed.doneReason, url: observed.url },
        note: "answer read off the live page; the site's own JS drove POST /duckchat/v1/chat (SSE)",
      };
    } catch (e) {
      return {
        capability: "duckduckgo_chat",
        ok: false,
        data: undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await this.teardownPage(page).catch(() => {});
    }
  }

  // --- duckduckgo_model_picker: REAL chip -> panel read (VERIFIED 2026-09-23) ---
  // Empty composer shows the active-model chip ("5.6 Luna", w≈100 h≈32, plain
  // button, no aria). Clicking it opens [role='menu'][aria-label='Choose a
  // model'] whose rows are [role='menuitemradio'] with
  // data-testid="model-picker-row-<id>" and aria-checked="true" on the active
  // model ("GPT-5.6 Luna\nBest for everyday use"). The post-chat composer hides
  // the chip — fall back to a fresh New Chat and retry once.
  private async modelPicker(): Promise<DuckduckgoCapabilityResult> {
    const page = await this.openPage();
    const t0 = Date.now();
    try {
      await page.waitForSelector("textarea", { timeout: 15000 });
      await page.waitForTimeout(1200);
      await this.dismissOverlays(page);
      let opened = await this.openModelPicker(page);
      if (!opened) {
        const nc = page.locator("button:has-text('New Chat')").first();
        if (await nc.isVisible({ timeout: 1500 }).catch(() => false)) {
          await nc.click().catch(() => {});
          await page.waitForTimeout(1500);
          opened = await this.openModelPicker(page);
        }
      }
      if (!opened) {
        return {
          capability: "duckduckgo_model_picker",
          ok: false,
          method: "ui.model-picker",
          latencyMs: Date.now() - t0,
          data: undefined,
          error:
            "model chip not found on the composer (post-chat composer hides it and New Chat retry failed) — retry",
        };
      }
      const rows = await page.evaluate(() => {
        const out: Array<Record<string, string | null>> = [];
        for (const el of Array.from(document.querySelectorAll("[role='menu'] [role='menuitemradio'], [role='menuitemradio']"))) {
          const attrs: Record<string, string> = {};
          for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
          const txt = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() || "";
          if (!txt) continue;
          out.push({
            name: txt.split(" ").slice(0, 4).join(" "),
            full: txt.slice(0, 90),
            testId: attrs["data-testid"] ?? null,
            reaction: attrs["aria-checked"] ?? null,
          });
        }
        return out.slice(0, 20);
      });
      await page.keyboard.press("Escape").catch(() => {});
      if (rows.length === 0) {
        return {
          capability: "duckduckgo_model_picker",
          ok: false,
          method: "ui.model-picker",
          latencyMs: Date.now() - t0,
          data: undefined,
          error: "model panel opened but rendered no rows (hydration timing) — retry",
        };
      }
      const active = rows.find((r) => r.reaction === "true");
      return {
        capability: "duckduckgo_model_picker",
        ok: true,
        method: "ui.model-picker",
        latencyMs: Date.now() - t0,
        data: {
          selected: active ? active.full : null,
          count: rows.length,
          models: rows,
        },
        note:
          "REAL composer model chip -> [role='menu'][aria-label='Choose a model'] read of " +
          "[role='menuitemradio'] rows (data-testid=model-picker-row-<id>, aria-checked on the active model)",
      };
    } catch (e) {
      return {
        capability: "duckduckgo_model_picker",
        ok: false,
        data: undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await this.teardownPage(page).catch(() => {});
    }
  }

  // Click the composer model chip (live-measured shape: plain button, text
  // matching a model regex, w 40-450 h>20, no aria-label). Returns true if the
  // menu opened.
  private async openModelPicker(page: Page): Promise<boolean> {
    const clicked = await page
      .evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) => {
          const txt = ((b as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() || "";
          const r = b.getBoundingClientRect();
          const aria = b.getAttribute("aria-label") ?? "";
          return (
            txt &&
            txt.length < 30 &&
            r.width > 40 &&
            r.width < 450 &&
            r.height > 20 &&
            !aria &&
            /(^|\s)(luna|gpt|claude|haiku|llama|mistral|kimi|gemma)(\s|$)|[0-9]+\.[0-9]+|gpt-/i.test(txt)
          );
        });
        if (btn) {
          (btn as HTMLElement).click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (!clicked) return false;
    await page.waitForTimeout(1300);
    const menu = page.locator("[role='menu'][aria-label='Choose a model']");
    return await menu.isVisible({ timeout: 4000 }).catch(() => false);
  }

  // --- duckduckgo_web_search: REAL "Tools" -> Web Search toggle (VERIFIED 2026-09-23) ---
  // Composer "Tools" button (text "Tools") opens a popover whose rows include
  // "Web Search / Source answers from the web" ([role='menuitemradio']);
  // selecting it adds button[aria-label='Remove Web Search'] to the composer
  // (read-back). Disabling clicks that chip. Default args.enable=true targets
  // ON state; pass enable:false to turn it OFF. No request is ever synthesized —
  // only the site's own toggle is driven, and the enabled state is read back.
  private async webSearch(args: Record<string, unknown>): Promise<DuckduckgoCapabilityResult> {
    const page = await this.openPage();
    const t0 = Date.now();
    const enable = args.enable !== false;
    try {
      await page.waitForSelector("textarea", { timeout: 15000 });
      await page.waitForTimeout(1200);
      await this.dismissOverlays(page);
      const chip = page.locator("button[aria-label='Remove Web Search']");
      const before = await chip.isVisible({ timeout: 800 }).catch(() => false);
      if (before === enable) {
        return {
          capability: "duckduckgo_web_search",
          ok: true,
          method: "ui.toggle",
          latencyMs: Date.now() - t0,
          data: { enabled: enable, before, changed: false, readBack: enable ? "Remove Web Search chip present" : "no Web Search chip" },
          note: "already at the requested state — read back from composer chip",
        };
      }
      let readBack = before;
      if (enable) {
        const toolsOpened = await page
          .evaluate(() => {
            const b = Array.from(document.querySelectorAll("button")).find((x) => (x as HTMLElement).innerText?.trim() === "Tools");
            if (b) {
              (b as HTMLElement).click();
              return true;
            }
            return false;
          })
          .catch(() => false);
        if (!toolsOpened) {
          return {
            capability: "duckduckgo_web_search",
            ok: false,
            method: "ui.toggle",
            latencyMs: Date.now() - t0,
            data: undefined,
            error: "composer 'Tools' button not found — toggle unverifiable on this load",
          };
        }
        await page.waitForTimeout(1200);
        const wsRow = await page
          .evaluate(() => {
            const b = Array.from(document.querySelectorAll("[role='menuitemradio'], [role='menuitemcheckbox'], [role='menu'] button, button")).find(
              (x) => {
                const txt = ((x as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() || "";
                const aria = x.getAttribute("aria-label") ?? "";
                return /^web search/i.test(txt) || /web search source answers/i.test(txt) || /web search/i.test(aria);
              }
            );
            if (b) {
              (b as HTMLElement).click();
              return true;
            }
            return false;
          })
          .catch(() => false);
        if (!wsRow) {
          await page.keyboard.press("Escape").catch(() => {});
          return {
            capability: "duckduckgo_web_search",
            ok: false,
            method: "ui.toggle",
            latencyMs: Date.now() - t0,
            data: undefined,
            error: "Web Search row not found in the Tools popover (menu may have changed) — honest failed toggle",
          };
        }
        await page.waitForTimeout(900);
        await page.keyboard.press("Escape").catch(() => {});
        readBack = await chip.isVisible({ timeout: 2500 }).catch(() => false);
      } else {
        if (before) {
          await chip.click().catch(() => {});
          await page.waitForTimeout(900);
        }
        readBack = await chip.isVisible({ timeout: 2500 }).catch(() => false);
      }
      const ok = readBack === enable;
      return {
        capability: "duckduckgo_web_search",
        ok,
        method: "ui.toggle",
        latencyMs: Date.now() - t0,
        data: {
          enabled: readBack,
          before,
          changed: before !== readBack,
          readBack: readBack ? "Remove Web Search chip present" : "no Web Search chip",
        },
        note: ok
          ? "REAL composer toggle: 'Tools' -> 'Web Search' row, state read back from button[aria-label='Remove Web Search']; the enabled state drives metadata.toolChoice.WebSearch on the NEXT chat POST (bundle-verified)"
          : `requested ${enable ? "ON" : "OFF"} but composer chip reads ${readBack ? "ON" : "OFF"} — re-verify the toggle DOM`,
      };
    } catch (e) {
      return {
        capability: "duckduckgo_web_search",
        ok: false,
        data: undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await this.teardownPage(page).catch(() => {});
    }
  }

  // --- duckduckgo_file_upload: REAL composer input[type='file'] (VERIFIED 2026-09-23) ---
  // The attach button (button[aria-label='Add images or PDFs']) wraps a hidden
  // input[type='file'] with accept="image/png,image/jpeg,image/webp,image/gif,
  // application/pdf,.pdf". setInputFiles on the input (filechooser never fires
  // — same as kimi_file_upload) attaches the file; the composer then renders a
  // chip button[aria-label^='Remove image '] (read-back).
  //
  // GOAL 88: the payload is gated by the SHARED validator
  // (src/runtime/file-attach.ts) BEFORE any browser is launched. The old gate
  // compared the CALLER-DECLARED mimeType against ATTACH_ACCEPT, so
  // file:{path:"…/.ssh/id_rsa", name:"a.png", mimeType:"image/png"} was read
  // and uploaded. Now the real bytes are sniffed, the path form is refused
  // unless UI2API_ATTACH_ROOTS names a containing root, and the handoff is
  // always the in-memory payload.
  private async fileUpload(args: Record<string, unknown>): Promise<DuckduckgoCapabilityResult> {
    const t0 = Date.now();
    const file = validateAttachRequest(args, { siteId: "duckduckgo", accept: ATTACH_ACCEPT });
    if (!file.ok) {
      const refusal = attachRefusal(file, "duckduckgo_file_upload");
      return {
        capability: refusal.capability,
        ok: false,
        method: "ui.file-upload",
        latencyMs: Date.now() - t0,
        data: { code: refusal.code, rule: file.code, message: refusal.message },
        error: `[${refusal.code}] ${refusal.message}`,
        note: "GOAL 88 attach gate refused the payload before any browser launched — see src/runtime/file-attach.ts for the rule order",
      };
    }
    const payload = attachPayload(file);
    const { name, mimeType, buffer } = payload;
    const page = await this.openPage();
    try {
      await page.waitForSelector("textarea", { timeout: 15000 });
      await page.waitForTimeout(1200);
      await this.dismissOverlays(page);
      const input = page.locator("input[type='file']").first();
      if ((await input.count()) === 0) {
        return {
          capability: "duckduckgo_file_upload",
          ok: false,
          method: "ui.file-upload",
          latencyMs: Date.now() - t0,
          data: undefined,
          error: "composer input[type='file'] not found — attach UI unverifiable on this load",
        };
      }
      await input.setInputFiles(payload);
      await page.waitForTimeout(1400);
      const chip = page.locator("button[aria-label^='Remove image '], button[aria-label^='Remove file ']");
      const seen = await chip.isVisible({ timeout: 3000 }).catch(() => false);
      if (!seen) {
        return {
          capability: "duckduckgo_file_upload",
          ok: false,
          method: "ui.file-upload",
          latencyMs: Date.now() - t0,
          data: undefined,
          error:
            "no attachment chip rendered after setInputFiles (site rejected the file or hydration lagged) — honest on-page read",
        };
      }
      const chipLabel = await chip.getAttribute("aria-label").catch(() => null);
      return {
        capability: "duckduckgo_file_upload",
        ok: true,
        method: "ui.file-upload",
        latencyMs: Date.now() - t0,
        data: { fileName: name, mimeType, bytes: buffer.length, chip: chipLabel },
        note:
          "REAL composer attach: setInputFiles on hidden input[type='file'] (site's own upload handler) -> " +
          "attachment chip button[aria-label^='Remove image '] read-back; the file rides the next chat POST as a " +
          "{type:'image'|'file', content:...} part (bundle-verified)",
      };
    } catch (e) {
      return {
        capability: "duckduckgo_file_upload",
        ok: false,
        data: undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await this.teardownPage(page).catch(() => {});
    }
  }

  // GOAL 88: the old resolveUpload() (caller-mime gate + readFileSync on a
  // caller path) is GONE. Every attach on this runner goes through the shared
  // validator above — see src/runtime/file-attach.ts.

  // --- duckduckgo_reasoning: REAL composer reasoning toggle (VERIFIED 2026-09-23) ---
  // button[aria-label='Reasoning mode'] reads "Fast"/"Reasoning". Clicking it
  // opens a popover with [role='menuitemradio'] rows "Reasoning Takes longer to
  // respond" (aria-checked=false) and "Fast Answers right away"
  // (aria-checked=true). Selecting the other row flips the button text
  // (read-back). Modes accepted: "fast" | "reasoning". "extended" is NOT
  // offered for the free-tier GPT-5.6 Luna model (measured limit — reported
  // honestly as ok:false with the real reason, never fabricated).
  private async reasoning(args: Record<string, unknown>): Promise<DuckduckgoCapabilityResult> {
    const page = await this.openPage();
    const t0 = Date.now();
    const requested = String(args.mode ?? args.state ?? "").toLowerCase().replace(/[\s_-]/g, "") || "fast";
    try {
      await page.waitForSelector("textarea", { timeout: 15000 });
      await page.waitForTimeout(1200);
      await this.dismissOverlays(page);
      const btn = page.locator("button[aria-label='Reasoning mode']");
      await btn.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
      if (!(await btn.isVisible().catch(() => false))) {
        return {
          capability: "duckduckgo_reasoning",
          ok: false,
          method: "ui.toggle",
          latencyMs: Date.now() - t0,
          data: undefined,
          error: "button[aria-label='Reasoning mode'] not found on the composer — toggle unverifiable on this load",
        };
      }
      const before = (await btn.innerText().catch(() => "")).trim();
      if (requested === "extended") {
        return {
          capability: "duckduckgo_reasoning",
          ok: false,
          method: "ui.toggle",
          latencyMs: Date.now() - t0,
          data: { before, options: ["Fast", "Reasoning"] },
          error:
            'extended reasoning is NOT offered by the free-tier GPT-5.6 Luna composer (measured 2026-09-23: popover offers only "Fast" and "Reasoning" rows) ' +
            "- switch to a plus/pro model that carries extendedThinking (bundle-verified) — honest measured limit, never fabricated",
        };
      }
      if (requested !== "fast" && requested !== "reasoning") {
        return {
          capability: "duckduckgo_reasoning",
          ok: false,
          method: "ui.toggle",
          latencyMs: Date.now() - t0,
          data: undefined,
          error: `unknown reasoning mode "${requested}" — supported: fast, reasoning (extended is plan-gated)`,
        };
      }
      if (before.toLowerCase() === requested) {
        return {
          capability: "duckduckgo_reasoning",
          ok: true,
          method: "ui.toggle",
          latencyMs: Date.now() - t0,
          data: { before, after: before, mode: requested, changed: false, options: ["Fast", "Reasoning"] },
          note: "already at the requested mode — composer button read-back",
        };
      }
      await btn.click().catch(() => {});
      await page.waitForTimeout(1200);
      const clicked = await page
        .evaluate((want: string) => {
          const roots = Array.from(document.querySelectorAll("[role='dialog'], [role='menu']"));
          const scope = roots.find((r) => /reason/i.test((r as HTMLElement).innerText || "")) ?? document.body;
          const labels = { fast: ["fast", "answers right away"], reasoning: ["reasoning", "takes longer"] };
          const w = labels[want as keyof typeof labels] ?? [];
          const b = Array.from(scope.querySelectorAll("[role='menuitemradio'], [role='menuitemcheckbox'], button")).find((x) => {
            const txt = ((x as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() || "";
            return w.some((k) => txt.toLowerCase().includes(k));
          });
          if (b) {
            (b as HTMLElement).click();
            return true;
          }
          return false;
        }, requested)
        .catch(() => false);
      await page.waitForTimeout(1000);
      if (!clicked) {
        await page.keyboard.press("Escape").catch(() => {});
        return {
          capability: "duckduckgo_reasoning",
          ok: false,
          method: "ui.toggle",
          latencyMs: Date.now() - t0,
          data: { before },
          error: `"${requested}" row not found in the reasoning popover — honest failed toggle`,
        };
      }
      const after = (await btn.innerText().catch(() => "")).trim();
      await page.keyboard.press("Escape").catch(() => {});
      const ok = after.toLowerCase() === requested;
      return {
        capability: "duckduckgo_reasoning",
        ok,
        method: "ui.toggle",
        latencyMs: Date.now() - t0,
        data: { before, after, mode: requested, changed: before !== after, options: ["Fast", "Reasoning"] },
        note: ok
          ? "REAL composer toggle: button[aria-label='Reasoning mode'] popover -> [role='menuitemradio'], button text flipped (read-back); reasoningEffort rides the NEXT chat POST (bundle-verified)"
          : `requested "${requested}" but composer button reads "${after}" — re-verify the toggle DOM`,
      };
    } catch (e) {
      return {
        capability: "duckduckgo_reasoning",
        ok: false,
        data: undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await this.teardownPage(page).catch(() => {});
    }
  }

  // --- duckduckgo_chat_history: IndexedDB + sidebar read (VERIFIED 2026-09-23) ---
  // Chats live in IndexedDB "savedAIChatData" (v6), stores saved-chats and
  // pre-canonical-chats, keyed by chatId {title, model, messages[], lastEdit,
  // pinned, ...}. The site creates the store on FIRST chat, so a fresh
  // anonymous context reads empty — pass args.sendProbe to drive ONE real probe
  // chat (site's own JS, consent-wall handled) so the store exists and the read
  // returns rows. The sidebar (input[aria-label='Search chats'],
  // button[aria-label='Delete Chat'] per row) corroborates via DOM.
  private async chatHistory(args: Record<string, unknown>): Promise<DuckduckgoCapabilityResult> {
    const page = await this.openPage();
    const t0 = Date.now();
    try {
      await page.waitForSelector("textarea", { timeout: 15000 });
      await page.waitForTimeout(1200);
      await this.dismissOverlays(page);
      const probe = String(args.sendProbe ?? "").trim();
      if (probe) {
        await this.probeChatToSeed(page, probe);
      }
      const idb = await page.evaluate(READ_SAVED_CHATS_JS) as { stores: string[]; chats: Array<Record<string, unknown>>; watchdog?: boolean };
      const sidebar = await page.evaluate(READ_SIDEBAR_JS) as { searchInput: boolean; deleteRows: number; rows: string[] };
      const chats = idb.chats;
      return {
        capability: "duckduckgo_chat_history",
        ok: true,
        method: "indexeddb.saved-chats + dom.sidebar",
        latencyMs: Date.now() - t0,
        data: {
          count: chats.length,
          chats: chats.slice(0, 25),
          stores: idb.stores,
          sidebar,
          seeded: probe ? { prompt: probe, reason: "fresh anonymous context has no chats until one exists — drove a real probe chat (site's own JS)" } : undefined,
        },
        note:
          "REAL read of the site's own IndexedDB ('savedAIChatData' saved-chats/pre-canonical-chats, keyed by chatId) + " +
          "sidebar DOM corroboration; a fresh anonymous context is empty until the site's own JS creates a chat",
      };
    } catch (e) {
      return {
        capability: "duckduckgo_chat_history",
        ok: false,
        data: undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await this.teardownPage(page).catch(() => {});
    }
  }

  // Drive ONE real chat through the site's own composer to seed the IndexedDB
  // store (used by chat_history's optional sendProbe). Never synthetic.
  private async probeChatToSeed(page: Page, prompt: string): Promise<void> {
    const dom = makeDomPrimitives(() => Promise.resolve(page));
    const composer = this.profile.composer[0];
    await dom.type(composer, prompt);
    await page.waitForTimeout(80 + Math.floor(Math.random() * 100));
    await dom.press(composer, ["Enter"]);
    await page.waitForTimeout(1800);
    const wall = await page.locator(CONSENT_WALL_BUTTON).first().isVisible({ timeout: 1500 }).catch(() => false);
    if (wall) {
      await page.locator(CONSENT_WALL_BUTTON).first().click({ timeout: 3000 });
      await page.waitForTimeout(700 + Math.floor(Math.random() * 400));
      await dom.press(composer, ["Enter"]);
    }
    await page.waitForSelector("[id*='assistant-message']", { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000); // let the site persist saved-chats
    await this.dismissOverlays(page);
  }

  // Dismiss the post-first-chat onboarding overlay ("Got It!") + any modal that
  // Escape closes. Live-verified: this is enough to unblock the composer.
  private async dismissOverlays(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
    const gotit = page.locator("button:has-text('Got It!')").first();
    if (await gotit.isVisible({ timeout: 800 }).catch(() => false)) {
      await gotit.click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  private async teardownPage(page: Page): Promise<void> {
    if (page && !page.isClosed()) {
      try {
        await page.context().close();
      } catch {
        // context already gone
      }
    }
  }

  async close(): Promise<void> {
    if (this.ownsBrowser && this.browser && this.browser.isConnected()) {
      await this.browser.close().catch(() => {});
    }
  }
}