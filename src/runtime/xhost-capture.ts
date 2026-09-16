// xhost+ assisted login capture — the SIMPLEST login path for end users on
// Linux. Instead of scripted headless auth, the tool releases the X display
// lock (`xhost +...`), launches a REAL headed browser the user can see, the
// user logs in the REGULAR WAY, and the resulting on-disk Chrome profile is
// serialized into the identity-keyed vault under the ui2api user's data dir.
//
// The CLI wires the flow:
//   1. detectDisplayInfo()            -> is there a display worth sharing?
//   2. relaxDisplayLock()             -> make X usable by the ui2api user
//   3. launchHeadedChromeForLogin()   -> visible browser; user logs in normally
//   4. captureProfileFromLiveChrome() -> serialize profile into the vault
//
// Every function returns a result object on expected failure — nothing here
// throws at the caller except a genuinely broken profile ingest.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { chromium } from "playwright";
import { detectProfileIdentity, ingestProfile } from "./profile-ingest.js";
import { accountSnapshotPath, saveAccountSnapshot, slugifyIdentity } from "./session-store.js";

/** What a shared X session needs: the display name plus an optional XAUTHORITY. */
export interface DisplayInfo {
  display: string;
  xauthority?: string;
}

// Detect the X display to release/share. Reads DISPLAY (":0" when unset) and
// the optional XAUTHORITY. Returns null on a headless CI run (nothing to share).
export function detectDisplayInfo(): DisplayInfo | null {
  if (!process.env.DISPLAY && process.env.CI) return null;
  const display = process.env.DISPLAY || ":0";
  return process.env.XAUTHORITY ? { display, xauthority: process.env.XAUTHORITY } : { display };
}

/** Outcome of releasing the display lock via `xhost`. Never throws. */
export interface RelaxDisplayLockResult {
  command: string;
  exitCode: number | null; // null when the xhost binary is missing
  stderr: string;
}

/**
 * Release the X display lock so a headed Chrome owned by another user
 * (ui2api) can draw on the screen. `mode: "specific"` uses the scoped, safer
 * `xhost +SI:localuser:<user>`; `mode: "all"` is the literal plain `xhost +`
 * from the verbatim. Runs synchronously; an X-less host or missing binary
 * yields an object describing the failure instead of throwing.
 */
export function relaxDisplayLock(opts: {
  display: string;
  ui2apiUser: string;
  mode?: "specific" | "all";
}): RelaxDisplayLockResult {
  const mode = opts.mode ?? "specific";
  const command = mode === "all" ? "xhost +" : `xhost +SI:localuser:${opts.ui2apiUser}`;
  const [bin, ...args] = command.split(" ");
  try {
    execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    return { command, exitCode: 0, stderr: "" };
  } catch (e) {
    const err = e as { code?: string; status?: number | null; stderr?: string | Buffer };
    if (err.code === "ENOENT") {
      return {
        command,
        exitCode: null,
        stderr: `xhost binary not found — cannot release display ${opts.display} (install x11-xserver-utils)`,
      };
    }
    return { command, exitCode: err.status ?? null, stderr: text(err.stderr) };
  }
}

/** The system user that owns captured accounts — `UI2API_USER` or "ui2api". */
export function ui2apiUser(): string {
  return process.env.UI2API_USER || "ui2api";
}

// Resolve a user's home dir: the real one when it IS the current user (via
// os.userInfo), else the conventional `/home/<user>`.
export function ui2apiUserHome(user: string): string {
  try {
    const info = userInfo({ encoding: "utf8" });
    if (info.username === user) return info.homedir;
  } catch {
    // uid unresolvable (sandboxed) — fall through to the convention
  }
  return `/home/${user}`;
}

