import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { resolveChromeOwner, isUidTheChromeOwner, type ChromeOwner } from "./chrome-owner.js";
import { resolvedHeadless, CHROME_SYSTEM_PATHS, CHROME_CHROMIUM_PATHS } from "./browser.js";

/**
 * THE PERSISTENT CHROME DAEMON.
 *
 * "We should not fire Chrome each time" — the operator's rule. Chrome is
 * expensive to start (seconds), it holds the anti-bot warm state that makes a
 * session look real, and on this box a freshly-spawned Chrome has been observed
 * dying shortly after boot while a long-lived one survives indefinitely. So the
 * model is: ONE long-lived Chrome, owned by the dedicated `ui2api` user, started
 * once, and Playwright ATTACHES to it over CDP for every request.
 *
 * This is not a preference — it is already proven. During the first live
 * round-trip attempt the launched Chrome stayed alive holding the profile, the
 * second launch was correctly refused by Chrome's one-instance-per-profile rule,
 * and attaching to the live one worked. The daemon just makes that deliberate
 * instead of accidental.
 *
 * The daemon NEVER kills the browser it does not own: in attach mode the
 * operator's own Chrome is untouchable (see restartBrowser in pool.ts), and
 * `stop` refuses for the same reason.
 */

export const DAEMON_PORT_ENV = "UI2API_DAEMON_PORT";
export const DAEMON_STATE_ENV = "UI2API_CHROME_DAEMON_STATE";
export const DEFAULT_DAEMON_PORT = 9222;

/**
 * Where a recorded daemon came from. This is the fact `stop` needs and could
 * not get: `user` is written identically by BOTH paths, so it cannot tell "we
 * spawned this" from "we adopted a browser the operator started".
 *
 * Optional in the type on purpose — a state file written by an older build has
 * no `origin`, and "we cannot prove we started it" must read as UNKNOWN, not as
 * "spawned". `stopChromeDaemon` refuses on unknown unless `--force`.
 */
export type ChromeDaemonOrigin = "spawned" | "adopted";

export interface ChromeDaemonState {
  port: number;
  pid: number;
  user: string;
  profile: string;
  startedAt: string;
  origin?: ChromeDaemonOrigin;
}

/**
 * Where the daemon records `{port,pid,user,profile}`.
 *
 * MEASURED: putting it in the repo's `data/` is WRONG when the daemon runs as
 * the `ui2api` user — that directory belongs to the operator and the spawn died
 * with `EACCES: permission denied, open '…/data/chrome-daemon.json'`. The state
 * describes the OWNER's browser, so it belongs to the OWNER: default to
 * `<ownerHome>/.config/ui2api/chrome-daemon.json`, which that user can always
 * write. `UI2API_CHROME_DAEMON_STATE` overrides, and a caller-supplied dataDir is
 * still honoured when it is writable.
 */
function statePath(dataDir: string): string {
  const explicit = process.env[DAEMON_STATE_ENV];
  if (explicit) return explicit;
  const owner = resolveChromeOwner();
  if (owner.home) return resolve(owner.home, ".config", "ui2api", "chrome-daemon.json");
  return resolve(dataDir, "chrome-daemon.json");
}

/** Is something already listening on the CDP port? */
export async function isPortLive(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((res) => {
    const sock = createServer();
    const done = (v: boolean) => {
      sock.removeAllListeners();
      try {
        sock.close();
      } catch {
        /* already closing */
      }
      res(v);
    };
    // ONLY EADDRINUSE means something is listening. MEASURED BUG: this used to
    // treat ANY error as "in use", so a privileged port (EACCES on bind) read as
    // a live daemon and the daemon refused to start on it.
    sock.once("error", (err: NodeJS.ErrnoException) => done(err?.code === "EADDRINUSE"));
    sock.once("listening", () => done(false));
    try {
      sock.listen(port, "127.0.0.1");
    } catch {
      done(true);
    }
    setTimeout(() => done(false), timeoutMs).unref?.();
  });
}

/** Read the recorded state, or null when there is none. */
export function readDaemonState(dataDir: string): ChromeDaemonState | null {
  const p = statePath(dataDir);
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as ChromeDaemonState;
  } catch {
    return null;
  }
}

