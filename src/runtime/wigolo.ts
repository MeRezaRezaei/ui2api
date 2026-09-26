// Zero-dependency HTTP client for a local wigolo daemon (https://github.com/KnockOutEZ/wigolo).
//
// ui2api talks to wigolo over loopback HTTP only — no wigolo code is imported or
// vendored, so the MIT/AGPL boundary stays clean. wigolo runs wherever the agent
// runs ("wigolo serve", or this module can spawn one) and exposes:
//   GET  /health                 -> { status: "healthy" }
//   POST /v1/fetch               -> FetchOutput (200) or error envelope
//   POST /v1/extract             -> ExtractOutput (200) or error envelope
//
// The daemon is loopback-open by default: no token is required on 127.0.0.1.
// If it is bound off-loopback, WIGOLO_API_TOKEN is sent as a Bearer token.
//
// LOOPBACK-ONLY GATE: that second sentence is not a licence to point anywhere.
// A base that is not loopback RECEIVES the WIGOLO_API_TOKEN bearer credential
// and has its payloads returned verbatim as MCP tool results — a hostile base
// could answer 200 with a FABRICATED page, which the project's no-fabricated-
// traffic rule forbids outright. So every configured endpoint (the daemon base
// and the forwarded CDP endpoint) must be loopback; an explicit
// UI2API_WIGOLO_ALLOW_REMOTE=1 is the only way out, and even then the bearer
// token is NEVER attached (see resolveDaemonBase / wigoloRequest).

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, statSync } from "node:fs";
import { constants as FS } from "node:fs";

export type WigoloAction =
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "wait"; ms: number }
  | { type: "wait_for"; selector: string; timeout?: number }
  | { type: "scroll"; direction: "down" | "up"; amount?: number }
  | { type: "screenshot" }
  | { type: "paste"; selector: string; text: string }
  | { type: "keys"; selector?: string; keys: string[] }
  | { type: "capture"; selector: string; untilMs?: number }
  | { type: "status"; selector?: string };

export interface WigoloFetchInput {
  url: string;
  render_js?: "auto" | "always" | "never";
  use_auth?: boolean;
  max_chars?: number;
  max_content_chars?: number;
  section?: string;
  section_index?: number;
  screenshot?: boolean;
  headers?: Record<string, string>;
  actions?: WigoloAction[];
  force_refresh?: boolean;
  max_tokens_out?: number;
}

export interface WigoloActionResult {
  action_index: number;
  type: string;
  success: boolean;
  error?: string;
  screenshot?: string;
  output?: unknown;
}

export interface WigoloFetchOutput {
  url: string;
  title: string;
  markdown: string;
  metadata: Record<string, unknown>;
  links: string[];
  images: string[];
  cached: boolean;
  stale?: boolean;
  js_required?: boolean;
  fetch_method?: string;
  http_status?: number;
  challenge_class?: string;
  solve_method?: string | null;
  action_results?: WigoloActionResult[];
  error?: string;
  error_reason?: string;
}

export interface WigoloExtractInput {
  url?: string;
  html?: string;
  mode?: "selector" | "tables" | "metadata" | "schema" | "structured" | "brand";
  css_selector?: string;
  multiple?: boolean;
  schema?: Record<string, unknown>;
  execution_mode?: string;
}

export interface WigoloExtractOutput {
  data: unknown;
  source_url?: string;
  mode?: string;
  error?: string;
  warnings?: string[];
}

export interface WigoloClientOpts {
  base?: string;
  timeoutMs?: number;
}

function daemonToken(): string | undefined {
  return process.env.WIGOLO_API_TOKEN || undefined;
}

/** The one explicit escape hatch for a genuinely remote wigolo daemon. */
export const WIGOLO_ALLOW_REMOTE_ENV = "UI2API_WIGOLO_ALLOW_REMOTE";

