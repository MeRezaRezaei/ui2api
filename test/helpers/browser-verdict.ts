/**
 * GOAL 150: THE BROWSER HALF'S OUTCOME MUST BE A FACT, NOT A LOG LINE.
 *
 * The gap this exists to close, measured: `test/integration.ts` catches one
 * narrow class of failure — the dynamic loader cannot LOAD the browser because
 * an OS library is missing — prints one loud `stderr` line and calls
 * `process.exit(0)`. So `npm test` is green, `deploy` unblocks, and the only
 * evidence that half the suite never ran is one line buried in a ~3,500-line
 * log. Nothing asserted the skip did not happen. There was no marker, no
 * counter, no distinct job status, and nothing in the tree recorded it.
 *
 * TWO defects, and this module is the fix for both.
 *
 *   1. THE SKIP WAS INVISIBLE. It now writes a machine-readable verdict file
 *      (`.ci-verdict/integration.json`) on BOTH outcomes — pass and skip — and
 *      `test/gate-wiring.test.ts` READS it. "The browser half did not run"
 *      becomes an assertable fact instead of a log line somebody has to
 *      remember to scroll for. The read side needs no CI configuration at all:
 *      `npm test` already runs before `npm run test:unit` in every CI config,
 *      and `test/gate-wiring.test.ts`'s rule R6 already PINS that order, so
 *      the verdict is guaranteed to exist by the time the unit lane looks.
 *
 *   2. THE SKIP PREDICATE WAS TOO LOOSE — and this is the half that actually
 *      catches regressions. The old test matched
 *      `/error while loading shared libraries|cannot open shared object file/`
 *      against the WHOLE error blob. That pattern cannot tell an OS-provisioning
 *      fault from a real one: any missing shared object at all was silently
 *      downgraded to a green exit 0. So a genuine regression — this project
 *      gaining a native dependency whose `.so` is not installed, say — would
 *      have hidden behind the skip forever, and the narrowing would have been
 *      free of charge to an attacker or a careless contributor.
 *
 *      The classifier below closes that by NAME. A missing library is an
 *      environment fault only if it is one of the shared objects
 *      `playwright install-deps` is responsible for putting on the box. Anything
 *      else fails hard, with the name printed. The default is FAIL-CLOSED: an
 *      unrecognised library is a failure, never a skip.
 *
 * WHY A LIST AND NOT A SHAPE. The question that has to be answered is "whose
 * library is missing — Debian's, or ours?" and the only answer available at
 * failure time is the name. A shape heuristic ("looks like a system lib") would
 * happily accept `libu2api-native.so`, which is precisely the regression class
 * this gate exists to refuse. Naming is the discriminator; the list is the
 * boundary; being off the list is red.
 *
 * THE HONEST LIMIT, stated rather than hidden. The list has to be maintained.
 * If a future chromium revision gains a NEW OS dependency, that dependency is
 * off the list, the loader cannot load it, and the gate goes RED — naming the
 * library, which is the correct outcome and a one-line fix. That is the
 * intended shape of this failure: loud, specific, and actionable. The bad
 * shape would be the opposite, a skip that cannot be re-opened.
 *
 * WHY A FAIL-CLOSED BOUNDARY IS NOT THE "PERMANENTLY RED" TRAP. The recurring
 * `libnspr4` fault IS on the list, because it is a real chromium OS
 * dependency — so the measured fault keeps its skip and the pipeline does not
 * go permanently red on a foreign mirror signature. What goes red is an
 * UNRECOGNISED library, which is by construction not the recurring mirror
 * fault. The two cases are separated by the list, not by a retry count and not
 * by a human reading a log.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not change when a browser
 * that LOADS and then misbehaves fails — that path is untouched and still
 * `process.exit(1)`. It does not make the pipeline red when a known OS library
 * is missing; it makes that state a recorded, readable, queryable fact that a
 * gate can see, which is the difference between "silently absent" and
 * "absent and known".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Directory the verdict is written to, relative to the repo root. */
export const VERDICT_DIR = ".ci-verdict";

/** File name inside {@link VERDICT_DIR}. The `suite` field inside must agree. */
export const VERDICT_FILE = "integration.json";

