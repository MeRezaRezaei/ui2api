import { readFileSync, writeFileSync } from "node:fs";
import { launchBrowser, sessionPath, defaultSitesDir } from "../runtime/browser.js";
import { sameOrigin } from "../runtime/ssrf.js";
import { analyse } from "../analyzer/explore.js";
import type { ActionMap } from "../types.js";
import type { Ui2ApiContext, HubConfig, Logger, ToolDefinition, ToolHandler, AnalyseOpts } from "./types.js";

export interface ContextDeps { baseUrl: string; logger?: Logger; dataDir?: string; }
type ToolEntry = { def: ToolDefinition; handler: ToolHandler };

export function createContext(config: HubConfig, deps: ContextDeps): Ui2ApiContext & { tools: Map<string, ToolEntry> } {
  const logger: Logger = deps.logger ?? console;
  const tools = new Map<string, ToolEntry>();
  const dataDir = deps.dataDir ?? defaultSitesDir();
  let page: any = null;
  async function getPage(): Promise<any> {
    if (page) return page;
    const browser = await launchBrowser();
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
    dom: {
      async click(sel) { await (await getPage()).locator(sel).first().click({ timeout: 5000 }); },
      async type(sel, text) { await (await getPage()).locator(sel).first().fill(text); },
      async waitFor(sel, timeoutMs = 5000) { await (await getPage()).locator(sel).first().waitFor({ timeout: timeoutMs }); },
      async extract(expr) {
        const p = await getPage();
        const m = expr.trim().match(/^(text|attr|json)\s+(\S+)(?:\s+(\S+))?$/);
        if (!m) return (await p.evaluate(() => document.body.innerText)) as string;
        const [, kind, sel, arg] = m;
        return p.evaluate(({ sel, kind, arg }: { sel: string; kind: string; arg?: string }) => {
          const el = document.querySelector(sel) as HTMLElement | null; if (!el) return null;
          if (kind === "text" || kind === "json") return el.innerText;
          if (kind === "attr") return el.getAttribute(arg as string); return null;
        }, { sel, kind, arg });
      },
    },
  };
  return ctx;
}
