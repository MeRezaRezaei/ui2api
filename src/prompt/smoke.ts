// GOAL 40: `ui2api smoke` — one-command anonymous end-to-end self-test (the
// buy-first "zero to sell" artifact). Sequence + honesty contract:
//   (a) checkRequirements() runs UNCHANGED first (GOAL 33/39 doctrine: every
//       check executes for real with named reasons; any OS-level fail is a
//       NAMED failure + exit 1 — never a guessed verdict);
//   (b) an anonymous driveable chat package must be present — the named
//       candidate is duckduckgo (metadata.json VERIFIED 2026-09-23, full
//       surface, "Anonymous site — never login-gated", headless-capable). If
//       its package is not installed, the proven install-registry seam
//       (installPackage — the same one `ui2api install <pkg>` uses) installs
//       it and the CLI prints that it did;
//   (c) ONE real anonymous chat round-trip through the existing ChatDriver
//       path (the same driver `ui2api prompt` uses; headless per the anonymous
//       posture) — the answer is READ OFF THE PAGE by the driver, never
//       synthesized;
//   (d) prints `smoke OK: duckduckgo answered "<first line>" in Nms` or the
//       NAMED failure; the exit code is the gate (smokeExitCode: ok -> 0,
//       any named failure -> 1).
//
// Injectable seams (same pattern as test/requirements.test.ts): unit tests
// override checkOs / anonymousProfile / installAnon / ask so NO browser is
// ever launched in the test suite — the real defaults are thin real
// implementations.
import { isChatShapedProfile, resolveProfile, type ChatSiteProfile } from "../profile/profile.js";
import { ChatDriver, type PromptResult } from "./driver.js";
import { checkRequirements, type RequirementsReport } from "../runtime/requirements.js";
import {
  DEFAULT_REGISTRY_URL,
  defaultPackagesRoot,
  installPackage,
  type InstallResult,
} from "../registry/install.js";
import { resolveDataDir } from "./registry.js";

/** The named anonymous driveable chat package the smoke targets. */
export const SMOKE_ANON_SITE = "duckduckgo";

/** The smoke's round-trip prompt — the site must answer it verbatim. */
export const SMOKE_PROMPT = "reply with exactly: SMOKE OK";

/** Injectable seams — every default is a thin real implementation; tests
 *  override each one so no browser is launched and no network is touched. */
export interface SmokeDeps {
  /** Vault/data dir handed to the requirements gate (GOAL 33/39). */
  dataDir: string;
  /** Registry base the install seam uses when the anonymous package is missing. */
  registryBaseUrl: string;
  /** Packages root the install seam writes into (defaultPackagesRoot by default). */
  packagesRoot: string;
  /** The requirements gate — defaults to the REAL checkRequirements(). */
  checkOs: () => Promise<RequirementsReport>;
  /** Resolve the anonymous driveable chat profile — defaults to the real
   *  duckduckgo resolution (loginRequired=false AND chat-shaped only). */
  anonymousProfile: () => ChatSiteProfile | null;
  /** Install the named anonymous package via the registry seam. */
  installAnon: () => Promise<InstallResult>;
  /** ONE real chat round-trip — defaults to a real ChatDriver ask. */
  ask: (profile: ChatSiteProfile, prompt: string) => Promise<PromptResult>;
}

export interface SmokeOutcome {
  ok: boolean;
  /** The site that answered / failed. */
  site: string;
  /** First content line of the read-off-page answer (ok only). */
  answer?: string;
  /** Wall-clock ms of the round-trip (ok only). */
  ms?: number;
  /** The install seam ran because the anonymous package was missing — the
   *  CLI prints this ("smoke: installed it"). */
  installedAnon?: InstallResult;
  /** The printed verdict line (OK or the NAMED failure). */
  message: string;
}

/** Exit-code mapping — the shell gate: ok -> 0, every named failure -> 1. */
export function smokeExitCode(outcome: SmokeOutcome): 0 | 1 {
  return outcome.ok ? 0 : 1;
}

// The first CONTENT line of an answer read off the page. Some sites
// (duckduckgo — live-verified) prepend UI chrome — the active-model chip —
// to the assistant bubble's innerText ("<model chip>\n\n<answer>..."); the
// chip line is short and lacks terminal punctuation. Honest + site-agnostic:
// a first line that is short and has no terminal punctuation while more lines
// follow is treated as chrome and skipped (the same live-verified heuristic
// the duckduckgo capability runner uses, capabilities/duckduckgo.ts:293-298).
export function firstContentLine(raw: string): string {
  const lines = raw
    .split("\n")
    .map((l) => l.trim());
  while (lines.length && !lines[0]) lines.shift();
  const first = lines[0] ?? "";
  if (lines.length > 1 && first.length <= 40 && !/[.,!?]$/.test(first)) {
    const next = lines.slice(1).find((l) => l);
    return (next ?? first).slice(0, 200);
  }
  return first.slice(0, 200);
}

