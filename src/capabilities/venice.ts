// Venice capability runner — exposes venice.ai's JS-visible surface as typed
// callable capabilities over the SAME browser + session machinery as ChatDriver.
//
// Capability dispatch:
//   venice_chat               -> ChatDriver UI path (proven pattern; drives the
//                                site's own /chat/v2 composer. NOTE: the venice
//                                profile selectors are UNVERIFIED candidate
//                                guesses — confirm on first live capture)
//   venice_list_conversations -> sidebar DOM on the live page, with an honest
//                                rpcNote: the true wire API is plain REST + SSE
//                                on api.venice.ai/api/v1 (OpenAI-compatible
//                                /chat/completions), but the logged-in web
//                                session's cookie 'session' -> session-minted
//                                bearer transform is UNVERIFIED (chat-app
//                                chunks are lazy-loaded, absent from the landing
//                                bundle graph), so no direct-REST call is built.
//   venice_model_list         -> NOT built from the DOM: capabilities/venice/
//                                profile.json carries no model-picker selectors,
//                                so an honest ok:false "selectors unverified"
//                                is returned instead of guessing a catalog.
//   venice_image / venice_video / venice_audio -> grounded REST media
//                                capabilities (POST /api/v1/image/generate
//                                flux-2-pro, /video/queue
//                                veo3-full-text-to-video, /audio/queue
//                                stable-audio-25) returned as honest ok:false —
//                                executable only via direct REST with a Bearer
//                                API key, but the runner's own auth path is the
//                                web session's cookie 'session' -> token-mint
//                                bearer hop, UNVERIFIED, and no VENICE_API_KEY
//                                is provisioned here; not runnable until a live
//                                capture confirms the auth flow.
//
// TRANSPORT GROUND TRUTH (CAPABILITIES.md / manifest.json, landing-bundle
// analysis 2026-09-16 — VERIFIED):
//   - REST base https://api.venice.ai/api/v1, plain REST over HTTPS (no
//     protobuf/RPC/WS), OpenAI-compatible chat completions with SSE streaming
//     implied by the OpenAI contract (raw stream:true not observed in these
//     bundles — inferred, to-verify).
//   - Endpoints: /chat/completions (model + messages + venice_parameters
//     {enable_web_search:'auto', enable_web_citations:true}), /image/generate
//     (flux-2-pro), /video/queue (veo3-full-text-to-video), /audio/queue
//     (stable-audio-25). Media host https://media.venice.ai.
//   - Public API auth: Authorization: Bearer <api-key> (VERIFIED).
//   - Web-session auth (TO-VERIFY): cookie 'session' (provider-catalog
//     venice-web); the exact token-mint/bearer the logged-in chat canvas sends
//     is NOT in these bundles — confirm on first live capture.
//   - No bot wall: plain curl UA returned the full SSR HTML; landing has no
//     Cloudflare email/challenge wall (curl-friendly). Web chat may harden
//     behind the session — keep driving the site's own UI.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface VeniceCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface VeniceCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Wire-truth note — what the real REST surface offers vs what this run did. */
  wireNote?: string;
}

