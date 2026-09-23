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
//   tencent_aistudio_conversation_crud — LIVE-VERIFIED 2026-09-23: History →
//                                      /chat-history renders the user's real dated
//                                      conversation list as div.list-item rows
//                                      (title/model/type); clicking a row navigates
//                                      into /chat/HunyuanDefault/<id>?from=history.
//                                      rename/delete DOM NOT located → honest
//                                      ok:false for those actions.
//   tencent_aistudio_deep_think / web_search / image_gen / code_run /
//   file_upload / tts / podcast / translations — wire surface mapped in
//   CAPABILITIES.md from JS-bundle analysis (searchDeepMode, deep-think speech
//   types, DIT image gen, coder runCode, etc.); DOM toggles/panels measured on
//   live 2026-09-23: NONE of the composer toggles exist on the current Hy4
//   preview composer (no 搜索/联网, no 深度思考 switch, no attach control, no
//   input[type=file]), and /image /code /tts /podcast /translate routes answer
//   "Current Page Does Not Exist"; image surface lives on the separate
//   hy3d.tencent.ai app. Honest ok:false with measured reasons (never fabricated).
import { launchBrowser, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadAccountSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface TencentAistudioCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
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
  private readonly account?: string;

  constructor(private readonly profile: ChatSiteProfile, opts: TencentAistudioCapabilityOptions = {}) {
    this.browser = opts.browser;
    this.ownsBrowser = !opts.browser;
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.headless = opts.headless ?? headlessDefault();
    this.account = opts.account;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    // EdgeOne blocks headless — a headless request would fail at HTTP 567; the
    // caller is responsible for running this site headed (UI2API_HEADED=1).
    this.browser = await launchBrowser(3, { headless: this.headless });
    this.ownsBrowser = true;
    return this.browser;
  }

  private async openPage(initialUrl?: string): Promise<Page> {
    const browser = await this.ensureBrowser();
    // Reuse the caller-provided (attached / persistent) context ONLY, like
    // ChatDriver's defaultContext: a caller-supplied browser already carries its
    // real session. A freshly-launched browser ships with an EMPTY default
    // context — create our own and inject the snapshot into it.
    const existing = !this.ownsBrowser && browser.contexts().length > 0 ? browser.contexts()[0] : null;
    const context = existing ?? (await browser.newContext({
      viewport: usingUserChrome() || !this.headless ? null : { width: 1280, height: 900 },
    }));
    const host = new URL(this.profile.url).host;
    // Inject the captured session into FRESH contexts unconditionally (matches
    // ChatDriver): even real Chrome (UI2API_CHROME=1) launches with an EMPTY
    // profile — the snapshot is what makes the context a logged-in session.
    // The existing context (attached real profile) already carries its cookies.
    if (!existing) {
      let snap: ReturnType<typeof loadSnapshot> | null = null;
      if (this.account && this.account !== "default") {
        // Identity-keyed account vault (data/sessions/<host>/<slug>/): load the
        // requested identity's snapshot and inject IT — never a silent fallback
        // to the legacy default identity.
        snap = loadAccountSnapshot(this.dataDir, host, this.account);
        if (!snap) {
          throw new Error(
            `no stored session for ${this.profile.id} account "${this.account}" on ${host} — capture it ` +
              `first (ui2api profile capture <url> --login) or omit account for the legacy default snapshot`
          );
        }
      } else {
        snap = loadSnapshot(snapshotPath(this.dataDir, host));
      }
      if (snap) {
        await injectSnapshot(context, snap);
      }
    }
    const page = await context.newPage();
    // Navigate straight to the target route on a cold boot: the app's SPA router
    // can swallow a mid-boot route change, so double-navigation (home then
    // /chat-history) races the Vue boot. Entering at the target route works
    // (probe-verified 2026-09-23).
    await page.goto(initialUrl ?? this.profile.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    return page;
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<TencentAistudioCapabilityResult> {
    const base = { antiBot: ANTI_BOT_NOTE };
    switch (capability) {
      case "tencent_aistudio_chat":
        return { ...base, ...(await this.chat(args)) };
      case "tencent_aistudio_conversation_crud":
        return { ...base, ...(await this.conversationCrud(args)) };
      case "tencent_aistudio_deep_think":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "deep think / reasoning: the Hy4 preview composer (measured live 2026-09-23) exposes " +
            "NO deep-think toggle button (scanned every composer toolbar control / control-extra; " +
            "only the 'High' model-mode chip exists). Deep-think OUTPUT does render live — answers " +
            "carry a 'Deep thinking completed（Ran for …s）' detail block (hy-detail-block-header-title) — " +
            "but there is no switch to expose as a capability. Honest ok:false.",
        };
      case "tencent_aistudio_web_search":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "web search / deep search mode: bundle analysis proves searchDeepMode in the chat options " +
            "payload, but the live Hy4 preview composer (measured 2026-09-23) exposes NO search/联网 " +
            "toggle (scanned every composer control + all DOM elements matching 搜索/search/联网/deep " +
            "search — none). Honest ok:false until a toggle appears or the wire payload is captured.",
        };
      case "tencent_aistudio_image_gen":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "image generation (DIT / vision): the aistudio chat surface (measured live 2026-09-23) has " +
            "no image-gen trigger, and /image answers 'Current Page Does Not Exist'. The 3D Studio menu " +
            "entry opens the SEPARATE app hy3d.tencent.ai (text-to-3D / image-to-3D) — a different surface, " +
            "not the DIT image gen in aistudio. Honest ok:false.",
        };
      case "tencent_aistudio_code_run":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "code interpreter / sandbox (coder.runCode): bundle-mapped; live Hy4 preview composer + /code " +
            "route (measured 2026-09-23, 'Current Page Does Not Exist') expose no code-run trigger. " +
            "Honest ok:false.",
        };
      case "tencent_aistudio_file_upload":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "file upload + document QA: the composer has a files zone div " +
            "(hy-chat-input__content-top-content-wrapper--no-files) but NO input[type=file] and no " +
            "attach/upload control in the live DOM (measured 2026-09-23). Honest ok:false.",
        };
      case "tencent_aistudio_tts":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "TTS / ASR: bundle-mapped (audio/synthesis); NO TTS/朗读/speaker control anywhere in the live " +
            "DOM, and /tts answers 'Current Page Does Not Exist' (measured 2026-09-23). Honest ok:false.",
        };
      case "tencent_aistudio_podcast":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "podcast generation: bundle-mapped (PODCAST speech type); no podcast/播客 trigger in the live " +
            "composer or side menu (measured 2026-09-23); /podcast answers 'Current Page Does Not Exist'. " +
            "A prior 'MorningSunlightPodcastScript' conversation exists in history — feature has existed — " +
            "but no current trigger DOM. Honest ok:false.",
        };
      case "tencent_aistudio_translations":
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          error:
            "in-chat translation: bundle-mapped (translateModelList) but no translation/翻译 control in the " +
            "live composer, and /translate answers 'Current Page Does Not Exist' (measured 2026-09-23). " +
            "Honest ok:false.",
        };
      default:
        return { capability, ok: false, data: undefined, error: `unknown tencent-aistudio capability: ${capability}` };
    }
  }

  // --- tencent_aistudio_conversation_crud: LIVE-VERIFIED 2026-09-23 list + open ---
  // History menu → /chat-history renders the user's real dated conversation list as
  // `div.list-item` rows (title / model / type). Rows are divs (no href) — the id is
  // only revealed by the click, which navigates into /chat/HunyuanDefault/<id>?from=history.
  private async conversationCrud(args: Record<string, unknown>): Promise<TencentAistudioCapabilityResult> {
    const action = String(args.action ?? "list");
    if (action !== "list" && action !== "open") {
      return {
        capability: "tencent_aistudio_conversation_crud",
        ok: false,
        data: undefined,
        error:
          `conversation action "${action}" not live-verified: rename/delete DOM not located on the ` +
          `2026-09-23 revision (only the list + open-by-click are proven). Honest ok:false.`,
      };
    }
    const page = await this.openPage(new URL("/chat-history", this.profile.url).toString());
    try {
      // History is a dated list that hydrates ~5-9s after the SPA cold-boots.
      await page.waitForTimeout(8000 + Math.floor(Math.random() * 500));
      await page.waitForSelector(".list-item", { timeout: 45000 });
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".list-item")).map((el) => ({
          title: ((el.firstChild as HTMLElement)?.innerText ?? el.textContent ?? "").trim(),
          text: ((el as HTMLElement).innerText ?? "").trim(),
        }))
      );
      if (action === "list") {
        return {
          capability: "tencent_aistudio_conversation_crud",
          ok: true,
          method: "ui-path",
          data: {
            conversations: rows.map((r) => ({ title: r.text.split("\n")[0], text: r.text })),
            note:
              "History → /chat-history: real user conversation list rendered as div.list-item rows " +
              "(title/model/type, dated groups). LIVE-VERIFIED 2026-09-23 (headed real Chrome + snapshot).",
          },
          note: "list LIVE-VERIFIED 2026-09-23 — .list-item rows on /chat-history; ids are click-only (divs, no hrefs). rename/delete not located.",
        };
      }
      // action === "open" — click the row for args.title (or args.index) and read back the resulting URL.
      const title = String(args.title ?? "");
      const index = typeof args.index === "number" ? args.index : 0;
      const rowIndex = title.length > 0 ? rows.findIndex((r) => r.text.toLowerCase().includes(title.toLowerCase())) : index;
      if (rowIndex < 0 || !rows[rowIndex]) {
        return {
          capability: "tencent_aistudio_conversation_crud",
          ok: false,
          data: undefined,
          error: `no conversation row matching title="${title}" (got ${rows.length} rows)`,
        };
      }
      const target = rows[rowIndex];
      // Click the DOM row at the inspected index (rows share order with the DOM;
      // hasText/getByText are unreliable against the multi-line row text).
      await page.locator(".list-item").nth(rowIndex).click({ timeout: 10000 });
      await page.waitForTimeout(6000);
      const url = page.url();
      const m = url.match(/\/chat\/[^/]+\/([A-Za-z0-9]+)/);
      if (!m) {
        return {
          capability: "tencent_aistudio_conversation_crud",
          ok: false,
          data: { clicked: target.text },
          error: `clicked row "${target.text.slice(0, 60)}" but no /chat/<model>/<id> in resulting URL: ${url}`,
        };
      }
      return {
        capability: "tencent_aistudio_conversation_crud",
        ok: true,
        method: "ui-path",
        data: { conversationId: m[1], url, clicked: target.text.slice(0, 120) },
        note:
          "open LIVE-VERIFIED 2026-09-23: clicked /chat-history row → navigated into " +
          `/chat/HunyuanDefault/<id>?from=history (real conversation page).`,
      };
    } catch (e) {
      return this.fail("tencent_aistudio_conversation_crud", e);
    } finally {
      if (this.ownsBrowser) await page.context().close().catch(() => {});
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