/** Does the user exist on this host? getent passwd, or /home/<user> on disk. */
export function userExists(user: string): boolean {
  try {
    execFileSync("getent", ["passwd", user], { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return existsSync(`/home/${user}`);
  }
}

/** What a live-profile capture produced for the identity vault. */
export interface CaptureResult {
  identity: string;
  snapshotPath: string;
  warnings: string[];
  stats: { cookiesMatched: number; cookiesTotal: number; localStorageEntries: number };
}

/**
 * Serialize a live (ui2api-user-owned) headed Chrome profile into the vault —
 * no second browser. Ingests the on-disk profile for `host`, derives the
 * identity from the profile (or opts.identity, then a `<user>-default`
 * fallback), and stores the account keyed by (host, identity). Zero matched
 * cookies is NOT an error — localStorage may carry the auth — so it only adds
 * a warning. Rethrows only when the profile itself cannot be ingested.
 */
export async function captureProfileFromLiveChrome(opts: {
  profileDir: string;
  host: string;
  dataDir: string;
  identity?: string;
}): Promise<CaptureResult> {
  const ingest = await ingestProfile({ profileDir: opts.profileDir, targetHost: opts.host });
  const detected = detectProfileIdentity(opts.profileDir).best;
  const identity = detected || opts.identity || `${currentUsername()}-default`;
  saveAccountSnapshot(opts.dataDir, opts.host, identity, ingest.snapshot, {
    source: "capture",
    profileDir: opts.profileDir,
  });
  const warnings = [...ingest.warnings];
  if (ingest.stats.cookiesMatched === 0) {
    warnings.push(`zero cookies matched ${opts.host} — snapshot saved anyway (localStorage may carry the auth)`);
  }
  return {
    identity,
    snapshotPath: accountSnapshotPath(opts.dataDir, opts.host, slugifyIdentity(identity)),
    warnings,
    stats: {
      cookiesMatched: ingest.stats.cookiesMatched,
      cookiesTotal: ingest.stats.cookiesTotal,
      localStorageEntries: ingest.stats.localStorageEntries,
    },
  };
}

/** Outcome of the headed login-browser launch. Never throws. */
export interface LaunchHeadedResult {
  launched: boolean;
  error?: string;
  command?: string;
}

/**
 * Launch a REAL system Chrome (channel "chrome", or the executable at
 * UI2API_CHROME_PATH) HEADED on `display`, pointed at `url` — the browser the
 * end user SEES and logs into the regular way. When already running as the
 * ui2api user the profile is naturally owned by ui2api; otherwise the profile
 * dir is created recursively so it stays writable. Returns after navigation;
 * the browser stays open for the user, and the CLI waits for Enter before
 * calling captureProfileFromLiveChrome. Never throws.
 */
export async function launchHeadedChromeForLogin(opts: {
  url: string;
  profileDir: string;
  display: string;
  user?: string;
}): Promise<LaunchHeadedResult> {
  try {
    mkdirSync(opts.profileDir, { recursive: true });
    // `userDataDir` rides on launch() as a runtime-only option (Playwright's
    // type only exposes it on launchPersistentContext) — same cast the rest of
    // this codebase uses to hand Playwright a real profile.
    const browser = await chromium.launch({
      headless: false,
      channel: "chrome",
      userDataDir: opts.profileDir,
      args: ["--window-size=1280,800"],
      env: { ...process.env, DISPLAY: opts.display } as Record<string, string>,
      ...(process.env.UI2API_CHROME_PATH ? { executablePath: process.env.UI2API_CHROME_PATH } : {}),
    } as Parameters<typeof chromium.launch>[0] & { userDataDir: string });
    const page = await browser.newPage();
    await page.goto(opts.url, { waitUntil: "load", timeout: 60000 });
    const executable = process.env.UI2API_CHROME_PATH || "chrome";
    return {
      launched: true,
      command: `${executable} --user-data-dir=${opts.profileDir} --window-size=1280,800 ${opts.url}`,
    };
  } catch (e) {
    const ownership =
      opts.user && opts.user !== currentUsername() ? " (profileDir must be writable by the launching user)" : "";
    return { launched: false, error: `${text(e)}${ownership}` };
  }
}

/** Outcome of one assisted-login step the CLI drives. */
export interface AssistedResult {
  displayShared: boolean; // xhost released the display lock successfully
  xhost?: { command: string; exitCode: number | null; stderr: string };
  browserLaunched: boolean;
  error?: string;
  captured?: { identity: string; snapshotPath: string; warnings: string[] };
}

/**
 * The assisted-login flow, one orchestrated call:
 *   (1) relaxDisplayLock, (2) mkdir the profile dir, (3) launch the headed
 *   browser for the user to log in. This function does NOT block waiting for
 *   the user — the CLI prompts "Press Enter when logged in", then calls
 *   captureProfileFromLiveChrome. Returns a 4-key result and never throws.
 */
export async function assistedLoginFlow(opts: {
  url: string;
  host: string;
  dataDir: string;
  profileDir: string;
  display: string;
  ui2apiUser: string;
  relaxMode?: "specific" | "all";
  identity?: string;
}): Promise<AssistedResult> {
  const xhost = relaxDisplayLock({ display: opts.display, ui2apiUser: opts.ui2apiUser, mode: opts.relaxMode });
  const displayShared = xhost.exitCode === 0;
  try {
    mkdirSync(opts.profileDir, { recursive: true });
  } catch (e) {
    return { displayShared, xhost, browserLaunched: false, error: `cannot create profile dir ${opts.profileDir}: ${text(e)}` };
  }
  const launched = await launchHeadedChromeForLogin({
    url: opts.url,
    profileDir: opts.profileDir,
    display: opts.display,
    user: opts.ui2apiUser,
  });
  return { displayShared, xhost, browserLaunched: launched.launched, error: launched.error };
}

function currentUsername(): string {
  try {
    return userInfo({ encoding: "utf8" }).username;
  } catch {
    return "unknown";
  }
}

function text(v: unknown): string {
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return typeof v === "string" ? v : v instanceof Error ? v.message : String(v ?? "");
}