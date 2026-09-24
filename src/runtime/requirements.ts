// OS-level requirements readiness check (GOAL 33) — the `requirements`/`doctor`
// command + runtime checker. Answers "is this package's OS-level environment
// ready / working / on-hold / not-ready?" BEFORE any browser work, with the
// NAMED reason for every non-ready state.
//
// Honesty contract:
//   - every check is EXECUTED for real (tests inject-and-assert instead of
//     faking results); a check that cannot run reports not-ready + reason,
//     never a guessed verdict;
//   - this module NEVER launches a browser: the chrome check resolves the
//     binary through browser.ts's ladder (resolveChromeExec, exported) and
//     reads its version via a `chrome --version` execute-only probe (no
//     window/profile/renderer starts); the only network it touches is the
//     optional UI2API_ATTACH_PORT probe, a short HTTP GET against an
//     already-running Chrome's CDP /json/version endpoint;
//   - verdict vocabulary is the verbatim's own: ready / working / on-hold /
//     not-ready.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveChromeExec, bundledChromiumPath } from "./browser.js";
import {
  detectDisplayInfo,
  ui2apiUser,
  ui2apiUserHome,
  ui2apiUserDataDir,
  userExists,
  type DisplayInfo,
} from "./xhost-capture.js";
import { listAccounts, loadSnapshot, snapshotPath, type StoredAccount } from "./session-store.js";
import {
  buildRegistryPackages,
  chatSurfaceStatus,
  defaultChatSurface,
  listInstalledPackageIds,
  resolveDataDir,
  type ChatSurfaceStatus,
  type RegistryVerified,
} from "../prompt/registry.js";
import { resolvePackagedProfile } from "../profile/profile.js";

export type CheckStatus = "pass" | "fail" | "skip";
export interface RequirementsCheck {
  id: string;
  status: CheckStatus;
  /** Positive evidence when the check passed (e.g. resolved binary + version). */
  detail?: string;
  /** Named reason on fail — and the skip rationale when status is "skip". */
  reason?: string;
}

export type Verdict = "ready" | "working" | "on-hold" | "not-ready";
export type PackageKind = "chat" | "capability";

export interface RequirementPackage {
  id: string;
  kind: PackageKind;
  url: string;
  /** Derived from url (null when the url is absent/unparsable — no vault key). */
  host: string | null;
  loginRequired: boolean;
  /** GOAL 32 surface truth: builtin / verified / unverified-candidate /
   *  dormant / dead-end (chatSurfaceStatus). */
  siteStatus: ChatSurfaceStatus;
}

export interface VaultResult {
  status: CheckStatus;
  detail?: string;
  reason?: string;
  /** Capture date of the limiting (OLDEST) stored session — present only when
   *  the snapshot/account carries one (never guessed). */
  capturedAt?: string;
  /** Whole days since capture (clamped >= 0) — absent when no date is known. */
  ageDays?: number;
  /** Honest risk signal ONLY (GOAL 39): ageDays > SESSION_STALE_DAYS. Age is
   *  NOT expiry — site-dependent lifetimes — so the verdict stays pass/ready;
   *  the flag exists to make the pre-flight gate name what `profile list` has
   *  always shown. Absent when no date is known (skip silently, never guess). */
  stale?: boolean;
}

/** Capture-age risk flag threshold (days). A session older than this is flagged
 *  `stale` in the requirements report — an honest risk signal, never an
 *  "expired" verdict (age ≠ expiry: cookie/session lifetimes are
 *  site-dependent, so the flag never changes the ready/working verdict). */
export const SESSION_STALE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PackageRequirements extends RequirementPackage {
  verdict: Verdict;
  /** Named reasons for the verdict (empty when ready). */
  reasons: string[];
  vault: VaultResult;
}

export interface RequirementsReport {
  generatedAt: string;
  /** The daemon/CLI runtime's node version, for the report header. */
  node: string;
  /** Global OS-level checks (node, chrome, display, browser-home, attach,
   *  env-knobs) — identical for every package. */
  checks: RequirementsCheck[];
  packages: PackageRequirements[];
  summary: Record<Verdict, number>;
}