/** Absolute or repo-relative path of the verdict file. */
export function verdictPath(root: string): string {
  return isAbsolute(VERDICT_DIR)
    ? join(VERDICT_DIR, VERDICT_FILE)
    : join(root, VERDICT_DIR, VERDICT_FILE);
}

/**
 * Shared objects `playwright install-deps` is responsible for on Debian.
 *
 * The principle, so the list is auditable rather than magic: every entry is an
 * OS-level shared object that the BROWSER links against and that no code in
 * this repository ships. If this project ever grows its own native module, its
 * soname is absent from this list by construction, and the loader cannot load
 * it -> hard failure. That asymmetry is the whole design.
 *
 * `libnspr4.so` is the MEASURED case (pipelines 1056 and 1061: `libnspr4.so:
 * cannot open shared object file`), together with the two libraries that ship
 * in the same NSS package and fail together with it.
 *
 * Entries are stored as SONAME STEMS (`libfoo.so`), never versioned
 * (`libfoo.so.2`), and {@link sonameStem} strips the version off both sides.
 * That is deliberate: the list must survive a Debian point release bumping a
 * library's ABI suffix, otherwise the correct library on a newer base image
 * would read as an unknown one and turn this gate into noise.
 *
 * NOTE ON `libssl3.so`: that is NSS's, not OpenSSL's (`libssl.so.3`). Listing
 * the NSS soname means an OPENSSL regression is deliberately NOT excusable and
 * fails hard — again the intended direction.
 */
export const OS_DEP_LIBRARIES: readonly string[] = [
  "libasound.so",
  "libatk-1.0.so",
  "libatk-bridge-2.0.so",
  "libatspi.so",
  "libcairo.so",
  "libcups.so",
  "libdbus-1.so",
  "libdrm.so",
  "libexpat.so",
  "libgbm.so",
  "libglib-2.0.so",
  "libgobject-2.0.so",
  "libgtk-3.so",
  "libnspr4.so",
  "libnss3.so",
  "libnssutil3.so",
  "libpango-1.0.so",
  "libpangocairo-1.0.so",
  "libplc4.so",
  "libplds4.so",
  "libsecret-1.so",
  "libsmime3.so",
  "libssl3.so",
  "libx11-xcb.so",
  "libx11.so",
  "libxcb.so",
  "libxcomposite.so",
  "libxdamage.so",
  "libxext.so",
  "libxfixes.so",
  "libxi.so",
  "libxkbcommon.so",
  "libxrandr.so",
  "libxrender.so",
  "libxss.so",
  "libxtst.so",
];

/**
 * Strip an ABI version suffix so `libcups.so.2` and `libcups.so.2.0.0` compare
 * equal to the stem `libcups.so`. Only the numeric part AFTER the `.so` is
 * removed, so `libnspr4.so` (no version) is returned unchanged — the `4` is
 * part of the name, not an ABI suffix, and must not be stripped.
 */
export function sonameStem(name: string): string {
  return name.trim().replace(/\.so\.[0-9]+(?:\.[0-9]+)*$/i, ".so");
}

/** The library stems this repository treats as OS-provisioning faults. */
export function osDepStems(): Set<string> {
  return new Set(OS_DEP_LIBRARIES.map(sonameStem));
}

/**
 * The dynamic loader's own diagnostic. Deliberately NOT the old loose
 * `/error while loading shared libraries|cannot open shared object file/i`
 * test on its own: that pattern's presence is only ADMISSIBLE evidence. It
 * admits the question "which library"; the allowlist answers "is that ours".
 */
const LOADER_DIAGNOSTIC =
  /error while loading shared libraries|cannot open shared object file|shared object file not found/i;

