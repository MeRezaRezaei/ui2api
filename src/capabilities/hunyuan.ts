// Hunyuan / Yuanbao capability runner — exposes yuanbao.tencent.com's
// JS-visible surface as typed callable capabilities over the SAME browser +
// session machinery as ChatDriver.
//
// Capability dispatch:
//   hunyuan_chat               -> ChatDriver UI path (proven; the site's own JS
//                                 drives POST /api/chat/ as an SSE-over-XHR
//                                 stream)
//   hunyuan_list_conversations -> sidebar DOM on the live page, with an honest
//                                 rpcNote: the true wire API (/api/convs,
//                                 /api/user/agent/conversation/list) needs the
//                                 hy_user/hy_token session cookies + the
//                                 X-webdriver-free browser posture and is future
//                                 work pending a live capture.
//   hunyuan_deep_search       -> honest not-yet-live stub: deep-search session
//                                 (scene ai_search_pro*, GET
//                                 /api/inputguide/search/create, deep_search
//                                 CoT chunks) is inventory-proven but the
//                                 composer AI-search / deep-mode trigger is an
//                                 UNVERIFIED candidate selector — ok:false until
//                                 confirmed on a first live capture.
//   hunyuan_document_qa       -> honest not-yet-live stub: document attach wire
//                                 (/api/resource/genUploadInfo -> COS ->
//                                 /api/resource/fileParse|asyncFileParse) is
//                                 inventory-proven but the file-picker / attach
//                                 DOM is UNVERIFIED — ok:false until confirmed on
//                                 a first live capture.
//   hunyuan_voice_mode        -> honest not-yet-live stub: mic voice input
//                                 (voice_tmpkey + voice_recorder chunks) is NOT
//                                 directly scriptable (recipe scriptable:false —
//                                 needs a real mic + real speech + the anti-bot
//                                 headed session) — ok:false, human-assisted.
//
// ANTI-BOT POSTURE (from CAPABILITIES.md / profile.json — every call must
// remember it):
//   - HEADED, real-profile sessions ONLY: the SPA sets `X-webdriver: +!!`
//     navigator.webdriver`, so headless/puppeteer Chrome is fingerprint-flagged
//     (Turing.js risk-control + QIMEI fingerprint SDK on the page).
//   - The session is the hy_user/hy_token cookies asserted by the API server via
//     the Cookie header (cookie domain credentials from Tencent oneid/oauth;
//     never written by bundle JS — `credentials: include` on every XHR).
//   - All work is done by driving the site's own UI; no synthetic fetch layer.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface HunyuanCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface HunyuanCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Anti-bot posture note — headed/real-profile only, X-webdriver flag. */
  stealth?: string;
}

