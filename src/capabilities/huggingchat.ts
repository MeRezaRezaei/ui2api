// HuggingChat capability runner — exposes huggingface.co/chat's JS-visible
// surface as typed callable capabilities over the SAME browser + session
// machinery as ChatDriver.
//
// Capability dispatch:
//   huggingchat_chat            -> ChatDriver UI path (the site's own /chat
//                                  composer; SvelteKit v0.20 client drives
//                                  multipart POST /chat/conversation/{id} as
//                                  NDJSON behind the scenes, but the browser
//                                  handles this invisibly — no synthetic wire
//                                  call needed. NOTE: a direct NDJSON wire path
//                                  is grounded (CAPABILITIES.md §1) but not
//                                  built here — UI path chosen for CDP-reliability;
//                                  direct wire could be a future capability).
//   huggingchat_conversations   -> honest ok:false: REST v2 CRUD on same-origin
//                                  cookies (GET/POST/PATCH/DELETE
//                                  /chat/api/v2/conversations); no DOM path
//                                  exists and no synthetic fetch is built — the
//                                  v2 surface needs same-origin cookie auth
//                                  which is implicit in the browser but not
//                                  extractable for a standalone call without a
//                                  live session capture.
//   huggingchat_models          -> honest ok:false: GET /chat/api/v2/models
//                                  (140 models + omni router); same cookie-gated
//                                  REST surface as conversations — no standalone
//                                  path until the session cookie set is captured.
//   huggingchat_settings        -> honest ok:false: GET /chat/api/v2/user/settings
//                                  + POST /chat/settings (300ms debounced upsert);
//                                  same cookie-gated REST, no standalone path.
//   huggingchat_mcp             -> honest ok:false: GET /chat/api/mcp/servers;
//                                  same cookie-gated REST surface.
//
// TRANSPORT GROUND TRUTH (CAPABILITIES.md §1–§9 / manifest.json, SvelteKit
// bundle analysis 2026-09-16 — VERIFIED):
//   - Two parallel API surfaces: legacy non-versioned /chat/conversation (chat
//     flow) and /chat/api/v2 REST (management/models/settings).
//   - Chat wire: POST /chat/conversation (create, JSON) → {conversationId};
//     POST /chat/conversation/{id} (send, multipart/form-data; field `data` =
//     JSON {inputs, id, is_retry, is_continue, generationId, timezone, ...})
//     → 200 Chunked NDJSON (type: status|stream|finalAnswer|tool|file|
//     reasoning|routerMetadata|budget|turnState|elicitation|plan).
//   - Resume: GET /chat/conversation/{id}/stream?messageId=&fromSeq=
//     (EventSource; events 'update'/'end').
//   - Stop: POST /chat/conversation/{id}/stop-generating.
//   - v2 management: GET/POST/PATCH/DELETE /chat/api/v2/conversations,
//     /chat/api/v2/models, /chat/api/v2/user/settings, /chat/api/mcp/servers.
//   - Auth: cookie-based same-origin (no Authorization/bearer header anywhere
//     in the chat flow); anonymous OK (GET /chat/api/v2/user → null; 140 models
//     reachable signed-out). Exact cookie set is server-set and NOT visible in
//     client bundles.
//   - No bot wall: curl + Chrome UA returns HTTP 200 + full bundles.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface HuggingChatCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** External browser pool handle — reserved for daemon integration. */
  pool?: Browser;
}

export interface HuggingChatCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Wire-level note — what the real REST surface offers vs what this run did. */
  wireNote?: string;
}

