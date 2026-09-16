// Claude (claude.ai) capability runner — exposes claude.ai's JS-visible surface
// as typed callable capabilities over the SAME browser + session machinery as
// ChatDriver.
//
// Capability dispatch:
//   claude_chat               -> ChatDriver UI path (proven selectors; the site's
//                                own JS drives the SSE message stream)
//   claude_list_conversations -> sidebar DOM on the live page FIRST, with an
//                                honest rpcNote: the real wire API is
//                                GET/PUT /api/organizations/{org}/chat_conversations/
//                                {conv} (cookie-session auth via sessionKey,
//                                credentials:include, anthropic-version header)
//                                and is future work pending a signed-in capture —
//                                never half-implemented here.
//   claude_extended_thinking  -> honest best-effort ONLY: the profile has no
//                                grounded "thinking" toggle selector, so this is
//                                ok:false with the reasoning spelled out. Flag
//                                exists in bundles (extended_thinking in
//                                b-shared-0/b-shared-13) but no UI affordance is
//                                verified — no fabricated selectors.
//   claude_artifacts / claude_web_search -> honest ok:false + note: flag present
//                                in bundles; UI selector unverified.
//
// NOT built: claude_chat_direct / any wire capability. The REST surface
// (/api/organizations/{org}/chat_conversations/{conv}, queued_message poll,
// debug_block SSE, dust/chat_continuations, mcp/probe) is documented from bundle
// analysis but the session mechanics are UNVERIFIED: claude.ai is Cloudflare + hCaptcha
// gated, the credential cookie is `sessionKey` (name from provider-catalog.md, not
// raw bundle strings), AND the literal message-send call was NOT found in the harvested
// chunks — expected to live in a lazy route chunk (classic build used
// POST …/chat_conversations/{conv}/completion, but that literal string is absent here).
// Encoding a send payload without observing the UI's own would be fabrication.
// Driving the site's own send handler via ChatDriver is the only honest path until a
// live network log lands (§5 of CAPABILITIES.md).
//
// Bot-wall facts (CAPABILITIES.md 2026-09-16 bundle analysis, 22 bundles ~4.2MB):
//   - claude.ai returns a Cloudflare "Just a moment…" challenge to plain curl;
//     the DOM session must come from a headed live capture that solved it.
//   - hCaptcha invisible attestation (js.hcaptcha.com) feeds an
//     `X-Device-Attestation` header on sensitive SSE streams.
//   - All app fetches run `credentials: include` (cookie sessionKey) with header
//     `anthropic-version: 2023-06-01`; SSE is resumable via resume_token.
//   - Strongest GROUNDED selectors (from bundles): composer .ProseMirror
//     (b-shared-3/b-shared-15) and answer [data-testid="assistant-message"]
//     (b-shared-7/b-shared-msg-1/b-shared-common-msg-1).
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import { ChatDriver } from "../prompt/driver.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface ClaudeCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
}

export interface ClaudeCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Cloudflare/hCaptcha posture note — headed live capture only, no synthetic fetch layer. */
  gate?: string;
}