function defaultAnonymousProfile(): ChatSiteProfile | null {
  try {
    const p = resolveProfile(SMOKE_ANON_SITE);
    return p.loginRequired === false && isChatShapedProfile(p) ? p : null;
  } catch {
    return null; // not installed / not anonymous-driveable — the install seam decides
  }
}

async function defaultAsk(profile: ChatSiteProfile, prompt: string, dataDir: string): Promise<PromptResult> {
  const driver = new ChatDriver(profile, { dataDir });
  try {
    return await driver.ask(prompt);
  } finally {
    await driver.close();
  }
}

/** Build the smoke's default seams. `dataDir` from the canonical env source
 *  (UI2API_DATA_DIR / UI2API_DATA_DIR_OVERRIDE -> "data"). */
export function defaultSmokeDeps(overrides: Partial<SmokeDeps> = {}): SmokeDeps {
  const dataDir = resolveDataDir();
  const registryBaseUrl = process.env.UI2API_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const packagesRoot = defaultPackagesRoot();
  return {
    dataDir,
    registryBaseUrl,
    packagesRoot,
    checkOs: () => checkRequirements({ deps: { dataDir } }),
    anonymousProfile: defaultAnonymousProfile,
    installAnon: () => installPackage(SMOKE_ANON_SITE, registryBaseUrl, packagesRoot),
    ask: (profile, prompt) => defaultAsk(profile, prompt, dataDir),
    ...overrides,
  };
}

/**
 * Run the smoke: (a) the requirements gate, (b) ensure the anonymous
 * driveable package, (c) ONE real anonymous chat round-trip. Returns the
 * printed verdict + the exit-code decision — the CLI never guesses, it prints
 * this outcome and sets process.exitCode = smokeExitCode(outcome).
 */
export async function runSmoke(opts: { deps?: Partial<SmokeDeps>; prompt?: string } = {}): Promise<SmokeOutcome> {
  const deps = defaultSmokeDeps(opts.deps ?? {});
  const prompt = opts.prompt ?? SMOKE_PROMPT;

  // (a) the requirements gate — checkRequirements UNCHANGED; any OS-level
  // fail is a NAMED failure (the check's own reason), never a guessed verdict.
  const report = await deps.checkOs();
  const failed = report.checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    const reasons = failed.map((c) => `${c.id}: ${c.reason ?? "failed"}`).join("; ");
    return {
      ok: false,
      site: "",
      message: `smoke FAIL: OS-level requirements not met (${reasons}) — fix the named reasons, then re-run`,
    };
  }

  // (b) ensure an anonymous driveable chat package is present.
  let profile = deps.anonymousProfile();
  let installed: InstallResult | undefined;
  if (!profile) {
    try {
      installed = await deps.installAnon();
    } catch (e) {
      return {
        ok: false,
        site: "",
        message:
          `smoke FAIL: no anonymous chat package installable — installing "${SMOKE_ANON_SITE}" failed (${(e as Error).message}). ` +
          `Hint: 'ui2api install ${SMOKE_ANON_SITE}' (network/registry permitting), then re-run smoke`,
      };
    }
    profile = deps.anonymousProfile();
    if (!profile) {
      return {
        ok: false,
        site: "",
        message:
          `smoke FAIL: anonymous chat package "${SMOKE_ANON_SITE}" installed (v${installed.version}) but still not driveable — ` +
          `its packaged profile must be anonymous (loginRequired=false) and chat-shaped; inspect capabilities/${SMOKE_ANON_SITE}/profile.json, then re-run smoke`,
      };
    }
  }

  // (c) ONE real anonymous chat round-trip through the ChatDriver path — the
  // answer is read off the page, never synthesized.
  const t0 = Date.now();
  let result: PromptResult;
  try {
    result = await deps.ask(profile, prompt);
  } catch (e) {
    return {
      ok: false,
      site: profile.id,
      message: `smoke FAIL: round-trip failed on ${profile.id} — ${(e as Error).message.split("\n")[0]}`,
    };
  }
  const ms = Date.now() - t0;
  const first = firstContentLine(result.answer);
  if (!first) {
    return {
      ok: false,
      site: profile.id,
      message: `smoke FAIL: round-trip on ${profile.id} returned no answer (doneReason=${result.doneReason}) — the page did not answer`,
    };
  }
  const outcome: SmokeOutcome = {
    ok: true,
    site: profile.id,
    answer: first,
    ms,
    message: `smoke OK: ${profile.id} answered "${first}" in ${ms}ms`,
  };
  if (installed !== undefined) outcome.installedAnon = installed;
  return outcome;
}