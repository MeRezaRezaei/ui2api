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
//   GET  /status  -> pool state (warm/idle/busy pages) + `liveness` — the honest
//                 browser probe (up|down|unknown), when it last ran, the reaper's
//                 state and its last measured sweep, plus per-worker detail
//                 (site, busyMs, in-flight account)
//   GET  /requirements -> OS-level readiness report (GOAL 33 — the same data
//                 `ui2api requirements` prints: per-package verdict
//                 ready/working/on-hold/not-ready with named reasons, BEFORE
//                 any browser work), scoped to this daemon's profilesById gate
//                 + every installed capability package
//   GET  /health  -> {ok, defaultSite, sites, pool, liveness}
//   GET  /requests -> the bounded request ring (GOAL 87): the last N requests
//                 with {method, path, status, durationMs, site, account,
//                 outcome} so a wedged or refused request is visible. Prompts,
//                 answers, cookies and tokens are NEVER recorded.
//
// Bound to 127.0.0.1 by default; optionally guarded by a bearer token
// (UI2API_PROMPTD_TOKEN). The server owns a stand-by page pool (one headless
// browser, `min` warmed pages, `max` cap from UI2API_POOL_MAX / free memory) so
// prompts hit already-loaded pages and can run in parallel.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ChatPool, type PoolStatus } from "./pool.js";
import { daemonPosture } from "./posture.js";
import { handleOpenAIRoutes } from "./openai.js";
import { CAPABILITY_DISPATCH, dispatchableSiteIds, type CapabilityRunner } from "./capability-dispatch.js";
import { buildRegistryPackages, buildRegistryContract, defaultChatProfiles, chatSurfaceStatus, type RegistryPackage } from "./registry.js";
import { checkRequirements, requirementPackagesFor } from "../runtime/requirements.js";
import { defaultSiteId, resolveProfile, resolvePackagedProfile, resolvePackagedProfileFile, type ChatSiteProfile } from "../profile/profile.js";
import { listAccounts, slugifyIdentity, loadCapabilities, resolveStoredAccount, assertUsableStoredAccount } from "../runtime/session-store.js";
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

// GOAL 140: site id -> runner CLASS, the static half of the dispatch table. The
// class imports stay static on purpose: a dynamic import keyed off a URL or a
// package field would turn any registry content into executable code. The
// registry decides WHICH site; this map decides WHICH class, and only ids that
// appear in CAPABILITY_DISPATCH can reach it.
const CAPABILITY_RUNNERS: Readonly<Record<string, CapabilityRunner>> = {
  "adapta": AdaptaCapabilities,
  "araprat": ArapratCapabilities,
  "blackbox": BlackboxCapabilities,
  "chatglm": ChatglmCapabilities,
  "chatgpt": ChatGPTCapabilities,
  "claude": ClaudeCapabilities,
  "codex": CodexCapabilities,
  "conol": ConolCapabilities,
  "copilot": CopilotCapabilities,
  "copilot-m365": CopilotM365Capabilities,
  "deepseek": DeepSeekCapabilities,
  "doubao": DoubaoCapabilities,
  "duckduckgo": DuckduckgoCapabilities,
  "gemini": GeminiCapabilities,
  "gmail": GmailCapabilities,
  "google-ai-search": GoogleAiSearchCapabilities,
  "grok": GrokCapabilities,
  "huggingchat": HuggingChatCapabilities,
  "hunyuan": HunyuanCapabilities,
  "inner-ai": InnerAiCapabilities,
  "kimi": KimiCapabilities,
  "manus": ManusCapabilities,
  "notion": NotionCapabilities,
  "perplexity": PerplexityCapabilities,
  "poe": PoeCapabilities,
  "t3chat": T3chatCapabilities,
  "tencent-aistudio": TencentAistudioCapabilities,
  "tinycms": TinycmsCapabilities,
  "v0": V0Capabilities,
  "venice": VeniceCapabilities,
  "xiaomimimo": XiaomimimoCapabilities,
  "youtube": YouTubeCapabilities,
  "zenmux": ZenmuxCapabilities,
};


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
  /* GOAL 87 — the pool's liveness reaper interval (0 disables it). Env:
     UI2API_REAPER_INTERVAL_MS. The daemon starts it explicitly and pool.close()
     stops it — never a bare module-level timer. */
  reaperIntervalMs?: number;
  /* GOAL 87 — test seam: hand the daemon a pre-built pool (already saturated,
     fake drivers) so pool-saturated refusals can be exercised over the wire
     without launching a browser. Omitted in production: the daemon builds its
     own pool and warms it. */
  pool?: ChatPool;
}

