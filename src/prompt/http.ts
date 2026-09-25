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
//                 method}], source:"manifest", accounts:[{slug,identity,host,
//                 source,capturedAt}]} for any installed package — `accounts` is
//                 the same identity-keyed vault as /accounts?site= ([] when none).
//   OpenAI-compatible surface (for OpenAI SDKs, OmniRoute, etc.):
//   GET  /v1/models             -> {object:"list", data:[{id:"deepseek",...},...]}
//   POST /v1/chat/completions   {"model":"deepseek"|"ui2api/deepseek",
//                                "messages":[...], "stream"?:bool,
//                                "new_chat"?:bool, "account"?:string}
//                 -> OpenAI chat.completion JSON (or SSE chunks if stream:true)
//   GET  /sites   -> the available chat-site profiles
//   GET  /accounts?site=gemini  -> identity-keyed accounts stored for the site
//   GET  /status  -> pool health (warm/idle/busy pages)
//   GET  /requirements -> OS-level readiness report (GOAL 33 — the same data
//                 `ui2api requirements` prints: per-package verdict
//                 ready/working/on-hold/not-ready with named reasons, BEFORE
//                 any browser work), scoped to this daemon's profilesById gate
//                 + every installed capability package
//   GET  /health  -> {ok, defaultSite}
//
// Bound to 127.0.0.1 by default; optionally guarded by a bearer token
// (UI2API_PROMPTD_TOKEN). The server owns a stand-by page pool (one headless
// browser, `min` warmed pages, `max` cap from UI2API_POOL_MAX / free memory) so
// prompts hit already-loaded pages and can run in parallel.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ChatPool } from "./pool.js";
import { handleOpenAIRoutes } from "./openai.js";
import { buildRegistryPackages, defaultChatProfiles, chatSurfaceStatus, type RegistryPackage } from "./registry.js";
import { checkRequirements, requirementPackagesFor } from "../runtime/requirements.js";
import { defaultSiteId, resolveProfile, resolvePackagedProfile, resolvePackagedProfileFile, type ChatSiteProfile } from "../profile/profile.js";
import { listAccounts, slugifyIdentity, loadCapabilities, resolveStoredAccount } from "../runtime/session-store.js";
import { validateCapabilityReportShape } from "../runtime/capability-probe.js";
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
import { GmailCapabilities } from "../capabilities/gmail.js";
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
  /* GOAL 83 — aggregate deadline for the WORK routes (POST /prompt,
     POST /capability/<site>, POST /v1/chat/completions). Over it the daemon
     answers a NAMED 504 instead of holding the socket open forever. Env:
     UI2API_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /* GOAL 83 — how long close() waits for in-flight requests before destroying
     whatever is still open, so a wedged request can never make the daemon
     un-stoppable. Env: UI2API_SHUTDOWN_GRACE_MS. */
  shutdownGraceMs?: number;
}

