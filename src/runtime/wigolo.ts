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

import { spawn, type ChildProcess } from "node:child_process";

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

function daemonBase(): string {
  const url = process.env.WIGOLO_DAEMON_URL;
  if (url) return url.replace(/\/+$/, "");
  const port = Number(process.env.WIGOLO_DAEMON_PORT || 3333);
  return `http://127.0.0.1:${port}`;
}

function daemonToken(): string | undefined {
  return process.env.WIGOLO_API_TOKEN || undefined;
}

export async function wigoloHealth(base: string = daemonBase()): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
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

// Ensure a healthy wigolo daemon is reachable. If none is answering on the
// configured base URL, spawn one (WIGOLO_BIN, else npx `wigolo`) unless
// UI2API_WIGOLO_AUTOSTART=0. Returns a handle with `owned` set when this call
// started the daemon (caller should stop() it when done).
export async function ensureWigoloDaemon(opts: EnsureDaemonOpts = {}): Promise<WigoloDaemonHandle> {
  const base = opts.base ?? daemonBase();
  if (await wigoloHealth(base)) return { base, owned: false, stop: async () => {} };

  if (process.env.UI2API_WIGOLO_AUTOSTART === "0") {
    throw new Error(
      `wigolo daemon not reachable at ${base}. Start it with 'wigolo serve' (or UI2API_WIGOLO_AUTOSTART=1 here, WIGOLO_BIN=/path/to/wigolo).`
    );
  }

  const args = wigoloBin(opts.bin ?? process.env.WIGOLO_BIN);
  const daemonEnv: Record<string, string> = { ...process.env, WIGOLO_API_TOKEN: daemonToken() ?? "" };
  // Forward the user's real-Chrome config into the daemon so wigolo's auth reuse
  // drives the SAME browser and profile ui2api uses — the core of the "user's own
  // browser" vision. Maps UI2API_* to wigolo's WIGOLO_* keys, only when a value
  // is actually set (an explicit UI2API_WIGOLO_* wins).
  const chromeProfile =
    process.env.WIGOLO_CHROME_PROFILE_PATH ?? process.env.UI2API_USER_DATA_DIR ?? process.env.UI2API_CHROME_PROFILE_PATH;
  const cdp = process.env.WIGOLO_CDP_URL ?? process.env.UI2API_CDP_URL;
  const authState = process.env.WIGOLO_AUTH_STATE_PATH ?? process.env.UI2API_AUTH_STATE_PATH;
  if (chromeProfile) daemonEnv.WIGOLO_CHROME_PROFILE_PATH = chromeProfile;
  if (cdp) daemonEnv.WIGOLO_CDP_URL = cdp;
  if (authState) daemonEnv.WIGOLO_AUTH_STATE_PATH = authState;
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
  const base = opts.base ?? daemonBase();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(`${base}/v1/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(daemonToken() ? { authorization: `Bearer ${daemonToken()}` } : {}),
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