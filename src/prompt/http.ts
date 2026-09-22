// Promptd — a tiny, localhost-only HTTP service over the ChatPool. Live apps
// elsewhere on the machine (including anything in /var/www) can call it without
// having ui2api or a browser themselves:
//
//   POST /prompt  {"prompt":"...", "site":"gemini", "newChat":true, "account":"me@gmail.com"}
//                 -> {answer, chunkCount, doneReason, url, title[, citations]}
//   POST /capability/gemini  {"capability":"gemini_list_conversations", ...}
//                 -> one Gemini capability result (chat/list_conversations/
//                    model_list/search_toggle) over the same browser+session.
//                 Capabilities not declared by the site's package manifest are
//                 rejected with a 400 BEFORE any browser work: {error:
//                 "unknown capability "<x>" for "<site>"; available: […]"}.
//   GET  /capabilities/<site>  -> the installed package's manifest capability
//                 surface {site, name, url, capabilities:[{id,name,description,
//                 method}], source:"manifest"} for any installed package.
//   OpenAI-compatible surface (for OpenAI SDKs, OmniRoute, etc.):
//   GET  /v1/models             -> {object:"list", data:[{id:"deepseek",...},...]}
//   POST /v1/chat/completions   {"model":"deepseek"|"ui2api/deepseek",
//                                "messages":[...], "stream"?:bool,
//                                "new_chat"?:bool, "account"?:string}
//                 -> OpenAI chat.completion JSON (or SSE chunks if stream:true)
//   GET  /sites   -> the available chat-site profiles
//   GET  /accounts?site=gemini  -> identity-keyed accounts stored for the site
//   GET  /status  -> pool health (warm/idle/busy pages)
//   GET  /health  -> {ok, defaultSite}
//
// Bound to 127.0.0.1 by default; optionally guarded by a bearer token
// (UI2API_PROMPTD_TOKEN). The server owns a stand-by page pool (one headless
// browser, `min` warmed pages, `max` cap from UI2API_POOL_MAX / free memory) so
// prompts hit already-loaded pages and can run in parallel.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ChatPool } from "./pool.js";
import { handleOpenAIRoutes } from "./openai.js";
import { buildRegistryPackages, type RegistryPackage } from "./registry.js";
import { defaultSiteId, listProfiles, resolveProfile, resolvePackagedProfile, type ChatSiteProfile } from "../profile/profile.js";
import { listAccounts, slugifyIdentity, loadCapabilities } from "../runtime/session-store.js";
import { GeminiCapabilities } from "../capabilities/gemini.js";
import { KimiCapabilities } from "../capabilities/kimi.js";
import { HunyuanCapabilities } from "../capabilities/hunyuan.js";
import { VeniceCapabilities } from "../capabilities/venice.js";
import { DeepSeekCapabilities } from "../capabilities/deepseek.js";
import { TencentAistudioCapabilities } from "../capabilities/tencent-aistudio.js";
import { ClaudeCapabilities } from "../capabilities/claude.js";
import { ChatGPTCapabilities } from "../capabilities/chatgpt.js";
import { CopilotCapabilities } from "../capabilities/copilot.js";
import { HuggingChatCapabilities } from "../capabilities/huggingchat.js";
import { YouTubeCapabilities } from "../capabilities/youtube.js";
import { ArapratCapabilities } from "../capabilities/araprat.js";
import { AdaptaCapabilities } from "../capabilities/adapta.js";
import { BlackboxCapabilities } from "../capabilities/blackbox.js";
import { ChatglmCapabilities } from "../capabilities/chatglm.js";
import { CodexCapabilities } from "../capabilities/codex.js";
import { ConolCapabilities } from "../capabilities/conol.js";
import { CopilotM365Capabilities } from "../capabilities/copilot-m365.js";
import { DoubaoCapabilities } from "../capabilities/doubao.js";
import { DuckduckgoCapabilities } from "../capabilities/duckduckgo.js";
import { GoogleAiSearchCapabilities } from "../capabilities/google-ai-search.js";
import { GrokCapabilities } from "../capabilities/grok.js";
import { InnerAiCapabilities } from "../capabilities/inner-ai.js";
import { ManusCapabilities } from "../capabilities/manus.js";
import { NotionCapabilities } from "../capabilities/notion.js";
import { PerplexityCapabilities } from "../capabilities/perplexity.js";
import { PoeCapabilities } from "../capabilities/poe.js";
import { T3chatCapabilities } from "../capabilities/t3chat.js";
import { TinycmsCapabilities } from "../capabilities/tinycms.js";
import { V0Capabilities } from "../capabilities/v0.js";
import { XiaomimimoCapabilities } from "../capabilities/xiaomimimo.js";
import { ZenmuxCapabilities } from "../capabilities/zenmux.js";

