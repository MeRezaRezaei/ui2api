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
import { constants, existsSync, mkdirSync, readdirSync, statSync, accessSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { chromium } from "playwright";
import { detectProfileIdentity, ingestProfile } from "./profile-ingest.js";
import { accountSnapshotPath, saveAccountSnapshot, slugifyIdentity, slugCollision } from "./session-store.js";

/** What a shared X session needs: the display name plus an optional XAUTHORITY. */
export interface DisplayInfo {
  display: string;
  xauthority?: string;
  source?: "env" | "socket";
}

// Detect the X display to release/share. Priority:
//   1. DISPLAY env (a real session always sets it).
//   2. The /tmp/.X11-unix/ socket owned by OUR euid — the user's actual
//      session display. Falls back to ":0" ONLY when nothing else exists.
// The :0 fallback alone is wrong on multi-session boxes: there it often
// belongs to the login greeter, not the user (seen 2026-09-21 on a box
// where uid 1005 owned X10/X20 but X0 belonged to cosmic-greeter), so
// relaxing xhost on :0 would share the wrong screen.
// Returns null on a headless CI run (nothing to share).
export function detectDisplayInfo(): DisplayInfo | null {
  if (!process.env.DISPLAY && process.env.CI) return null;
  if (process.env.DISPLAY) {
    return process.env.XAUTHORITY
      ? { display: process.env.DISPLAY, xauthority: process.env.XAUTHORITY, source: "env" }
      : { display: process.env.DISPLAY, source: "env" };
  }
  const mine = displayFromOwnedSocket();
  if (mine) return process.env.XAUTHORITY ? { display: mine, xauthority: process.env.XAUTHORITY, source: "socket" } : { display: mine, source: "socket" };
  return process.env.XAUTHORITY ? { display: ":0", xauthority: process.env.XAUTHORITY } : { display: ":0" };
}

// Scan /tmp/.X11-unix/X* sockets; return the first owned by the current euid.
// Each socket file is named X<N> meaning display ":N". Never throws.
function displayFromOwnedSocket(): string | null {
  try {
    const dir = "/tmp/.X11-unix";
    const entries = readdirSync(dir, { withFileTypes: true });
    const euid = typeof process.geteuid === "function" ? process.geteuid() : 0;
    for (const e of entries) {
      if (!e.isSocket() || !e.name.startsWith("X")) continue;
      const stat = statSync(join(dir, e.name));
      if (stat.uid === euid) return `:${e.name.slice(1)}`;
    }
  } catch {
    // no X11 dir or unreadable — caller falls back
  }
  return null;
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

// Deps for ui2apiUserDataDir, injectable so the unit tests never touch a real
// system user's home.
export interface Ui2apiUserDataDirDeps {
  ui2apiUser?: () => string;
  currentUser?: () => string;
  userExists?: (user: string) => boolean;
  userHome?: (user: string) => string;
  /** Writability probe: may grant W_OK on an existing dir or create it. */
  probeWrite?: (dir: string) => boolean;
}

function defaultProbeWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    try {
      mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Where login-UX data should live per verbatim 1495 ("data ill be stored in
 * the ui2api user not the current user"). Returns the ui2api user's XDG data
 * dir (…/.local/share/ui2api) when that path is GENUINELY usable from this
 * session — either the current process already runs AS the ui2api user, or
 * the ui2api user exists on this host and its candidate dir is writable or
 * creatable right now. Returns null otherwise, meaning the caller MUST fall
 * back to the current-user data dir (that fallback keeps captures working and
 * is honest: we never claim the ui2api-user dir when we cannot write to it).
 */
export function ui2apiUserDataDir(deps: Ui2apiUserDataDirDeps = {}): string | null {
  const d = {
    ui2apiUser: ui2apiUser.bind(null),
    currentUser: currentUsername,
    userExists,
    userHome: ui2apiUserHome,
    probeWrite: defaultProbeWrite,
    ...deps,
  };
  const user = d.ui2apiUser();
  const mine = join(d.userHome(user), ".local", "share", "ui2api");
  if (d.currentUser() === user) return mine; // running AS ui2api — the current-user dir IS the ui2api dir
  if (!d.userExists(user)) return null;
  return d.probeWrite(mine) ? mine : null;
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
  const warnings = [...ingest.warnings];
  // GOAL 49 write truth gate: a FULLY anonymous capture (zero cookies matched
  // AND zero localStorage entries for the target host) is REFUSED at the write
  // seam — nothing written to the vault, empty snapshotPath, named verdict.
  // The decrypt-limited partial (cookies matched but undecryptable, or
  // cookies-only storage) keeps its honest warning below and IS still written:
  // it represents a real logged-in session whose auth simply could not be
  // exported, so it is not the silent-wrong-session class this gate kills.
  if (ingest.stats.cookiesMatched === 0 && ingest.stats.localStorageEntries === 0) {
    warnings.push(`skipped-no-auth (nothing to save) — no cookies and no localStorage matched ${opts.host} (logged out?)`);
    return {
      identity,
      snapshotPath: "",
      warnings,
      stats: {
        cookiesMatched: ingest.stats.cookiesMatched,
        cookiesTotal: ingest.stats.cookiesTotal,
        localStorageEntries: ingest.stats.localStorageEntries,
      },
    };
  }
  // GOAL 50 account-INDEX collision gate: a same-slug DIFFERENT identity
  // already in the vault is REFUSED — never silently destroy the existing
  // account. Same identity string = latest-wins re-capture, NOT a collision.
  const collision = slugCollision(opts.dataDir, opts.host, identity);
  if (collision) {
    warnings.push(`slug-collision (NOT overwritten — account "${collision.slug}" already exists as "${collision.identity}")`);
    return {
      identity,
      snapshotPath: "",
      warnings,
      stats: {
        cookiesMatched: ingest.stats.cookiesMatched,
        cookiesTotal: ingest.stats.cookiesTotal,
        localStorageEntries: ingest.stats.localStorageEntries,
      },
    };
  }
  saveAccountSnapshot(opts.dataDir, opts.host, identity, ingest.snapshot, {
    source: "capture",
    profileDir: opts.profileDir,
  });
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
    // Persistent context: Playwright rejects userDataDir on launch(); the
    // persistent-context form is the one that hands a real on-disk profile
    // dir to the user's Chrome (same mechanism the pool's own Chrome uses).
    const context = await chromium.launchPersistentContext(opts.profileDir, {
      headless: false,
      channel: "chrome",
      args: ["--window-size=1280,800"],
      env: { ...process.env, DISPLAY: opts.display } as Record<string, string>,
      ...(process.env.UI2API_CHROME_PATH ? { executablePath: process.env.UI2API_CHROME_PATH } : {}),
    });
    const page = context.pages()[0] ?? (await context.newPage());
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