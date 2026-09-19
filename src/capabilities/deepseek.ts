// DeepSeek capability runner — exposes chat.deepseek.com's JS-visible surface
// as typed callable capabilities over the SAME browser + session machinery as
// ChatDriver.
//
// Capability dispatch:
//   deepseek_chat               -> ChatDriver UI path (the site's own JS drives
//                                  POST /api/v0/chat/completion as an SSE stream
//                                  behind AWS WAF + PoW; the browser solves both
//                                  invisibly).
//   deepseek_list_conversations -> DOM sidebar/history on the live page, with an
//                                  honest rpcNote naming the real session APIs
//                                  (needs a captured localStorage userToken +
//                                  PoW-solved session; future work pending a live
//                                  capture).
//   deepseek_reasoner           -> honest best-effort stub: CoT is
//                                  thinking_enabled in the completion body +
//                                  localStorage thinkingEnabledStorageHandle;
//                                  no verified DOM toggle selector exists in the
//                                  profile yet — returns ok:false with the real
//                                  mechanism documented.
//
// NOT built: deepseek_chat_direct (POST /api/v0/chat/completion over direct
// fetch with auth + PoW headers — PoW mining algorithm lives in an async chunk
// and has not been reverse-engineered; mining difficulty is unknown; AWS WAF
// sits on / and redirects challenge-cleared sessions to the SPA. When a live
// captured session has its PoW loop observed end-to-end, a wire path can be
// built as a page.evaluate + fetch mirroring gemini-rpc.ts).
//
// Auth facts (VERIFIED from bundle analysis, see CAPABILITIES.md / manifest.json):
//   localStorage key `userToken` → every authed request carries
//   `Authorization: Bearer <userToken>` (http interceptor keyed on
//   `context.withToken`; resolved by `getUserTokenWithSource()`). Also stored:
//   `settingsJwt` → sent as `x-settings-token`; `__appKit_userInfo` → user id.
//
// Anti-bot:
//   AWS WAF JS challenge on / (HTTP 202 + `x-amzn-waf-action: challenge`;
//   curl UA → HTTP 403). Proof-of-work: `POST /api/v0/chat/create_pow_challenge
//   {target_path}` → {algorithm, challenge, salt, signature, expire_at,
//   expire_after}; client mines (async chunk) then submits
//   `X-DS-PoW-Response: base64(JSON{algorithm, challenge, salt, answer,
//   signature, target_path})`. Headed Playwright + real profile solves both
//   WAF + PoW transparently — the UI path is the only viable posture until
//   the PoW algorithm is captured.
//
// DeepSeek uses per-session `model_type` (sent on every completion); the
// literal id values are server-driven from `/api/v0/client/settings` feature
// `model_configs` and do NOT appear in the bundles. The "Think" toggle maps
// to `thinking_enabled` in the completion body + localStorage
// `thinkingEnabledStorageHandle`; the "Search" toggle maps to
// `search_enabled` + localStorage `searchEnabledStorageHandle`.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface DeepSeekCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** External browser pool handle — reserved for daemon integration. */
  pool?: Browser;
}

export interface DeepSeekCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Wire-level note — what the RPC path needs before it can be driven directly. */
  wireNote?: string;
  /** Anti-bot posture note — AWS WAF + PoW, browser-solved only. */
  antiBot?: string;
  /** Human note about the verified mechanism / posture. */
  note?: string;
}