const STEALTH_NOTE =
  "headed/real-profile browser ONLY — the API flags X-webdriver: 1 when navigator.webdriver is true " +
  "(Turing.js + QIMEI fingerprinting); session is the hy_user/hy_token cookies asserted server-side, " +
  "never written by the site's own JS. Drive the site's UI; no synthetic fetch layer.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class HunyuanCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: HunyuanCapabilityOptions = {}) {
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
  // page. NOTE: hunyuan's anti-bot posture requires a real, headed profile —
  // `usingUserChrome()` (UI2API_USER_DATA_DIR) is the supported path; snapshot
  // injection is kept for parity but the headed caveat stands.
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

  async run(capability: string, args: Record<string, unknown> = {}): Promise<HunyuanCapabilityResult> {
    const base = { stealth: STEALTH_NOTE };
    switch (capability) {
      case "hunyuan_chat":
        return { ...base, ...(await this.chat(args)) };
      case "hunyuan_list_conversations":
        return { ...base, ...(await this.listConversations(args)) };
      case "hunyuan_deep_search":
        return { ...base, ...(await this.deepSearch(args)) };
      case "hunyuan_document_qa":
        return { ...base, ...(await this.documentQa(args)) };
      case "hunyuan_voice_mode":
        return { ...base, ...(await this.voiceMode(args)) };
      default:
        return { capability, ok: false, data: undefined, error: `unknown hunyuan capability: ${capability}`, ...base };
    }
  }

  // --- hunyuan_chat: the UI path (the Quill composer -> POST /api/chat/ SSE
  // stream, all owned by the site's own JS) ---
  private async chat(args: Record<string, unknown>): Promise<HunyuanCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("hunyuan_chat", "prompt is required");
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
        capability: "hunyuan_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- hunyuan_list_conversations: sidebar DOM on the live page ---
  // The production APIs (/api/convs, /api/user/agent/conversation/list) need
  // the hy_user/hy_token session cookies and the X-webdriver-free posture;
  // without a live capture of the session they would hop straight to a bot
  // wall. Per the anti-bot rule, the pointer is the page's own sidebar DOM —
  // which always reflects the current logged-in session.
  private async listConversations(args: Record<string, unknown>): Promise<HunyuanCapabilityResult> {
    const page = await this.openPage();
    await waitForDomain(page, 3000);
    const query = String(args.query ?? "").trim();
    const rpcNote =
      "wire RPC (/api/convs and /api/user/agent/conversation/v1/detail) is future work pending a live, " +
      "headed session capture — it requires the hy_user/hy_token cookies and the X-webdriver-free " +
      "browser posture (Turing.js/QIMEI); DOM sidebar reflects the current session" +
      (query ? "; query filter not available on the DOM path — full list returned" : "");
    try {
      // unverified — conversation links on the live sidebar; routes proven by the
      // router (/chat/*) but the exact DOM classes are not — confirm on first
      // live capture.
      const dom = await page.evaluate(() => {
        const nav = new Set(["/chat", "/chat/", "/chat/history"]);
        const out: Array<{ id: string; title: string }> = [];
        for (const a of document.querySelectorAll("a[href^='/chat']")) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const id = href.replace(/^\/chat\/?/, "").split(/[?&]/)[0];
          if (!id || nav.has(href) || href === "/chat") continue;
          const text = ((a as HTMLElement).innerText || "").trim();
          if (!out.some((x) => x.id === id)) out.push({ id, title: text || id });
        }
        return out.slice(0, 20);
      });
      return {
        capability: "hunyuan_list_conversations",
        ok: true,
        method: "dom.sidebar",
        data: { conversations: dom, via: "dom.sidebar", rpcNote },
      };
    } catch (e) {
      return this.fail("hunyuan_list_conversations", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- hunyuan_deep_search: honest not-yet-live stub ---
  // Inventory-proven (bundles, not executed): deep mode = chat scene
  // ai_search_pro (finance ai_search_pro_fin / DeepSeek ai_search_deepseek) sent
  // on the turn; search-session provisioning via
  // GET /api/inputguide/search/create; CoT streams over the same POST /api/chat/
  // SSE as content[].type deep_search with step/process + per-step waits and
  // searchGuid cards (tools google_web_search / paper_search / hunyuan_web_search
  // render as deep-search CoT cards). NOT executable yet: the composer's
  // AI-search entry / 联网-deep-mode trigger is only a CANDIDATE selector and the
  // request bodies were never executed. Fabricating a toggle would break on the
  // first live capture — confirm the exact trigger on a live session first.
  private async deepSearch(args: Record<string, unknown>): Promise<HunyuanCapabilityResult> {
    return {
      capability: "hunyuan_deep_search",
      ok: false,
      method: "unavailable",
      data: undefined,
      error:
        "Deep search builds an AI-search report: chat scene ai_search_pro (finance " +
        "ai_search_pro_fin / DeepSeek ai_search_deepseek) with search-session provisioning via " +
        "GET /api/inputguide/search/create; the CoT streams over the same POST /api/chat/ SSE " +
        "stream as content[].type deep_search with step/process + per-step waits and searchGuid " +
        "cards (tools google_web_search / paper_search / hunyuan_web_search render as deep-search " +
        "CoT cards). NOT executable yet: the composer AI-search / 联网-deep-mode trigger is only a " +
        "CANDIDATE selector and the request bodies were never executed during bundle analysis — " +
        "confirm the exact toggle + selector on a first live capture to activate.",
    };
  }

  // --- hunyuan_document_qa: honest not-yet-live stub ---
  // Inventory-proven (bundles, not executed): attach ONE document per turn
  // (pdf/doc/docx/ppt/pptx/xls/xlsx/txt/csv); wire =
  // /api/resource/genUploadInfo -> COS write -> /api/resource/fileParse|
  // asyncFileParse, then doc analysis rides the same /api/chat SSE stream as
  // doc_percent/docDeepModeInfo/step chunks (deep-read modes
  // TRANSLATION/SUMMARY/GUIDE/DEEP_SEARCH; mind-map
  // GET /api/user/agent/doc/getMindMap). NOT executable yet: the file-picker /
  // plus-panel attach DOM is an UNVERIFIED candidate — confirm the selector on a
  // first live capture rather than fabricate it.
  private async documentQa(args: Record<string, unknown>): Promise<HunyuanCapabilityResult> {
    return {
      capability: "hunyuan_document_qa",
      ok: false,
      method: "unavailable",
      data: undefined,
      error:
        "Document Q&A attaches one document per turn (pdf/doc/docx/ppt/pptx/xls/xlsx/txt/csv): " +
        "wire = /api/resource/genUploadInfo -> COS write -> /api/resource/fileParse|asyncFileParse, " +
        "then the analysis rides the same POST /api/chat/ SSE stream as doc_percent / docDeepModeInfo / " +
        "step chunks (deep-read modes TRANSLATION/SUMMARY/GUIDE/DEEP_SEARCH; mind-map via " +
        "GET /api/user/agent/doc/getMindMap). NOT executable yet: the file-picker / attach-button " +
        "DOM is only an UNVERIFIED candidate and the endpoints were validated from bundles but never " +
        "executed — confirm the selector + wire on a first live capture to activate.",
    };
  }

  // --- hunyuan_voice_mode: honest not-yet-live stub ---
  // Recipe is scriptable:false — voice input is NOT directly scriptable by
  // Playwright/CDP: it needs a real microphone, real speech, and the anti-bot
  // headed session (X-webdriver:1 flag + Turing.js/QIMEI fingerprint);
  // browser automation cannot feed the mic a clean synthetic signal through the
  // site's ASR path without tripping ASR/anti-bot gates. Inventory-proven
  // surface: GET /api/generate/voice_tmpkey (ASR/TTS SDK temp key), voice turns
  // ride the same POST /api/chat/ SSE as content[].type voice_recorder
  // (SPEAKING/STOPPING/SPLIT), X-Input-Type text|voice. UNVERIFIED until a
  // live session: the exact mic-trigger DOM and the temp-key payload shape. So
  // this is a human-assisted round-trip, not an automated one.
  private async voiceMode(args: Record<string, unknown>): Promise<HunyuanCapabilityResult> {
    return {
      capability: "hunyuan_voice_mode",
      ok: false,
      method: "unavailable",
      data: undefined,
      error:
        "Voice mode captures mic input on the composer: the ASR/TTS SDK temp key comes from " +
        "GET /api/generate/voice_tmpkey, and voice turns ride the same POST /api/chat/ SSE stream " +
        "as content[].type voice_recorder (statuses SPEAKING/STOPPING/SPLIT, X-Input-Type text|voice). " +
        "NOT executable yet: the mic-trigger DOM and temp-key payload shape are UNVERIFIED, and the " +
        "recipe is scriptable:false — it requires a real microphone + real speech plus the anti-bot " +
        "headed session (X-webdriver:1 flag, Turing.js/QIMEI fingerprint), so it is a human-assisted " +
        "round-trip pending a first live capture, not an automated one.",
    };
  }

  private fail(capability: string, e: unknown): HunyuanCapabilityResult {
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

// Let the SPA settle past domcontentloaded; Yuanbao's sidebar renders after
// hydration, not at document load.
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