/** Injectable seams — every default is a thin real implementation; tests
 *  override each one so no real binary/network/filesystem is touched. */
export interface RequirementsDeps {
  dataDir: string;
  nodeVersion: string;
  ui2apiUser: () => string;
  userExists: (user: string) => boolean;
  ui2apiUserDataDir: () => string | null;
  ui2apiUserHome: (user: string) => string;
  copiedProfileProbe: (user: string) => "present" | "missing" | "unreadable";
  detectDisplay: () => DisplayInfo | null;
  chromeResolve: () => string | null;
  chromeVersion: (exec: string) => string | null;
  bundledChromium: () => string | null;
  probeAttachPort: (port: number) => Promise<boolean>;
  listAccounts: (dataDir: string, host: string) => StoredAccount[];
  legacySessionPresent: (dataDir: string, host: string) => boolean;
  /** The legacy flat snapshot's capturedAt (ProfileSnapshot.capturedAt) — the
   *  freshness source when no identity-keyed account exists. Default reads the
   *  snapshot; tests inject. Null/empty = no date → flag skipped, never guessed. */
  legacySnapshotCapturedAt: (dataDir: string, host: string) => string | null;
  /** Injectable clock for capture-age math (GOAL 39) — tests pin time; the
   *  default is the real wall clock. */
  now: () => Date;
  packages: () => RequirementPackage[];
  registryVerified: (id: string) => RegistryVerified | false;
}

// --- default implementations of the seams (all thin, all real) ---

function defaultChromeResolve(): string | null {
  return resolveChromeExec({}) ?? null;
}

// Execute-only version probe: `chrome --version` prints and exits — no window,
// no profile, no renderer, no browser session. Bounded and injectable so tests
// never execute a real binary.
function defaultChromeVersion(exec: string): string | null {
  try {
    const out = execFileSync(exec, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const m = /\d+(?:\.\d+)+/.exec(out);
    return m ? m[0] : out.trim().slice(0, 80);
  } catch {
    return null;
  }
}

// The machine-owned browser home: the ui2api user's copied Chrome profile
// (wave-19 seam: launched with --user-data-dir=/home/ui2api/.ui2api-chrome).
// "present" = the dir exists AND is non-empty AND readable from this session;
// EACCES is reported honestly as "unreadable", never as "missing".
function defaultCopiedProfileProbe(user: string): "present" | "missing" | "unreadable" {
  const dir = join(ui2apiUserHome(user), ".ui2api-chrome");
  try {
    return readdirSync(dir).length > 0 ? "present" : "missing";
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err?.code === "ENOENT" ? "missing" : "unreadable";
  }
}

// The attach probe is the ONLY network this module performs: a short HTTP GET
// against the CDP endpoint of an ALREADY-RUNNING Chrome. Never launches one.
async function defaultProbeAttachPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function defaultLegacySessionPresent(dataDir: string, host: string): boolean {
  return loadSnapshot(snapshotPath(dataDir, host)) !== null;
}

function defaultLegacySnapshotCapturedAt(dataDir: string, host: string): string | null {
  return loadSnapshot(snapshotPath(dataDir, host))?.capturedAt ?? null;
}

// --- package surface derivation (the same /sites + /registry coverage) ---

export interface ChatSurfaceInput {
  id: string;
  url: string;
  loginRequired: boolean;
}

/**
 * The full per-package surface the doctor covers: the given chat surface first
 * (the CLI passes the default chat set; the daemon passes its own profilesById
 * gate), then every installed capability package (the /registry coverage),
 * then any packaged chat-shaped profile the chat surface excluded (zenmux /
 * xiaomimimo — surfaced HONESTLY with their dormant/dead-end status instead of
 * being hidden). Chat profiles first, capability packages after.
 */
export function requirementPackagesFor(chatSurface: ChatSurfaceInput[]): RequirementPackage[] {
  const out: RequirementPackage[] = [];
  const seen = new Set<string>();
  for (const c of chatSurface) {
    seen.add(c.id);
    out.push(mkPackage(c.id, "chat", c.url, c.loginRequired));
  }
  for (const p of buildRegistryPackages()) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(mkPackage(p.id, "capability", p.url, p.authRequired));
  }
  // Packaged chat-shaped profiles outside the surfaced set (dormant/dead-end
  // exclusions and any profile without a manifest) — the doctor must NAME them.
  for (const id of listInstalledPackageIds()) {
    if (seen.has(id)) continue;
    const prof = resolvePackagedProfile(id);
    if (!prof) continue;
    seen.add(id);
    out.push(mkPackage(id, "chat", prof.url, prof.loginRequired !== false));
  }
  out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "chat" ? -1 : 1));
  return out;
}

