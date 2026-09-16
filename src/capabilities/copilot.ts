// Microsoft Copilot capability runner — exposes copilot.microsoft.com's
// JS-visible surface as typed callable capabilities over the SAME browser +
// session machinery as ChatDriver.
//
// Capability dispatch:
//   copilot_chat          -> ChatDriver UI path (proven pattern; the composer
//                            <textarea id="userInput"> + Enter drives the site's
//                            own send handler). Underlying wire = WebSocket
//                            wss://copilot.microsoft.com/c/api/chat.
//   copilot_search_mode   -> honest not-yet-live stub: composer chat mode 'cs'
//                            (Bing/grounded search, citation inbound events) —
//                            mode map VERIFIED from bundles, but the UI-mode
//                            toggle DOM is UNVERIFIED (SSR confirms only
//                            composer DOM) — ok:false until confirmed live.
//   copilot_thinking_mode -> honest not-yet-live stub: composer chat mode 'td'
//                            (Think deeper / reasoning, chainOfThought inbound
//                            events) — same gap: mode map VERIFIED, toggle DOM
//                            UNVERIFIED — ok:false until confirmed live.
//   copilot_history       -> honest not-yet-live stub: REST /c/api/conversations
//                            CRUD + /conversations/{id}/history?api-version=2,
//                            autotitle via titleUpdate — inventory-proven, but
//                            anonymous REST-call availability (header/session
//                            requirements) is TO-VERIFY live — no synthetic
//                            fetch layer, ok:false.
//   copilot_image_gen     -> honest not-yet-live stub: image gen rides the chat
//                            socket (generatingImage/imageGenerated inbound)
//                            with the /imagine gallery + Bing Image Creator
//                            pipeline — pipeline verified, endpoint + gallery
//                            DOM to-confirm-live; a raw WS client is not built,
//                            ok:false.
//
// ANTI-BOT POSTURE (from CAPABILITIES.md §5 — every call must remember it):
//   Cloudflare Turnstile (in-band `challenge` WS event -> {event:
//   'challengeResponse', method:'cloudflare'}) + hashcash SHA-256 proof-of-work
//   (hashcash.worker). First socket connect on a clean-IP headless context is
//   EXPECTED to be gated by a challenge; the client blocks sends until the
//   in-stream challenge is answered. The anonymous path needs a temporary
//   session key (POST /c/api/user/sessions/temporary -> sessionKey, TTL 6h) sent
//   as the socket `temporarySessionKey` query param + X-Copilot-TemporarySessionKey
//   header. Static curl passed with a Chrome UA (full SSR HTML, no HTML-layer
//   wall), but the live socket handshake outcome is the main open risk.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface CopilotCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface CopilotCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Wire-truth note — what the real WS/REST surface offers vs what this run did. */
  wireNote?: string;
  /** Anti-bot posture note — Turnstile + hashcash PoW on the socket. */
  stealth?: string;
}

// Grounded from CAPABILITIES.md §1–§5 (landing-bundle analysis 2026-09-16): the
// WebSocket transport, event protocol, anonymous temp-session endpoint and the
// Turnstile + hashcash anti-bot stack are VERIFIED from static bundles; the
// live socket handshake + challenge outcome are TO-CONFIRM-LIVE.
const WIRE_NOTE =
  "wire transport is WebSocket wss://copilot.microsoft.com/c/api/chat?api-version=2 (out " +
  "{event:'send',content:[...],mode:'chat'|'research'}; in startMessage/appendText/replaceText/.../done, " +
  "citation + chainOfThought + titleUpdate; in-band 'challenge' event) — verified in landing bundles. " +
  "Anonymous flow: POST /c/api/user/sessions/temporary -> sessionKey (TTL 6h) sent as socket " +
  "temporarySessionKey + X-Copilot-TemporarySessionKey header. Cloudflare Turnstile + hashcash PoW may " +
  "gate the first socket connect — confirm on first live capture."

