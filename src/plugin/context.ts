import { readFileSync, writeFileSync } from "node:fs";
import { launchBrowser, sessionPath, loadCookies, usingUserChrome, defaultSitesDir } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, loadAccountSnapshot, loadAccountSnapshotVerdict, snapshotPath, listAccounts, resolveStoredAccount } from "../runtime/session-store.js";
import { makeDomPrimitives } from "../runtime/dom-primitives.js";
import { sameOrigin } from "../runtime/ssrf.js";
import { analyse } from "../analyzer/explore.js";
import { createWigoloContext } from "./wigolo-context.js";
import type { ActionMap } from "../types.js";
import type { Ui2ApiContext, HubConfig, Logger, ToolDefinition, ToolHandler, AnalyseOpts } from "./types.js";

export { createWigoloContext }; // re-exported so callers can pin an engine directly

export interface ContextDeps { baseUrl: string; logger?: Logger; dataDir?: string; authRequired?: boolean; account?: string; }
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
    // Reuse the site's captured session the same way ChatDriver and the
    // capability runners do: a full profile snapshot (cookies + localStorage +
    // sessionStorage + IndexedDB) when one exists, else the legacy cookie file.
    // Without this a `plugin serve`/generated-consumer page is anonymous even
    // though a real vault session is stored (flat state.json on this box).
    const host = new URL(deps.baseUrl).host;
    if (!usingUserChrome()) {
      // GOAL 52: an explicitly requested vault account wins — exact resolution
      // (resolveStoredAccount: identity or canonical slug only, GOAL 51), never
      // a silent accts[0]. A miss is a loud throw.
      if (deps.account) {
        const acct = resolveStoredAccount(dataDir, host, deps.account);
        if (!acct) {
          throw new Error(
            `no stored account "${deps.account}" for "${host}" — run \`ui2api profile add-all --known\` or pick one from \`ui2api profiles ${host}\``
          );
        }
        const verdict = loadAccountSnapshotVerdict(dataDir, host, acct.slug);
        if (verdict.snapshot) {
          await injectSnapshot(ctx, verdict.snapshot);
        } else {
          // GOAL 124: name WHY the requested account could not be loaded, never
          // a bare "no snapshot" that reads as "carry on anonymously".
          const why = verdict.status === "shape-invalid" ? `shape-invalid: ${verdict.detail ?? "unknown field"}` : verdict.status;
          throw new Error(
            `vault account "${deps.account}" for "${host}" has no usable snapshot (${why}; ${dataDir}/sessions/${host}/${acct.slug})`
          );
        }
      } else {
        let snap = loadSnapshot(snapshotPath(dataDir, host));
        if (!snap) {
          // Fall back to the first stored vault account when no flat snapshot
          // exists (identity-keyed vault is the bulk-import layout of record).
          // GOAL 124: SKIP rows the GOAL 89 reconciliation marked unusable —
          // picking an anonymous/corrupt/missing row blindly is the
          // cross-account-bleed hazard (an unusable first row used to drive
          // the request). This is the UN-requested path, so an empty result
          // still means an honest anonymous run, not an error.
          const accts = listAccounts(dataDir, host).filter((a) => a.usable !== false);
          if (accts.length) snap = loadAccountSnapshot(dataDir, host, accts[0].slug);
        }
        if (snap) {
          await injectSnapshot(ctx, snap);
        } else {
          const cookies = loadCookies(sessionPath(dataDir, host));
          if (cookies.length > 0) await ctx.addCookies(cookies as never[]);
        }
      }
    }
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
      // GOAL 105: the SITE'S OWN fetch, run inside the page. `p.request.fetch`
      // was an out-of-page APIRequestContext — a synthesized request with no
      // page JS, no page origin and no page cookies.
      return await p.evaluate(async (a: { url: string; method: string; body?: string }) => {
        const init: RequestInit = { method: a.method, credentials: "include" };
        if (a.body !== undefined && a.method !== "GET" && a.method !== "HEAD") {
          init.body = a.body;
          init.headers = { "content-type": "application/json" };
        }
        const r = await window.fetch(a.url, init);
        return await r.text();
      }, { url: resolved, method: (req.method as string) || "GET", body: req.body as string | undefined });
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
