/**
 * GOAL 100: the daemon disclosed NOTHING about its own posture. `GET /health`
 * answered only `{ ok, defaultSite, sites, pool }`, so neither an operator nor a
 * health-checker could learn whether the process was token-gated or wide open,
 * or whether a trust-weakening knob was active — even though every one of those
 * knobs is genuinely enforced in code.
 *
 * This module derives the disclosure from the EXACT functions the enforcement
 * paths call, so the report cannot drift from the behaviour. It reports SHAPES
 * and COUNTS only: never a token value, never a path, never a cookie.
 *
 * THE THREE LIES THIS FILE USED TO TELL (all measured, all closed here)
 *
 *  1. `attachRootsCount` re-parsed `UI2API_ATTACH_ROOTS` on `/[:,]/` while the
 *     gate (`file-attach.ts:230`) splits on `/[:;,]/` and then keeps only
 *     ABSOLUTE entries. MEASURED on `"/tmp/a:/tmp/b;/tmp/c,/tmp/d"`: the gate
 *     opened FOUR roots, `/health` reported THREE. A semicolon-separated list —
 *     the obvious way an operator writes one — under-reported the attack
 *     surface, and `"/a,rel/path,./x"` reported 3 roots for a gate that opens 1.
 *     The same class of drift made the byte cap a lie in the OTHER direction:
 *     the gate parses with `Number.parseInt` and this file used `Number`, so
 *     `UI2API_ATTACH_MAX_BYTES=20mb` capped the gate at 20 BYTES while /health
 *     reported 20 MiB — a million-fold over-statement of what may be read.
 *     FIX: call the gate's own `attachRoots()` / `attachMaxBytes()`. A posture
 *     report is only worth reading if the thing it reports on is the thing.
 *
 *  2. `chromeNoSandbox` was read from the env alone
 *     (`UI2API_CHROME_NO_SANDBOX !== "0"`), which is the CONFIGURED INTENT. The
 *     launch seam (`browser.ts:413`) applies `--no-sandbox` only when
 *     `!(usingRealProfile || env.UI2API_CHROME_NO_SANDBOX === "0")`. MEASURED
 *     with a real profile in play: the report said "sandbox disabled" while the
 *     spawned Chrome kept its sandbox ON — a TRUST row stating the opposite of
 *     the truth. FIX: report the EFFECTIVE outcome, derived from the same
 *     `userChromeProfile()` input the launcher reads, and disclose
 *     `realProfileInPlay` so the operator can see WHY.
 *
 *  3. `UI2API_PROMPTD_TOKEN` was typed as a literal in more than one place.
 *     `TOKEN_ENV` below is the single definition; the remaining literal sites
 *     are reported in the comment on the constant.
 */

// The GATE's own resolvers, imported (aliased `gate*` so the reported fields
// below keep the honest names) rather than re-parsed. This import IS the fix for
// LIE 1: there is no second parser left in this file to drift.
import {
  attachMaxBytes as gateAttachMaxBytes,
  attachRoots as gateAttachRoots,
  ATTACH_MAX_BYTES_ENV,
  ATTACH_ROOTS_ENV,
} from "../runtime/file-attach.js";
import { userChromeProfile } from "../runtime/browser.js";

/**
 * THE definition site for the daemon's bearer-token knob. Everything that reads
 * the token must import this name instead of typing the string.
 *
 * Two sites still type the literal and are REPORTED, not silently duplicated:
 *   - `src/prompt/http.ts:534` — `opts.token ?? process.env.UI2API_PROMPTD_TOKEN`
 *     (NOT this file's to edit; the exact change is in the handover).
 *   - `src/prompt/http.ts:699` — `buildRegistryContract(Boolean(process.env.UI2API_PROMPTD_TOKEN))`
 *   - `src/cli.ts` imports it from here (fixed in the same change).
 */
export const TOKEN_ENV = "UI2API_PROMPTD_TOKEN";

export type Posture = {
  /** GOAL 126: the RESOLVED launch mode, not what the env merely requested. */
  headless: boolean;
  headful: boolean;
  /** the operator requested headful and did not get it — never silent */
  headlessDegraded: boolean;
  auth: "token" | "localhost-only";
  bind: string;
  /**
   * The EFFECTIVE `--no-sandbox` outcome of the launch seam — NOT the env's
   * configured intent. `false` here means the spawned Chrome keeps its sandbox,
   * whether or not `UI2API_CHROME_NO_SANDBOX` was set.
   */
  chromeNoSandbox: boolean;
  /**
   * A REAL user profile is in play for the launch. This is the fact that
   * suppresses `--no-sandbox` in `browser.ts:413`, disclosed so the row above
   * is explainable rather than mysterious.
   */
  realProfileInPlay: boolean;
  singleProcess: boolean;
  attachRootsCount: number;
  attachMaxBytes: number;
  warnings: string[];
};

/**
 * The env keys the GATE functions below read for themselves. `attachRoots()`,
 * `attachMaxBytes()` and `userChromeProfile()` all consult `process.env`
 * directly, while `daemonPosture` takes an injectable env so a test can pin the
 * report against a stated environment. These two facts are bridged HERE, in one
 * place, rather than by re-implementing the gate's parsing (which is how LIE 1
 * happened in the first place).
 *
 * The swap is synchronous, exception-safe, and skipped entirely in production —
 * `http.ts` calls `daemonPosture(process.env, …)`, so `env === process.env` and
 * the gate is consulted with the environment it would see anyway.
 */
