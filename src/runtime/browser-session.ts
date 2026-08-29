import { type Browser, type BrowserContext, type Page } from "playwright";
import type { ActionMap, Action } from "../types.js";
import { launchBrowser, sessionPath, defaultSitesDir } from "./browser.js";
import { sameOrigin } from "./ssrf.js";

// Long-lived browser session per site. Loads the URL, keeps it authenticated,
// and executes a generated tool's recipe — either by calling the real in-page
// JS function (live-js) or by replaying the captured request (replay).
export class BrowserSession {
  private map: ActionMap;
  private browser!: Browser;
  private ctx!: BrowserContext;
  private page!: Page;
  private started = false;
  private outDir: string;

  constructor(map: ActionMap, outDir: string = defaultSitesDir()) {
    this.map = map;
    this.outDir = outDir;
  }

  async start(): Promise<void> {
    if (this.started) return;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let crashed = false;
      this.browser = await launchBrowser();
      this.browser.on("disconnected", () => {
        crashed = true;
      });
      try {
        this.ctx = await this.browser.newContext();
        await this.loadSession();
        this.page = await this.ctx.newPage();
        await this.page.goto(this.map.url, { waitUntil: "load", timeout: 30000 });
        await this.page.waitForTimeout(400);
        if (crashed) throw new Error("browser crashed during start");
        this.started = true;
        return;
      } catch (e) {
        lastErr = e;
        if (!crashed) await this.browser.close().catch(() => {});
        if (attempt < 3) {
          console.error(
            `[ui2api] serve start attempt ${attempt} failed (${e instanceof Error ? e.message : e}); retrying...`
          );
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("serve start failed");
  }

  private async loadSession(): Promise<void> {
    if (!this.map.auth?.required) return;
    // Session cookies are stored at sites/<host>/.session/cookies.json (gitignored).
    try {
      const { readFileSync } = await import("node:fs");
      const path = sessionPath(this.outDir, this.map.host);
      const cookies = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(cookies)) await this.ctx.addCookies(cookies);
    } catch (e) {
      // No session yet — analyzer will prompt for login on first run.
    }
  }

  async executeRecipe(action: Action, args: Record<string, unknown>): Promise<unknown> {
    if (!this.started) await this.start();
    // Recover from a browser that died between start() and this call.
    if (!this.browser?.isConnected()) {
      this.started = false;
      await this.start();
    }
    const argArray = action.parameters.map((p) => args[p.name]);

    // SSRF guard: replay only targets that share the analyzed site's origin.
    // This prevents a crafted/compromised action-map from making the browser
    // issue requests (carrying the page's session cookies) to localhost or
    // internal services.
    if (action.execution === "replay" && action.recipe.network) {
      const net = action.recipe.network;
      const resolved = net.url.startsWith("http")
        ? net.url
        : new URL(net.url, this.map.url).toString();
      if (!sameOrigin(resolved, this.map.url)) {
        throw new Error(
          `SSRF guard: replay target ${resolved} is cross-origin to analyzed site ${this.map.url}`
        );
      }
      const resp = await this.page.request.fetch(resolved, {
        method: (net.method as any) || "GET",
        data: net.requestBody,
        headers: { "content-type": "application/json" },
      });
      return await resp.text();
    }

    // DOM-interaction actions (button clicks / form submits captured during
    // analysis) are re-driven by selector on the live page.
    if (action.recipe.kind === "dom-interaction") {
      const sel = action.recipe.target;
      try {
        await this.page.locator(sel).first().click({ timeout: 5000 });
      } catch {
        // Fall back to a synthetic click if the locator API can't resolve it.
        await this.page.evaluate((s: string) => {
          const el = document.querySelector(s) as HTMLElement | null;
          el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }, sel);
      }
      return "";
    }

    // DOM-extract mode: read a value off the page using a constrained,
    // eval-free extractor. `result.extract` is one of:
    //   "text <selector>"
    //   "attr <selector> <attr>"
    //   "json <selector>"
    if (action.result.mode === "dom" && action.result.extract) {
      const parsed = parseExtract(action.result.extract);
      if (parsed) {
        const { sel, kind, arg } = parsed;
        return this.page.evaluate(
          ({ sel, kind, arg }: { sel: string; kind: string; arg: string | null }) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return null;
            if (kind === "text" || kind === "json") return el.innerText;
            if (kind === "attr") return el.getAttribute(arg as string);
            return null;
          },
          { sel, kind, arg }
        );
      }
      // Unsupported extract syntax — fall back to a safe page-text snapshot.
      const fallback = await this.page.evaluate(() => document.body.innerText);
      return fallback.length > 8000 ? fallback.slice(0, 8000) : fallback;
    }

    return this.page.evaluate(
      (a: any) => {
        const parts = a.target.split(".");
        let fn: any = window;
        for (const part of parts) fn = fn[part];
        return fn(...a.args);
      },
      { target: action.recipe.target, args: argArray }
    );
  }

  async stop(): Promise<void> {
    if (this.browser) await this.browser.close();
    this.started = false;
  }
}

// Parse a constrained DOM-extract expression. Returns null if the syntax is not
// one of the supported forms (caller falls back to a safe page-text snapshot).
function parseExtract(
  extract: string
): { sel: string; kind: string; arg: string | null } | null {
  const m = extract.trim().match(/^(text|attr|json)\s+(\S+)(?:\s+(\S+))?$/);
  if (!m) return null;
  const kind = m[1];
  const sel = m[2];
  const arg = m[3] ?? null;
  if (kind === "attr" && arg === null) return null;
  return { sel, kind, arg };
}
