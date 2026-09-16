// Promptd — a tiny, localhost-only HTTP service over the ChatPool. Live apps
// elsewhere on the machine (including anything in /var/www) can call it without
// having ui2api or a browser themselves:
//
//   POST /prompt  {"prompt":"...", "site":"gemini", "newChat":true, "account":"me@gmail.com"}
//                 -> {answer, chunkCount, doneReason, url, title[, citations]}
//   POST /capability/gemini  {"capability":"gemini_list_conversations", ...}
//                 -> one Gemini capability result (chat/list_conversations/
//                    model_list/search_toggle) over the same browser+session.
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
import { defaultSiteId, listProfiles, resolveProfile, resolvePackagedProfile, type ChatSiteProfile } from "../profile/profile.js";
import { listAccounts, slugifyIdentity, loadCapabilities } from "../runtime/session-store.js";
import { GeminiCapabilities } from "../capabilities/gemini.js";
import { KimiCapabilities } from "../capabilities/kimi.js";
import { HunyuanCapabilities } from "../capabilities/hunyuan.js";
import { VeniceCapabilities } from "../capabilities/venice.js";
import { DeepSeekCapabilities } from "../capabilities/deepseek.js";
import { ClaudeCapabilities } from "../capabilities/claude.js";
import { ChatGPTCapabilities } from "../capabilities/chatgpt.js";
import { CopilotCapabilities } from "../capabilities/copilot.js";
import { HuggingChatCapabilities } from "../capabilities/huggingchat.js";

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
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
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
      if (req.method === "GET" && req.url === "/sites") {
        return send(res, 200, { sites: Object.values(profilesById).map((p) => ({ id: p.id, name: p.name, url: p.url, loginRequired: p.loginRequired })) });
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
        const profile = idFrom("gemini", profilesById);
        // Reuse the pool's logged-in browser: a fresh per-request browser lands
        // on the signed-out landing shell and RPC/DOM reads fail. Sharing the
        // pool browser keeps the proven session AND avoids a second Chrome.
        const shared = await pool.sharedBrowser();
        const caps = new GeminiCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("kimi", profilesById);
        } catch {
          profile = resolvePackagedProfile("kimi") ?? resolveProfile("capabilities/kimi/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new KimiCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("hunyuan", profilesById);
        } catch {
          profile = resolvePackagedProfile("hunyuan") ?? resolveProfile("capabilities/hunyuan/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new HunyuanCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("venice", profilesById);
        } catch {
          profile = resolvePackagedProfile("venice") ?? resolveProfile("capabilities/venice/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new VeniceCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("deepseek", profilesById);
        } catch {
          profile = resolveProfile("capabilities/deepseek/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new DeepSeekCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("claude", profilesById);
        } catch {
          profile = resolveProfile("capabilities/claude/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new ClaudeCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("chatgpt", profilesById);
        } catch {
          profile = resolveProfile("capabilities/chatgpt/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new ChatGPTCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("copilot", profilesById);
        } catch {
          profile = resolveProfile("capabilities/copilot/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new CopilotCapabilities(profile, { browser: shared, dataDir });
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
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("huggingchat", profilesById);
        } catch {
          profile = resolveProfile("capabilities/huggingchat/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new HuggingChatCapabilities(profile, { browser: shared, dataDir });
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
      send(res, e instanceof Error && /unknown site /.test(e.message) ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
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