/** Upper bound on a forwarded Playwright storage-state file (bytes). */
export const WIGOLO_AUTH_STATE_MAX_BYTES = 32 * 1024 * 1024;

function allowRemote(): boolean {
  const v = process.env[WIGOLO_ALLOW_REMOTE_ENV];
  return v === "1" || v === "true";
}

/** 127.0.0.0/8, ::1, or `localhost`. Case-insensitive; IPv6 brackets tolerated. */
export function isLoopbackHost(rawHost: string): boolean {
  const h = rawHost.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return false;
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  return v4.slice(1).every((part) => Number(part) <= 255) && Number(v4[1]) === 127;
}

const ALLOWED_SCHEMES = new Set(["http", "https", "ws", "wss", "cdp"]);

// [scheme]://host[:port][/path]  OR  bare host[:port]
const ENDPOINT_RE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\[[0-9a-fA-F:.]+\]|[^/:?\s]+)(?::(\d{1,5}))?(?:[/?#].*)?$/;

/**
 * Refuse a configured wigolo endpoint that is not loopback (or not http/https),
 * naming BOTH the env var and the offending host. Throwing is deliberate: a typo
 * must fail loudly rather than silently repoint the whole engine — and with it
 * the WIGOLO_API_TOKEN credential — at an arbitrary host.
 */
export function assertLoopbackEndpoint(raw: string, envVar: string): { host: string; loopback: boolean } {
  const m = ENDPOINT_RE.exec(raw.trim());
  if (!m) {
    throw new Error(
      `wigolo refused ${envVar}="${raw}": not a host[:port] or URL (expected e.g. http://127.0.0.1:3333)`
    );
  }
  const scheme = (m[1] ?? "").toLowerCase();
  if (scheme && !ALLOWED_SCHEMES.has(scheme)) {
    throw new Error(
      `wigolo refused ${envVar}="${raw}": scheme "${scheme}:" is not allowed (only ${[...ALLOWED_SCHEMES].join(", ")} over loopback HTTP)`
    );
  }
  if (m[3] !== undefined) {
    const p = Number(m[3]);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`wigolo refused ${envVar}="${raw}": port ${m[3]} is not an integer in 1-65535`);
    }
  }
  const host = m[2];
  const loopback = isLoopbackHost(host);
  if (!loopback && !allowRemote()) {
    throw new Error(
      `wigolo refused ${envVar}="${raw}": host ${host} is not loopback. ` +
        `ui2api talks to wigolo over loopback HTTP only — an off-loopback base would receive the WIGOLO_API_TOKEN bearer credential and its payloads are returned verbatim as tool results. ` +
        `Point ${envVar} at 127.0.0.1 / ::1 / localhost, or set ${WIGOLO_ALLOW_REMOTE_ENV}=1 to override this explicitly.`
    );
  }
  return { host, loopback };
}

/** Integer 1-65535, or a NAMED refusal — never `http://127.0.0.1:NaN`. */
export function validateWigoloDaemonPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 3333;
  const t = raw.trim();
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t)) || Number(t) < 1 || Number(t) > 65535) {
    throw new Error(`wigolo refused WIGOLO_DAEMON_PORT="${raw}": expected an integer in 1-65535 (got ${raw})`);
  }
  return Number(t);
}

/** The resolved base plus whether it is loopback (the token-attach gate). */
export interface ResolvedWigoloBase {
  base: string;
  loopback: boolean;
}

export function resolveDaemonBase(explicitBase?: string): ResolvedWigoloBase {
  if (explicitBase !== undefined && explicitBase !== "") {
    const { loopback } = assertLoopbackEndpoint(explicitBase, "the wigolo base URL (opts.base)");
    return { base: explicitBase.replace(/\/+$/, ""), loopback };
  }
  const url = process.env.WIGOLO_DAEMON_URL;
  if (url && url.trim() !== "") {
    const { loopback } = assertLoopbackEndpoint(url, "WIGOLO_DAEMON_URL");
    return { base: url.replace(/\/+$/, ""), loopback };
  }
  const port = validateWigoloDaemonPort(process.env.WIGOLO_DAEMON_PORT);
  return { base: `http://127.0.0.1:${port}`, loopback: true };
}


