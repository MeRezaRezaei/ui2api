// ChatDriver — the "use AI sites for doing prompts" engine. One instance = one
// browser page against one chat site profile. It reuses the same browser launch
// + session-cookie machinery as the rest of ui2api (real Chrome + profile when
// configured, zero-config fallback otherwise) and the same DOM primitives, so a
// prompt behaves exactly like a human typing it: paste + Enter runs the site's
// own JS, and the streamed answer is read off the page's event bus.
import { launchBrowser, loadCookies, sessionPath } from "../runtime/browser.js";
import { makeDomPrimitives, type DomPrimitives } from "../runtime/dom-primitives.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface PromptOptions {
  newChat?: boolean;
  timeoutMs?: number;
  stableMs?: number;
}

export interface PromptResult {
  answer: string;
  chunkCount: number;
  doneReason: "stable" | "timeout" | "empty";
  url: string;
  title: string;
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (truncated at ${n} chars)` : s;
}

export interface ChatDriverOptions {
  /* Reuse an externally-owned browser (the daemon pool's). When set, close()
     only tears down this driver's context+page, never the browser. */
  browser?: Browser;
  /* Use the browser's existing default context (the attached user browser's
     logged-in session) instead of a fresh incognito context. Light-mode
     image/font/media blocking is skipped: routes can only attach at context
     creation, and the user's standing browser must keep its own look. */
  defaultContext?: boolean;
  dataDir?: string;
}

export class ChatDriver {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private defaultContext: boolean;
  private page?: Page;
  private dom: DomPrimitives;
  private readonly dataDir: string;

  constructor(
    private readonly profile: ChatSiteProfile,
    { browser, defaultContext = false, dataDir = resolveDataDir() }: ChatDriverOptions = {}
  ) {
    this.dataDir = dataDir;
    this.browser = browser;
    this.ownsBrowser = !browser;
    this.defaultContext = defaultContext;
    this.dom = makeDomPrimitives(() => this.getPage());
  }

  // Bounded liveness probe for the current page. A stand-by page can die while
  // idle; a dead page must be read as a transient crash (rebuild/retry) rather
  // than a changed site UI.
  private async pageAlive(ms = 5000): Promise<boolean> {
    if (!this.page) return false;
    return Promise.race([
      this.page.evaluate(() => 1).then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  private async getPage(): Promise<Page> {
    if (this.page) {
      // A stand-by page can die (or wedge) while idle; probe it with a hard
      // bound so a corpse is rebuilt, never served as a fake "no composer".
      if (await this.pageAlive()) return this.page;
      this.page = undefined;
    }
    // A browser can die between spawn and context/page setup (CDP socket lingers
    // a moment); drop the corpse and relaunch rather than 500ing the request.
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.browser && !this.browser.isConnected()) this.browser = undefined;
      if (!this.browser) {
        this.browser = await launchBrowser(3, { headless: headlessDefault() });
        this.ownsBrowser = true;
      }
      try {
        const usingDefaultContext = this.defaultContext && this.browser.contexts().length > 0;
        const context = usingDefaultContext
          ? this.browser.contexts()[0]
          : await this.browser.newContext({ viewport: { width: lightMode() ? 1024 : 1280, height: lightMode() ? 700 : 900 } });
        // Light mode (default): drop images/fonts/media so the page loads in a
        // fraction of the memory — chat UIs are text; this keeps headless Chrome
        // alive on memory-starved hosts and cuts load time dramatically. Skipped
        // for an existing (user's-attached) context, whose look we must not change.
        if (!usingDefaultContext && lightMode()) {
          await context.route("**/*", (route) => {
            const t = route.request().resourceType();
            if (t === "image" || t === "font" || t === "media") return route.abort();
            return route.continue();
          });
        }
        // Reuse a previously captured authenticated session, if one exists.
        const host = new URL(this.profile.url).host;
        const cookies = loadCookies(sessionPath(this.dataDir, host));
        if (!usingDefaultContext && cookies.length > 0) await context.addCookies(cookies as never[]);
        this.page = await context.newPage();
        await this.page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        return this.page;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!/Target page|context or browser has been closed|Execution context was destroyed/i.test(lastErr)) throw e;
        if (this.ownsBrowser) {
          try {
            await this.browser?.close().catch(() => {});
          } catch {
            // browser already gone
          }
        }
        this.browser = undefined;
      }
    }
    throw new Error(lastErr);
  }

  async start(): Promise<void> {
    await this.getPage();
  }

  // Pick the first selector that is actually present on the page (profiles carry
  // a few candidate selectors because chat UIs rename classes constantly).
  private async firstVisible(selectors: string[]): Promise<string | null> {
    for (const sel of selectors) {
      try {
        const loc = this.page!.locator(sel).first();
        if (await loc.isVisible()) return sel;
      } catch {
        // selector syntax error or element absent — try the next candidate
      }
    }
    return null;
  }

  private async dismissOverlays(): Promise<void> {
    for (const sel of this.profile.dismiss ?? []) {
      try {
        const loc = this.page!.locator(sel).first();
        if (await loc.isVisible({ timeout: 300 })) await loc.click({ timeout: 1500 });
      } catch {
        // overlay already gone — fine
      }
    }
  }

  async ask(prompt: string, opts: PromptOptions = {}): Promise<PromptResult> {
    const text = String(prompt ?? "").trim();
    if (!text) throw new Error("prompt must not be empty");
    // Sandboxed Chromium occasionally dies mid-run on constrained hosts
    // ("Target page/context/browser has been closed"). Retry with a fresh
    // browser rather than failing the caller.
    const transient = /Target page|context or browser has been closed|Execution context was destroyed/i;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.askOnce(text, opts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (transient.test(msg) && attempt < 3) {
          await this.close();
          continue;
        }
        throw e;
      }
    }
    throw new Error("unreachable");
  }

  private async askOnce(prompt: string, opts: PromptOptions): Promise<PromptResult> {
    const text = String(prompt ?? "").trim();
    if (!text) throw new Error("prompt must not be empty");
    await this.getPage();
    if (opts.newChat && this.profile.newChat) {
      try {
        await this.dom.click(this.profile.newChat);
        await this.page!.waitForTimeout(800);
      } catch {
        // no new-chat affordance on this profile/revision — continue in-page
      }
    }
    await this.dismissOverlays();
    const composer = await this.firstVisible(this.profile.composer);
    if (!composer) {
      if (!(await this.pageAlive())) {
        // page died mid-read — retried on a fresh browser, not reported as rot
        throw new Error("page died reading the composer — Target page, context or browser has been closed");
      }
      let title = "", url = "";
      try { title = await this.page!.title(); url = await this.page!.url(); } catch { /* page gone */ }
      throw new Error(
        `no composer found on ${this.profile.id} (${this.profile.url}) — the site UI may have changed. ` +
          `Tune ${this.profile.id} in src/profile/profile.ts or ship a JSON override (--profile FILE). ` +
          `Page title: ${title}, url: ${url}`
      );
    }
    // Send the prompt the way the site's own JS expects it. AI chat composers
    // (Copilot/ChatGPT/Claude) are controlled React inputs: `type` sets the
    // value in one shot (Playwright fill semantics) so the element does not
    // detach on every keystroke, then Enter fires the site's own send handler.
    if (this.profile.send.kind === "click") {
      const sendSel = this.profile.send.selector;
      if (!sendSel) throw new Error(`${this.profile.id}: send.kind "click" requires a selector`);
      await this.dom.type(composer, text);
      await this.dom.click(sendSel);
    } else {
      await this.dom.type(composer, text);
      await this.dom.press(composer, ["Enter"]);
    }
    // Read the streamed answer off the page: stop when text stops growing.
    const answerSel = this.profile.answer.join(", ") || "body";
    const observed = await this.dom.awaitAnswer(answerSel, {
      timeoutMs: opts.timeoutMs ?? this.profile.captureMs,
      stableMs: opts.stableMs ?? this.profile.stableMs,
    });
    const answer = (observed.text ?? "").trim();
    if (!answer) {
      throw new Error(
        `no answer appeared on ${this.profile.id} within ${opts.timeoutMs ?? this.profile.captureMs}ms. ` +
          (this.profile.loginRequired
            ? `This site requires sign-in. ${this.profile.loginHint}.`
            : "The page may be behind a consent wall — tune the profile's `dismiss` selectors.")
      );
    }
    return {
      answer: cap(answer, 60000),
      chunkCount: observed.chunkCount,
      doneReason: observed.doneReason,
      url: observed.url,
      title: observed.title,
    };
  }

  async close(): Promise<void> {
    if (this.defaultContext) {
      // The attached user browser's shared context must stay alive — only the
      // worker's own tab (this driver's page) is closed.
      try {
        await this.page?.close();
      } catch {
        // page already gone
      }
    } else {
      try {
        await this.page?.context()?.close();
      } catch {
        // context already gone
      }
    }
    if (this.ownsBrowser) {
      try {
        await this.browser?.close();
      } catch {
        // browser already gone
      }
    }
    this.page = undefined;
    this.browser = undefined;
  }
}

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

function lightMode(): boolean {
  return process.env.UI2API_LIGHT !== "0";
}