const STEALTH_NOTE =
  "the socket is gated by an anti-bot stack: Cloudflare Turnstile (in-band 'challenge' WS event answered " +
  "with {event:'challengeResponse',method:'cloudflare'}) + hashcash SHA-256 proof-of-work (WebCrypto " +
  "worker; leading-zero difficulty check), plus motion/analytics fingerprinting (Clarity, 1DS, Bing UET). " +
  "A clean-IP headless context is expected to receive a challenge on the first socket connect; static curl " +
  "with a Chrome UA passes the HTML layer. The steering rule is the same as hunyuan: drive the site's own " +
  "UI; no synthetic fetch/WS layer."

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class CopilotCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: CopilotCapabilityOptions = {}) {
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

  async run(capability: string, args: Record<string, unknown> = {}): Promise<CopilotCapabilityResult> {
    const base = { wireNote: WIRE_NOTE, stealth: STEALTH_NOTE };
    switch (capability) {
      case "copilot_chat":
        return { ...base, ...(await this.chat(args)) };
      case "copilot_search_mode":
        return { ...base, ...this.searchMode() };
      case "copilot_thinking_mode":
        return { ...base, ...this.thinkingMode() };
      case "copilot_history":
        return { ...base, ...this.history() };
      case "copilot_image_gen":
        return { ...base, ...this.imageGen() };
      default:
        return { capability, ok: false, data: undefined, error: `unknown copilot capability: ${capability}`, ...base };
    }
  }

  // --- copilot_chat: the UI path (the composer #userInput + Enter drives the
  // site's own JS send handler -> the page's WS client to /c/api/chat). The
  // direct WS path is NOT built: the in-band Turnstile/hashcash challenge
  // handshake is verified only from static bundles, so the UI path is the only
  // built route until first live capture.
  private async chat(args: Record<string, unknown>): Promise<CopilotCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("copilot_chat", "prompt is required");
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
        capability: "copilot_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
        // honest wire note — the WS /c/api/chat surface is bundle-verified, but
        // the anonymous temp-session + Turnstile/PoW handshake may gate the
        // first send; confirm on first live capture.
        wireNote:
          "underlying wire is WebSocket wss://copilot.microsoft.com/c/api/chat?api-version=2 — bundle-verified " +
          "(out {event:'send',content:[...],mode:'chat'}, in appendText/replaceText until done). Anonymous " +
          "temp-session (POST /c/api/user/sessions/temporary -> sessionKey, TTL 6h) + Cloudflare Turnstile / " +
          "hashcash PoW may gate the first send — the UI path lets the page answer any in-band 'challenge'; " +
          "confirm the challenge outcome on first live capture",
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- copilot_search_mode: honest not-yet-live stub ---
  // Ground truth (bundles): composer chat mode key 'cs' -> Bing-grounded search
  // (answers with `citation` inbound events, bing.com host); full mode map
  // VERIFIED. NOT executable yet: the composer's UI-mode toggle (think-deeper /
  // search / study selector) DOM is UNVERIFIED — CAPABILITIES.md §7 lists answer/
  // composer DOM as the open item, and SSR confirms ONLY the composer (#userInput,
  // data-testid="composer-input"). Fabricating a toggle would break on first live
  // capture — confirm the exact mode-switch DOM on a live session first.
  private searchMode(): CopilotCapabilityResult {
    return {
      capability: "copilot_search_mode",
      ok: false,
      method: "ui-mode toggle (wire mode map: 'cs' -> search)",
      data: undefined,
      error:
        "Search mode (Bing grounding) is composer chat mode 'cs' — wire mode map VERIFIED from bundles " +
        "(answers carry `citation` inbound events, bing.com host). NOT executable yet: the composer " +
        "UI-mode toggle DOM (think-deeper / search / study selector) is UNVERIFIED — SSR confirms only " +
        "the composer (#userInput), and the mode-select DOM is an open item from CAPABILITIES.md §7. " +
        "Confirm the exact toggle selector on a first live capture to activate.",
    };
  }

  // --- copilot_thinking_mode: honest not-yet-live stub ---
  // Ground truth (bundles): composer chat mode key 'td' -> reasoning / "Think
  // deeper" (chainOfThought inbound events); mode map VERIFIED. Same gap as
  // search mode: the mode-toggle DOM is UNVERIFIED — ok:false until confirmed.
  private thinkingMode(): CopilotCapabilityResult {
    return {
      capability: "copilot_thinking_mode",
      ok: false,
      method: "ui-mode toggle (wire mode map: 'td' -> reasoning)",
      data: undefined,
      error:
        "Think-deeper (reasoning) mode is composer chat mode 'td' — wire mode map VERIFIED from bundles " +
        "(reasoning tokens arrive as `chainOfThought` inbound events before the final text). NOT " +
        "executable yet: the composer UI-mode toggle DOM is UNVERIFIED — SSR confirms only the composer " +
        "(#userInput), and the mode-select DOM is an open item from CAPABILITIES.md §7. Confirm the exact " +
        "toggle selector on a first live capture to activate.",
    };
  }

  // --- copilot_history: honest not-yet-live stub ---
  // Ground truth (bundles): REST base https://copilot.microsoft.com/c/api with
  // /conversations CRUD + /conversations/{id}/history?api-version=2 (autotitle
  // via inbound titleUpdate events). NOT executable yet: authenticated reads use
  // Authorization Bearer (MSAL access_token in the header), and anonymous-session
  // REST-call availability (exact header set, incl. X-Copilot-TemporarySessionKey)
  // is TO-VERIFY on a live session. CAPABILITIES.md §7 lists anonymous REST CRUD
  // availability as an open item — no synthetic fetch layer until confirmed.
  private history(): CopilotCapabilityResult {
    return {
      capability: "copilot_history",
      ok: false,
      method: "in-page REST (/c/api/conversations CRUD + history?api-version=2)",
      data: undefined,
      error:
        "Conversation history is REST on https://copilot.microsoft.com/c/api — /conversations CRUD + " +
        "/conversations/{id}/history?api-version=2, titles via inbound `titleUpdate` events — inventory " +
        "VERIFIED from bundles. NOT executable yet: the authenticated path needs an MSAL access_token " +
        "as Authorization Bearer, and anonymous temp-session REST-call availability (header set incl. " +
        "X-Copilot-TemporarySessionKey) is TO-VERIFY on a live session (CAPABILITIES.md §7). Confirm the " +
        "anonymous/authed REST call shape on a first live capture, then wire it.",
    };
  }

  // --- copilot_image_gen: honest not-yet-live stub ---
  // Ground truth (bundles): image generation (Imagine) rides the SAME chat
  // socket — /imagine route + in-band generatingImage / partialImageGenerated /
  // imageGenerated / imageGeneratedFailed events — Bing Image Creator pipeline.
  // NOT executable yet: it needs the in-band WS path (a raw socket client, whose
  // challenge handshake is TO-CONFIRM-LIVE) plus the /imagine gallery DOM —
  // CAPABILITIES.md §7 pins the image endpoint as to-confirm-live. No fabricated
  // call is built until a first live capture grounds the pipeline.
  private imageGen(): CopilotCapabilityResult {
    return {
      capability: "copilot_image_gen",
      ok: false,
      method: "ui-path + in-band WS events (/imagine, generatingImage...imageGenerated)",
      data: undefined,
      error:
        "Image generation (Imagine) rides the chat socket: /imagine route + in-band `generatingImage` / " +
        "`partialImageGenerated` / `imageGenerated` / `imageGenerationFailed` events over the Bing Image " +
        "Creator pipeline — pipeline VERIFIED from bundles, but the image endpoint and the /imagine " +
        "gallery DOM are TO-CONFIRM-LIVE (CAPABILITIES.md §7), and executing it requires the in-band WS " +
        "path whose Turnstile/hashcash challenge handshake is unverified. Confirm the live pipeline on a " +
        "first capture before building a call.",
    };
  }

  private fail(capability: string, e: unknown): CopilotCapabilityResult {
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

// Let the SPA settle past domcontentloaded; Copilot's answer DOM renders after
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