const GATE_NOTE =
  "claude.ai is Cloudflare + hCaptcha-gated — the DOM session must come from a headed live capture " +
  "(cookie sessionKey per provider-catalog.md claude-web entry); all app fetches run credentials:include " +
  "with anthropic-version: 2023-06-01 and no synthetic fetch layer is used. Drive the site's own UI; " +
  "the send wire lives in a lazy route chunk and is unverified for this build.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class ClaudeCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: ClaudeCapabilityOptions = {}) {
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
  // page. NOTE: claude.ai is Cloudflare/hCaptcha-gated — a real, headed profile
  // (`usingUserChrome()`, UI2API_USER_DATA_DIR) that already solved the challenge
  // is the supported path; snapshot/cookie injection is kept for parity but the
  // headed caveat stands.
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

  async run(capability: string, args: Record<string, unknown> = {}): Promise<ClaudeCapabilityResult> {
    const base = { gate: GATE_NOTE };
    switch (capability) {
      case "claude_chat":
        return { ...base, ...(await this.chat(args)) };
      case "claude_list_conversations":
        return { ...base, ...(await this.listConversations(args)) };
      case "claude_extended_thinking":
        return { ...base, ...(await this.extendedThinking(args)) };
      case "claude_artifacts":
        return { ...base, ...(await this.artifacts(args)) };
      case "claude_web_search":
        return { ...base, ...(await this.webSearch(args)) };
      default:
        return { capability, ok: false, data: undefined, error: `unknown claude capability: ${capability}`, ...base };
    }
  }

  // --- claude_chat: the UI path (the ProseMirror composer -> the site's own SSE
  // send handler, all owned by the site's own JS) ---
  // Grounded selectors (from bundle analysis): composer .ProseMirror +
  // contenteditable (b-shared-3/b-shared-15), answer [data-testid="assistant-message"]
  // (b-shared-7/b-shared-msg-1/b-shared-common-msg-1). The remaining profile
  // candidates — [data-testid="prompt-editor"], .font-claude-message,
  // .whitespace-pre-wrap — are built-in-profile ground truth but were NOT found
  // literally in the minified bundles (runtime/template-injected, unverified);
  // ChatDriver tries them as fallbacks and they must be confirmed on first live capture.
  private async chat(args: Record<string, unknown>): Promise<ClaudeCapabilityResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) return this.fail("claude_chat", "prompt is required");
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
        capability: "claude_chat",
        ok: true,
        data: { answer: r.answer, chunkCount: r.chunkCount, doneReason: r.doneReason, url: r.url, title: r.title },
      };
    } finally {
      // Only tear down what we own; an externally-supplied browser (pool) stays.
      if (this.ownsBrowser) await driver.close().catch(() => {});
    }
  }

  // --- claude_list_conversations: sidebar DOM on the live page FIRST, honest
  // rpcNote ---
  // The production API (GET/PUT …/api/organizations/{org}/chat_conversations/{conv},
  // +?rendering_mode=raw; GET …/queued_message poll) needs the sessionKey cookie
  // session, the Cloudflare/hCaptcha-cleared posture, and an orgUuid from the
  // account — all UNVERIFIED until a headed live capture. Per the bot-wall rule,
  // the pointer is the page's own sidebar DOM, which always reflects the current
  // logged-in session. The message-send endpoint (absent from the bundles — lazy
  // route chunk) is future work to verify on the first live network log.
  private async listConversations(args: Record<string, unknown>): Promise<ClaudeCapabilityResult> {
    // unverified — conversation links on the live sidebar; both route shapes
    // (/chat/<uuid> and /conversation/<uuid>) are covered, but actual hrefs must
    // be confirmed on first live capture.
    const page = await this.openPage();
    await waitForDomain(page, 3000);
    const query = String(args.query ?? "").trim();
    const rpcNote =
      "wire API (GET/PUT /api/organizations/{org}/chat_conversations/{conv}, +?rendering_mode=raw; " +
      "GET …/queued_message poll) is future work pending a live, headed session capture — it requires " +
      "the sessionKey cookie session past the Cloudflare/hCaptcha gate and the orgUuid; the message-send " +
      "endpoint is in a lazy route chunk absent from the harvested bundles — record it from the first " +
      "live network log. DOM sidebar reflects the current session" +
      (query ? "; query filter not available on the DOM path — full list returned" : "");
    try {
      const dom = await page.evaluate(() => {
        const out: Array<{ id: string; title: string }> = [];
        const seen = new Set<string>();
        for (const a of document.querySelectorAll("a[href*='/chat/'], a[href*='/conversation/']")) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const m = href.match(/^\/(?:chat|conversation)\/([^?#\s]+)/);
          if (!m) continue;
          const id = m[1];
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const text = ((a as HTMLElement).innerText || "").trim();
          out.push({ id, title: text || id });
        }
        return out.slice(0, 20);
      });
      return {
        capability: "claude_list_conversations",
        ok: true,
        method: "dom.sidebar",
        data: { conversations: dom, via: "dom.sidebar", rpcNote },
      };
    } catch (e) {
      return this.fail("claude_list_conversations", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- claude_extended_thinking: honest best-effort ONLY ---
  // The extended_thinking flag exists in the bundles (b-shared-0/b-shared-13),
  // but profile.json carries NO "thinking" toggle selector, so there is nothing
  // grounded to drive. Returning ok:false with the reasoning, never a fabricated
  // selector. Revisit when a live capture names the toggle.
  private async extendedThinking(_args: Record<string, unknown>): Promise<ClaudeCapabilityResult> {
    return {
      capability: "claude_extended_thinking",
      ok: false,
      data: undefined,
      error:
        "extended_thinking flag confirmed in bundles (b-shared-0/b-shared-13) but the profile has no " +
        "grounded 'thinking' toggle selector — no fabricated selectors. Once a live capture names the UI " +
        "affordance (composer toggle or the send payload's flag), this can be driven; request-level mapping " +
        "is unverified for this build.",
    };
  }

  // --- claude_artifacts: honest ok:false ---
  // Artifacts/CCR sandbox surface exists in bundles (anthropic.claude.usercontent.sandbox.
  // ClaudeCompletionRequest/Response) but there is no verified UI toggle selector.
  // No fabrication until a live capture grounds it.
  private async artifacts(_args: Record<string, unknown>): Promise<ClaudeCapabilityResult> {
    return {
      capability: "claude_artifacts",
      ok: false,
      data: undefined,
      error:
        "artifacts flag exists in bundles (CCR sandbox types) but the UI selector is unverified — " +
        "no fabricated selectors; revisit on a live capture.",
    };
  }

  // --- claude_web_search: honest ok:false ---
  // web_search tool references are in the bundles (b-shared-0 et al.) but no
  // toggle selector or request-level mapping is verified. No fabrication.
  private async webSearch(_args: Record<string, unknown>): Promise<ClaudeCapabilityResult> {
    return {
      capability: "claude_web_search",
      ok: false,
      data: undefined,
      error:
        "web_search flag exists in bundles (b-shared-0 et al.) but the UI selector is unverified — " +
        "no fabricated selectors; revisit on a live capture.",
    };
  }

  private fail(capability: string, e: unknown): ClaudeCapabilityResult {
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

// Let the SPA settle past domcontentloaded; claude.ai's sidebar renders after
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