function writeDaemonState(dataDir: string, st: ChromeDaemonState): void {
  const p = statePath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(st, null, 2), { mode: 0o600 });
}

function clearDaemonState(dataDir: string): void {
  try {
    unlinkSync(statePath(dataDir));
  } catch {
    /* already gone */
  }
}

/**
 * The status a caller can trust: it does not read the state file alone, it also
 * checks the port is actually live, because a recorded pid can outlive its
 * process (or a crash can leave the file behind).
 */
export async function chromeDaemonStatus(
  dataDir: string,
  port = Number(process.env[DAEMON_PORT_ENV] ?? DEFAULT_DAEMON_PORT),
): Promise<{ running: boolean; state: ChromeDaemonState | null; port: number; note: string }> {
  const state = readDaemonState(dataDir);
  const live = await isPortLive(port);
  if (live && state) return { running: true, state, port, note: `chrome daemon up on 127.0.0.1:${port} (pid ${state.pid}, user ${state.user})` };
  // A Chrome for the owner may already be running on ANOTHER port (started by
  // the operator, a test, or an earlier session). Adopt it rather than spawn a
  // second one — Chrome allows one instance per profile and will refuse anyway.
  const ownerProfile = resolveChromeOwner().profile;
  if (ownerProfile) {
    const found = findOwnerChrome(ownerProfile);
    if (found) {
      // Persist the adoption, so `stop` can act on it and a later status does
      // not have to re-discover it. MEASURED gap: adoption reported the port but
      // wrote no state, so the daemon looked un-stoppable.
      if (!state) {
        const adopted: ChromeDaemonState = {
          port: found.port,
          pid: found.pid,
          user: resolveChromeOwner().user,
          profile: ownerProfile,
          startedAt: new Date().toISOString(),
          origin: "adopted",
        };
        try {
          writeDaemonState(dataDir, adopted);
        } catch {
          /* the owner may not be able to write; discovery still works */
        }
      }
      return {
        running: true,
        state: state ?? { port: found.port, pid: found.pid, user: resolveChromeOwner().user, profile: ownerProfile, startedAt: new Date().toISOString(), origin: "adopted" },
        port: found.port,
        note: `adopting the Chrome already running for ${resolveChromeOwner().user} on 127.0.0.1:${found.port} (pid ${found.pid}) — not spawning another`,
      };
    }
  }
  if (live) return { running: true, state: null, port, note: `something is already listening on 127.0.0.1:${port} — attaching to it rather than starting another` };
  if (state) return { running: false, state, port, note: `recorded daemon (pid ${state.pid}) is NOT live on 127.0.0.1:${port} — stale state` };
  return { running: false, state: null, port, note: `no chrome daemon on 127.0.0.1:${port}` };
}

/**
 * Resolve the Chrome executable the same way the launch seam does — because it
 * now READS the seam's ladder instead of typing a fourth copy of it.
 *
 * It walks the seam's SYSTEM paths, then the CHROMIUM paths. The Playwright
 * cache is deliberately NOT here: that cache lives in the OPERATOR's home
 * (`~/.cache/ms-playwright`), and this function's result is spawned AS the
 * chrome owner (`sudo -n -u <owner> -H <exec>`), which may not be able to read
 * or execute it. Offering it would trade a clean "no Chrome executable found"
 * for an opaque EACCES from a `sudo` — a worse answer, not a better one. The
 * seam itself keeps the cache as its last resort, because it runs as whoever
 * holds the cache.
 */