// Grounded from CAPABILITIES.md §1–§9 (SvelteKit bundle analysis): two parallel
// API surfaces — legacy /chat/conversation (chat flow, NDJSON) and
// /chat/api/v2 REST (management). The chat wire is fully pinned; the v2
// management surface is cookie-gated same-origin REST with no standalone auth
// path. Anonymous mode works for chat.
const WIRE_NOTE =
  "two parallel API surfaces: legacy POST /chat/conversation (chat flow, multipart → NDJSON stream " +
  "with type: status|stream|finalAnswer|tool|file|reasoning|routerMetadata|budget|turnState|elicitation) " +
  "and /chat/api/v2 REST (conversations, models, settings, MCP servers) — all cookie-gated same-origin, " +
  "anonymous OK. Wire fully pinned in CAPABILITIES.md §1–§9 from SvelteKit v0.20 bundle analysis. The " +
  "runner currently drives the UI path for chat; direct NDJSON wire and v2 REST are not built yet.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class HuggingChatCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: HuggingChatCapabilityOptions = {}) {
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
        if (t === "image" || t === "font" || t === "media") return route.continue();
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

  async run(capability: string, args: Record<string, unknown> = {}): Promise<HuggingChatCapabilityResult> {
    const base = { wireNote: WIRE_NOTE };
    switch (capability) {
      case "huggingchat_chat":
        return { ...base, ...(await this.chat(args)) };
      case "huggingchat_conversations":
        return { ...base, ...this.conversations() };
      case "huggingchat_models":
        return { ...base, ...this.models() };
      case "huggingchat_settings":
        return { ...base, ...this.settings() };
      case "huggingchat_mcp":
        return { ...base, ...this.mcp() };
      default:
        return { capability, ok: false, data: undefined, error: `unknown huggingchat capability: ${capability}`, ...base };
    }
  }

  // --- huggingchat_chat: the UI path (the /chat composer, driven by the
  // site's own SvelteKit JS). The direct wire (POST /chat/conversation to
  // create, then multipart POST /chat/conversation/{id} → NDJSON stream) is
  // fully grounded in CAPABILITIES.md §1 but NOT built here: the UI path is
  // chosen for CDP-reliability — the browser solves cookie auth, CSRF, and
  // multipart boundary generation invisibly. A direct NDJSON wire path is a
  // future capability. Composer selectors are the builtin profile values with
  // the grounded v0.20 alternatives noted in profile.json unverified[] —
  // the first builtin selector (textarea[placeholder*='Ask']) is the fallback
  // when the placeholder-free v0.20 textarea[role="combobox"] is absent.
  private async chat(args: Record<string, unknown>): Promise<HuggingChatCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("huggingchat_chat", "prompt is required");
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
        capability: "huggingchat_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
        wireNote:
          "direct NDJSON POST /chat/conversation/{id} (multipart, field `data` = JSON {inputs, id, is_retry, " +
          "is_continue, generationId, timezone, selectedMcpServerNames, selectedMcpServers}) verified in " +
          "CAPABILITIES.md §1.2 from chunks/D_6jIJz0.js; event types: status|stream|finalAnswer|tool|file|" +
          "reasoning|routerMetadata|budget|turnState|elicitation|plan. UI path chosen for CDP-reliability — " +
          "direct wire could be a future capability",
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- huggingchat_conversations: REST v2 CRUD on same-origin cookies ---
  // Ground truth (CAPABILITIES.md §2, manifest.json): GET/POST/PATCH/DELETE
  // /chat/api/v2/conversations (?p= page, create, rename?, delete-all), detail
  // GET/PATCH/DELETE /chat/api/v2/conversations/{id}, per-message
  // GET/PATCH/DELETE /chat/api/v2/conversations/{id}/message/{messageId},
  // import-share POST /chat/api/v2/conversations/import-share.
  // Not executable from this runner: the v2 surface is cookie-gated same-origin
  // REST; the browser carries the cookies but a standalone fetch outside the
  // page context would need the exact cookie set, which is server-set and NOT
  // visible in client bundles (§8 — cookie set unverified statically). Honest
  // ok:false with grounded facts rather than fabricating a call.
  private conversations(): HuggingChatCapabilityResult {
    return {
      capability: "huggingchat_conversations",
      ok: false,
      method: "rest-v2 (same-origin cookies)",
      data: undefined,
      error:
        "not executable yet — ground truth: GET/POST/PATCH/DELETE https://huggingface.co/chat/api/v2/conversations " +
        "(?p= page → {conversations[], hasMore}; create; delete-all), per-conversation GET/PATCH/DELETE " +
        "/conversations/{id}, per-message GET/PATCH/DELETE /conversations/{id}/message/{messageId}, import-share " +
        "POST /conversations/import-share {shareId} → {conversationId} " +
        "(CAPABILITIES.md §2, manifest.json; verified from chunks/DVITWop-.js client factory + nodes/12). " +
        "All endpoints are cookie-gated same-origin REST — the browser carries the session cookies but a " +
        "standalone fetch outside the page context requires the exact cookie set, which is server-set and " +
        "NOT visible in client bundles (cookie set unverified statically). Capture a live session with " +
        "`ui2api profile capture \"https://huggingface.co/chat\" --login` to enable a direct-REST path.",
    };
  }

  // --- huggingchat_models: model catalog via GET /chat/api/v2/models ---
  // Ground truth (CAPABILITIES.md §4, manifest.json): GET /chat/api/v2/models
  // returns 140 models + omni router (live payload); per-model detail
  // GET /chat/api/v2/models/{id} exposes supportsTools, supportsReasoning,
  // supportsArtifacts, multimodal flags, promptExamples, system-prompt UI.
  // Not executable: same cookie-gated v2 REST surface.
  private models(): HuggingChatCapabilityResult {
    return {
      capability: "huggingchat_models",
      ok: false,
      method: "rest-v2 (same-origin cookies)",
      data: undefined,
      error:
        "not executable yet — ground truth: GET https://huggingface.co/chat/api/v2/models returns 140 models + " +
        "omni router (isRouter:true, default); per-model GET /models/{id} exposes supportsTools, " +
        "supportsReasoning, supportsArtifacts, multimodal (multimodalAcceptedMimetypes), promptExamples, " +
        "system-prompt UI (CAPABILITIES.md §4, manifest.json; verified from SSR data-sveltekit-fetched " +
        "payloads + chunks/DVITWop-.js client factory). Cookie-gated same-origin REST — same auth constraint " +
        "as conversations; capture a live session to enable direct-REST.",
    };
  }

  // --- huggingchat_settings: user settings read/upsert ---
  // Ground truth (CAPABILITIES.md §6, manifest.json): GET
  // /chat/api/v2/user/settings (full settings shape with activeModel,
  // streamingMode, customPrompts, toolsOverrides, reasoningOverrides, etc.),
  // debounced POST /chat/settings (300ms debounce, full settings JSON body).
  // Not executable: same cookie-gated v2 REST surface.
  private settings(): HuggingChatCapabilityResult {
    return {
      capability: "huggingchat_settings",
      ok: false,
      method: "rest-v2 (same-origin cookies)",
      data: undefined,
      error:
        "not executable yet — ground truth: GET https://huggingface.co/chat/api/v2/user/settings returns the " +
        "full settings shape (activeModel, streamingMode smooth|raw, customPrompts, toolsOverrides, " +
        "artifactsOverrides, reasoningOverrides, providerOverrides, etc.); debounced POST /chat/settings " +
        "(300ms debounce, full settings JSON) writes the upsert " +
        "(CAPABILITIES.md §6, manifest.json; verified from chunks/CZhNzXSe.js). Cookie-gated same-origin " +
        "REST — same auth constraint; capture a live session to enable direct-REST.",
    };
  }

  // --- huggingchat_mcp: MCP server list ---
  // Ground truth (CAPABILITIES.md §7, manifest.json): GET
  // /chat/api/mcp/servers returns two base MCP servers: Web Search (Exa) and
  // Hugging Face. Enabled server names are attached to each send body
  // (selectedMcpServerNames / selectedMcpServers).
  // Not executable: same cookie-gated v2 REST surface.
  private mcp(): HuggingChatCapabilityResult {
    return {
      capability: "huggingchat_mcp",
      ok: false,
      method: "rest-v2 (same-origin cookies)",
      data: undefined,
      error:
        "not executable yet — ground truth: GET https://huggingface.co/chat/api/mcp/servers returns two base " +
        "MCP servers: 'Web Search (Exa)' (https://mcp.exa.ai/mcp?tools=web_search_exa,...) and 'Hugging Face' " +
        "(https://hf.co/mcp?login). Enabled server names are attached to every send via " +
        "selectedMcpServerNames/selectedMcpServers fields in the multipart POST body " +
        "(CAPABILITIES.md §7, manifest.json; verified from SSR data-sveltekit-fetched payloads). Cookie-gated " +
        "same-origin REST — same auth constraint; capture a live session to enable direct-REST.",
    };
  }

  private fail(capability: string, e: unknown): HuggingChatCapabilityResult {
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

// Let the SPA settle past domcontentloaded; HuggingChat's SvelteKit shell
// hydrates after initial load — the composer and sidebar render post-hydration.
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
