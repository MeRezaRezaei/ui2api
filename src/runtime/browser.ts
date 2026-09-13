import { chromium, type Browser } from "playwright";
import { resolve, dirname } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

// Hardened launch args that keep headless Chromium stable across environments
// (containers/CI especially), where the default launch can crash intermittently.
// These are only applied to the BUNDLED Chromium — for the user's real Chrome we
// pass nothing (see userChromeLaunchArgs), so the session is indistinguishable
// from the user's own browser (zero bot fingerprint).
export const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-software-rasterizer",
];

// Is this run using the USER'S real Chrome (not the bundled Chromium)?
// A user-data-dir implies the user's real Chrome profile, so it counts too.
export function usingUserChrome(): boolean {
  return (
    (process.env.UI2API_CHROME && process.env.UI2API_CHROME !== "0") ||
    Boolean(process.env.UI2API_CHROME_PATH) ||
    Boolean(userChromeProfile())
  );
}

// The user's Chrome profile dir, when one was given (mirrors the env that wigolo
// reads as WIGOLO_CHROME_PROFILE_PATH, so the daemon can reuse the same profile).
export function userChromeProfile(): string | undefined {
  return process.env.UI2API_USER_DATA_DIR || process.env.UI2API_CHROME_PROFILE_PATH || undefined;
}

// Launch args for the user's real Chrome: deliberately NONE beyond a stable
// window-size. No --no-sandbox/--disable-gpu/--disable-dev-shm-usage: those are
// headless-tell hardening flags for the bundled Chromium on constrained hosts,
// and passing them to the user's own browser would print "you are using an
// unsupported command-line flag" and change its fingerprint. The whole point of
// user-chrome mode is that the session IS the user's browser.
function userChromeLaunchArgs(channel: string | undefined): string[] {
  return ["--window-size=1280,800"];
}

// Build the Playwright launch options. By default this uses the bundled
// Chromium. Opt-in env vars let a user reuse their REAL installed Chrome and
// logged-in profile (for analyzing sites they're authenticated to):
//   UI2API_CHROME=1          -> use the system Chrome (channel: "chrome")
//   UI2API_CHROME_PATH=...   -> explicit Chrome/Chromium executable path
//   UI2API_USER_DATA_DIR=... -> reuse an existing Chrome user-data dir (cookies/session)
// Overrides (passed programmatically) take precedence over env.
export function buildLaunchOptions(overrides: LaunchOpts = {}): Record<string, unknown> {
  const userDataDir = overrides.userDataDir ?? userChromeProfile();
  // A user-data-dir/discrete profile implies the user's real Chrome, so a profile
  // alone selects channel "chrome" too. An explicit path beats a channel.
  const channel = overrides.channel ?? (process.env.UI2API_CHROME && process.env.UI2API_CHROME !== "0" ? "chrome" : userDataDir ? "chrome" : undefined);
  const executablePath = overrides.executablePath ?? process.env.UI2API_CHROME_PATH;
  const usingUserChrome = Boolean(channel || executablePath || userDataDir);
  const opts: Record<string, unknown> = { args: usingUserChrome ? userChromeLaunchArgs(channel) : [...LAUNCH_ARGS] };
  // Memory-starved hosts: `--single-process` collapses Chrome's many subprocess
  // into one address space, cutting footprint enough to survive. Opt-in only —
  // it changes crash semantics, so it is never on by default.
  if (!usingUserChrome && process.env.UI2API_SINGLE_PROCESS === "1") {
    (opts.args as string[]).push("--single-process");
  }
  if (channel) opts.channel = channel;
  if (executablePath) opts.executablePath = executablePath;
  if (userDataDir) opts.userDataDir = userDataDir;
  if (overrides.headless !== undefined) opts.headless = overrides.headless;
  return opts;
}

export interface LaunchOpts {
  channel?: string;
  executablePath?: string;
  userDataDir?: string;
  headless?: boolean;
  attachPort?: number;
}

// Does the bundled Chromium executable exist on disk? Playwright only downloads
// it on demand (npx playwright install); on hosts where someone never ran that,
// `chromium.launch()` dies with "Executable doesn't exist". We auto-detect that
// so launchBrowser can fall back to the system Chrome instead of failing.
function bundledChromiumMissing(): boolean {
  try {
    return !existsSync(chromium.executablePath());
  } catch {
    return true;
  }
}