function chromeExec(): string | null {
  const explicit = process.env.UI2API_CHROME_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  for (const c of [...CHROME_SYSTEM_PATHS, ...CHROME_CHROMIUM_PATHS]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Is THIS process already running as the named user? Compares real uids.
 *
 *  DERIVED, not re-derived: this used to run its own `getent passwd` and compare
 *  `process.getuid()` to the parsed uid, i.e. a THIRD implementation of the
 *  question the launch guard and the readiness gate each answered too. It now
 *  asks the one resolver in chrome-owner.ts, so the answer that decides
 *  `sudo -u` here can never disagree with the answer that decides the launch
 *  refusal. It is the fact that distinguishes spawning directly from wrapping
 *  the spawn in `sudo` — see the MEASURED BUG note at the call site. */
function isThisProcessOwner(user: string): boolean {
  try {
    return isUidTheChromeOwner(process.getuid?.(), user);
  } catch {
    return false;
  }
}

/**
 * Find a Chrome ALREADY running for the chrome owner, whoever started it.
 *
 * This is what makes "do not fire Chrome each time" actually true. Checking only
 * our own port is not enough: MEASURED, a Chrome started earlier was alive on
 * port 38073 holding the owner's profile, so the daemon believed nothing was
 * running, tried to spawn, and Chrome refused with
 * `Failed to create ... ProcessSingleton` — one instance per profile. The right
 * behaviour is to ADOPT the live one and attach to it.
 *
 * Reads `ps` for the owner's Chrome and extracts its --user-data-dir and
 * --remote-debugging-port, so an operator- or test-started Chrome is reused
 * rather than duplicated.
 */
export function findOwnerChrome(profile: string): { pid: number; port: number } | null {
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 5000 });
  } catch {
    return null;
  }
  for (const line of out.split("\n")) {
    if (!line.includes(profile)) continue;
    if (!/chrome|chromium/i.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    const portMatch = /--remote-debugging-port[= ](\d+)/.exec(line);
    if (!portMatch) continue;
    return { pid, port: Number(portMatch[1]) };
  }
  return null;
}

/**
 * Start the daemon if it is not already running. IDEMPOTENT: when the port is
 * already live this returns the existing daemon's status and spawns nothing —
 * that is the whole point of "do not fire Chrome each time".
 */