export interface PromptdServer {
  server: Server;
  port: number;
  /* GOAL 87 — the same pool /status reports, and the same request ring
     GET /requests serves, so a caller (and a test) can assert on the exact
     object rather than on a JSON round-trip. */
  pool: ChatPool;
  requestLog: RequestLog;
  close(): Promise<void>;
}

/* ── GOAL 87 — the bounded request ring ─────────────────────────────────────
 *
 * Before this the daemon logged nothing at all outside UI2API_DEBUG: a wedged
 * request was invisible ("busy: 1" with no start time, no site, no account, no
 * elapsed time), so the only diagnosis was attaching a debugger.
 *
 * What is recorded is deliberately minimal and non-secret: method, path (the
 * PATHNAME — the query string is dropped, because it can carry anything),
 * status, durationMs, site, account, outcome. The prompt, the messages, the
 * answer, cookies, headers and tokens are NEVER read out of the request: only
 * `site`/`model`/`account` are, and the no-secret pin enforces that.
 *
 * It is a RING: bounded to `limit` entries (default 20, UI2API_REQUEST_LOG), the
 * oldest evicted on overflow, in memory only, no disk writes. */
export interface RequestLogEntry {
  seq: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  site: string | null;
  account: string | null;
  /* "done"     — the route answered 2xx/3xx.
     "timeout"  — the daemon's aggregate deadline cut it off (504).
     "refused"  — the request was NOT served: a 4xx shape/identity error, a 5xx
                   fault, or a 503 pool refusal (saturated / queue timeout /
                   closed). The status code beside it carries the real code. */
  outcome: "done" | "timeout" | "refused";
  startedAt: string;
}

const DEFAULT_REQUEST_LOG_SIZE = 20;
/* A hard ceiling on the knob so UI2API_REQUEST_LOG can never turn a bounded ring
   into unbounded growth. */
const MAX_REQUEST_LOG_SIZE = 500;

function requestLogSize(explicit?: number): number {
  if (Number.isFinite(explicit) && explicit !== undefined) {
    return Math.max(0, Math.min(MAX_REQUEST_LOG_SIZE, Math.floor(explicit as number)));
  }
  const raw = Number(process.env.UI2API_REQUEST_LOG);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(MAX_REQUEST_LOG_SIZE, Math.floor(raw));
  return DEFAULT_REQUEST_LOG_SIZE;
}

function outcomeFor(status: number): RequestLogEntry["outcome"] {
  if (status === 504) return "timeout";
  return status >= 400 ? "refused" : "done";
}

export class RequestLog {
  private ring: RequestLogEntry[] = [];
  private nextSeq = 1;
  private open = 0;
  readonly limit: number;

  constructor(limit?: number) {
    this.limit = requestLogSize(limit);
  }

  /* How many requests are in flight RIGHT NOW. A wedge is visible here before
     the deadline cuts it: inFlight>0 with no finished entry beside it. */
  get inFlight(): number {
    return this.open;
  }

  list(): RequestLogEntry[] {
    return this.ring.map((e) => ({ ...e }));
  }

  /* Start a record for one request and get the finisher. The finisher is
     idempotent (end + close can both fire for one request) and decrements the
     in-flight count exactly once, so `inFlight` can never leak upwards. */
  begin(method: string, path: string): (fields: { status: number; site?: string | null; account?: string | null }) => void {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    this.open++;
    let closed = false;
    return (fields) => {
      if (closed) return;
      closed = true;
      this.open = Math.max(0, this.open - 1);
      if (this.limit <= 0) return;
      const status = Math.trunc(fields.status);
      this.ring.push({
        seq: this.nextSeq++,
        method,
        path,
        status,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        site: fields.site ?? null,
        account: fields.account ?? null,
        outcome: outcomeFor(status),
        startedAt,
      });
      while (this.ring.length > this.limit) this.ring.shift();
    };
  }
}