/** Every shared-object name mentioned in a blob, in first-seen order. */
function sonamesIn(blob: string): string[] {
  const out: string[] = [];
  for (const m of blob.matchAll(/([A-Za-z0-9_+.-]+\.so(?:\.[0-9]+)*)/g)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export type VerdictOutcome = "passed" | "skipped" | "failed";

export type VerdictClassification = "none" | "os-library-provisioning";

export interface BrowserVerdict {
  /** Schema version. Bump on any breaking shape change; the validator pins it. */
  schema: 1;
  suite: "integration";
  outcome: VerdictOutcome;
  /** Non-empty IFF `outcome === "skipped"`. Names as the loader printed them. */
  missingLibraries: string[];
  /** One line, never empty — a verdict with no reason is not a verdict. */
  reason: string;
  /** `"os-library-provisioning"` only when the skip was justified by the list. */
  classification: VerdictClassification;
  /**
   * Which job wrote this. The gate refuses a verdict stamped by a DIFFERENT
   * job, so a stale file left in a workspace can never vouch for a later run.
   * `null` outside CI.
   */
  job: { ciJobId: string | null; ciPipelineId: string | null; ciCommitSha: string | null };
  node: string;
  platform: string;
}

/** The environment stamp a verdict carries. Read from the ambient env. */
export function stampJob(env: NodeJS.ProcessEnv = process.env): BrowserVerdict["job"] {
  const nullable = (v: string | undefined): string | null => (v && v.length > 0 ? v : null);
  return {
    ciJobId: nullable(env.CI_JOB_ID),
    ciPipelineId: nullable(env.CI_PIPELINE_ID),
    ciCommitSha: nullable(env.CI_COMMIT_SHA),
  };
}

/** Build a verdict from the ambient runtime. Always returns a complete record. */
export function makeVerdict(
  outcome: VerdictOutcome,
  reason: string,
  missingLibraries: string[] = [],
  classification: VerdictClassification = "none",
): BrowserVerdict {
  return {
    schema: 1,
    suite: "integration",
    outcome,
    missingLibraries,
    reason: reason.length > 0 ? reason : outcome,
    classification: outcome === "skipped" ? classification : "none",
    job: stampJob(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

export type Classification =
  | { outcome: "skipped"; missingLibraries: string[]; reason: string; classification: "os-library-provisioning" }
  | { outcome: "failed"; missingLibraries: string[]; reason: string; classification: "none" };

/**
 * Decide whether a failed integration run is an ENVIRONMENT fault or a REAL
 * one. This is the whole regression-vs-transient-mirror decision, and it is a
 * pure function of the error text so it can be tested without a browser.
 *
 * The three outcomes, and each is a decision somebody can audit:
 *
 *   - No loader diagnostic at all -> `failed`. The browser either loaded and
 *     misbehaved, or failed for some other reason. This is the real-regression
 *     path and it is untouched by the skip.
 *   - Loader diagnostic, every named library on {@link OS_DEP_LIBRARIES} ->
 *     `skipped`, classified `os-library-provisioning`. The recurring
 *     `libnspr4` fault lands here and keeps its non-red pipeline.
 *   - Loader diagnostic, any library OFF the list -> `failed`, with the name
 *     in the reason. A `.so` this repository introduced is not Debian's
 *     problem and must not be excusable.
 */
export function classifyIntegrationFailure(blob: string): Classification {
  if (!LOADER_DIAGNOSTIC.test(blob)) {
    return {
      outcome: "failed",
      missingLibraries: [],
      reason: "not a loader diagnostic — the browser loaded and then failed, which is a real regression",
      classification: "none",
    };
  }
  const named = sonamesIn(blob);
  if (named.length === 0) {
    // The diagnostic is present but names no library. That is the shape this
    // gate must NOT wave through: an unnameable provisioning fault is exactly
    // the case where nobody could later tell it from a regression.
    return {
      outcome: "failed",
      missingLibraries: [],
      reason:
        "loader diagnostic present but no shared object was named — refusing to skip an unnamed provisioning fault, " +
        "because an unnameable skip is indistinguishable from a regression",
      classification: "none",
    };
  }
  const allowed = osDepStems();
  const unknown = named.filter((n) => !allowed.has(sonameStem(n)));
  if (unknown.length > 0) {
    return {
      outcome: "failed",
      missingLibraries: named,
      reason:
        `missing shared object(s) not in the OS-dependency list, so this is NOT a provisioning fault: ${unknown.join(", ")} — ` +
        `a library this repository introduced is a real failure and must not be skipped`,
      classification: "none",
    };
  }
  return {
    outcome: "skipped",
    missingLibraries: named,
    reason:
      `the dynamic loader could not load the browser because OS library/libraries ${named.join(", ")} ` +
      `are absent; these are playwright install-deps dependencies, so this is a runner-provisioning fault`,
    classification: "os-library-provisioning",
  };
}

/**
 * The machine-checkable contract of a verdict file. Returns one message per
 * violation, so a caller can report all of them instead of the first.
 *
 * This is the "assertable fact" the gap asked for. It is a VALIDATOR over an
 * UNKNOWN value on purpose: the gate must be able to reject a file it did not
 * write, including a truncated one and a hand-written one.
 */
export function verdictProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["verdict is not a JSON object"];
  }
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) problems.push(`schema must be 1, got ${JSON.stringify(v.schema)}`);
  if (v.suite !== "integration") problems.push(`suite must be "integration", got ${JSON.stringify(v.suite)}`);
  const outcome = v.outcome;
  if (outcome !== "passed" && outcome !== "skipped" && outcome !== "failed") {
    problems.push(`outcome must be one of passed|skipped|failed, got ${JSON.stringify(outcome)}`);
  }
  if (typeof v.reason !== "string" || v.reason.trim().length === 0) {
    problems.push("reason must be a non-empty string");
  }
  if (!Array.isArray(v.missingLibraries) || v.missingLibraries.some((n) => typeof n !== "string")) {
    problems.push("missingLibraries must be an array of strings");
  } else if (outcome === "skipped" && v.missingLibraries.length === 0) {
    problems.push('outcome "skipped" with an empty missingLibraries — a skip must name what was missing');
  } else if (outcome !== "skipped" && v.missingLibraries.length > 0) {
    problems.push(`outcome ${JSON.stringify(outcome)} carries missingLibraries, which only a skip may do`);
  }
  const expected: VerdictClassification = outcome === "skipped" ? "os-library-provisioning" : "none";
  if (v.classification !== expected) {
    problems.push(`classification must be ${JSON.stringify(expected)} for outcome ${JSON.stringify(outcome)}, got ${JSON.stringify(v.classification)}`);
  }
  // The self-consistency of the skip: a verdict may not claim the
  // provisioning classification for a library the list does not carry. This is
  // the assertion that makes a HAND-WRITTEN skip unpassable.
  if (outcome === "skipped" && Array.isArray(v.missingLibraries) && v.missingLibraries.length > 0) {
    const allowed = osDepStems();
    const unknown = (v.missingLibraries as string[]).filter((n) => !allowed.has(sonameStem(n)));
    if (unknown.length > 0) {
      problems.push(`verdict claims a provisioning skip for library/libraries outside the OS list: ${unknown.join(", ")}`);
    }
  }
  const job = v.job as Record<string, unknown> | undefined;
  if (job === null || typeof job !== "object" || Array.isArray(job)) {
    problems.push("job must be an object");
  } else {
    for (const k of ["ciJobId", "ciPipelineId", "ciCommitSha"]) {
      if (!(k in job) || (job[k] !== null && typeof job[k] !== "string")) {
        problems.push(`job.${k} must be present and a string or null`);
      }
    }
  }
  for (const k of ["node", "platform"]) {
    if (typeof v[k] !== "string" || (v[k] as string).length === 0) problems.push(`${k} must be a non-empty string`);
  }
  return problems;
}

/** Write the verdict, creating the directory. Returns the path written. */
export function writeVerdict(root: string, verdict: BrowserVerdict): string {
  const path = verdictPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(verdict, null, 2) + "\n");
  return path;
}

export interface VerdictRead {
  present: boolean;
  path: string;
  value?: unknown;
  problems: string[];
}

/**
 * Read + validate the verdict. A MISSING file is reported as `present: false`
 * with no problems, because whether one is owed depends on the caller (CI owes
 * one; a bare local unit run does not). Deciding that is the gate's job, not
 * this function's — a reader that failed on absence would make every local run
 * of the unit suite red.
 */
export function readVerdict(root: string): VerdictRead {
  const path = verdictPath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { present: false, path, problems: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { present: true, path, problems: [`verdict is not parseable JSON: ${(e as Error).message}`] };
  }
  return { present: true, path, value, problems: verdictProblems(value) };
}
