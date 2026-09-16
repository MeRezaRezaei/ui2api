import { readFileSync, writeFileSync } from "node:fs";
import { launchBrowser, sessionPath, defaultSitesDir } from "../runtime/browser.js";
import { makeDomPrimitives } from "../runtime/dom-primitives.js";
import { sameOrigin } from "../runtime/ssrf.js";
import { analyse } from "../analyzer/explore.js";
import { createWigoloContext } from "./wigolo-context.js";
import type { ActionMap } from "../types.js";
import type { Ui2ApiContext, HubConfig, Logger, ToolDefinition, ToolHandler, AnalyseOpts } from "./types.js";

export { createWigoloContext }; // re-exported so callers can pin an engine directly

export interface ContextDeps { baseUrl: string; logger?: Logger; dataDir?: string; authRequired?: boolean; }
type ToolEntry = { def: ToolDefinition; handler: ToolHandler };

export type EngineName = "native" | "wigolo";

// Resolve the execution engine from env. `createExecContext` picks it per load,
// so a generated server (or hub run) can choose an engine without regenerating.
export function readEngine(): EngineName {
  const raw = (process.env.UI2API_ENGINE ?? "native").toLowerCase();
  return raw === "wigolo" ? "wigolo" : "native";
}

// Create the Ui2ApiContext that backs a generated tool server, using the engine
// selected by UI2API_ENGINE (default: native Playwright).
export function createExecContext(
  config: HubConfig,
  deps: ContextDeps,
  engine: EngineName = readEngine()
): Ui2ApiContext & { tools: Map<string, ToolEntry> } {
  return engine === "wigolo"
    ? createWigoloContext(config, deps)
    : createContext(config, deps);
}

export function createContext(config: HubConfig, deps: ContextDeps): Ui2ApiContext & { tools: Map<string, ToolEntry> } {
  const logger: Logger = deps.logger ?? console;
  const tools = new Map<string, ToolEntry>();
  const dataDir = deps.dataDir ?? defaultSitesDir();
  let page: any = null;
  let browserRef: any = null;
  async function getPage(): Promise<any> {
    if (page) return page;
    const browser = await launchBrowser();
    browserRef = browser;
    const ctx = await browser.newContext();
    try { const c = JSON.parse(readFileSync(sessionPath(dataDir, new URL(deps.baseUrl).host), "utf8")); if (Array.isArray(c)) await ctx.addCookies(c); } catch {}
    page = await ctx.newPage();
    await page.goto(deps.baseUrl, { waitUntil: "load", timeout: 30000 });
    return page;
  }
  const ctx: Ui2ApiContext & { tools: Map<string, ToolEntry> } = {
    config, logger, tools,
    registerTool(def, handler) { if (tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`); tools.set(def.name, { def, handler }); },
    async analyse(url, opts?: AnalyseOpts) { return analyse(url, { root: opts?.root, outDir: opts?.outDir, llm: opts?.llm, maxTasks: opts?.maxTasks }); },
    async replay(req) {
      const resolved = req.url.startsWith("http") ? req.url : new URL(req.url, deps.baseUrl).toString();
      if (!sameOrigin(resolved, deps.baseUrl)) throw new Error(`SSRF guard: replay ${resolved} cross-origin`);
      const p = await getPage();
      const resp = await p.request.fetch(resolved, { method: (req.method as any) || "GET", data: req.body as any, headers: { "content-type": "application/json" } });
      return await resp.text();
    },
    async call(target, args) {
      const p = await getPage();
      return p.evaluate((a: { target: string; args: unknown[] }) => { let fn: any = window; for (const part of a.target.split(".")) fn = fn[part]; return fn(...a.args); }, { target, args });
    },
    session: {
      async load(host) { try { return JSON.parse(readFileSync(sessionPath(dataDir, host), "utf8")); } catch { return []; } },
      async save(host, cookies) { writeFileSync(sessionPath(dataDir, host), JSON.stringify(cookies)); },
    },
    http: { async fetch(url, init) { if (!sameOrigin(url, deps.baseUrl)) throw new Error(`SSRF guard: http ${url} cross-origin`); return fetch(url, init); } },
    dom: makeDomPrimitives(() => getPage()),
    // Release the lazily-launched browser (owned by this context). Callers that
    // create a context must close() it or the Chromium process leaks.
    async close() {
      if (browserRef) {
        try { await browserRef.close(); } catch {}
        browserRef = null;
        page = null;
      }
    },
  };
  return ctx;
}
