import { chromium, type Browser } from "playwright";
import { resolve, dirname } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveChromeOwner } from "./chrome-owner.js";
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
  // Explicit wins, always.
  const explicit = process.env.UI2API_USER_DATA_DIR || process.env.UI2API_CHROME_PROFILE_PATH;
  if (explicit) return explicit;
  // THE POINT OF USE is a dedicated user's Chrome, not the operator's keyboard
  // browser (Chrome refuses to attach to one). But handing that profile to a
  // caller that is NOT the owner was a real flaw: the profile is 0700 and
  // PROFILE-LOCKED, so any other caller — including every browser test in the
  // suite — died with `chrome exited early (code 21)`. MEASURED: this silently
  // coupled the whole test suite to the machine's ambient state.
  //
  // So the owner's profile is used when we ARE that user (the real production
  // case), or when it is named explicitly. Otherwise a managed launch, which is
  // hermetic. `chrome start` is how the daemon gets it, and it always runs AS
  // the owner.
  // NO ambient owner fallback — and the reason is measured, twice.
  //
  // The owner's profile is used by EXACTLY ONE caller: the daemon
  // (`chrome start`), which always runs AS the owner. Everything else — the app,
  // and every test — reaches it by ATTACHING over CDP, which is the operator's
  // model anyway. An earlier version fell back to the owner profile whenever the
  // process "was" the owner, and a test run then launched its own --headless
  // Chrome onto the live profile, silently taking it over: CDP moved to a random
  // port, the headed daemon's 9222 went dead, attach failed, and the launch fell
  // through to a doomed respawn (`chrome exited early (code 21)`). The suite was
  // coupled to machine state AND to whoever happened to hold the profile.
  //
  // So: explicit env, or the explicit opt-in. Otherwise a hermetic managed
  // launch. The daemon is the only owner of the owner's profile.
  if ((process.env.UI2API_CHROME_OWNER_PROFILE ?? "") === "1") {
    return resolveChromeOwner().profile ?? undefined;
  }
  return undefined;
}

// Launch args for the user's real Chrome: deliberately NONE beyond a stable
// window-size. No --no-sandbox/--disable-gpu/--disable-dev-shm-usage: those are
// headless-tell hardening flags for the bundled Chromium on constrained hosts,
// and passing them to the user's own browser would print "you are using an
// unsupported command-line flag" and change its fingerprint. The whole point of
// user-chrome mode is that the session IS the user's browser.
//
// EXPORTED, because the argument list is a CONTRACT with the fingerprint: a
// second copy of it is a second thing that can drift away from the browser the
// site actually sees. `launchHeadedChromeForLogin` (xhost-capture.ts) used to
// type `["--window-size=1280,800"]` a second time by hand.
export function userChromeLaunchArgs(channel: string | undefined): string[] {
  void channel; // the flag set is deliberately channel-independent — see above
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
  return bundledChromiumPath() === null;
}