// Launch Chromium, retrying if the process dies before it is usable. This hides
// the intermittent "Target page, context or browser has been closed" crashes
// that otherwise make analyze/serve flaky.
//
// Primary path: SPAWN Chrome ourselves and attach via CDP over a localhost
// debug port (the wigolo cdp-direct pattern). Playwright's managed launch drives
// Chromium through `--remote-debugging-pipe` + `--no-startup-window`, which on
// several hosts (AppArmor/container/seccomp) makes the renderer hit `trap int3`
// CHECK-crashes the moment a heavy SPA starts drawing — while the SAME binary
// launched bare (`chrome --headless=new URL`, or via `--remote-debugging-port`)
// renders those pages fine. So we never hand the browser to Playwright's
// launcher: we pass an ordinary `--remote-debugging-port` handle instead (as a
// normal user-session Chrome would have), and connect to it.
//
// Zero-config fallback: keep Playwright's own launch as a safety net, and when
// no browser was pinned (no channel/path/profile) and the bundled Chromium was
// never downloaded, reuse the SYSTEM Chrome via `channel: "chrome"`. That keeps
// every flow working on hosts that only have a normal Chrome installed.
export async function launchBrowser(retries = 3, overrides: LaunchOpts = {}): Promise<Browser> {
  const launchOpts = buildLaunchOptions(overrides);
  const pinless = !(launchOpts as any).channel && !(launchOpts as any).executablePath && !(launchOpts as any).userDataDir;
  const candidates: Array<Record<string, unknown>> =
    pinless && bundledChromiumMissing()
      ? [launchOpts, { ...launchOpts, channel: "chrome" }]
      : [launchOpts];
  let lastErr: unknown;
  // 0) Attach to an existing long-lived Chrome (UI2API_ATTACH_PORT / attachPort),
  // enabled by default. On hosts where freshly-spawned Chromium dies seconds
  // after boot (AppArmor userns + trap int3 — see below), the user's own
  // running Chrome survives indefinitely; attached via CDP it serves the whole
  // pool with zero spawn/teardown.
  if (process.env.UI2API_ATTACH_PORT || overrides.attachPort) {
    const port = Number(process.env.UI2API_ATTACH_PORT ?? overrides.attachPort);
    try {
      return await connectExistingChrome(port);
    } catch (e) {
      lastErr = e;
    }
  }
  // 1) Managed spawn + CDP attach (the path that actually survives heavy SPAs).
  try {
    return await spawnChromeAndConnect(overrides);
  } catch (e) {
    lastErr = e;
  }
  // 2) Playwright's own launch as a fallback, retried, with the channel fallback.
  for (const opts of candidates) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const browser = await chromium.launch(opts as any);
        let usable = true;
        const lost = new Promise<never>((_, reject) => {
          browser.on("disconnected", () => {
            usable = false;
            reject(new Error("browser disconnected during launch"));
          });
        });
        await Promise.race([browser.newPage().then((p) => p.close()), lost]);
        if (usable) return browser;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("failed to launch browser");
}

// --- Managed Chrome spawn + CDP attach (wigolo cdp-direct pattern) ---

// Resolve a real Chrome executable. Order: explicit path flag/env, then Playwright's
// `channel: "chrome"` registry, then the two common linux locations.
function resolveChromeExec(overrides: LaunchOpts): string | undefined {
  const explicit = overrides.executablePath ?? process.env.UI2API_CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  for (const cand of [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
  ]) {
    if (existsSync(cand)) return cand;
  }
  try {
    const p = (chromium as any).executablePath();
    const base = typeof p === "string" ? p : "";
    return base && existsSync(base) ? base : undefined;
  } catch {
    return undefined;
  }
}

// Reserve a free TCP port for the CDP endpoint.
function reserveFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

// Attach with a hard deadline: on this host the freshly-spawned browser can die
// right between the endpoint probe and the CDP handshake — an unbounded attach
// would hang the caller forever instead of failing into a retry.
async function connectWithTimeout(endpoint: string, ms = 25000): Promise<Browser> {
  let browser: Browser | undefined;
  let ok = false;
  await Promise.race([
    chromium.connectOverCDP(endpoint).then((b) => {
      browser = b;
      ok = true;
    }),
    new Promise((r) => setTimeout(r, ms)),
  ]);
  if (!ok || !browser) throw new Error(`connectOverCDP timed out after ${ms}ms (${endpoint})`);
  return browser;
}

// Adopt an already-running Chrome over CDP (UI2API_ATTACH_PORT). The operator's
// long-lived browser is the stable target on hosts that kill freshly-spawned
// Chrome; this ONLY connects and sanity-checks via a throwaway tab — it never
// spawns, kills or closes anything.
export async function connectExistingChrome(port: number): Promise<Browser> {
  const browser = await connectWithTimeout(`http://127.0.0.1:${port}`);
  await browser.newPage().then((p) => p.close());
  return browser;
}

