// ChatGPT (chatgpt.com) capability runner — exposes chatgpt.com's JS-visible
// surface as typed callable capabilities over the SAME browser + session
// machinery as ChatDriver.
//
// Capability dispatch:
//   chatgpt_chat               -> ChatDriver UI path (proven pattern; drives the
//                                site's own #prompt-textarea composer. Wire note:
//                                direct SSE POST /backend-api/f/conversation is
//                                verified in bundles; auth interplay (chatreq_token,
//                                conversation_mode) is unverified live — UI path
//                                until first live capture).
//   chatgpt_conversation_crud  -> NOT built. Ground truth: /backend-api/conversation/*
//                                endpoints exist in bundles (GET/DELETE, rename,
//                                stream_status, async-status) with Bearer access
//                                token + csrfToken. Live shapes to verify — no
//                                fabricated calls.
//   chatgpt_web_search         -> NOT built. Ground truth: web_search + cloud_browser
//                                flags feed client_tools in the send payload (flag
//                                literals in bundle). UI toggle selector unverified.
//   chatgpt_upload_attach      -> NOT built. Ground truth: /backend-api/estuary/upload
//                                content + upload_content_bytes (azure/aws direct
//                                strategies, size buckets). Auth via Bearer — live
//                                shape to verify.
//   chatgpt_artifacts          -> NOT built. Ground truth: window.CanmoreNative hook
//                                + artifact_* message fields + /conversation/{id}/
//                                textdocs endpoint. UI selector unverified.
//   chatgpt_gpts               -> NOT built. Ground truth: conversation_mode
//                                {kind: GizmoInteraction, gizmo_id} + model_slug on
//                                custom GPTs. Payload field verified in bundle; live
//                                walk to verify.
//   chatgpt_voice              -> NOT built. Ground truth: /backend-api/transcribe
//                                endpoint literal + voice_landing field on send
//                                payload. Live shape to verify.
//
// TRANSPORT GROUND TRUTH (CAPABILITIES.md / manifest.json, landing-bundle
// analysis 2026-09-16 — VERIFIED):
//   - Send endpoint: POST /backend-api/f/conversation (text/event-stream SSE);
//     historical /backend-api/conversation also in codebase string table.
//   - Auth: same-origin /api/auth/session -> Authorization: Bearer <accessToken>;
//     token refresh via BroadcastChannel auth-session / access-token-refreshed-v1.
//   - Request body fields: model_slug, model_slug_advanced, chatreq_token,
//     client_tools, history_and_training_disabled, conversation_mode
//     ({kind: PrimaryAssistant} or {kind: GizmoInteraction, gizmo_id}),
//     parent_message_id, system_hints, system_prompt_type, contextScopes.
//   - SSE event literals: stream_start, status_message, conversation_id,
//     turn_complete; per-chunk delta name composed dynamically (to-verify).
//   - Model names: gpt-4, gpt-4-1, gpt-4-1-mini, gpt-4-5, gpt-4o, o4-mini,
//     gpt-5-2, gpt-5-3, gpt-5-mini, gpt-5-thinking, gpt-5-t-mini.
//   - No bot wall: plain curl UA returned the full SSR HTML (572 KB); no
//     Cloudflare challenge at the static layer. Anti-automation expected once
//     headless signals appear (Guardian / datadog-session checks).
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface ChatGPTCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface ChatGPTCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Wire-truth note — what the real SSE surface offers vs what this run did. */
  wireNote?: string;
}