export interface PromptdOptions {
  port: number;
  host?: string;
  dataDir?: string;
  token?: string;
  profiles?: ChatSiteProfile[] | { [id: string]: ChatSiteProfile };
  min?: number;
  max?: number;
}

export interface PromptdServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Cache the parsed body on the request so a pre-dispatch guard (capability
  // validation) and the routed handler can both read the same body.
  const cached = (req as IncomingMessage & { bodyCache?: Record<string, unknown> }).bodyCache;
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        (req as IncomingMessage & { bodyCache?: Record<string, unknown> }).bodyCache = parsed;
        resolve(parsed);
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

// Resolve a site id from the request. Accept only built-in ids or the ids of
// profiles handed to the server at startup — NEVER an arbitrary URL, so the
// service cannot be used to drive unintended origins.
function idFrom(reqSite: unknown, resolved: Record<string, ChatSiteProfile>): ChatSiteProfile {
  const id = String(reqSite ?? "").trim() || defaultSiteId();
  const p = resolved[id];
  if (!p) throw new Error(`unknown site "${id}" — try one of ${Object.keys(resolved).join(", ")}`);
  return p;
}

// Resolve the installed capability package for a site (registry-first: the same
// source /registry serves). Absent package → undefined (no packaged surface).
function registryPackageFor(siteId: string): RegistryPackage | undefined {
  return buildRegistryPackages().find((p) => p.id === siteId);
}

// Identity-keyed account routing on the capability surface — the same `account`
// contract as /prompt: empty or "default" = the legacy shared session; anything
// else must resolve to a stored vault snapshot for this site's host, else the
// request is rejected (400, thrown up to the server catch) BEFORE any browser
// work — never launch a browser for a nonexistent account.
function resolveCapabilityAccount(account: string | undefined, profile: ChatSiteProfile, dataDir: string): void {
  if (!account || account === "default") return;
  const host = new URL(profile.url).host;
  const slug = slugifyIdentity(account);
  const stored = listAccounts(dataDir, host);
  const match = stored.find((a) => a.slug === slug || a.identity === account);
  if (!match) {
    throw new Error(`no stored account "${account}" for "${host}"; available: [${stored.map((a) => a.slug).join(", ")}]`);
  }
}

export async function startPromptd(opts: PromptdOptions): Promise<PromptdServer> {
  const token = opts.token ?? process.env.UI2API_PROMPTD_TOKEN ?? "";
  const dataDir = opts.dataDir ?? process.env.UI2API_DATA_DIR ?? "data";

  // Build a per-id profile map. When explicit profiles are handed in (CLI
  // `--site X`), serve ONLY those; otherwise serve the built-in catalog. A
  // promptd instance therefore never drives an origin nobody configured.
  const profileList: ChatSiteProfile[] = [];
  if (opts.profiles) {
    if (Array.isArray(opts.profiles)) {
      profileList.push(...opts.profiles);
    } else {
      profileList.push(...Object.values(opts.profiles));
    }
  } else {
    profileList.push(...listProfiles());
  }
  const profilesById: Record<string, ChatSiteProfile> = {};
  for (const p of profileList) profilesById[p.id] = p;

  // The stand-by page pool. `min` pages are warmed at boot for the default site
  // so the very first prompt is served by an already-loaded composer.
  const pool = new ChatPool({
    profiles: profileList,
    min: opts.min,
    max: opts.max,
    defaultProfile: defaultSiteId(),
    dataDir,
  });
  // Warm lazily on first use per site; if boot warm failed (site changed / site
  // down), keep going — requests will open pages on demand.
  await pool.warm().catch(() => undefined);

  const server = createServer(async (req, res) => {
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        return send(res, 401, { error: "unauthorized" });
      }
      // Capability-dispatch guard: reject capabilities the site's package does
      // not declare (manifest is the single source of truth, matching the
      // /registry tools), BEFORE the routed runner does any browser work.
      // Declared capabilities — including login-gated ones — flow through
      // unchanged to their runner.
      if (req.method === "POST" && req.url) {
        const capMatch = /^\/capability\/([^/?#]+)$/.exec(req.url);
        if (capMatch) {
          const site = decodeURIComponent(capMatch[1]);
          const pkg = registryPackageFor(site);
          if (pkg) {
            const body = await readJson(req);
            const capability = String(body.capability ?? "");
            if (!capability) return send(res, 400, { error: "capability is required" });
            const available = pkg.tools.map((t) => t.id);
            if (!available.includes(capability)) {
              return send(res, 400, {
                error: `unknown capability "${capability}" for "${site}"; available: [${available.join(", ")}]`,
              });
            }
          }
        }
      }
      // OpenAI-compatible surface: /v1/models + /v1/chat/completions
      if (req.url?.startsWith("/v1/")) {
        return handleOpenAIRoutes(req, res, { pool, profilesById });
      }
      if (req.method === "GET" && req.url === "/sites") {
        return send(res, 200, { sites: Object.values(profilesById).map((p) => ({ id: p.id, name: p.name, url: p.url, loginRequired: p.loginRequired })) });
      }
      // REGISTRY — the installed ui2api packages (capabilities/<id>/), the
      // contract consumed by OmniRoute to materialize provider nodes (models)
      // and MCP tools (capabilities). Everything in the registry repo, nothing
      // else: GET /registry -> { packages: [...] }
      if (req.method === "GET" && req.url === "/registry") {
        return send(res, 200, {
          packages: buildRegistryPackages(),
          generatedAt: new Date().toISOString(),
        });
      }
      // Identity-keyed accounts stored for a site (the multi-account vault):
      //   GET /accounts?site=gemini  -> { site, accounts: [{slug, identity, capturedAt, source}] }
      // A `/prompt` may then pass `account: <slug|identity>` to drive that
      // specific logged-in session.
      if (req.method === "GET" && req.url?.startsWith("/accounts")) {
        const q = new URL(req.url, "http://localhost");
        const site = q.searchParams.get("site") ?? "";
        const profile = site ? idFrom(site, profilesById) : undefined;
        if (!profile) return send(res, 400, { error: "site is required" });
        const host = new URL(profile.url).host;
        return send(res, 200, { site: profile.id, host, accounts: listAccounts(dataDir, host) });
      }
      // Capability reflection, path form: GET /capabilities/<site> -> the
      // installed package's declared capability surface (the same manifest the
      // /registry tools derive from). Works for every installed package —
      // capability-first sites (youtube/araprat) have no ChatDriver profile
      // entry, so this reads the local manifest only and never drives an
      // origin; the gate is package existence, not profile existence.
      if (req.method === "GET" && req.url) {
        const pathCap = /^\/capabilities\/([^/?#]+)\/?$/.exec(req.url);
        if (pathCap) {
          const site = decodeURIComponent(pathCap[1]);
          const pkg = registryPackageFor(site);
          if (!pkg) return send(res, 400, { error: `no capability package installed for "${site}"` });
          return send(res, 200, {
            site: pkg.id,
            name: pkg.name,
            url: pkg.url,
            capabilities: pkg.tools.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              method: t.method,
            })),
            source: "manifest",
          });
        }
      }
      // Capability reflection: the stored per-account fingerprint (models,
      // tier, restrictions) captured by `ui2api profile capabilities`.
      //   GET /capabilities?site=gemini&account=merezarezaei@gmail.com
      if (req.method === "GET" && req.url?.startsWith("/capabilities")) {
        const q = new URL(req.url, "http://localhost");
        const site = q.searchParams.get("site") ?? "";
        const account = q.searchParams.get("account") ?? "";
        if (!site || !account) return send(res, 400, { error: "site and account are required" });
        const profile = idFrom(site, profilesById);
        const host = new URL(profile.url).host;
        const slug = slugifyIdentity(account);
        const stored = loadCapabilities(dataDir, host, slug);
        if (!stored) {
          return send(res, 200, {
            site: profile.id,
            host,
            account,
            probed: false,
            hint: "run `ui2api profile capabilities <host> --account <email>` once to probe this account",
          });
        }
        return send(res, 200, stored);
      }
      if (req.method === "GET" && req.url === "/status") {
        return send(res, 200, { ok: true, pool: pool.status });
      }
      if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
        return send(res, 200, { ok: true, defaultSite: defaultSiteId(), sites: Object.keys(profilesById), pool: pool.status });
      }
      if (req.method === "POST" && req.url === "/prompt") {
        const body = await readJson(req);
        const prompt = String(body.prompt ?? "");
        if (!prompt.trim()) return send(res, 400, { error: "prompt is required" });
        const profile = idFrom(body.site, profilesById);
        const newChat = Boolean(body.newChat);
        // Identity-keyed account (email or vault slug). A dedicated worker
        // carries the requested account's snapshot; "default" = legacy path.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        const model = typeof body.model === "string" && body.model ? body.model : undefined;
        const worker = await pool.acquire(profile.id, account);
        try {
          const result = await worker.driver.ask(prompt, { newChat, ...(model ? { model } : {}) });
          await pool.release(worker);
          return send(res, 200, { ok: true, ...result });
        } catch (e) {
          await pool.release(worker);
          throw e;
        }
      }
      // Gemini capability surface: list/conversations/model-picker/search-toggle
      // via the same logged-in browser machinery.
      if (req.method === "POST" && req.url === "/capability/gemini") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        const profile = idFrom("gemini", profilesById);
        // Reuse the pool's logged-in browser: a fresh per-request browser lands
        // on the signed-out landing shell and RPC/DOM reads fail. Sharing the
        // pool browser keeps the proven session AND avoids a second Chrome.
        // An explicit account must resolve to a stored snapshot before any
        // browser work (a nonexistent account never spins Chrome up).
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new GeminiCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // Kimi capability surface: chat / list_conversations (DOM) / model_list
      // via the same logged-in browser machinery. Profile resolution: registry
      // FIRST (kimi is now built-in), packaged-JSON fallback for servers started
      // with an explicit --site allow-list that excludes it.
      if (req.method === "POST" && req.url === "/capability/kimi") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("kimi", profilesById);
        } catch {
          profile = resolvePackagedProfile("kimi") ?? resolveProfile("capabilities/kimi/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new KimiCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // Hunyuan / Yuanbao capability surface: chat + list_conversations (DOM).
      // Same registry-first, packaged-JSON-fallback profile resolution. The
      // runner's results carry the anti-bot (X-webdriver / headed-only) note.
      if (req.method === "POST" && req.url === "/capability/hunyuan") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("hunyuan", profilesById);
        } catch {
          profile = resolvePackagedProfile("hunyuan") ?? resolveProfile("capabilities/hunyuan/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new HunyuanCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // Venice capability surface: chat + list_conversations (DOM sidebar).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/venice") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("venice", profilesById);
        } catch {
          profile = resolvePackagedProfile("venice") ?? resolveProfile("capabilities/venice/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new VeniceCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // DeepSeek capability surface: chat + list_conversations (DOM sidebar) +
      // reasoner (honest ok:false until a grounded "Think" toggle exists).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/deepseek") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("deepseek", profilesById);
        } catch {
          profile = resolveProfile("capabilities/deepseek/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new DeepSeekCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // Tencent AI Studio capability surface: chat (verified HEADED-only path —
      // EdgeOne blocks headless) + documented-but-unverified wire caps. The
      // ChatDriver path enforces the headed/real-Chrome posture itself.
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/tencent-aistudio") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("tencent-aistudio", profilesById);
        } catch {
          profile = resolveProfile("capabilities/tencent-aistudio/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new TencentAistudioCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // Claude capability surface: chat + list_conversations (DOM sidebar).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/claude") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("claude", profilesById);
        } catch {
          profile = resolveProfile("capabilities/claude/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new ClaudeCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // ChatGTP capability surface: chat (ChatDriver UI). Registry-first, packaged-JSON fallback.
      if (req.method === "POST" && req.url === "/capability/chatgpt") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("chatgpt", profilesById);
        } catch {
          profile = resolveProfile("capabilities/chatgpt/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new ChatGPTCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // Copilot capability surface: chat (ChatDriver UI). Registry-first, packaged-JSON fallback.
      if (req.method === "POST" && req.url === "/capability/copilot") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("copilot", profilesById);
        } catch {
          profile = resolveProfile("capabilities/copilot/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new CopilotCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // HuggingChat capability surface: chat (ChatDriver UI). Registry-first, packaged-JSON fallback.
      if (req.method === "POST" && req.url === "/capability/huggingchat") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("huggingchat", profilesById);
        } catch {
          profile = resolveProfile("capabilities/huggingchat/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new HuggingChatCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // YouTube capability surface: video search + transcript read-back
      // (NOT a chat site — no ChatDriver flow). SCAFFOLD, DOM-UNVERIFIED.
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/youtube") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("youtube", profilesById);
        } catch {
          profile = resolveProfile("capabilities/youtube/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new YouTubeCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // Aparat capability surface: video search / trending / video-detail
      // (LIVE-VERIFIED 2026-09-20) + posting actions dispatched HONESTLY as
      // login-gated (ok:false login-required, no captured session exists).
      // Not a chat site — no ChatDriver. Registry-first, packaged-JSON-fallback
      // profile resolution.
      if (req.method === "POST" && req.url === "/capability/araprat") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("araprat", profilesById);
        } catch {
          profile = resolveProfile("capabilities/araprat/profile.json");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new ArapratCapabilities(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
      // adapta capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/adapta") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("adapta", profilesById);
        } catch {
          profile = resolvePackagedProfile("adapta") ?? resolveProfile("capabilities/adapta/profile.json");
        }
        const caps = new AdaptaCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // blackbox capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/blackbox") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("blackbox", profilesById);
        } catch {
          profile = resolvePackagedProfile("blackbox") ?? resolveProfile("capabilities/blackbox/profile.json");
        }
        const caps = new BlackboxCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // chatglm capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/chatglm") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("chatglm", profilesById);
        } catch {
          profile = resolvePackagedProfile("chatglm") ?? resolveProfile("capabilities/chatglm/profile.json");
        }
        const caps = new ChatglmCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // codex capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/codex") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("codex", profilesById);
        } catch {
          profile = resolvePackagedProfile("codex") ?? resolveProfile("capabilities/codex/profile.json");
        }
        const caps = new CodexCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // conol capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/conol") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("conol", profilesById);
        } catch {
          profile = resolvePackagedProfile("conol") ?? resolveProfile("capabilities/conol/profile.json");
        }
        const caps = new ConolCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // copilot-m365 capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/copilot-m365") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("copilot-m365", profilesById);
        } catch {
          profile = resolvePackagedProfile("copilot-m365") ?? resolveProfile("capabilities/copilot-m365/profile.json");
        }
        const caps = new CopilotM365Capabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // doubao capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/doubao") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("doubao", profilesById);
        } catch {
          profile = resolvePackagedProfile("doubao") ?? resolveProfile("capabilities/doubao/profile.json");
        }
        const caps = new DoubaoCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // duckduckgo capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/duckduckgo") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("duckduckgo", profilesById);
        } catch {
          profile = resolvePackagedProfile("duckduckgo") ?? resolveProfile("capabilities/duckduckgo/profile.json");
        }
        const caps = new DuckduckgoCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // google-ai-search capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/google-ai-search") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("google-ai-search", profilesById);
        } catch {
          profile = resolvePackagedProfile("google-ai-search") ?? resolveProfile("capabilities/google-ai-search/profile.json");
        }
        const caps = new GoogleAiSearchCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // grok capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/grok") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("grok", profilesById);
        } catch {
          profile = resolvePackagedProfile("grok") ?? resolveProfile("capabilities/grok/profile.json");
        }
        const caps = new GrokCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // inner-ai capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/inner-ai") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("inner-ai", profilesById);
        } catch {
          profile = resolvePackagedProfile("inner-ai") ?? resolveProfile("capabilities/inner-ai/profile.json");
        }
        const caps = new InnerAiCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // manus capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/manus") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("manus", profilesById);
        } catch {
          profile = resolvePackagedProfile("manus") ?? resolveProfile("capabilities/manus/profile.json");
        }
        const caps = new ManusCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // notion capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/notion") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("notion", profilesById);
        } catch {
          profile = resolvePackagedProfile("notion") ?? resolveProfile("capabilities/notion/profile.json");
        }
        const caps = new NotionCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // perplexity capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/perplexity") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("perplexity", profilesById);
        } catch {
          profile = resolvePackagedProfile("perplexity") ?? resolveProfile("capabilities/perplexity/profile.json");
        }
        const caps = new PerplexityCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // poe capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/poe") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("poe", profilesById);
        } catch {
          profile = resolvePackagedProfile("poe") ?? resolveProfile("capabilities/poe/profile.json");
        }
        const caps = new PoeCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // t3chat capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/t3chat") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("t3chat", profilesById);
        } catch {
          profile = resolvePackagedProfile("t3chat") ?? resolveProfile("capabilities/t3chat/profile.json");
        }
        const caps = new T3chatCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // tinycms capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/tinycms") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("tinycms", profilesById);
        } catch {
          profile = resolvePackagedProfile("tinycms") ?? resolveProfile("capabilities/tinycms/profile.json");
        }
        const caps = new TinycmsCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // v0 capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/v0") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("v0", profilesById);
        } catch {
          profile = resolvePackagedProfile("v0") ?? resolveProfile("capabilities/v0/profile.json");
        }
        const caps = new V0Capabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // xiaomimimo capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/xiaomimimo") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("xiaomimimo", profilesById);
        } catch {
          profile = resolvePackagedProfile("xiaomimimo") ?? resolveProfile("capabilities/xiaomimimo/profile.json");
        }
        const caps = new XiaomimimoCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      // zenmux capability surface: no captured session exists on this box — every
      // declared capability is dispatched HONESTLY as login-gated by its runner
      // (ok:false loginGated:true, no browser opened, no fabricated result).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/zenmux") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("zenmux", profilesById);
        } catch {
          profile = resolvePackagedProfile("zenmux") ?? resolveProfile("capabilities/zenmux/profile.json");
        }
        const caps = new ZenmuxCapabilities(profile, { account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }

      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, e instanceof Error && /unknown site |no stored account /.test(e.message) ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    server,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.close();
    },
  };
}