export async function startChromeDaemon(opts: {
  dataDir: string;
  port?: number;
  headless?: boolean;
  user?: string;
}): Promise<{ started: boolean; state: ChromeDaemonState | null; note: string }> {
  const port = opts.port ?? Number(process.env[DAEMON_PORT_ENV] ?? DEFAULT_DAEMON_PORT);
  const before = await chromeDaemonStatus(opts.dataDir, port);
  if (before.running) {
    return { started: false, state: before.state, note: `already running — not spawning another Chrome (${before.note})` };
  }

  const owner: ChromeOwner = opts.user
    ? { user: opts.user, home: null, profile: null, runningAsOwner: false, missing: null, profileExistsButUnreadable: false }
    : resolveChromeOwner();
  const exec = chromeExec();
  if (!exec) return { started: false, state: null, note: "no Chrome executable found" };
  if (!owner.profile) {
    return { started: false, state: null, note: `no Chrome profile for ${owner.user} — see docs/CHROME_POINT_OF_USE.md` };
  }

  // GOAL 126: ask the ONE resolver, never the env. Reading UI2API_HEADED here
  // would reintroduce the exact split-brain this cycle removed: the daemon
  // believing "headed" while the launch seam spawned --headless=new.
  // GOAL 135: headless is what gets us BLOCKED. MEASURED, same site, same
  // request, only headfulness changed: `--headless=new` -> ERR_CHALLENGE;
  // headed on Xvfb :99 -> `ok:true` with a real DOM-read answer. So the daemon
  // must never SILENTLY pick headless: it says which mode it is in and why,
  // and it tells the operator how to get a real one.
  const headless = opts.headless ?? resolvedHeadless();
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (headless) {
    const asked = process.env.UI2API_HEADED === "1";
    console.error(
      asked
        ? `[ui2api] headless-degraded: UI2API_HEADED=1 was requested but no DISPLAY is set, so this ` +
          `browser is --headless=new. That is MEASURED to get challenged (ERR_CHALLENGE). ` +
          `Start a virtual display first:  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &  then ` +
          `DISPLAY=:99 ui2api chrome start`
        : `[ui2api] WARNING: starting --headless=new (no DISPLAY, UI2API_HEADED!=1). Headless is ` +
          `MEASURED to be challenged. For a real browser: Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & ` +
          `then DISPLAY=:99 UI2API_HEADED=1 ui2api chrome start`,
    );
  }
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--mute-audio",
    "--disable-hang-monitor",
    "--disable-v8-idle-tasks",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${owner.profile}`,
  ];
  if (headless) args.push("--headless=new");
  args.push("about:blank");

  // Run it AS the chrome owner when we are not ALREADY that user. MEASURED BUG:
  // this used to test `owner.user !== "me"` — a hardcoded username — so when the
  // CLI was already running AS ui2api (the correct way to run it) it still
  // wrapped the spawn in `sudo -u ui2api`, which fails from inside that user and
  // left "chrome did not open :9222 within 5s". The check must be the REAL uid.
  const alreadyOwner = isThisProcessOwner(owner.user);
  const child = alreadyOwner
    ? spawn(exec, args, { detached: true, stdio: "ignore" })
    : spawn("sudo", ["-n", "-u", owner.user, "-H", exec, ...args], { detached: true, stdio: "ignore" });
  child.unref();

  const state: ChromeDaemonState = {
    port,
    pid: child.pid ?? -1,
    user: owner.user,
    profile: owner.profile,
    startedAt: new Date().toISOString(),
    // The one fact that makes `stop` safe: THIS process group is ours.
    origin: "spawned",
  };
  // wait briefly for the port to come up so the caller gets a real answer
  for (let i = 0; i < 20; i++) {
    if (await isPortLive(port)) {
      writeDaemonState(opts.dataDir, state);
      return { started: true, state, note: `chrome daemon started on 127.0.0.1:${port} (user ${owner.user}, pid ${state.pid})` };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  clearDaemonState(opts.dataDir);
  return { started: false, state: null, note: `chrome did not open 127.0.0.1:${port} within 5s` };
}

/**
 * Stop the daemon — but ONLY a Chrome we started. A browser we merely attached
 * to (the operator's own) is never killed; that rule is why GOAL 119 made
 * restartBrowser refuse to close an attached browser.
 *
 * MEASURED DEAD GUARD, now closed. This used to read
 * `if (state.user === "me" && !opts.force)`. `state.user` is only ever written
 * from `resolveChromeOwner().user` (or an explicit `--user`), which resolves to
 * the default owner name or whatever `CHROME_USER_ENV` names — it is NEVER the
 * literal "me" in the production configuration, so the veto could never fire. The
 * consequence was the exact thing the docstring promises against: ADOPTION
 * deliberately writes state for a browser it did not start (see
 * chromeDaemonStatus), records it under the owner's user name, and `stop` then
 * SIGTERM'd it — the operator's own Chrome. A sibling comment 30 lines above
 * records that hardcoding a username there was already a measured bug and was
 * fixed in `isThisProcessOwner`; the same mistake survived here. The predicate is
 * now the fact that actually distinguishes the two paths: `origin`.
 */
export function stopChromeDaemon(opts: { dataDir: string; force?: boolean }): { stopped: boolean; note: string } {
  const state = readDaemonState(opts.dataDir);
  if (!state) return { stopped: false, note: "no recorded chrome daemon to stop" };
  if (!opts.force && state.origin !== "spawned") {
    return {
      stopped: false,
      note:
        state.origin === "adopted"
          ? "refusing to stop: this Chrome was ADOPTED, not started by ui2api — it belongs to whoever launched it. Re-run with --force only if you are certain it is ours."
          : "refusing to stop: the recorded daemon carries no spawn provenance (written by an older build), so we cannot prove ui2api started it. Re-run with --force only if you are certain it is ours.",
    };
  }
  try {
    process.kill(state.pid, "SIGTERM");
    clearDaemonState(opts.dataDir);
    return { stopped: true, note: `stopped chrome daemon pid ${state.pid}` };
  } catch (e) {
    clearDaemonState(opts.dataDir);
    return { stopped: false, note: `could not signal pid ${state.pid}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The attach port Playwright should use, or undefined when no daemon is up.
 * This is what makes the launch seam prefer the EXISTING Chrome: when a daemon
 * is live, the pool attaches instead of spawning a browser per request.
 */
export async function resolveAttachPort(
  dataDir: string,
): Promise<number | undefined> {
  const explicit = process.env.UI2API_ATTACH_PORT;
  if (explicit) return Number(explicit);
  const st = await chromeDaemonStatus(dataDir);
  return st.running ? st.port : undefined;
}