// A health probe carries no credential, but the base is still gated: a
// non-loopback base is refused here too, so a hostile host is never contacted
// even by the cheap probe that runs before the autostart spawn.
export async function wigoloHealth(base?: string): Promise<boolean> {
  let target: string;
  try {
    target = resolveDaemonBase(base).base;
  } catch {
    return false;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${target}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "healthy";
  } catch {
    return false;
  }
}

export interface WigoloDaemonHandle {
  base: string;
  owned: boolean;
  stop(): Promise<void>;
}

export interface EnsureDaemonOpts {
  bin?: string;
  base?: string;
  timeoutMs?: number;
}

const DEFAULT_DAEMON_TIMEOUT_MS = 60_000;

function wigoloBin(argv0?: string): string[] {
  if (argv0) return [argv0, "serve"];
  // `npx -y wigolo serve` fetches the published package — no install, no repo clone needed.
  return ["npx", "-y", "wigolo", "serve"];
}

/**
 * Forward the user's real-Chrome config into the daemon so wigolo's auth reuse
 * drives the SAME browser and profile ui2api uses — the core of the "user's own
 * browser" vision. Maps UI2API_* to wigolo's WIGOLO_* keys, only when a value
 * is actually set (an explicit WIGOLO_* wins).
 *
 * Every forwarded knob is VALIDATED here, i.e. strictly BEFORE spawn(): a bad
 * value throws naming the offending knob and no process is started. Validation
 * never weakens autostart — a well-formed config still spawns exactly as before.
 */
export function buildWigoloDaemonEnv(): Record<string, string> {
  const daemonEnv: Record<string, string> = { ...process.env, WIGOLO_API_TOKEN: daemonToken() ?? "" };
  const chromeProfile =
    process.env.WIGOLO_CHROME_PROFILE_PATH ?? process.env.UI2API_USER_DATA_DIR ?? process.env.UI2API_CHROME_PROFILE_PATH;
  const cdp = process.env.WIGOLO_CDP_URL ?? process.env.UI2API_CDP_URL;
  const authState = process.env.WIGOLO_AUTH_STATE_PATH ?? process.env.UI2API_AUTH_STATE_PATH;
  if (chromeProfile) daemonEnv.WIGOLO_CHROME_PROFILE_PATH = chromeProfile;
  if (cdp && cdp.trim() !== "") {
    // Same loopback-or-opt-in gate as the daemon base: a remote CDP endpoint is
    // a remote browser-control channel, so it is never forwarded silently.
    assertLoopbackEndpoint(cdp, "WIGOLO_CDP_URL");
    daemonEnv.WIGOLO_CDP_URL = cdp;
  }
  if (authState && authState.trim() !== "") {
    validateWigoloAuthStatePath(authState);
    daemonEnv.WIGOLO_AUTH_STATE_PATH = authState;
  }
  return daemonEnv;
}

/** An existing, readable, size-bounded regular file — or a named refusal. */
export function validateWigoloAuthStatePath(raw: string): string {
  const p = raw.trim();
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch (e) {
    throw new Error(
      `wigolo refused WIGOLO_AUTH_STATE_PATH="${raw}": not an existing readable file (${(e as NodeJS.ErrnoException).code ?? "stat failed"})`
    );
  }
  if (!st.isFile()) {
    throw new Error(`wigolo refused WIGOLO_AUTH_STATE_PATH="${raw}": not a regular file`);
  }
  if (st.size > WIGOLO_AUTH_STATE_MAX_BYTES) {
    throw new Error(
      `wigolo refused WIGOLO_AUTH_STATE_PATH="${raw}": ${st.size} bytes exceeds the ${WIGOLO_AUTH_STATE_MAX_BYTES}-byte bound`
    );
  }
  try {
    accessSync(p, FS.R_OK);
  } catch {
    throw new Error(`wigolo refused WIGOLO_AUTH_STATE_PATH="${raw}": not readable`);
  }
  return p;
}