// Grounded from CAPABILITIES.md §1–§9 (landing-bundle analysis): the send
// endpoint POST /backend-api/f/conversation, SSE streaming, Bearer auth from
// /api/auth/session, and request-body field names are VERIFIED from bundles.
// The auth interplay (chatreq_token gating, conversation_mode defaults,
// __chatreq_mode_at_send semantics) is UNVERIFIED — no live capture yet.
const WIRE_NOTE =
  "direct SSE POST /backend-api/f/conversation verified in bundles (text/event-stream, " +
  "event literals: stream_start / status_message / conversation_id / turn_complete); auth interplay " +
  "(chatreq_token, conversation_mode, model_slugAdvanced gating) is unverified live — UI path via " +
  "ChatDriver until first live capture. No bot wall at static layer; Guardian / datadog-session " +
  "checks expected on headless-automation signals.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class ChatGPTCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: ChatGPTCapabilityOptions = {}) {
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
  // carries the session).
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

  async run(capability: string, args: Record<string, unknown> = {}): Promise<ChatGPTCapabilityResult> {
    const base = { wireNote: WIRE_NOTE };
    switch (capability) {
      case "chatgpt_chat":
        return { ...base, ...(await this.chat(args)) };
      case "chatgpt_conversation_crud":
        return { ...base, ...(this.conversationCrud()) };
      case "chatgpt_web_search":
        return { ...base, ...(this.webSearch()) };
      case "chatgpt_upload_attach":
        return { ...base, ...(this.uploadAttach()) };
      case "chatgpt_artifacts":
        return { ...base, ...(this.artifacts()) };
      case "chatgpt_gpts":
        return { ...base, ...(this.gpts()) };
      case "chatgpt_voice":
        return { ...base, ...(this.voice()) };
      default:
        return { capability, ok: false, data: undefined, error: `unknown chatgpt capability: ${capability}`, ...base };
    }
  }

  // --- chatgpt_chat: the UI path (the #prompt-textarea composer, driven by
  // the site's own JS). The direct SSE path (/backend-api/f/conversation) is
  // verified in bundles but the auth interplay (chatreq_token, conversation_mode,
  // model_slugAdvanced gating) is UNVERIFIED — UI path only until first live
  // capture. Selectors are ground truth from the builtin profile.
  private async chat(args: Record<string, unknown>): Promise<ChatGPTCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("chatgpt_chat", "prompt is required");
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
        capability: "chatgpt_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
        wireNote:
          "direct SSE POST /backend-api/f/conversation (text/event-stream, event literals: stream_start / " +
          "status_message / conversation_id / turn_complete) verified in bundles; auth interplay " +
          "(chatreq_token, conversation_mode, model_slugAdvanced gating) is unverified live — " +
          "UI path via ChatDriver until first live capture",
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- chatgpt_conversation_crud: NOT built ---
  // Ground truth from CAPABILITIES.md §4: /backend-api/conversation/{id} (GET/DELETE),
  // /conversation/{id}/rename, /conversation/{id}/stream_status, /conversation/{id}/
  // async-status, /conversation/{id}/lock, /conversation/message_feedback,
  // /conversation/textdocs — all with Bearer access token + csrfToken. Endpoint
  // literals verified in bundles; live request/response shapes to verify. No
  // fabricated calls.
  private conversationCrud(): ChatGPTCapabilityResult {
    return {
      capability: "chatgpt_conversation_crud",
      ok: false,
      method: "api-path (GET/POST /backend-api/conversation/*)",
      data: undefined,
      error:
        "not built yet — ground truth: /backend-api/conversation/{id} (GET/DELETE), " +
        "/conversation/{id}/rename, /conversation/{id}/stream_status, /conversation/{id}/async-status, " +
        "/conversation/{id}/lock, /conversation/message_feedback, /conversation/textdocs " +
        "(CAPABILITIES.md §4, endpoint literals verified from bundles); auth via Bearer access token " +
        "+ csrfToken. Live request/response shapes unverified — no fabricated calls until first " +
        "live capture",
    };
  }

  // --- chatgpt_web_search: NOT built ---
  // Ground truth from CAPABILITIES.md §2: web_search + cloud_browser flags feed
  // client_tools in the /backend-api/f/conversation request body (flag literals in
  // bundle). The exact tool-shape (which flags, which values) is to verify on live
  // capture. The UI toggle selector is not grounded.
  private webSearch(): ChatGPTCapabilityResult {
    return {
      capability: "chatgpt_web_search",
      ok: false,
      method: "composer-sidebar toggle (site UI)",
      data: undefined,
      error:
        "not built yet — ground truth: web_search + cloud_browser flags feed client_tools in the " +
        "/backend-api/f/conversation request body (CAPABILITIES.md §2, flag literals in bundle). " +
        "Exact tool-shape to verify on live capture; UI toggle selector unverified — no fabricated " +
        "selectors",
    };
  }

  // --- chatgpt_upload_attach: NOT built ---
  // Ground truth from CAPABILITIES.md §3: /backend-api/estuary/content + /backend-api/
  // estuary/upload_content_bytes (upload_url_expiry, strategies: estuary_bytes,
  // direct_azure, direct_azure_multipart, direct_aws; size buckets: 20_to_100_mib,
  // gte_100_mib). Auth via Bearer. Live upload flow to verify.
  private uploadAttach(): ChatGPTCapabilityResult {
    return {
      capability: "chatgpt_upload_attach",
      ok: false,
      method: "api-path (POST /backend-api/estuary/*)",
      data: undefined,
      error:
        "not built yet — ground truth: /backend-api/estuary/content + /backend-api/estuary/upload_content_bytes " +
        "(CAPABILITIES.md §3, upload_url_expiry, strategies: estuary_bytes / direct_azure / " +
        "direct_azure_multipart / direct_aws, size buckets: 20_to_100_mib / gte_100_mib — endpoint " +
        "literals verified from bundles). Auth via Bearer access token. Live upload flow unverified — " +
        "no fabricated calls until first live capture",
    };
  }

  // --- chatgpt_artifacts: NOT built ---
  // Ground truth from CAPABILITIES.md §3: window.CanmoreNative hook present in
  // bundles; message fields artifact_id, artifact_kind, artifact_files,
  // artifact_preview_result, artifact_renderer, artifact_known_file_sizes_per_event;
  // conversation docs endpoint /backend-api/conversation/{id}/textdocs. UI selector
  // (iframe/artifact-mode) unverified.
  private artifacts(): ChatGPTCapabilityResult {
    return {
      capability: "chatgpt_artifacts",
      ok: false,
      method: "site iframe/artifact-mode",
      data: undefined,
      error:
        "not built yet — ground truth: window.CanmoreNative hook + artifact_id / artifact_kind / " +
        "artifact_files / artifact_preview_result / artifact_renderer / " +
        "artifact_known_file_sizes_per_event message fields; /conversation/{id}/textdocs endpoint " +
        "(CAPABILITIES.md §3, verified from bundles). UI selector (iframe/artifact-mode) unverified — " +
        "no fabricated selectors until first live capture",
    };
  }

  // --- chatgpt_gpts: NOT built ---
  // Ground truth from CAPABILITIES.md §1: conversation_mode {kind: GizmoInteraction,
  // gizmo_id} + model_slug on custom GPTs. Payload field verified in bundle; the live
  // walk (navigating to a /g/… route, picking a GPT, confirming the send payload
  // contains the GizmoInteraction mode) is unverified.
  private gpts(): ChatGPTCapabilityResult {
    return {
      capability: "chatgpt_gpts",
      ok: false,
      method: "ui-path (site picker)",
      data: undefined,
      error:
        "not built yet — ground truth: conversation_mode {kind: GizmoInteraction, gizmo_id} + model_slug " +
        "on custom GPTs (CAPABILITIES.md §1, payload field verified from bundles); /g/… route " +
        "confirmed in SSR nav. Live walk to verify the GPT picker + send payload contains GizmoInteraction — " +
        "no fabricated selectors or calls until first live capture",
    };
  }

  // --- chatgpt_voice: NOT built ---
  // Ground truth from CAPABILITIES.md §5: /backend-api/transcribe endpoint literal;
  // dictation/gate key gpt-dictation; voice_landing field on the send payload. Live
  // shape (request body, audio format, response) unverified.
  private voice(): ChatGPTCapabilityResult {
    return {
      capability: "chatgpt_voice",
      ok: false,
      method: "api-path (POST /backend-api/transcribe)",
      data: undefined,
      error:
        "not built yet — ground truth: /backend-api/transcribe endpoint literal + gpt-dictation " +
        "feature-gate key + voice_landing field on the send payload (CAPABILITIES.md §5, verified " +
        "from bundles). Live request body (audio format, response shape) unverified — no fabricated " +
        "calls until first live capture",
    };
  }

  private fail(capability: string, e: unknown): ChatGPTCapabilityResult {
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

// Let the SPA settle past domcontentloaded; chatgpt.com's shell renders after
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