// Exported for the requirements/doctor checker (GOAL 33): the bundled Chromium
// binary path when Playwright's cache has it, else null. Never spawns anything —
// a pure fs existence check, no browser launch.
export function bundledChromiumPath(): string | null {
  try {
    const p = chromium.executablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
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
/** True when THIS process runs as the user that owns the Chrome profile. The
 *  browser may only be born in that identity — see the refusal in launchBrowser. */
function isChromeOwnerProcess(): boolean {
  const owner = process.env.UI2API_CHROME_USER ?? "ui2api";
  try {
    // `os.userInfo()` reflects the REAL uid, not $USER, which an operator can set
    // to anything and which would make this check trivially bypassable.
    return typeof process.getuid === "function" && String(process.getuid()) === ownerUid(owner);
  } catch {
    return false;
  }
}

function ownerUid(name: string): string {
  // /etc/passwd is the only source that cannot be spoofed by an env var, and it
  // is what `id -u` reads. A cache avoids a file read per launch attempt.
  try {
    const cached = uidCache.get(name);
    if (cached !== undefined) return cached;
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.split(":")[0] === name);
    const uid = line ? String(line.split(":")[2]) : "-1";
    uidCache.set(name, uid);
    return uid;
  } catch {
    return "-1";
  }
}
const uidCache = new Map<string, string>();

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
  // ROUND N+104 — the ONLY supported way to get a browser here is the `ui2api`
  // daemon. A managed spawn is refused unless this process IS the chrome owner.
  //
  // Measured cost of leaving it open: 23 orphaned Chrome processes owned by `me`
  // while the real browser was `ui2api`'s. Nobody leaked them on purpose — every
  // ad-hoc CLI invocation as the operator silently started a browser, and a
  // second, duplicate, unmanaged, un-supervised browser accumulated for the life
  // of the box. The "warm state" the pool was supposed to keep lived in the
  // daemon's Chrome; the CLI's browsers were pure drain, and they were the ones
  // that would eventually get an account challenged.
  //
  // So the invariant is now enforced at the only place a browser can be born:
  // if we are not the chrome owner, attach or fail. Attaching is the correct
  // answer, not a compromise — the daemon already holds the profile, the session
  // and the warm state, and a second browser cannot have any of those.
  if (!isChromeOwnerProcess()) {
    const port = process.env.UI2API_ATTACH_PORT ?? overrides.attachPort;
    if (port) {
      try {
        return await connectExistingChrome(Number(port));
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `refusing to spawn a browser: this process is not the chrome owner ` +
        `(${process.env.UI2API_CHROME_USER ?? "ui2api"}), and the only supported browser is ` +
        `that user's daemon. Spawning here produced 23 orphaned Chrome processes on this host. ` +
        `Run as that user, or set UI2API_ATTACH_PORT to attach to its existing Chrome.`
    );
  }
  // 1) Managed spawn + CDP attach (the path that actually survives heavy SPAs).
  try {
    return await spawnChromeAndConnect(overrides);
  } catch (e) {
    lastErr = e;
  }
  // 2) Playwright's own launch as a fallback, retried, with the channel fallback.
  //    NEVER for the user's real Chrome/profile: `chromium.launch` injects
  //    Playwright's automation defaults (--enable-automation, CDP hints) which a
  //    real user profile would carry into the site as a detectable tell. The
  //    managed spawn above already chose the real profile + clean flag set; if
  //    that path failed, fail loudly rather than leak automation flags into the
  //    user's browser. The bundled-Chromium fallback (no profile) stays.
  const userProfileInPlay = Boolean(
    (launchOpts as any).userDataDir ||
      process.env.UI2API_USER_DATA_DIR ||
      process.env.UI2API_CHROME_PROFILE_PATH ||
      process.env.UI2API_CHROME_PATH
  );
  if (!userProfileInPlay) {
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
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("failed to launch browser");
}

// --- Managed Chrome spawn + CDP attach (wigolo cdp-direct pattern) ---

// THE Chrome ladder, as DATA, in ONE place — the third copy this repo used to
// carry (the seam here, `chromeExec()` in chrome-daemon.ts, and the remedy prose
// in requirements.ts) with no edge between any of them. MEASURED drift: the
// daemon's private 4-path list could not see `/opt/google/chrome/chrome`, which
// EXISTS on this box, so `ui2api requirements` (which folds THIS ladder) called
// Chrome ready while `ui2api chrome start` — the actual point of use — answered
// "no Chrome executable found". Two commands an operator runs back to back,
// contradicting each other, because one of them typed its own list.
//
// ORDER is POLICY and is stated here once, so it cannot be re-typed elsewhere:
// real Chrome before Chromium, because the whole project exists to be
// indistinguishable from the user's own browser (see `usingUserChrome` and the
// headless-gets-you-blocked rule in AGENTS.md). The knobs stay LITERAL —
// `UI2API_CHROME_PATH` is a name a consumer types into their environment, so it
// is a published contract, not rot.
//
// `resolveChromeExec` walks SYSTEM paths only, then the Playwright cache: that is
// the seam's resolution, UNCHANGED, so nothing about how the seam picks a binary
// moves. The daemon walks SYSTEM then CHROMIUM (see chrome-daemon.ts) — its old
// order had chromium in 3rd place, and the new one puts the real Chrome ahead of
// it, which is the only box whose outcome changes: a host with BOTH
// `/opt/google/chrome/chrome` and `/usr/bin/chromium` now gets the REAL Chrome,
// matching every other launcher in the project. Every other host is unaffected.
export const CHROME_SYSTEM_PATHS: readonly string[] = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
];

export const CHROME_CHROMIUM_PATHS: readonly string[] = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

// Resolve a real Chrome executable. Order: explicit path flag/env, then Playwright's
// `channel: "chrome"` registry, then the two common linux locations. Exported for
// the requirements/doctor checker (GOAL 33) so the readiness check folds the SAME
// ladder launchBrowser uses instead of duplicating it.
export function resolveChromeExec(overrides: LaunchOpts): string | undefined {
  const explicit = overrides.executablePath ?? process.env.UI2API_CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  for (const cand of CHROME_SYSTEM_PATHS) {
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

/**
 * GOAL 126: THE resolved headless truth. There were two truths and they
 * disagreed.
 *
 * The launch seam computed the ACTUAL mode as
 * `!(wantHeadful && displayAvailable())` — so `UI2API_HEADED=1` with no DISPLAY
 * still spawned `--headless=new`. But ~17 call sites (driver, pool, 14
 * capability runners) decided "am I a real user?" from the ENV ALONE with
 * `UI2API_HEADED !== "1"`, which is TRUE in that state. MEASURED:
 * `{runnerTreatsAsRealUser: true, spawnActualHeadless: true}`.
 *
 * That is the worst of both worlds: the real-user branch fires — viewport
 * inheritance, light-mode asset aborting SKIPPED, GPU/software-rasterizer
 * hardening flags DROPPED — on a headless-spawned page with no extensions and
 * no window chrome. A contradictory forgery is a WORSE fingerprint than an
 * honest headless default, and nothing reported the mismatch.
 *
 * One resolver, used by every caller. The env var is a REQUEST for headful, not
 * a statement of fact.
 */
export function resolvedHeadless(overrides: LaunchOpts = {}): boolean {
  const wantHeadful = !headlessDefaulted(overrides);
  return !(wantHeadful && displayAvailable());
}

/** True only when we really are a headful, real-user browser. */
export function resolvedHeaded(overrides: LaunchOpts = {}): boolean {
  return !resolvedHeadless(overrides);
}

/**
 * The honest named verdict for the degraded case: the operator ASKED for a
 * headed browser and did not get one. Never silent — this is exactly the state
 * that used to pass unnoticed.
 */
export function headlessDegradedReason(overrides: LaunchOpts = {}): string | null {
  const wantHeadful = !headlessDefaulted(overrides);
  if (wantHeadful && !displayAvailable()) {
    return (
      "headless-degraded: UI2API_HEADED=1 was requested but no DISPLAY/WAYLAND_DISPLAY is available, " +
      "so the browser was spawned --headless=new. The real-user posture is NOT in effect. " +
      "Run under Xvfb (or a real desktop session) for a genuinely headful browser."
    );
  }
  return null;
}

// Spawn Chrome ourselves on a temp profile with a loopback CDP port, then attach
// Playwright to it. Returns a Browser whose lifecycle ALSO kills the spawned
// process group (CDP attach does not own the child).
export async function spawnChromeAndConnect(overrides: LaunchOpts = {}): Promise<Browser> {
  const exec = resolveChromeExec(overrides);
  if (!exec) throw new Error("no Chrome executable found for managed spawn");
  const port = await reserveFreePort();
  // Reuse the user's real profile when one was configured (env UI2API_USER_DATA_DIR
  // / UI2API_CHROME_PROFILE_PATH, or an explicit override). This is the whole
  // "drive the user's own browser" point: cookies, localStorage, site logins and
  // chat history live in the profile. A temp profile is ONLY the zero-config
  // fallback for hosts that never pinned one.
  const explicitProfile = overrides.userDataDir ?? userChromeProfile();
  const userDataDir = explicitProfile || mkdtempSync(resolve(tmpdir(), "ui2api-chrome-"));
  const usingRealProfile = Boolean(explicitProfile);
  // Headful only when explicitly requested AND a display exists; otherwise stay
  // headless (a window would pop on the user's desktop).
  // GOAL 126: the spawn reads the ONE resolver, so it can never disagree with
  // what the posture code believes.
  const headless = resolvedHeadless(overrides);
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
    // A REAL user profile never gets the hardening flags — they would change
    // the user's browser fingerprint.
    ...(usingRealProfile || process.env.UI2API_CHROME_NO_SANDBOX === "0" ? [] : ["--no-sandbox"]),
    ...(usingRealProfile ? [] : ["--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer"]),
    // The HangWatcher treats a thread stalled under scheduler pressure (this
    // host runs heavy services on 4 free GB) as a hang and CHECK-crashes via
    // int3. The same binary survives for hours once past bootstrap; kill the
    // watchdog to stop the CHECK.
    "--disable-hang-monitor",
    "--disable-v8-idle-tasks",
    // Heavy SPA renderers (Gemini/Copilot) die fastest on this host; stop
    // background throttling/rendering so the renderer burns through the load
    // (and the answer stream) before the bootstrap window closes.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
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