const ANTI_BOT_NOTE =
  "AWS WAF JS challenge on / (HTTP 202 + x-amzn-waf-action: challenge; curl UA → 403) plus PoW mining " +
  "(POST /api/v0/chat/create_pow_challenge → X-DS-PoW-Response header) — both solved invisibly by a " +
  "headed Playwright session; synthetic fetch is blocked until the PoW algorithm is captured.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class DeepSeekCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: DeepSeekCapabilityOptions = {}) {
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

  // Open a fresh incognito context with the captured session injected (same as
  // ChatDriver.getPage), pointed at the profile's landing page, and return the
  // page. `usingUserChrome()` users skip injection (their real profile already
  // carries the session, which must clear the AWS WAF challenge first).
  private async openPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: usingUserChrome() || !this.headless ? null : { width: 1280, height: 900 },
    });
    if (!usingUserChrome() && this.headless) {
      await context.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (t === "image" || t === "font" || t === "media") return route.abort();
        return route.continue();
      });
    }
    const host = new URL(this.profile.url).host;
    if (!usingUserChrome()) {
      const snap = loadSnapshot(snapshotPath(this.dataDir, host));
      if (snap) {
        await injectSnapshot(context, snap);
      } else {
        const cookies = loadCookies(sessionPath(this.dataDir, host));
        if (cookies.length > 0) await context.addCookies(cookies as never[]);
      }
    }
    const page = await context.newPage();
    await page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    return page;
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<DeepSeekCapabilityResult> {
    const base = { antiBot: ANTI_BOT_NOTE };
    switch (capability) {
      case "deepseek_chat":
        return { ...base, ...(await this.chat(args)) };
      case "deepseek_list_conversations":
        return { ...base, ...(await this.listConversations(args)) };
      case "deepseek_reasoner":
        return { ...base, ...(await this.reasoner(args)) };
      case "deepseek_web_search":
        return { ...base, ...(await this.webSearch(args)) };
      default:
        return { capability, ok: false, data: undefined, error: `unknown deepseek capability: ${capability}` };
    }
  }

  // --- deepseek_chat: the UI path (proven for every other runner; the site's
  // own JS drives POST /api/v0/chat/completion as an SSE stream) ---
  private async chat(args: Record<string, unknown>): Promise<DeepSeekCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("deepseek_chat", "prompt is required");
    const driver = new ChatDriver(this.profile, {
      browser: this.browser,
      dataDir: this.dataDir,
    });
    try {
      const r = await driver.ask(prompt, {
        newChat: Boolean(args.newChat),
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      });
      return {
        capability: "deepseek_chat",
        ok: true,
        data: {
          answer: r.answer,
          chunkCount: r.chunkCount,
          doneReason: r.doneReason,
          url: r.url,
          title: r.title,
        },
        wireNote:
          "POST /api/v0/chat/completion + PoW mining verified in bundles but needs a captured " +
          "localStorage userToken + the PoW algorithm (in an async chunk, not reverse-engineered yet); " +
          "UI path until first live capture",
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- deepseek_list_conversations: DOM sidebar/history on the live page ---
  // The real session list API is POST /api/v0/chat_session/fetch_page, but it
  // requires the localStorage userToken Bearer + PoW challenge headers — both
  // only available inside a live headed session. Without a live capture of a
  // logged-in session, a synthetic fetch would bounce on the AWS WAF wall or
  // fail PoW validation. DOM is the only viable current path.
  private async listConversations(args: Record<string, unknown>): Promise<DeepSeekCapabilityResult> {
    const page = await this.openPage();
    // The SPA renders the sidebar conversation list after hydration — a
    // readyState wait is NOT enough; wait for the actual anchor nodes.
    await page.waitForSelector("a[href*='/chat/']", { timeout: 15000 }).catch(() => {});
    const query = String(args.query ?? "").trim();
    const rpcNote =
      "wire RPC (POST /api/v0/chat_session/fetch_page for session listing, " +
      "GET /api/v0/chat/history_messages for message history, localStorage userToken Bearer " +
      "+ POST /api/v0/chat/create_pow_challenge for PoW headers) is future work pending a " +
      "live headed session capture — DOM sidebar reflects the current session" +
      (query ? "; query filter not available on the DOM path — full list returned" : "");
    try {
      // a[href*='/chat/'] — conversation links in the sidebar. DeepSeek routes
      // conversations under /chat/ or /a/chat/s/ (exact href shape varies by
      // UI revision). Static nav routes are excluded. Selectors are UNVERIFIED
      // candidates — confirm on first live capture.
      const dom = await page.evaluate(() => {
        const nav = new Set(["/chat", "/chat/", "/chat/history", "/chat/settings"]);
        const out: Array<{ id: string; title: string }> = [];
        for (const a of document.querySelectorAll("a[href*='/chat/']")) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          // Extract the id after the /chat/ segment — works for both
          // /chat/<id> and /a/chat/s/<id> href shapes.
          const match = href.match(/\/chat\/(.+?)(?:[?&]|$)/);
          if (!match) continue;
          const id = match[1].replace(/\/+$/, "").split(/[?&]/)[0];
          if (!id || nav.has(href) || nav.has("/chat/" + id)) continue;
          const text = ((a as HTMLElement).innerText || "").trim();
          if (!out.some((x) => x.id === id)) out.push({ id, title: text || id });
        }
        return out.slice(0, 20);
      });
      return {
        capability: "deepseek_list_conversations",
        ok: true,
        method: "dom.sidebar",
        data: { conversations: dom, via: "dom.sidebar", rpcNote },
      };
    } catch (e) {
      return this.fail("deepseek_list_conversations", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- deepseek_reasoner: flip the REAL "DeepThink" toggle (VERIFIED 2026-09-19) ---
// Composer toggles are div.ds-toggle-button rows labelled "DeepThink" and
// "Search"; the active one carries the class ds-toggle-button--selected.
// DeepThink flips `thinking_enabled` on the next completion + the per-session
// model_type (bundle-verified); "Search" flips `search_enabled`. Live probe:
// clicking flips the --selected class both ways; localStorage handles
// (thinkingEnabledStorageHandle / searchEnabledStorageHandle) stayed null in
// this session — the toggle state lives in the app store and is sent on the
// wire in the completion body. `args.state` ("on" | "off") optionally targets
// a specific state; default = click (toggle).
private async reasoner(args: Record<string, unknown>): Promise<DeepSeekCapabilityResult> {
  return this.flipToggle("deepseek_reasoner", "DeepThink", args);
}

// --- deepseek_web_search: flip the REAL "Search" toggle (VERIFIED 2026-09-19) ---
private async webSearch(args: Record<string, unknown>): Promise<DeepSeekCapabilityResult> {
  return this.flipToggle("deepseek_web_search", "Search", args);
}

private async flipToggle(
  capability: "deepseek_reasoner" | "deepseek_web_search",
  toggleText: "DeepThink" | "Search",
  args: Record<string, unknown>
): Promise<DeepSeekCapabilityResult> {
  const page = await this.openPage();
  try {
    // Let the composer + toggles hydrate (the "next"-style SPA boots its event
    // wiring lazily; a click before boot is dropped — same cold-boot behaviour
    // as Tencent/Kimi). Poll for the toggle row up to 15s.
    const toggle = page.locator(".ds-toggle-button").filter({ hasText: toggleText }).first();
    const t0 = Date.now();
    let visible = await toggle.isVisible().catch(() => false);
    while (!visible && Date.now() - t0 < 15000) {
      await page.waitForTimeout(700);
      visible = await toggle.isVisible().catch(() => false);
    }
    if (!visible) {
      return this.fail(capability, `"${toggleText}" toggle not visible after settle (composer/toggles may not have rendered)`);
    }
    const state = (): Promise<{ selected: boolean; cls: string | null }> =>
      page.evaluate((label: string) => {
        const el = [...document.querySelectorAll(".ds-toggle-button")].find(
          (b) => ((b as HTMLElement).innerText || "").trim() === label
        ) as HTMLElement | null;
        if (!el) return { selected: false, cls: null };
        return { selected: el.className.includes("ds-toggle-button--selected"), cls: el.className };
      }, toggleText);

    const before = await state();
    const wanted = String(args.state ?? "").toLowerCase();
    if (wanted === "on" && before.selected) {
      // already on — nothing to flip
    } else if (wanted === "off" && !before.selected) {
      // already off — nothing to flip
    } else {
      await toggle.click().catch((e) => {
        throw new Error(`toggle click failed: ${(e as Error).message.slice(0, 120)}`);
      });
      await page.waitForTimeout(900);
    }
    const after = await state();
    const ok = wanted === "" || (wanted === "on" && after.selected) || (wanted === "off" && !after.selected);
    return {
      capability,
      ok,
      method: "dom.toggle",
      data: { toggle: toggleText, before: before.selected, after: after.selected, stateClass: after.cls?.slice(0, 90) ?? null },
      note:
        ok
          ? `${toggleText} → ${after.selected ? "ON" : "OFF"}. The class ds-toggle-button--selected tracks the switch; the value reaches the wire as ${
              toggleText === "DeepThink" ? "thinking_enabled" : "search_enabled"
            } in the next completion body (bundle-verified). Toggle state is held in the app store — the localStorage handles stayed null in the verified session.`
          : `requested state ${wanted} but ended at ${after.selected ? "ON" : "OFF"} — re-verify the toggle DOM.`,
    };
  } catch (e) {
    return this.fail(capability, e);
  } finally {
    await this.teardownPage(page);
  }
}

  private fail(capability: string, e: unknown): DeepSeekCapabilityResult {
    return { capability, ok: false, data: undefined, error: e instanceof Error ? e.message : String(e) };
  }

  private async teardownPage(page: Page): Promise<void> {
    try {
      await page.context()?.close();
    } catch {
      // already gone
    }
    // Browser is only ours when the caller didn't hand one in.
    if (this.ownsBrowser) {
      try {
        await this.browser?.close().catch(() => {});
      } catch {
        // gone
      }
      this.browser = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.ownsBrowser) {
      try {
        await this.browser?.close().catch(() => {});
      } catch {
        // gone
      }
    }
    this.browser = undefined;
  }
}

// Let the SPA settle past domcontentloaded; DeepSeek's sidebar renders after
// hydration, not at document load. The AWS WAF JS challenge on / may also
// delay the real SPA HTML arriving.
async function waitForDomain(page: Page, ms: number): Promise<void> {
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < ms) {
      const ready = await page.evaluate(() => document.readyState).catch(() => "missing");
      if (ready === "complete") break;
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {
    // page gone mid-wait — caller will get its own evaluate error
  }
}