// Ensure a healthy wigolo daemon is reachable. If none is answering on the
// configured base URL, spawn one (WIGOLO_BIN, else npx `wigolo`) unless
// UI2API_WIGOLO_AUTOSTART=0. Returns a handle with `owned` set when this call
// started the daemon (caller should stop() it when done).
export async function ensureWigoloDaemon(opts: EnsureDaemonOpts = {}): Promise<WigoloDaemonHandle> {
  // Gate the base BEFORE the health probe: a non-loopback base must throw, not
  // be probed, and never reach the spawn below.
  const base = resolveDaemonBase(opts.base).base;
  if (await wigoloHealth(base)) return { base, owned: false, stop: async () => {} };

  if (process.env.UI2API_WIGOLO_AUTOSTART === "0") {
    throw new Error(
      `wigolo daemon not reachable at ${base}. Start it with 'wigolo serve' (or UI2API_WIGOLO_AUTOSTART=1 here, WIGOLO_BIN=/path/to/wigolo).`
    );
  }

  const args = wigoloBin(opts.bin ?? process.env.WIGOLO_BIN);
  const daemonEnv = buildWigoloDaemonEnv();
  const child = spawn(args[0], args.slice(1), {
    stdio: ["ignore", "ignore", "pipe"],
    env: daemonEnv,
  });
  let stderrTail = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const msg = `wigolo daemon exited early (code ${child.exitCode}): ${stderrTail.trim() || "no stderr"}`;
      throw new Error(msg);
    }
    if (await wigoloHealth(base)) {
      return {
        base,
        owned: true,
        stop: async () => {
          child.kill("SIGTERM");
          await new Promise<void>((r) => setTimeout(r, 100));
        },
      };
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  child.kill("SIGTERM");
  const msg = `timed out waiting for wigolo daemon at ${base}. ${stderrTail.trim() || "(no daemon stderr yet)"}`;
  throw new Error(msg);
}

async function wigoloRequest<T>(
  tool: string,
  input: unknown,
  opts: WigoloClientOpts = {}
): Promise<T> {
  const { base, loopback } = resolveDaemonBase(opts.base);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  // The bearer credential is attached ONLY to a loopback daemon. A remote base
  // is reachable either through the explicit opt-in or through a caller-supplied
  // base that already passed the gate — in neither case does the secret leave.
  const token = loopback ? daemonToken() : undefined;
  try {
    const res = await fetch(`${base}/v1/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok || (isEnvelope(body) && !body.ok)) {
      const err = isEnvelope(body) ? body : { error_reason: String(body) };
      throw new Error(
        `wigolo ${tool} (HTTP ${res.status}): ${(err as { error_reason?: string }).error_reason ?? (err as { error?: string }).error ?? "request failed"}`
      );
    }
    return body as T;
  } finally {
    clearTimeout(t);
  }
}

// wigolo wraps handlers in a StageResult envelope { ok, data | error... } but the
// REST layer unwraps success to raw `data`. This detects an error envelope
// (rarely surfaced with a 2xx) defensively.
function isEnvelope(v: unknown): v is { ok?: boolean; error?: string; error_reason?: string } {
  return typeof v === "object" && v !== null && "ok" in (v as object);
}

export async function wigoloFetch(input: WigoloFetchInput, opts?: WigoloClientOpts): Promise<WigoloFetchOutput> {
  return wigoloRequest<WigoloFetchOutput>("fetch", input, opts);
}

export async function wigoloExtract(input: WigoloExtractInput, opts?: WigoloClientOpts): Promise<WigoloExtractOutput> {
  return wigoloRequest<WigoloExtractOutput>("extract", input, opts);
}