// Grounded from CAPABILITIES.md §1–§8 (landing-bundle analysis): the REST base,
// four endpoints, request bodies and Bearer-key scheme are VERIFIED; the
// logged-in cookie->token-mint is NOT, so no direct-REST capability is shipped.
const WIRE_NOTE =
  "wire API is plain REST + SSE at api.venice.ai/api/v1 (OpenAI-compatible /chat/completions with " +
  "venice_parameters web-search/citations; /image/generate flux-2-pro, /video/queue veo3-full-text-to-video, " +
  "/audio/queue stable-audio-25) — verified from landing bundles with Bearer API-key auth. The logged-in web " +
  "session's cookie 'session' -> session-minted bearer flow is UNVERIFIED (chat-app chunks lazy-loaded), so no " +
  "direct-REST capability is built yet — every current capability drives the site's own UI; re-check on first " +
  "live capture.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class VeniceCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: VeniceCapabilityOptions = {}) {
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

  async run(capability: string, args: Record<string, unknown> = {}): Promise<VeniceCapabilityResult> {
    const base = { wireNote: WIRE_NOTE };
    switch (capability) {
      case "venice_chat":
        return { ...base, ...(await this.chat(args)) };
      case "venice_list_conversations":
        return { ...base, ...(await this.listConversations(args)) };
      case "venice_model_list":
        return { ...base, ...this.modelList() };
      case "venice_image":
        return { ...base, ...this.imageGenerate() };
      case "venice_video":
        return { ...base, ...this.videoGenerate() };
      case "venice_audio":
        return { ...base, ...this.audioGenerate() };
      default:
        return { capability, ok: false, data: undefined, error: `unknown venice capability: ${capability}`, ...base };
    }
  }

  // --- venice_chat: the UI path (the /chat/v2 composer, driven by the site's
  // own JS). The direct REST path (/chat/completions) is NOT built: the
  // session cookie -> token-mint bearer flow is unverified — UI path only
  // until first live capture. Selectors are unverified candidates per
  // profile.json note — confirm on first live capture.
  private async chat(args: Record<string, unknown>): Promise<VeniceCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("venice_chat", "prompt is required");
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
        capability: "venice_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
        // honest wire note — the direct chip exists but is gated on an
        // unverified session-mint; the UI path is the only built route.
        wireNote:
          "direct REST api.venice.ai/api/v1/chat/completions (OpenAI-compatible, venice_parameters " +
          "web-search/citations) exists but the session cookie -> token-mint bearer flow is unverified — " +
          "UI path only until first live capture",
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- venice_list_conversations: sidebar DOM on the live page ---
  // The production wire API (api.venice.ai/api/v1, OpenAI-compatible) needs the
  // session cookie -> session-minted bearer transform, which is UNVERIFIED
  // (chat-app chunks are lazy-loaded, absent from the landing bundle graph).
  // Without a live capture, a direct REST conversation-list call would be
  // fabrication — so the pointer is the page's own sidebar DOM, which always
  // reflects the current logged-in session.
  private async listConversations(args: Record<string, unknown>): Promise<VeniceCapabilityResult> {
    const page = await this.openPage();
    await waitForDomain(page, 3000);
    const query = String(args.query ?? "").trim();
    const rpcNote =
      "wire API is plain REST at api.venice.ai/api/v1 (OpenAI-compatible /chat/completions; a dedicated " +
      "conversation-history/list endpoint is not confirmed from the landing bundles) driven by the logged-in " +
      "web session's cookie 'session' -> token-mint bearer — that flow is unverified, so the DOM sidebar " +
      "reflects the current session" +
      (query ? "; query filter not available on the DOM path — full list returned" : "");
    try {
      // unverified — conversation links on the live sidebar. Route /chat/v2 is
      // confirmed from SSR nav, but the exact sidebar DOM classes are not —
      // confirm on first live capture. nav-chrome static routes are excluded.
      const dom = await page.evaluate(() => {
        const nav = new Set(["/chat", "/chat/v2"]);
        const out: Array<{ id: string; title: string }> = [];
        for (const a of document.querySelectorAll("a[href*='/chat/']")) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const path = href.split(/[?#]/)[0];
          if (!path.startsWith("/chat/")) continue;
          const id = path.replace(/^\/chat\/?/, "");
          if (!id || nav.has(path)) continue;
          const text = ((a as HTMLElement).innerText || "").trim();
          if (!out.some((x) => x.id === id)) out.push({ id, title: text || id });
        }
        return out.slice(0, 20);
      });
      return {
        capability: "venice_list_conversations",
        ok: true,
        method: "dom.sidebar",
        data: { conversations: dom, via: "dom.sidebar", rpcNote },
      };
    } catch (e) {
      return this.fail("venice_list_conversations", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- venice_model_list: NOT DOM-readable from the current profile ---
  // capabilities/venice/profile.json carries only composer/answer selectors —
  // no model-picker DOM candidate — and the logged-in model catalog lives in
  // the lazy-loaded chat-app chunks (absent from the landing bundle graph).
  // Guessing a catalog or picker classes would be fabrication, so this is an
  // honest ok:false until a live capture grounds the picker DOM.
  private modelList(): VeniceCapabilityResult {
    return {
      capability: "venice_model_list",
      ok: false,
      method: "dom.picker",
      data: undefined,
      error:
        "model picker selectors unverified — capabilities/venice/profile.json has no model-picker DOM " +
        "candidate (only composer/answer selectors), and the logged-in /chat/v2 catalog is a lazy chunk " +
        "absent from the landing bundle graph; confirm the picker DOM on first live capture",
    };
  }

  // --- venice_image / venice_video / venice_audio: grounded REST media
  // capabilities that this runner cannot execute yet ---
  // Ground truth (recipes + verified landing bundles): direct REST POSTs on
  // api.venice.ai/api/v1 — /image/generate {model:'flux-2-pro', prompt, width,
  // height}, /video/queue {model:'veo3-full-text-to-video', prompt},
  // /audio/queue {model:'stable-audio-25', prompt} — with Bearer API-key auth.
  // They are not executable from THIS runner: its auth path is the web
  // session's cookie 'session' -> token-mint bearer hop, which is UNVERIFIED
  // (chat-app chunks lazy-loaded), and no VENICE_API_KEY is provisioned here.
  // Honest ok:false rather than fabricating a call until first live capture.
  private imageGenerate(): VeniceCapabilityResult {
    return {
      capability: "venice_image",
      ok: false,
      method: "api-path (POST /api/v1/image/generate)",
      data: undefined,
      error:
        "not executable yet — ground truth: POST https://api.venice.ai/api/v1/image/generate with " +
        "{model:'flux-2-pro', prompt, width, height} + Bearer API key " +
        "(recipes/venice_image.json, endpoint/body verified from landing bundles). The runner's auth path is " +
        "the web session's cookie 'session' -> token-mint bearer hop, which is UNVERIFIED, and no " +
        "VENICE_API_KEY is provisioned in the runner; confirm the auth flow on first live capture",
    };
  }

  private videoGenerate(): VeniceCapabilityResult {
    return {
      capability: "venice_video",
      ok: false,
      method: "api-path (POST /api/v1/video/queue)",
      data: undefined,
      error:
        "not executable yet — ground truth: POST https://api.venice.ai/api/v1/video/queue with " +
        "{model:'veo3-full-text-to-video', prompt} + Bearer API key " +
        "(recipes/venice_video.json, endpoint/body verified from landing bundles; async queue, poll/download " +
        "endpoints to-verify). The runner's auth path is the web session's cookie 'session' -> token-mint " +
        "bearer hop, which is UNVERIFIED, and no VENICE_API_KEY is provisioned in the runner; confirm the " +
        "auth flow on first live capture",
    };
  }

  private audioGenerate(): VeniceCapabilityResult {
    return {
      capability: "venice_audio",
      ok: false,
      method: "api-path (POST /api/v1/audio/queue)",
      data: undefined,
      error:
        "not executable yet — ground truth: POST https://api.venice.ai/api/v1/audio/queue with " +
        "{model:'stable-audio-25', prompt} + Bearer API key " +
        "(recipes/venice_audio.json, endpoint/body verified from landing bundles; async queue, poll/download " +
        "endpoints to-verify). The runner's auth path is the web session's cookie 'session' -> token-mint " +
        "bearer hop, which is UNVERIFIED, and no VENICE_API_KEY is provisioned in the runner; confirm the " +
        "auth flow on first live capture",
    };
  }

  private fail(capability: string, e: unknown): VeniceCapabilityResult {
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

// Let the SPA settle past domcontentloaded; Venice's sidebar renders after
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