/* Site + account for the log, read from what the route already parsed. The
   parsed body is cached on the request (readJson), so no route has to be edited
   to become visible — and nothing else is ever read out of the body: the
   prompt, the messages and the args stay out of the log. */
function requestIdentity(req: IncomingMessage, url: string): { site: string | null; account: string | null } {
  const body = (req as IncomingMessage & { bodyCache?: Record<string, unknown> }).bodyCache;
  const text = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t.slice(0, 120) : null;
  };
  const q = url.includes("?") ? new URL(url, "http://localhost") : null;
  const cap = /^\/(?:capabilities|capability|v1\/chat)\/([^/?#]+)/.exec(url);
  const site = text(body?.site) ?? text(body?.model) ?? (cap ? text(decodeURIComponent(cap[1])) : null) ?? (q ? text(q.searchParams.get("site")) : null);
  const account = text(body?.account) ?? (q ? text(q.searchParams.get("account")) : null);
  return { site, account };
}

// The log's honest liveness block: the daemon answered (that is what makes
// `daemon:"up"` a measurement, not a claim) and the browser state is the REAL
// probe from pool.status, never the old null-check.
function livenessBlock(st: PoolStatus): Record<string, unknown> {
  return {
    daemon: "up",
    browser: st.browser,
    browserProbe: st.browserProbe,
    browserCheckedAt: st.browserCheckedAt,
    reaper: st.reaper,
    lastSweep: st.lastSweep,
  };
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

/**
 * GOAL 104: a typed client fault. Before this, a body of literal `null` was
 * accepted as a "body object", the handler's `body.prompt` threw a TypeError,
 * and the last-resort net answered `500 {"error":"Cannot read properties of
 * null (reading 'prompt')"}` — a caller mistake rendered as a server fault with
 * a JavaScript internal string. A caller mistake is a 4xx with a NAMED code.
 */
export class HttpClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpClientError";
  }
}

const MAX_BODY_BYTES = 1e6;

/**
 * GOAL 117: all 32 `/capability/<site>` handlers answered
 * `500 {ok:false, error: e.message}` — echoing internal exception text (an
 * absolute path, a hostname, a library internal, a selector string) straight to
 * any caller. This is the same class GOAL 104 fixed on the request-level net,
 * which is exactly why it survived: the criterion that "passed" was scoped to
 * the region GOAL 104 had touched, and the readiness gate caught it by
 * re-deriving from the WHOLE file.
 *
 * The failure stays a real, useful 500 with the capability id and a stable
 * reason_code — only the raw internal text is removed. `UI2API_DEBUG=1` still
 * prints the full error server-side, where an operator can see it.
 */
function capabilityFailure(capability: string, err: unknown): string {
  if (process.env.UI2API_DEBUG === "1") {
    console.error(`[ui2api] capability ${capability} failed:`, err);
  }
  return `capability "${capability}" failed inside the runner — see the daemon log (UI2API_DEBUG=1) for the internal error`;
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
      if (body.length > MAX_BODY_BYTES) {
        // Stop the upload: without this the client keeps streaming megabytes at
        // a server that already refused the request.
        req.destroy();
        reject(new HttpClientError(413, "payload_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`));
      }
    });
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        // A JSON body must be an OBJECT. `null`, an array, a string and a number
        // all parse fine and would otherwise be handed to a handler that reads
        // `body.<field>` — a TypeError surfacing as a 500.
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new HttpClientError(400, "invalid_json", "request body must be a JSON object"));
          return;
        }
        (req as IncomingMessage & { bodyCache?: Record<string, unknown> }).bodyCache = parsed as Record<string, unknown>;
        resolve(parsed as Record<string, unknown>);
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
  // GOAL 124: an index ROW is only a claim. The snapshot behind it can be
  // missing, corrupt-JSON, wrong-shaped (GOAL 59) or anonymous (GOAL 49) — and
  // the runners' own `loadAccountSnapshot` returns null for all of them, which
  // used to degrade into an anonymous run that still answered ok:true. Judge it
  // HERE, on the pre-browser guard, so an unusable account is a 400 before a
  // single browser is launched. The unknown-account message above is unchanged.
  assertUsableStoredAccount(dataDir, host, match);
}