// Headful is strictly opt-in (UI2API_HEADED=1). On hosts with a display we could
// open a real window, but popping/closing Chrome on the user's desktop is exactly
// what a headless daemon must NOT do — headless is the default and the visible
// window (real-Chrome identity) is reserved for `--login` analyse sessions.
function headlessDefaulted(overrides: LaunchOpts): boolean | undefined {
  if (overrides.headless !== undefined) return overrides.headless;
  return process.env.UI2API_HEADED !== "1";
}

// Is there a display session we could show a window on? Headful needs one.
function displayAvailable(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// Spawn Chrome ourselves on a temp profile with a loopback CDP port, then attach
// Playwright to it. Returns a Browser whose lifecycle ALSO kills the spawned
// process group (CDP attach does not own the child).
export async function spawnChromeAndConnect(overrides: LaunchOpts = {}): Promise<Browser> {
  const exec = resolveChromeExec(overrides);
  if (!exec) throw new Error("no Chrome executable found for managed spawn");
  const port = await reserveFreePort();
  const userDataDir = overrides.userDataDir
    ? overrides.userDataDir
    : mkdtempSync(resolve(tmpdir(), "ui2api-chrome-"));
  // Headful only when explicitly requested AND a display exists; otherwise stay
  // headless (a window would pop on the user's desktop).
  const wantHeadful = !headlessDefaulted(overrides);
  const headless = !(wantHeadful && displayAvailable());
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--mute-audio",
    // Sandbox + GPU flags mirror the raw-CLI combo that provably survives on
    // AppArmor-restricted hosts (the box's own audit trail showed
    // userns_create being denied): running WITHOUT --no-sandbox here made the
    // renderers hit `trap int3` within seconds of loading a heavy SPA.
    // With unprivileged user namespaces re-enabled (kernel knob) the real
    // sandbox can run again: set UI2API_CHROME_NO_SANDBOX=0 to drop the flag.
    ...(process.env.UI2API_CHROME_NO_SANDBOX === "0" ? [] : ["--no-sandbox"]),
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    // The HangWatcher treats a thread stalled under scheduler pressure (this
    // host runs heavy services on 4 free GB) as a hang and CHECK-crashes via
    // int3. The same binary survives for hours once past bootstrap; kill the
    // watchdog to stop the CHECK.
    "--disable-hang-monitor",
    "--disable-v8-idle-tasks",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    // Deliberately NO `--no-startup-window`: on Chrome 129+ it suppresses the
    // initial page target, so a CDP attach finds nothing to navigate.
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const child: ChildProcess = spawn(exec, args, {
    env: {
      ...process.env,
      ...(displayAvailable() && !headless ? { DISPLAY: process.env.DISPLAY } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.on("error", () => {});
  // Forward the browser's own stderr when asked — the crash CHECK line ("Check
  // failed: ...", "[FATAL:...]") is the only way to see WHY a page kills it.
  if (process.env.UI2API_CHROME_STDERR === "1") {
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[chrome] ${d.toString()}`));
  }
  const endpoint = `http://127.0.0.1:${port}`;

  // Wait for the debug endpoint to answer (bounded); then attach.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
    if (child.exitCode !== null) throw new Error(`chrome exited early (code ${child.exitCode})`);
  }

  const browser = await connectWithTimeout(endpoint);
  // The CDP connection does not own the spawned process: kill it on detach.
  const killGroup = () => {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }
  };
  browser.on("disconnected", killGroup);
  // Minimize a headful window so the user's screen stays clean (best effort).
  if (!headless) {
    try {
      const ctxs = browser.contexts();
      for (const ctx of ctxs) {
        const pages = ctx.pages();
        for (const p of pages) {
          try { await p.evaluate(() => { try { window.moveTo(-10000, -10000); } catch {} }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  return browser;
}

// --- M7: cookie session capture for cookie-gated sites ---

// A host taken from an untrusted action-map must never be able to escape the
// sites directory via path separators or "..". Allow only hostname-safe chars.
export function sanitizeHost(host: string): string {
  const cleaned = String(host || "").replace(/[^a-zA-Z0-9._:\-[\]]/g, "");
  return cleaned || "unknown";
}

// Default sites root (where analyzed maps + sessions live).
export function defaultSitesDir(): string {
  return resolve(process.cwd(), "sites");
}

// Resolve the path where a site's session cookies are stored
// (sites/<host>/.session/cookies.json). `outDir` is the sites root.
export function sessionPath(outDir: string, host: string): string {
  return resolve(outDir, sanitizeHost(host), ".session", "cookies.json");
}

// Persist cookies (array of Playwright cookie objects) to disk. Creates the
// .session directory as needed. Cookies are gitignored by convention.
export function saveCookies(path: string, cookies: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cookies, null, 2));
}

// Load previously saved cookies, or [] if none exist / unreadable. Never throws.
export function loadCookies(path: string): any[] {
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [];
  }
}