export interface PromptdServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/* GOAL 83 defaults.
 *
 * `REQUEST_TIMEOUT_MS` = 300s sits comfortably ABOVE the real worst case of one
 * legitimate round-trip: page.goto 60s (driver.ts) + the profile's captureMs,
 * whose packaged maximum is 120s, i.e. ~180s of work, plus pool-queue time and
 * a realProfileOnly browser respawn (pool.spawn retries once with a fresh
 * Chrome, another goto). 180s would have been exactly the measured worst case
 * with ZERO headroom; 300s never cuts a legitimate 90s capture (the flagship
 * chat profiles' captureMs) and still bounds a wedged request.
 *
 * `SHUTDOWN_GRACE_MS` = 15s is how long close() waits for in-flight requests
 * before destroying the sockets: long enough for a normal request to finish
 * answering, short enough that a stopped daemon stops. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function resolveRequestTimeoutMs(explicit?: number): number {
  if (Number.isFinite(explicit) && (explicit as number) > 0) return Math.floor(explicit as number);
  return envMs("UI2API_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
}

// GOAL 83: the routes that drive a browser get the aggregate deadline. Every
// other route is a local read (models/sites/status/accounts/registry/
// requirements/health) that finishes in milliseconds — including the GOAL 81
// terminal 404 fallbacks, which must keep answering exactly as they do.
function isWorkRoute(req: IncomingMessage): boolean {
  if (req.method !== "POST") return false;
  const url = req.url ?? "";
  return url === "/prompt" || url.startsWith("/capability/") || url.startsWith("/v1/chat/completions");
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

// Write one JSON response, at most once per request. GOAL 83: a work route that
// trips the aggregate deadline has ALREADY been answered with the named 504
// while its browser call is still in flight (a Playwright call cannot be
// cancelled mid-flight). When that call finally settles, the handler tries to
// answer as usual — the guard below makes that a no-op instead of a second
// write on a finished response (which would throw ERR_HTTP_HEADERS_SENT), so
// the response is written EXACTLY once either way.
function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(data, null, 2);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), ...headers });
    res.end(payload);
  } catch {
    // socket already gone (client hung up / shutdown destroyed it)
  }
}

// A pool refusal is not a server fault: the queue is full, a page never freed
// in time, or the daemon is shutting down. Answer 503 with a stable code AND
// the named cause, so a client can tell "come back later" from "this is
// broken" — never a bare 500 with no reason.
function poolRefusal(message: string): { code: string } | null {
  if (/^pool saturated /.test(message)) return { code: "pool_saturated" };
  if (/^pool queue timeout /.test(message)) return { code: "pool_queue_timeout" };
  if (/^pool closed /.test(message)) return { code: "pool_closed" };
  return null;
}

// Resolve a site id from the request. Accept only built-in ids or the ids of
// profiles handed to the server at startup — NEVER an arbitrary URL, so the
// service cannot be used to drive unintended origins.
//
// GOAL 32 two-step: an id that is NOT on the chat surface but IS an installed
// capability package is a real thing this daemon serves — `/capability/<id>` —
// so the error says so instead of calling it "unknown" (POST /prompt with
// "youtube" used to 400 `unknown site "youtube"` though youtube is a
// registry-listed package serving /capability/youtube). Truly-unknown ids keep
// the plain "unknown site" 400.
function idFrom(reqSite: unknown, resolved: Record<string, ChatSiteProfile>): ChatSiteProfile {
  const id = String(reqSite ?? "").trim() || defaultSiteId();
  const p = resolved[id];
  if (p) return p;
  const chatIds = Object.keys(resolved);
  const pkg = registryPackageFor(id);
  if (pkg) {
    throw new Error(`"${id}" is installed and serves POST /capability/${id}, not /prompt — try one of ${chatIds.join(", ")}`);
  }
  throw new Error(`unknown site "${id}" — try one of ${chatIds.join(", ")}`);
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
export function resolveCapabilityAccount(account: string | undefined, profile: ChatSiteProfile, dataDir: string): void {
  if (!account || account === "default") return;
  const host = new URL(profile.url).host;
  // GOAL 51: canonical resolution — an account reference resolves ONLY on the
  // exact stored identity or the exact stored slug. A write-refused alias
  // ("john  smith" when "John Smith" is stored) 400s here instead of silently
  // driving the survivor's session.
  const match = resolveStoredAccount(dataDir, host, account);
  if (!match) {
    const stored = listAccounts(dataDir, host);
    throw new Error(`no stored account "${account}" for "${host}"; available: [${stored.map((a) => a.slug).join(", ")}]`);
  }
}

export async function startPromptd(opts: PromptdOptions): Promise<PromptdServer> {
  const token = opts.token ?? process.env.UI2API_PROMPTD_TOKEN ?? "";
  const dataDir = opts.dataDir ?? process.env.UI2API_DATA_DIR ?? "data";

  // Build a per-id profile map. When explicit profiles are handed in (CLI
  // `--site X`), serve ONLY those; otherwise serve the full default chat set —
  // builtin catalog + every installed chat-shaped package (duckduckgo, poe,
  // grok, …) so a freshly installed chat package reaches GET /sites, /v1/models
  // and POST /prompt without a restart-wide special-case. A promptd instance
  // still never drives an origin nobody configured: the merged set is exactly
  // what defaultChatProfiles() enumerates (builtin + packaged chat shapes).
  const profileList: ChatSiteProfile[] = [];
  if (opts.profiles) {
    if (Array.isArray(opts.profiles)) {
      profileList.push(...opts.profiles);
    } else {
      profileList.push(...Object.values(opts.profiles));
    }
  } else {
    profileList.push(...defaultChatProfiles());
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

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
        // Await (not `return`) so a rejected handler (e.g. an unknown-account
        // guard throw) lands in this handler's catch as a response — a bare
        // `return <promise>` would orphan the rejection and hang the client.
        await handleOpenAIRoutes(req, res, {
          pool,
          profilesById,
          // The OpenAI surface resolves its profile from the requested model
          // inside the route, so it receives the SAME vault-validating helper
          // the /capability and /prompt branches call directly.
          validateAccount: (account, profile) => resolveCapabilityAccount(account, profile, dataDir),
        });
        return;
      }
      if (req.method === "GET" && req.url === "/sites") {
        return send(res, 200, {
          sites: Object.values(profilesById).map((p) => ({
            id: p.id,
            name: p.name,
            url: p.url,
            loginRequired: p.loginRequired,
            // GOAL 32: every surfaced id carries its status (builtin catalog
            // entry, live-verified package, or unverified-candidate). Dormant/
            // dead-end packages are excluded from this list entirely — their
            // honest status lives on /registry + GET /capabilities/<site>.
            status: chatSurfaceStatus(p.id),
          })),
        });
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
      //
      // Resolution (GOAL 31): the chat-profile set first (byte-identical legacy
      // contract), then the installed capability package — the SAME
      // registryPackageFor → buildRegistryPackages source /registry and
      // /capabilities/<site> serve — so capability-only installed packages
      // (gmail/youtube/araprat/chatglm/…) surface their identity-keyed vault
      // here too. 400 ONLY when neither a profile nor a package exists (the
      // unknown-site throw keeps flowing to the server catch).
      if (req.method === "GET" && req.url?.startsWith("/accounts")) {
        const q = new URL(req.url, "http://localhost");
        const site = q.searchParams.get("site") ?? "";
        if (!site) return send(res, 400, { error: "site is required" });
        let profile: ChatSiteProfile | undefined;
        let idError: unknown;
        try {
          profile = idFrom(site, profilesById);
        } catch (e) {
          idError = e; // not a chat profile — maybe an installed capability-only package
        }
        if (profile) {
          const host = new URL(profile.url).host;
          return send(res, 200, { site: profile.id, host, accounts: listAccounts(dataDir, host) });
        }
        const pkg = registryPackageFor(site);
        if (pkg) {
          return send(res, 200, {
            site: pkg.id,
            host: pkg.url ? new URL(pkg.url).host : null,
            accounts: pkg.accounts ?? [],
          });
        }
        throw idError ?? new Error(`unknown site "${site}"`);
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
            // Identity-keyed vault accounts stored for this site — the SAME
            // source as the peer's registry field (`buildRegistryPackages`
            // derives the host from the packaged profile url) and `/accounts?site=`.
            // `[]` is honest "no accounts stored"; a package with no resolvable url
            // leaves the field absent (undefined) → surface as [].
            accounts: pkg.accounts ?? [],
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
        // GOAL 51: canonical resolution — an unresolvable account (write-refused
        // alias) 400s instead of reading a fingerprint under a folded slug.
        if (!resolveStoredAccount(dataDir, host, account)) {
          const stored = listAccounts(dataDir, host);
          return send(res, 400, {
            error: `no stored account "${account}" for "${host}"; available: [${stored.map((a) => a.slug).join(", ")}]`,
          });
        }
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
        // GOAL 58: read-side truth gate — never serve a malformed/stale
        // fingerprint as truth (a hand-edited or schema-drifted file with
        // valid JSON but the wrong shape would 200 as a real fingerprint).
        // Refuse with the named reason; the account must re-probe.
        const invalid = validateCapabilityReportShape(stored);
        if (invalid) {
          return send(res, 200, {
            site: profile.id,
            host,
            account,
            probed: false,
            error: `stored fingerprint for "${account}" on "${host}" is not a valid CapabilityReport — ${invalid}; re-run \`ui2api profile capabilities ${host} --account ${account}\` to re-probe`,
          });
        }
        return send(res, 200, stored);
      }
      if (req.method === "GET" && req.url === "/status") {
        return send(res, 200, { ok: true, pool: pool.status });
      }
      // OS-level requirements readiness (GOAL 33): the same report the
      // `requirements`/`doctor` command prints, scoped to THIS daemon's surface —
      // the profilesById gate (explicit --site allow-list or the default chat
      // set) as chat packages first, then every installed capability package.
      // Plain GET: no browser, no pool involvement; the only network it may
      // touch is the optional UI2API_ATTACH_PORT probe (an HTTP GET against an
      // already-running Chrome's CDP endpoint).
      if (req.method === "GET" && req.url === "/requirements") {
        const report = await checkRequirements({
          deps: {
            dataDir,
            packages: () =>
              requirementPackagesFor(
                Object.values(profilesById).map((p) => ({ id: p.id, url: p.url, loginRequired: p.loginRequired }))
              ),
          },
        });
        return send(res, 200, report);
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
        // Same identity-keyed guard the /capability routes run: an unknown
        // account is rejected (400) BEFORE any browser work — never a silent
        // fallback to the legacy default session.
        resolveCapabilityAccount(account, profile, dataDir);
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
          profile = resolvePackagedProfile("kimi") ?? resolvePackagedProfileFile("capabilities/kimi/profile.json", "kimi");
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
          profile = resolvePackagedProfile("hunyuan") ?? resolvePackagedProfileFile("capabilities/hunyuan/profile.json", "hunyuan");
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
          profile = resolvePackagedProfile("venice") ?? resolvePackagedProfileFile("capabilities/venice/profile.json", "venice");
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
          profile = resolvePackagedProfileFile("capabilities/deepseek/profile.json", "deepseek");
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
          profile = resolvePackagedProfileFile("capabilities/tencent-aistudio/profile.json", "tencent-aistudio");
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
          profile = resolvePackagedProfileFile("capabilities/claude/profile.json", "claude");
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
          profile = resolvePackagedProfileFile("capabilities/chatgpt/profile.json", "chatgpt");
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
          profile = resolvePackagedProfileFile("capabilities/copilot/profile.json", "copilot");
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
          profile = resolvePackagedProfileFile("capabilities/huggingchat/profile.json", "huggingchat");
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
          profile = resolvePackagedProfileFile("capabilities/youtube/profile.json", "youtube");
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
      // Gmail capability surface — the user's flagship adoption pitch
      // (.brain/verbatim.md:313): mail.google.com abilities callable as API.
      // NOT a chat site — no ChatDriver. GOAL 19 static wire analysis
      // (2026-09-23): mail.google.com is 100% auth-walled (every path 302s to
      // accounts.google.com/ServiceLogin), so every runner selector is
      // DOM-UNVERIFIED known-stable Gmail surface; each call honestly detects
      // the auth wall (redirect → ok:false with the measured two-step unblock)
      // and never fabricates a read or a send. Registry-first,
      // packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/gmail") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real
        // runners) and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("gmail", profilesById);
        } catch {
          profile = resolvePackagedProfileFile("capabilities/gmail/profile.json", "gmail");
        }
        resolveCapabilityAccount(account, profile, dataDir);
        const shared = await pool.sharedBrowser();
        const caps = new GmailCapabilities(profile, { browser: shared, dataDir, account });
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
          profile = resolvePackagedProfileFile("capabilities/araprat/profile.json", "araprat");
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
          profile = resolvePackagedProfile("adapta") ?? resolvePackagedProfileFile("capabilities/adapta/profile.json", "adapta");
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
          profile = resolvePackagedProfile("blackbox") ?? resolvePackagedProfileFile("capabilities/blackbox/profile.json", "blackbox");
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
          profile = resolvePackagedProfile("chatglm") ?? resolvePackagedProfileFile("capabilities/chatglm/profile.json", "chatglm");
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
          profile = resolvePackagedProfile("codex") ?? resolvePackagedProfileFile("capabilities/codex/profile.json", "codex");
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
          profile = resolvePackagedProfile("conol") ?? resolvePackagedProfileFile("capabilities/conol/profile.json", "conol");
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
          profile = resolvePackagedProfile("copilot-m365") ?? resolvePackagedProfileFile("capabilities/copilot-m365/profile.json", "copilot-m365");
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
          profile = resolvePackagedProfile("doubao") ?? resolvePackagedProfileFile("capabilities/doubao/profile.json", "doubao");
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

      // duckduckgo capability surface: ANONYMOUS site (no captured session — or
      // account — is ever needed; VQD tokens are minted at runtime by the site's
      // own JS). duckduckgo_chat is VERIFIED (live headed round-trip 2026-09-22);
      // the remaining declared capabilities run their own honest read paths with
      // ok:false + reason (never login-gated — a login-gated verdict would be a
      // fabricated excuse for an anonymous site).
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
          profile = resolvePackagedProfile("duckduckgo") ?? resolvePackagedProfileFile("capabilities/duckduckgo/profile.json", "duckduckgo");
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
          profile = resolvePackagedProfile("google-ai-search") ?? resolvePackagedProfileFile("capabilities/google-ai-search/profile.json", "google-ai-search");
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
          profile = resolvePackagedProfile("grok") ?? resolvePackagedProfileFile("capabilities/grok/profile.json", "grok");
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
          profile = resolvePackagedProfile("inner-ai") ?? resolvePackagedProfileFile("capabilities/inner-ai/profile.json", "inner-ai");
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
          profile = resolvePackagedProfile("manus") ?? resolvePackagedProfileFile("capabilities/manus/profile.json", "manus");
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
          profile = resolvePackagedProfile("notion") ?? resolvePackagedProfileFile("capabilities/notion/profile.json", "notion");
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
          profile = resolvePackagedProfile("perplexity") ?? resolvePackagedProfileFile("capabilities/perplexity/profile.json", "perplexity");
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
          profile = resolvePackagedProfile("poe") ?? resolvePackagedProfileFile("capabilities/poe/profile.json", "poe");
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
          profile = resolvePackagedProfile("t3chat") ?? resolvePackagedProfileFile("capabilities/t3chat/profile.json", "t3chat");
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
          profile = resolvePackagedProfile("tinycms") ?? resolvePackagedProfileFile("capabilities/tinycms/profile.json", "tinycms");
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
          profile = resolvePackagedProfile("v0") ?? resolvePackagedProfileFile("capabilities/v0/profile.json", "v0");
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
          profile = resolvePackagedProfile("xiaomimimo") ?? resolvePackagedProfileFile("capabilities/xiaomimimo/profile.json", "xiaomimimo");
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
          profile = resolvePackagedProfile("zenmux") ?? resolvePackagedProfileFile("capabilities/zenmux/profile.json", "zenmux");
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
      // GOAL 83: a pool refusal (queue full / page never freed in time /
      // shutdown) answers 503 with a stable code + the NAMED cause, so a client
      // can retry instead of reading a bare server fault.
      const msg = e instanceof Error ? e.message : String(e);
      const refusal = poolRefusal(msg);
      if (refusal) {
        return send(res, 503, { error: { code: refusal.code, message: msg } });
      }
      // 400 for request-shape/identity errors the caller can correct: unknown
      // site, installed-but-not-chat (GOAL 32 two-step idFrom), unknown account.
      send(res, e instanceof Error && /unknown site |no stored account |is installed and serves POST \/capability\//.test(e.message) ? 400 : 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  // The work-route deadline. `requestTimeout: 0` disables Node's OWN 5-minute
  // request timeout: it would kill a long round-trip with an unnamed socket
  // destroy, so the daemon's own deadline below is the single authority and
  // every over-deadline answer is the NAMED shape
  // {error:{code:"request_timeout", message:"request timeout after Nms ..."}}.
  const requestTimeoutMs = resolveRequestTimeoutMs(opts.requestTimeoutMs);
  const server = createServer({ requestTimeout: 0 }, (req, res) => {
    // The routed work; every failure path inside it already answers (the
    // handler's own catch), so this never rejects in practice — the catch here
    // is the last-resort net.
    const work = handleRequest(req, res).catch((e) => {
      send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
    if (!isWorkRoute(req)) {
      void work;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), requestTimeoutMs);
      timer.unref?.();
    });
    void Promise.race([work.then(() => "done" as const, () => "done" as const), deadline]).then((winner) => {
      if (timer) clearTimeout(timer);
      if (winner !== "deadline") return;
      // The browser call cannot be cancelled mid-flight, so it keeps running in
      // the background and the pool is still released by its own handler — but
      // the client gets a NAMED 504 now, and `send`'s guard means the late
      // handler cannot write a second response. `connection: close` because the
      // abandoned request body leaves that socket unusable for keep-alive.
      send(
        res,
        504,
        {
          error: {
            code: "request_timeout",
            message:
              `request timeout after ${requestTimeoutMs}ms on ${req.method} ${req.url} — ` +
              "the browser work outlived the daemon's aggregate deadline; raise UI2API_REQUEST_TIMEOUT_MS to allow more",
          },
        },
        { connection: "close" }
      );
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const shutdownGraceMs =
    Number.isFinite(opts.shutdownGraceMs) && (opts.shutdownGraceMs as number) > 0
      ? Math.floor(opts.shutdownGraceMs as number)
      : envMs("UI2API_SHUTDOWN_GRACE_MS", DEFAULT_SHUTDOWN_GRACE_MS);
  return {
    server,
    port,
    close: async () => {
      // Stop accepting new work. In-flight requests keep their sockets while
      // they finish, but only for a bounded grace — after that whatever is
      // still open is destroyed. Without this bound a wedged request (or one
      // parked on a pool page) held the close promise open forever and SIGINT /
      // SIGTERM could not stop promptd: the un-stoppable daemon. The pool's
      // close() then settles every queued waiter with a named cause, so those
      // handlers answer instead of hanging.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Idle keep-alive sockets are not in-flight work — close them now instead
      // of waiting out their keep-alive timeout (a client that never asks again
      // must not hold the daemon open for seconds).
      server.closeIdleConnections();
      const grace = setTimeout(() => {
        server.closeAllConnections();
      }, shutdownGraceMs);
      grace.unref?.();
      try {
        await closed;
      } finally {
        clearTimeout(grace);
      }
      await pool.close();
    },
  };
}