function mkPackage(id: string, kind: PackageKind, url: string, loginRequired: boolean): RequirementPackage {
  let host: string | null = null;
  if (url) {
    try {
      host = new URL(url).host;
    } catch {
      host = null;
    }
  }
  return { id, kind, url, host, loginRequired, siteStatus: chatSurfaceStatus(id) };
}

// The chat surface the doctor lists is exactly what /sites serves; the excluded
// chat-shaped packages (zenmux/xiaomimimo) are added with their honest status.

function defaultPackages(): RequirementPackage[] {
  const chat = defaultChatSurface().map((e): ChatSurfaceInput => ({
    id: e.id,
    url: e.profile.url,
    loginRequired: e.profile.loginRequired !== false,
  }));
  return requirementPackagesFor(chat);
}

// --- the checks ---

/** (a) Node floor: >= 22.13.0 (the node:sqlite unflagged floor). */
export function checkNodeVersion(version: string): RequirementsCheck {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return { id: "node", status: "fail", reason: `node version "${version}" unparsable` };
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ok =
    major > 22 ||
    (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)));
  return ok
    ? { id: "node", status: "pass", detail: `node ${version} (>= 22.13.0)` }
    : { id: "node", status: "fail", reason: `node ${version} < 22.13.0 — node:sqlite (profile scan/ingest) is unflagged from 22.13.0` };
}

/** (g) env-knob sanity: conflicting combos are NAMED, never silent. */
export function envKnobChecks(env: NodeJS.ProcessEnv = process.env): RequirementsCheck[] {
  const out: RequirementsCheck[] = [];
  const attach = env.UI2API_ATTACH_PORT;
  const userData = env.UI2API_USER_DATA_DIR || env.UI2API_CHROME_PROFILE_PATH;
  if (attach && userData) {
    out.push({
      id: "env-knobs",
      status: "fail",
      reason: "UI2API_ATTACH_PORT and UI2API_USER_DATA_DIR/UI2API_CHROME_PROFILE_PATH both set — attach mode ignores the profile dir (pick one)",
    });
  }
  if (env.UI2API_CHROME === "0" && env.UI2API_CHROME_PATH) {
    out.push({
      id: "env-knobs",
      status: "fail",
      reason: "UI2API_CHROME=0 (explicit off) conflicts with UI2API_CHROME_PATH — unset one",
    });
  }
  if (out.length === 0) {
    out.push({ id: "env-knobs", status: "pass", detail: "no conflicting env-knob combos" });
  }
  return out;
}

