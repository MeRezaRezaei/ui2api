// Tencent AI Studio capability runner — exposes the JS-visible surface of
// aistudio.tencent.ai as typed callable capabilities over the SAME browser +
// session machinery as ChatDriver.
//
// IMPORTANT POSTURE FACTS (all verified, see capabilities/tencent-aistudio/CAPABILITIES.md):
//  * EdgeOne blocks headless Chromium with HTTP 567 — runs are headed / real
//    Chrome ONLY (mirrors capabilities/hunyuan).
//  * Auth = session cookies hunyuan_token + hunyuan_user + hunyuan_source on
//    .tencent.ai (VERIFIED against the captured snapshot).
//  * The app cold-boots ~5-8s: the composer becomes visible long before the
//    app can dispatch a send (probe-verified 2026-09-19) — ChatDriver's
//    preComposeDelayMs covers the chat path.
//
// Verified LIVE (2026-09-19, headed real Chrome + injected snapshot):
//   tencent_aistudio_chat            — YES. Composer textarea.t-textarea__inner
//                                      ("Ask me anything"), Enter submits, answer
//                                      streams into .agent-chat__bubble--ai
//                                      .hyc-content-md (markdown body
//                                      .hyc-common-markdown), completion marker
//                                      "Completed". proof round-trips PASS
//                                      (12, 13717, 72, …).
//   tencent_aistudio_conversation_crud — NO live DOM selector yet: the History
//                                      drawer (layout-menu__menu-history) renders
//                                      no anchor list on this revision; the wire
//                                      chat-list API is documented in
//                                      CAPABILITIES.md but not captured. Honest
//                                      ok:false pending a live History capture.
//   tencent_aistudio_deep_think / web_search / image_gen / code_run /
//   file_upload / tts / podcast / translations — wire surface mapped in
//   CAPABILITIES.md from JS-bundle analysis (searchDeepMode, deep-think speech
//   types, DIT image gen, coder runCode, etc.); DOM toggles/panels for these
//   are UNVERIFIED — honest ok:false with mechanism notes (never fabricated).
import { launchBrowser, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface TencentAistudioCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface TencentAistudioCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  wireNote?: string;
  antiBot?: string;
  note?: string;
}

const ANTI_BOT_NOTE =
  "EdgeOne CDN blocks headless Chromium (HTTP 567) + galileotelemetry/traceId monitoring — " +
  "headed real Chrome ONLY; the UI path (ChatDriver) is the only viable posture. " +
  "Session cookies: hunyuan_token/hunyuan_user/hunyuan_source on .tencent.ai.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class TencentAistudioCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: TencentAistudioCapabilityOptions = {}) {
    this.browser = opts.browser;
    this.ownsBrowser = !opts.browser;
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.headless = opts.headless ?? headlessDefault();
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    // EdgeOne blocks headless — a headless request would fail at HTTP 567; the
    // caller is responsible for running this site headed (UI2API_HEADED=1).
    this.browser = await launchBrowser(3, { headless: this.headless });
    this.ownsBrowser = true;
    return this.browser;
  }

  private async openPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: usingUserChrome() || !this.headless ? null : { width: 1280, height: 900 },
    });
    const host = new URL(this.profile.url).host;
    if (!usingUserChrome()) {
      const snap = loadSnapshot(snapshotPath(this.dataDir, host));
      if (snap) {
        await injectSnapshot(context, snap);
      }
    }
    const page = await context.newPage();
    await page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    return page;
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<TencentAistudioCapabilityResult> {
    const base = { antiBot: ANTI_BOT_NOTE };
    switch (capability) {
      case "tencent_aistudio_chat":
        return { ...base, ...(await this.chat(args)) };
      case "tencent_aistudio_conversation_crud":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "conversation list/CRUD: the History drawer (layout-menu__menu-history) rendered no " +
            "anchor list on the 2026-09-19 revision — no verified DOM selector. Wire API documented " +
            "in CAPABILITIES.md (per-chat /chat/HunyuanDefault route + chat list endpoints) but not " +
            "yet captured live. Re-verify on a live headed capture.",
        };
      case "tencent_aistudio_deep_think":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "deep think / reasoning: bundle analysis proves deep-think speech types in the SSE stream " +
            "(HYCSpeechType) rendered as .agent-chat__conv--ai__deep_think-style blocks, but the composer " +
            "toggle DOM is UNVERIFIED (the composer area shows a model chip + toolbar, no confirmed " +
            "deep-think switch selector). Confirm the toggle selector on a live capture to activate.",
        };
      case "tencent_aistudio_web_search":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "web search / deep search mode: bundle analysis proves searchDeepMode in the chat options " +
            "payload, but the composer's search-mode toggle DOM is UNVERIFIED. Confirm on a live capture.",
        };
      case "tencent_aistudio_image_gen":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "image generation (DIT / vision): wire surface mapped in CAPABILITIES.md from bundles; no " +
            "verified in-chat trigger DOM. Confirm on a live capture.",
        };
      case "tencent_aistudio_code_run":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "code interpreter / sandbox (coder.runCode): bundle-mapped; no verified in-chat trigger DOM. " +
            "Confirm on a live capture.",
        };
      case "tencent_aistudio_file_upload":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "file upload + document QA: bundle-mapped; the composer file affordance selector is " +
            "UNVERIFIED. Confirm on a live capture.",
        };
      case "tencent_aistudio_tts":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "TTS / ASR: bundle-mapped; no verified in-chat trigger DOM. Confirm on a live capture.",
        };
      case "tencent_aistudio_podcast":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "podcast generation: bundle-mapped; no verified in-chat trigger DOM. Confirm on a live capture.",
        };
      case "tencent_aistudio_translations":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "in-chat translation: bundle-mapped (translation speech type in the stream); no verified " +
            "composer toggle DOM. Confirm on a live capture.",
        };
      default:
        return { capability, ok: false, data: undefined, error: `unknown tencent-aistudio capability: ${capability}` };
    }
  }

  // --- tencent_aistudio_chat: the verified UI path (ChatDriver + preComposeDelayMs) ---
  private async chat(args: Record<string, unknown>): Promise<TencentAistudioCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("tencent_aistudio_chat", "prompt is required");
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
        capability: "tencent_aistudio_chat",
        ok: true,
        method: "ui-path",
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
        note: "chat round-trip VERIFIED 2026-09-19 (headed real Chrome, injected snapshot): answer streams into .agent-chat__bubble--ai .hyc-content-md; completion marker 'Completed'.",
      };
    } catch (e) {
      return this.fail("tencent_aistudio_chat", e);
    } finally {
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  private fail(capability: string, e: unknown): TencentAistudioCapabilityResult {
    return { capability, ok: false, data: undefined, error: e instanceof Error ? e.message : String(e) };
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