function withGateEnv<T>(env: NodeJS.ProcessEnv, keys: readonly string[], fn: () => T): T {
  if (env === process.env) return fn();
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const k of keys) {
      const v = env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const PROFILE_ENV_KEYS = [
  "UI2API_USER_DATA_DIR",
  "UI2API_CHROME_PROFILE_PATH",
  "UI2API_CHROME_OWNER_PROFILE",
] as const;

/**
 * Is a REAL user profile in play for the next launch?
 *
 * `browser.ts:391-393` computes `explicitProfile = overrides.userDataDir ??
 * userChromeProfile()` and `usingRealProfile = Boolean(explicitProfile)`. The
 * daemon launches through `launchBrowser()` with no overrides, so the override
 * half is empty and the answer is exactly `Boolean(userChromeProfile())` — asked
 * of the SEAM's own resolver, never of a second reading of the env.
 */
export function realProfileInPlay(env: NodeJS.ProcessEnv = process.env): boolean {
  return withGateEnv(env, PROFILE_ENV_KEYS, () => Boolean(userChromeProfile()));
}

/**
 * The EFFECTIVE `--no-sandbox` decision, transcribed from the ONE place the
 * launch is built — `src/runtime/browser.ts:413`:
 *
 *   ...(usingRealProfile || process.env.UI2API_CHROME_NO_SANDBOX === "0"
 *        ? [] : ["--no-sandbox"]),
 *
 * so the flag is present iff NEITHER a real profile NOR the explicit opt-out.
 * `test/posture-gate-truth.test.ts` pins this transcription against the source
 * line, so an edit to the launcher fails LOUD here instead of quietly inverting
 * a TRUST row.
 */
export function effectiveChromeNoSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(realProfileInPlay(env) || env.UI2API_CHROME_NO_SANDBOX === "0");
}

/**
 * Derive the honest posture. `env` is injected so the report is provably the
 * same function of the environment the guards read.
 */
export function daemonPosture(env: NodeJS.ProcessEnv = process.env, bind = "127.0.0.1"): Posture {
  const token = (env[TOKEN_ENV] ?? "").trim();
  const auth: Posture["auth"] = token ? "token" : "localhost-only";

  // LIE 1, closed: the gate's own parser, never a second one.
  const attachRootsCount = withGateEnv(env, [ATTACH_ROOTS_ENV], () => gateAttachRoots()).length;
  const attachMaxBytes = withGateEnv(env, [ATTACH_MAX_BYTES_ENV], () => gateAttachMaxBytes());

  // LIE 2, closed: the EFFECTIVE outcome of the launch seam, not the env's wish.
  const realProfile = realProfileInPlay(env);
  const chromeNoSandbox = effectiveChromeNoSandbox(env);
  const singleProcess = env.UI2API_SINGLE_PROCESS === "1";

  const warnings: string[] = [];
  if (auth === "localhost-only") warnings.push("no bearer token set — reachable by anything that can reach the bind address");
  if (bind !== "127.0.0.1" && bind !== "::1" && auth === "localhost-only")
    warnings.push(`bound to ${bind} with NO token — do not expose this`);
  if (chromeNoSandbox) {
    warnings.push("chrome sandbox disabled (--no-sandbox) — no real profile in play and UI2API_CHROME_NO_SANDBOX!=0");
  } else if (realProfile) {
    // The confusing case, named: the knob may well be unset, and the sandbox is
    // ON anyway, because a real profile suppresses the flag. Reporting only the
    // knob here is what let the old row read the opposite of the truth.
    warnings.push(
      "chrome sandbox ON — a real user profile is in play, and the launch seam never adds --no-sandbox for one " +
        "(browser.ts:413), so UI2API_CHROME_NO_SANDBOX is irrelevant on this path"
    );
  } else {
    warnings.push("chrome sandbox ON (UI2API_CHROME_NO_SANDBOX=0)");
  }
  if (singleProcess) warnings.push("UI2API_SINGLE_PROCESS=1 — no pool isolation");
  if (attachRootsCount > 0) warnings.push(`${attachRootsCount} attach root(s) readable — file-upload paths are widened`);
  if (attachRootsCount === 0) warnings.push("attach path form refused (no UI2API_ATTACH_ROOTS)");

  // GOAL 126: disclose the RESOLVED headless truth, and name the degraded case.
  // The operator asked for a headed browser and did not get one is exactly the
  // state that used to pass unnoticed while the code believed it was a real
  // user. A posture report that cannot express "you asked for X, you got Y" is
  // not a posture report.
  const wantHeadful = env.UI2API_HEADED === "1";
  const displayAvailable = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  const headless = !(wantHeadful && displayAvailable);
  const headlessDegraded = wantHeadful && !displayAvailable;
  if (headlessDegraded) {
    warnings.push(
      "headless-degraded — UI2API_HEADED=1 was requested but no DISPLAY/WAYLAND_DISPLAY is available, " +
        "so the browser was spawned --headless=new; the real-user posture is NOT in effect"
    );
  }

  return {
    auth,
    bind,
    chromeNoSandbox,
    realProfileInPlay: realProfile,
    singleProcess,
    attachRootsCount,
    attachMaxBytes,
    headless,
    headful: !headless,
    headlessDegraded,
    warnings,
  };
}