function browserHomeCheck(deps: RequirementsDeps): RequirementsCheck {
  const user = deps.ui2apiUser();
  if (!deps.userExists(user)) {
    return {
      id: "browser-home",
      status: "fail",
      reason: `ui2api OS user "${user}" missing — sudo useradd -m ${user} (machine-owned browser home + login data, verbatim 1495)`,
    };
  }
  const home = deps.ui2apiUserHome(user);
  const dataDir = deps.ui2apiUserDataDir();
  const copied = deps.copiedProfileProbe(user);
  const problems: string[] = [];
  if (dataDir === null) {
    problems.push(
      `ui2api data dir not usable from this session (${user}'s XDG data dir unwritable) — run one setup pass as root/sudo -u ${user}, or set UI2API_DATA_DIR`
    );
  }
  if (copied === "missing") {
    problems.push(
      `copied Chrome profile dir ${home}/.ui2api-chrome missing or empty — run the copy-of-official-Chrome setup (the machine-owned browser home)`
    );
  } else if (copied === "unreadable") {
    problems.push(
      `copied Chrome profile dir ${home}/.ui2api-chrome unreadable from this session (permission denied) — run the check with read access (root or the owning group)`
    );
  }
  if (problems.length > 0) {
    return { id: "browser-home", status: "fail", reason: problems.join("; ") };
  }
  return {
    id: "browser-home",
    status: "pass",
    detail: `ui2api user "${user}" present — data dir ${dataDir}; copied Chrome profile ${home}/.ui2api-chrome present`,
  };
}

/** Run the global OS checks (node, chrome, display, browser-home, attach,
 *  env-knobs). The only side effects: fs reads, the execute-only chrome
 *  --version probe, and (only when UI2API_ATTACH_PORT is set) the HTTP GET
 *  probe. Never launches a browser. */
export async function runOsChecks(deps: RequirementsDeps): Promise<{ node: string; checks: RequirementsCheck[] }> {
  const checks: RequirementsCheck[] = [];
  // (a) node
  const node = deps.nodeVersion;
  checks.push(checkNodeVersion(node));
  // (b) chrome binary via the launchBrowser ladder (folded, never duplicated)
  const exec = deps.chromeResolve();
  if (!exec) {
    checks.push({
      id: "chrome",
      status: "fail",
      reason:
        "no Chrome binary resolvable through the launchBrowser ladder (UI2API_CHROME_PATH, /usr/bin/google-chrome[-stable], /opt/google/chrome/chrome, playwright browser cache) — run `npx playwright install chromium` or install Chrome",
    });
  } else {
    const ver = deps.chromeVersion(exec);
    if (ver) {
      checks.push({ id: "chrome", status: "pass", detail: `${exec} ${ver}` });
    } else {
      checks.push({
        id: "chrome",
        status: "fail",
        detail: exec,
        reason: `chrome binary at ${exec} but --version probe failed (execute-only probe, no browser session)`,
      });
    }
  }
  // (c) display: headed needs a real display; headless needs the playwright cache
  const headed = process.env.UI2API_HEADED === "1";
  if (headed) {
    const disp = deps.detectDisplay();
    if (disp) {
      checks.push({
        id: "display",
        status: "pass",
        detail: `headed (UI2API_HEADED=1) — display ${disp.display}${disp.xauthority ? " + XAUTHORITY" : ""}`,
      });
    } else {
      checks.push({
        id: "display",
        status: "fail",
        reason: "UI2API_HEADED=1 but no display detected — headed needs one (start Xvfb, or unset UI2API_HEADED)",
      });
    }
  } else {
    const bundled = deps.bundledChromium();
    if (bundled) {
      checks.push({ id: "display", status: "pass", detail: `headless — playwright browser cache present (${bundled})` });
    } else {
      checks.push({
        id: "display",
        status: "fail",
        reason: "headless: playwright browser cache missing — run `npx playwright install chromium` (or set UI2API_CHROME_PATH)",
      });
    }
  }
  // (d) machine-owned browser home
  checks.push(browserHomeCheck(deps));
  // (f) attach port reachable when set (HTTP probe of an already-running Chrome)
  const portRaw = process.env.UI2API_ATTACH_PORT;
  if (portRaw) {
    const port = Number(portRaw);
    const ok = await deps.probeAttachPort(port);
    checks.push(
      ok
        ? { id: "attach", status: "pass", detail: `UI2API_ATTACH_PORT=${port} reachable (CDP /json/version answered)` }
        : {
            id: "attach",
            status: "fail",
            reason: `attach port not reachable (UI2API_ATTACH_PORT=${port}) — start Chrome with --remote-debugging-port=${port} or unset UI2API_ATTACH_PORT`,
          }
    );
  } else {
    checks.push({ id: "attach", status: "skip", reason: "UI2API_ATTACH_PORT not set" });
  }
  // (g) env-knob conflicts
  checks.push(...envKnobChecks(process.env));
  return { node, checks };
}

