import { type Browser, type BrowserContext, type Page } from "playwright";
import type { ActionMap, Action } from "../types.js";
import { launchBrowser } from "./browser.js";

// Long-lived browser session per site. Loads the URL, keeps it authenticated,
// and executes a generated tool's recipe — either by calling the real in-page
// JS function (live-js) or by replaying the captured request (replay).
export class BrowserSession {
  private map: ActionMap;
  private browser!: Browser;
  private ctx!: BrowserContext;
  private page!: Page;
  private started = false;

  constructor(map: ActionMap) {
    this.map = map;
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
      const { fileURLToPath } = await import("node:url");
      const path = fileURLToPath(
        new URL(`../../sites/${this.map.host}/.session/cookies.json`, import.meta.url)
      );
      const cookies = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(cookies)) await this.ctx.addCookies(cookies);
    } catch (e) {
      // No session yet — analyzer will prompt for login on first run.
    }
  }

  async executeRecipe(action: Action, args: Record<string, unknown>): Promise<unknown> {
    if (!this.started) await this.start();
    const argArray = action.parameters.map((p) => args[p.name]);

    if (action.execution === "replay" && action.recipe.network) {
      const net = action.recipe.network;
      const resolved = net.url.startsWith("http")
        ? net.url
        : new URL(net.url, this.map.url).toString();
      const resp = await this.page.request.fetch(resolved, {
        method: (net.method as any) || "GET",
        data: net.requestBody,
        headers: { "content-type": "application/json" },
      });
      return await resp.text();
    }

    // live-js: call the real in-page function.
    if (action.result.mode === "dom" && action.result.extract) {
      return this.page.evaluate(
        (a: any) => {
          const parts = a.target.split(".");
          let fn: any = window;
          for (const part of parts) fn = fn[part];
          fn(...a.args);
          // eslint-disable-next-line no-eval
          return (0, eval)(a.extract);
        },
        { target: action.recipe.target, args: argArray, extract: action.result.extract }
      );
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
