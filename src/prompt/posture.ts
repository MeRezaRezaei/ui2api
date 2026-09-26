/**
 * GOAL 100: the daemon disclosed NOTHING about its own posture. `GET /health`
 * answered only `{ ok, defaultSite, sites, pool }`, so neither an operator nor a
 * health-checker could learn whether the process was token-gated or wide open,
 * or whether a trust-weakening knob was active — even though every one of those
 * knobs is genuinely enforced in code.
 *
 * This module derives the disclosure from the EXACT env reads the enforcement
 * paths use, so the report cannot drift from the behaviour. It reports SHAPES
 * and COUNTS only: never a token value, never a path, never a cookie.
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
  chromeNoSandbox: boolean;
  singleProcess: boolean;
  attachRootsCount: number;
  attachMaxBytes: number;
  warnings: string[];
};

const parseRoots = (raw: string | undefined): number =>
  (raw ?? "")
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean).length;

/**
 * Derive the honest posture. `env` is injected so the report is provably the
 * same function of the environment the guards read.
 */
export function daemonPosture(env: NodeJS.ProcessEnv = process.env, bind = "127.0.0.1"): Posture {
  const token = (env[TOKEN_ENV] ?? "").trim();
  const auth: Posture["auth"] = token ? "token" : "localhost-only";
  const attachRootsCount = parseRoots(env.UI2API_ATTACH_ROOTS);
  const rawMax = Number(env.UI2API_ATTACH_MAX_BYTES);
  const attachMaxBytes = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 20 * 1024 * 1024;

  // Mirrors src/runtime/browser.ts: `--no-sandbox` is applied unless a REAL user
  // profile is in use, so the default posture on this box IS sandbox-disabled.
  const chromeNoSandbox = env.UI2API_CHROME_NO_SANDBOX !== "0";
  const singleProcess = env.UI2API_SINGLE_PROCESS === "1";

  const warnings: string[] = [];
  if (auth === "localhost-only") warnings.push("no bearer token set — reachable by anything that can reach the bind address");
  if (bind !== "127.0.0.1" && bind !== "::1" && auth === "localhost-only")
    warnings.push(`bound to ${bind} with NO token — do not expose this`);
  if (chromeNoSandbox) warnings.push("chrome sandbox disabled (--no-sandbox) unless UI2API_CHROME_NO_SANDBOX=0");
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
    singleProcess,
    attachRootsCount,
    attachMaxBytes,
    headless,
    headful: !headless,
    headlessDegraded,
    warnings,
  };
}