/** The limiting capture: the OLDEST date wins (oldest = the session most at
 *  risk of having drifted). Lexicographic compare is valid for ISO-8601. */
function oldestCapturedAt(accounts: StoredAccount[]): string | undefined {
  let oldest: string | undefined;
  for (const a of accounts) {
    if (!a.capturedAt) continue;
    if (oldest === undefined || a.capturedAt < oldest) oldest = a.capturedAt;
  }
  return oldest;
}

/**
 * GOAL 39: freshness math from a capture date. Missing/empty/unparsable dates
 * return {} — the flag is SKIPPED silently, never guessed. ageDays is clamped
 * >= 0 (a clock-skewed future date is not "minus N days stale").
 */
function freshnessFor(
  capturedAt: string | undefined | null,
  now: Date
): { capturedAt?: string; ageDays?: number; stale?: boolean } {
  if (!capturedAt) return {};
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return {};
  const ageDays = Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
  return { capturedAt, ageDays, stale: ageDays > SESSION_STALE_DAYS };
}

/** Spread the freshness fields onto a pass VaultResult + the human-readable
 *  age detail ("captured <date> (N days ago)") and, when stale, the NAMED warn
 *  reason with the re-capture instruction. No date → base returned untouched. */
function withFreshness(
  base: VaultResult,
  f: { capturedAt?: string; ageDays?: number; stale?: boolean },
  host: string
): VaultResult {
  if (!f.capturedAt || f.ageDays === undefined) return base;
  const date = f.capturedAt.slice(0, 10);
  const v: VaultResult = {
    ...base,
    capturedAt: f.capturedAt,
    ageDays: f.ageDays,
    stale: f.stale,
    detail: `${base.detail} — captured ${date} (${f.ageDays} days ago)`,
  };
  if (f.stale) {
    v.reason = `stale: captured ${date} (${f.ageDays} days ago) — re-capture: profile add-all --known (or 'profile capture/import ${host}')`;
  }
  return v;
}

/** (e) vault session per host: identity-keyed accounts first, legacy flat
 *  snapshot second. Anonymous packages skip (no stored session needed). The
 *  pass result carries capture-age freshness (GOAL 39): capturedAt, ageDays and
 *  the stale risk flag — age is surfaced honestly, never an expiry verdict. */
export function resolveVault(pkg: RequirementPackage, deps: RequirementsDeps): VaultResult {
  if (!pkg.host) return { status: "skip", reason: "no resolvable url — no host to key the vault by" };
  if (!pkg.loginRequired) return { status: "skip", reason: "anonymous — no stored session needed" };
  const accounts = deps.listAccounts(deps.dataDir, pkg.host);
  if (accounts.length > 0) {
    return withFreshness(
      {
        status: "pass",
        detail: `${accounts.length} stored account(s) for ${pkg.host} (${accounts.map((a) => a.slug).join(", ")})`,
      },
      freshnessFor(oldestCapturedAt(accounts), deps.now()),
      pkg.host
    );
  }
  if (deps.legacySessionPresent(deps.dataDir, pkg.host)) {
    return withFreshness(
      { status: "pass", detail: `legacy flat session present for ${pkg.host}` },
      freshnessFor(deps.legacySnapshotCapturedAt(deps.dataDir, pkg.host), deps.now()),
      pkg.host
    );
  }
  return {
    status: "fail",
    reason: `no stored session for ${pkg.host} — awaiting-capture (run 'ui2api profile add-all --known' or 'profile capture/import ${pkg.host}')`,
  };
}

/**
 * Pure verdict derivation — jointly falsifiable in tests:
 *   not-ready: dormant/dead-end (GOAL 32 honest exclusion), missing vault
 *              session (never captured), or a check that cannot run (no host);
 *   on-hold:   a named OS check failed;
 *   working:   all OS checks pass + vault present + a real recorded live
 *              round-trip (metadata.verified — never claimed otherwise);
 *   ready:     all OS checks pass + vault present + no recorded round-trip
 *              (driveable now, honestly unverified).
 */