export async function startPromptd(opts: PromptdOptions): Promise<PromptdServer> {
  const token = opts.token ?? process.env.UI2API_PROMPTD_TOKEN ?? "";
  // GOAL 100: the SAME bind address the listener uses, resolved up front so the
  // posture report can never disagree with where we actually listen.
  const bindAddr = opts.host ?? "127.0.0.1";
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
  // (opts.pool is a test seam — a pre-built pool, no warm, so pool saturation
  // can be exercised over the wire without a browser.)
  const pool =
    opts.pool ??
    new ChatPool({
      profiles: profileList,
      min: opts.min,
      max: opts.max,
      defaultProfile: defaultSiteId(),
      dataDir,
      reaperIntervalMs: opts.reaperIntervalMs,
    });
  // Warm lazily on first use per site; if boot warm failed (site changed / site
  // down), keep going — requests will open pages on demand.
  if (!opts.pool) await pool.warm().catch(() => undefined);
  // GOAL 87: the liveness reaper, started EXPLICITLY. Without it a page that
  // died while idle kept reporting warm/idle forever (the only liveness check
  // lived inside release()), and the respawn only happened when a REQUEST
  // arrived — which a health-checker polling /status never does. Owned by the
  // pool: pool.close() stops it, so a stopped daemon is a stopped daemon.
  pool.startReaper(opts.reaperIntervalMs);
  // GOAL 87: the bounded request ring. Per-server (never module state), so one
  // daemon's log can never leak into another's — and never into a test's.
  const requestLog = new RequestLog();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // GOAL 87: open a ring record and capture the answer. Every response path
    // ends the response (send(), the /v1 SSE stream, the deadline's 504), so
    // wrapping `end` catches them all without editing a single route. The ring
    // never records ITSELF (reading the log must not append to it) — but
    // /status and /health ARE recorded, because a refused or wedged health check
    // is exactly what you want to see.
    const url = req.url ?? "/";
    const finish = url.startsWith("/requests")
      ? null
      : requestLog.begin(req.method ?? "GET", url.split("?")[0].slice(0, 200));
    if (finish) {
      const end = res.end.bind(res);
      (res as unknown as { end: (...args: unknown[]) => unknown }).end = (...args: unknown[]) => {
        // 499: the socket went away before any answer — the daemon never
        // finished serving this request, which is exactly what a client hang-up
        // looks like from here. Never logged as a 2xx.
        const status = res.headersSent ? res.statusCode : 499;
        finish({ status: status || 499, ...requestIdentity(req, url) });
        return end(...(args as []));
      };
      // A client that hangs up mid-request never reaches `end`; finalize on close
      // so the in-flight count cannot leak upwards and a vanished request is
      // still visible in the ring.
      res.on("close", () => finish({ status: res.headersSent ? res.statusCode || 499 : 499, ...requestIdentity(req, url) }));
    }
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
          // GOAL 111: the operator's allow-list must bind EVERY surface. These
          // 32 routes used to step around `profilesById` via a `catch` that
          // re-resolved a PACKAGED profile from disk, so a `promptd --site
          // gemini` daemon still dispatched a runner — launching a browser and
          // replaying a captured session — for every installed site. That
          // contradicted the documented posture ("answers ONLY the profiles
          // handed to it at startup").
          //
          // Only an EXPLICIT allow-list narrows the surface. A default daemon
          // (no opts.profiles) keeps serving every declared capability exactly
          // as before, because `profilesById` there is just the chat set and
          // capability sites are legitimately wider.
          if (opts.profiles && !profilesById[site]) {
            const allowed = Object.keys(profilesById);
            return send(res, 400, {
              error:
                `"${site}" is not in this daemon's configured allow-list [${allowed.join(", ")}] — ` +
                `this daemon was started with an explicit site list, so it serves only those sites`,
            });
          }
          const pkg = registryPackageFor(site);
          if (pkg) {
            const body = await readJson(req);
            const capability = String(body.capability ?? "");
            if (!capability) return send(res, 400, { error: "capability is required" });
            const available = pkg.tools.map((t) => t.id);
            if (!available.includes(capability)) {
              return send(res, 400, {
                error: {
                  code: "unknown_capability",
                  message: `unknown capability "${capability}" for "${site}"; available: [${available.join(", ")}]`,
                },
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
          ...buildRegistryContract(Boolean(process.env.UI2API_PROMPTD_TOKEN)),
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
            error: {
              code: "no_stored_account",
              message: `no stored account "${account}" for "${host}"; available: [${stored.map((a) => a.slug).join(", ")}]`,
            },
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
        const st = pool.status;
        // GOAL 100: disclose the daemon's OWN posture (auth mode + active
        // trust knobs) so "is it safe to expose this?" is answerable without
        // reading the source. Shapes/counts only — never a token value.
        return send(res, 200, { ok: true, pool: st, liveness: livenessBlock(st), posture: daemonPosture(process.env, bindAddr) });
      }
      // GOAL 87 — the bounded request ring, read-only. Same localhost-only +
      // optional-bearer posture as every other route here (it lives behind the
      // same auth check at the top of the handler). It exposes method, path,
      // status, duration, site, account and outcome — nothing else: no prompt,
      // no answer, no cookie, no token, no headers, and the query string is
      // dropped from `path`.
      if (req.method === "GET" && (req.url === "/requests" || req.url === "/requests/")) {
        return send(res, 200, {
          ok: true,
          limit: requestLog.limit,
          inFlight: requestLog.inFlight,
          requests: requestLog.list(),
        });
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
        const st = pool.status;
        return send(res, 200, { ok: true, defaultSite: defaultSiteId(), sites: Object.keys(profilesById), pool: st, posture: daemonPosture(process.env, bindAddr), liveness: livenessBlock(st) });
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
          // GOAL 109: a restriction wall is NOT an ok:true empty answer. The
          // named hits must reach the caller, and ok must be false so no client
          // can mistake a paywall/limit/login wall for a completed prompt.
          if (result.doneReason === "restricted") {
            return send(res, 200, {
              ...result,
              ok: false,
              doneReason: "restricted",
              reason: "restriction wall detected (paywall, plan limit, or login required)",
              restrictions: result.restrictions ?? [],
            });
          }
          return send(res, 200, { ok: true, ...result });
        } catch (e) {
          await pool.release(worker);
          throw e;
        }
      }
      // GOAL 140: ONE table-driven capability handler replaces 33 copy-pasted
      // `if (req.url === "/capability/<site>")` blocks (54,851 chars). The table
      // (src/prompt/capability-dispatch.ts) is the single place a site becomes
      // dispatchable, and it is DATA — so registering a site is adding a package
      // plus one table row, not editing a 1,700-line HTTP handler. The three
      // measured shapes (shared browser / account validation / packaged-profile
      // fallback) are now data on the row instead of copy-paste.
      if (req.method === "POST" && req.url?.startsWith("/capability/")) {
        const site = req.url.slice("/capability/".length);
        const entry = CAPABILITY_DISPATCH[site];
        if (!entry) {
          // Named, not a bare 404: a consumer that trusted /registry deserves to
          // know the site is DECLARED but not dispatched, with what does exist.
          return send(res, 404, {
            // GOAL 143: a code like every other refusal, so a client reads the
            // name instead of regex-matching our English prose. The message and
            // the dispatchable list stay — they are the actionable part.
            error: { code: "site_not_dispatched", message: `unknown site "${site}"` },
            reason_code: "site_not_dispatched",
            dispatchable: dispatchableSiteIds(),
          });
        }
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        // Identity-keyed account (same contract as /prompt `account`): empty /
        // "default" = legacy shared session; explicit -> validated (real runners)
        // and forwarded to the runner constructor opts below.
        const account = typeof body.account === "string" && body.account ? body.account : undefined;
        let profile: ChatSiteProfile;
        try {
          profile = idFrom(site, profilesById);
        } catch {
          profile = entry.packagedFallback
            ? (resolvePackagedProfile(site) ?? resolvePackagedProfileFile(`capabilities/${site}/profile.json`, site))
            : resolvePackagedProfileFile(`capabilities/${site}/profile.json`, site);
        }
        // Resolve the account BEFORE any browser work, so a nonexistent account
        // never spins Chrome up.
        if (entry.account) resolveCapabilityAccount(account, profile, dataDir);
        // Reuse the pool's logged-in browser: a fresh per-request browser lands
        // on the signed-out landing shell and DOM/RPC reads fail. Sharing the
        // pool browser keeps the proven session AND avoids a second Chrome.
        const shared = entry.shared ? await pool.sharedBrowser() : undefined;
        const Runner = CAPABILITY_RUNNERS[site];
        const caps = new Runner(profile, { browser: shared, dataDir, account });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: capabilityFailure(capability, e), reason_code: "runner_error" });
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
      // MEASURED BUG (CI pipeline 193, pre-existing — reproduced at HEAD in a
      // pristine worktree before I touched it): this guard matched
      // `is installed and serves chat`, a wording that NO LONGER EXISTS. The
      // message idFrom throws is `"<id>" is installed and serves POST /capability/<id>`,
      // so the guard never fired and a caller who asked a capability-only site on
      // /prompt got a 500 "internal error" — the actionable "try /capability/<id>"
      // guidance was swallowed and replaced by a generic fault. A client cannot
      // correct itself from "internal error". One regex, one wording, kept
      // together below so the guard and the code cannot drift apart again.
      const SHAPE_MESSAGES = [
        { re: /unknown site /, code: "unknown_site" },
        { re: /no stored account /, code: "no_stored_account" },
        { re: /is installed and serves POST \/capability/, code: "not_chat" },
        { re: /unknown capability /, code: "unknown_capability" },
      ] as const;
      const isRequestShape = e instanceof Error && SHAPE_MESSAGES.some((m) => m.re.test(e.message));
      // GOAL 143: a request-shape refusal now carries a MACHINE code beside its
      // named message, like every other refusal the daemon sends. Measured: this
      // branch sent a bare `error: "<string>"`, so a client could only recover the
      // code by regex-matching our ENGLISH PROSE — and the generated PHP client
      // did exactly that (lang-php.ts codeFor()). Reword the message and every
      // generated client silently degrades to `http_<status>`. The message is kept
      // verbatim (the caller can correct it); the code is what code should be.
      // Substring, not `^`-anchored: MEASURED BUG in my first cut — the
      // not-a-chat message is `"<id>" is installed and serves POST /capability/<id>`,
      // which STARTS WITH THE SITE ID IN QUOTES, so `/^is installed/` could never
      // match and `not_chat` was unreachable. The `^` forms below would have had
      // the same fate for any reworded prefix. The codes are what clients branch
      // on, so they must not depend on where the sentence starts.
      const shapeCode = isRequestShape
        ? SHAPE_MESSAGES.find((m) => m.re.test(msg))?.code ?? "bad_request"
        : null;
      // GOAL 117: a request-shape error keeps its NAMED message (the caller can
      // correct it); anything else is an internal fault and must NOT echo the
      // internal text to the client.
      send(res, isRequestShape ? 400 : 500, shapeCode
        ? { error: { code: shapeCode, message: e instanceof Error ? e.message : String(e) } }
        : { error: { code: "internal_error", message: "internal error" } });
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
      // GOAL 104: a caller mistake keeps its named 4xx; a REAL internal fault
      // still answers 500 — but neither may echo the internal message, which can
      // carry absolute paths, hostnames or library internals to a client.
      if (e instanceof HttpClientError) {
        send(res, e.status, { error: { code: e.code, message: e.message } });
        return;
      }
      if (process.env.UI2API_DEBUG === "1") console.error("[ui2api] unhandled request error:", e);
      send(res, 500, { error: { code: "internal_error", message: "internal error" } });
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

  const host = bindAddr;
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
    pool,
    requestLog,
    close: async () => {
      // GOAL 87: stop the liveness reaper at the very START of the shutdown, so
      // no sweep can race a closing pool (and so a stopped daemon leaves nothing
      // behind that could keep the process alive). Idempotent — pool.close()
      // stops it again.
      pool.stopReaper();
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
