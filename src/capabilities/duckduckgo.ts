// Duckduckgo capability runner — the LIVE, honest reporter for DuckDuckGo AI
// Chat (duck.ai). This package is ANONYMOUS-capable (manifest auth.anonymous,
// profile loginRequired:false): NO session capture is needed for chat, so this
// runner NEVER short-circuits to login-gated (that would be a fabricated
// excuse for an anonymous site). Each capability is dispatched through its
// real implementation where proven, and honestly reports the measured blocker
// otherwise (GOAL 13, fold #19, 2026-09-22 — before this fold the whole
// surface was wrongly gated as login-required).
//
// Capability dispatch:
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
//   duckduckgo_model_picker  -> live DOM read of the model-picker trigger
//                                ("5.6 Luna" chip) + its panel labels.
//   duckduckgo_web_search    -> honest-unverified: the composer toolbar Web
//                                Search toggle has hashed module CSS; toggling
//                                rides metadata.toolChoice.WebSearch on the
//                                chat POST — needs a live-proven DOM path
//                                before implementation (never a synthesized
//                                request).
//   duckduckgo_file_upload   -> honest-unverified: composer attach UI
//                                unproven; uploads ride the chat POST content
//                                parts.
//   duckduckgo_reasoning     -> honest-unverified: reasoning-mode toggle DOM
//                                unproven (reasoningEffort rides the chat POST).
//   duckduckgo_chat_history  -> honest-unverified: chat history lives in
//                                IndexedDB / DDG-account sync; no proven
//                                sidebar-anchor read on the current UI.
//
// Anti-bot: no Cloudflare wall on the page (CAPABILITIES.md §8); the chat POST
// may raise ERR_CHALLENGE under abuse signals — the site's OWN JS handles the
// VQD canvas fingerprint challenge inside the page, so driving the UI is the
// only posture that keeps anonymous chat working (same principle as the
// signed-in sites: never send a request the page didn't make itself).
import { launchBrowser } from "../runtime/browser.js";
import { makeDomPrimitives } from "../runtime/dom-primitives.js";
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
  return process.env.UI2API_HEADED !== "1";
}

/** The side-chat consent wall's agree button (live-verified 2026-09-22). */
const CONSENT_WALL_BUTTON = "button:has-text('Continue')";

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
        return {
          capability,
          ok: false,
          data: undefined,
          error:
            "duckduckgo_web_search: the composer toolbar Web Search toggle (metadata.toolChoice.WebSearch " +
            "on the chat POST) has hashed module-scoped CSS — its DOM path is UNVERIFIED (live probing " +
            "2026-09-22); toggling is never synthesized, so this stays honest-unverified until a live " +
            "round-trip proves the toggle",
        };
      case "duckduckgo_file_upload":
        return {
          capability,
          ok: false,
          data: undefined,
          error:
            "duckduckgo_file_upload: the composer attach UI (file input) is UNVERIFIED — uploads ride the " +
            "chat POST content parts ({type:'file', content: base64,...}); needs a live-proven attach path " +
            "before implementation (never a synthesized upload)",
        };
      case "duckduckgo_reasoning":
        return {
          capability,
          ok: false,
          data: undefined,
          error:
            "duckduckgo_reasoning: the reasoning-mode toggle DOM (reasoningEffort on the chat POST: " +
            "fast/reasoning/extended) is UNVERIFIED — the composer control's selector is unknown; stays " +
            "honest-unverified until a live round-trip proves the toggle",
        };
      case "duckduckgo_chat_history":
        return {
          capability,
          ok: false,
          data: undefined,
          error:
            "duckduckgo_chat_history: chat history lives in IndexedDB (anonymous, device-local) or DDG-account " +
            "sync — the current UI has no proven sidebar-anchor read path (2026-09-22 probing); stays " +
            "honest-unverified until a live round-trip proves a read surface",
        };
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

  // --- duckduckgo_model_picker: live DOM read of the model chip + panel ---
  // The composer shows the active model ("5.6 Luna") and opens a panel with the
  // DUCKCHAT_MODEL_PICKER_LABEL list; the model catalog itself is embedded in
  // the JS bundle (CAPABILITIES.md §1). DOM read is the honest live surface.
  private async modelPicker(): Promise<DuckduckgoCapabilityResult> {
    const page = await this.openPage();
    const t0 = Date.now();
    try {
      await page.waitForSelector("[aria-label*='model' i], [class*='model']", { timeout: 15000 }).catch(() => {});
      const picked = await page.evaluate(() => {
        const buts = Array.from(
          document.querySelectorAll<HTMLElement>("[aria-label*='Model'], [class*='model-picker'], [class*='model-selector']")
        );
        const labels = buts.map((b) => (b.innerText || "").trim()).filter(Boolean);
        return labels.slice(0, 8);
      });
      if (picked.length === 0) {
        return {
          capability: "duckduckgo_model_picker",
          ok: false,
          method: "dom.model-picker",
          latencyMs: Date.now() - t0,
          data: undefined,
          error:
            "model picker rendered no label on this load (hydration timing or the chip needs composer focus) — " +
            "retry; the model catalog is embedded in the JS bundle (CAPABILITIES.md §1), a DOM read is the honest surface",
        };
      }
      return {
        capability: "duckduckgo_model_picker",
        ok: true,
        method: "dom.model-picker",
        latencyMs: Date.now() - t0,
        data: { pickerLabels: picked },
        note: "model catalog is embedded in the JS bundle; DOM read reflects the current picker chip",
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