export function packageVerdict(
  pkg: RequirementPackage,
  os: { node: string; checks: RequirementsCheck[] },
  vault: VaultResult,
  verified: RegistryVerified | false
): PackageRequirements {
  const base: PackageRequirements = { ...pkg, verdict: "ready", reasons: [], vault };
  if (pkg.siteStatus === "dormant") {
    return { ...base, verdict: "not-ready", reasons: ["dormant (metadata.json) — parked origin; excluded from the chat surface until live-verified"] };
  }
  if (pkg.siteStatus === "dead-end") {
    return { ...base, verdict: "not-ready", reasons: ["dead-end (metadata.json) — DNS-pinned dead-end; no live round-trip exists"] };
  }
  const failed = os.checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    return { ...base, verdict: "on-hold", reasons: failed.map((c) => c.reason ?? c.id) };
  }
  if (vault.status === "skip" && !pkg.host) {
    return { ...base, verdict: "not-ready", reasons: [vault.reason ?? "no host to key the vault by"] };
  }
  if (vault.status === "fail") {
    return { ...base, verdict: "not-ready", reasons: [vault.reason ?? "no stored session"] };
  }
  if (verified && typeof verified === "object" && typeof verified.since === "string") {
    return {
      ...base,
      verdict: "working",
      reasons: [`live round-trip verified ${verified.since} (${verified.evidence ?? "recorded proof"})`],
    };
  }
  return base;
}

function defaultRegistryVerified(id: string): RegistryVerified | false {
  return buildRegistryPackages().find((p) => p.id === id)?.verified ?? false;
}

/** Build the checker's default seams. `dataDir` from the canonical env source
 *  (UI2API_DATA_DIR / UI2API_DATA_DIR_OVERRIDE → "data"). */
export function defaultRequirementsDeps(overrides: Partial<RequirementsDeps> = {}): RequirementsDeps {
  return {
    dataDir: resolveDataDir(),
    nodeVersion: process.versions.node,
    ui2apiUser: ui2apiUser.bind(null),
    userExists,
    ui2apiUserDataDir,
    ui2apiUserHome,
    copiedProfileProbe: defaultCopiedProfileProbe,
    detectDisplay: detectDisplayInfo,
    chromeResolve: defaultChromeResolve,
    chromeVersion: defaultChromeVersion,
    bundledChromium: bundledChromiumPath,
    probeAttachPort: defaultProbeAttachPort,
    listAccounts,
    legacySessionPresent: defaultLegacySessionPresent,
    legacySnapshotCapturedAt: defaultLegacySnapshotCapturedAt,
    now: () => new Date(),
    packages: defaultPackages,
    registryVerified: defaultRegistryVerified,
    ...overrides,
  };
}

/** The full requirements report: global OS checks + per-package verdicts. */
export async function checkRequirements(opts: { deps?: Partial<RequirementsDeps> } = {}): Promise<RequirementsReport> {
  const deps = defaultRequirementsDeps(opts.deps ?? {});
  const os = await runOsChecks(deps);
  const packages = deps.packages().map((pkg) => {
    // Dormant/dead-end (GOAL 32 exclusions) are decided WITHOUT a vault probe
    // — they are not-ready regardless, and we never touch the session store
    // for a package the chat surface already excludes.
    const vault =
      pkg.siteStatus === "dormant" || pkg.siteStatus === "dead-end"
        ? { status: "skip" as const, reason: "dormant/dead-end package — verdict decided without a vault probe" }
        : resolveVault(pkg, deps);
    return packageVerdict(pkg, os, vault, deps.registryVerified(pkg.id));
  });
  const summary: Record<Verdict, number> = { ready: 0, working: 0, "on-hold": 0, "not-ready": 0 };
  for (const p of packages) summary[p.verdict]++;
  return { generatedAt: new Date().toISOString(), node: os.node, checks: os.checks, packages, summary };
}