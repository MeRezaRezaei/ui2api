// GOAL 149 follow-up: the WIRING OF THE WIRING. Gates that are correct but never
// RUN, or that run in only one of two places.
//
// This repo has paid for that class three times, in three different shapes, and
// every one stayed invisible precisely because the existing pins guard the wrong
// axis — they answer "is this number/claim true?", never "does the pipeline
// actually invoke it?":
//   1. GOAL 145 — six test files on disk that NO npm script ran. The gates were
//      real; nothing executed them. Six green gates that meant nothing.
//   2. The doc-numbers self-reference — its file count regexed the package.json
//      script STRING instead of readdir-ing `test/`, so a file missing from the
//      script was invisible to the very pin guarding it. (Fixed; the precedent.)
//   3. CI had not compiled this project since pipeline 196: a `build` job died on
//      `git clone --depth 1` + a pinned sha, and `verify` was SKIPPED. Three
//      pipelines went by before anyone read the CI state.
//
// A change that wires a real gate wrongly — a CI step pointing at a file that
// does not exist, a config inventing `npm run <script>` package.json never
// defined, a knob set in `.gitlab-ci.yml` and forgotten in
// `.github/workflows/ci.yml`, a corpus gate quietly dropped from a config, a
// `test/*.test.ts` reachable only by a bespoke script — passes every other gate
// in the repo. That is this file's whole subject.
//
// DESIGN RULES this file holds itself to:
//   * Every list is DERIVED from disk (`readdirSync`, `readFileSync`, the git
//     index). A hardcoded list of gates or configs is exactly what rots.
//   * The GOAL 145 predicate is REUSED from `./doc-numbers-truth.test.js`
//     (`testFilesOnDisk` / `testFilesNamedByUnitScript` / `unrunTestFiles`), not
//     reimplemented: two copies of one pin rot independently and then one of them
//     is wrong in a way nothing notices. Side effect of that reuse, accepted
//     deliberately: importing that module registers ITS 14 tests in this process
//     too, so they appear in this file's output. It costs ~40ms and buys a single
//     source of truth; the alternative (moving the helpers to test/helpers/) is an
//     edit to a file this change does not own.
//   * Every rule is a REQUIRED-PRESENCE assertion, and every predicate takes the
//     config TEXT as an argument. A scanner that under-reads a config it cannot
//     parse turns into a FAILURE here, never a vacuous pass — and the one way a
//     scanner can lie green is by reading nothing at all, so each config is
//     separately asserted to have yielded real content (the non-vacuity tests).
//   * Rules 4 and 5 are scoped to the GIT INDEX, not the bare directory: CI
//     checks out a commit, so the shipped set is the index. A file on disk but
//     untracked is not yet part of the repo's contract and no pipeline could run
//     it — and four agents edit this tree at once, so failing on their in-flight
//     files would be a false positive on correct wiring, the class that teaches
//     people to ignore a gate. The scope reduction expires by itself: the moment
//     the file is committed, the requirement lands.
//   * Every assertion lives in a real top-level `test(...)`. This repo's rule: a
//     pin nobody counts is a pin nobody reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ciScan from "./helpers/ci-contract-scan.js";

import {
  GATE_CHAIN,
  KNOB_PARITY_ALLOW,
  checkChain,
  checkCiPaths,
  checkCiScripts,
  ciEnvKnobs,
  ciNpmRunScripts,
  ciPathRefs,
  ciStepTokens,
  discoverCiConfigs,
  fileExists,
  fmtDivergence,
  knobDivergences,
  packageJson,
  stripComments,
  trackedTestFiles,
  ui2apiKnobs,
  yamlScannerHazards,
} from "./helpers/ci-contract-scan.js";
import {
  testFilesNamedByUnitScript,
  testFilesOnDisk,
  unrunTestFiles,
} from "./doc-numbers-truth.test.js";
import {
  OS_DEP_LIBRARIES,
  VERDICT_DIR,
  classifyIntegrationFailure,
  makeVerdict,
  osDepStems,
  readVerdict,
  sonameStem,
  verdictPath,
  verdictProblems,
} from "./helpers/browser-verdict.js";
import { classifyLaunchFailure } from "./helpers/browser-launchability.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PKG = packageJson(ROOT);
const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

/** Every CI config, discovered rather than listed. */
const CI_CONFIG_FILES = discoverCiConfigs(ROOT);
const CI_TEXTS: Record<string, string> = Object.fromEntries(
  CI_CONFIG_FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]),
);

/** The shipped test files, from the git index. */
const TRACKED = trackedTestFiles(ROOT);

/** Test files on disk that the index does not carry yet (in-flight work). */
const UNTRACKED = [...testFilesOnDisk()].filter((f) => !TRACKED.has(f)).sort();

/** `test/….test.ts` paths named by ANY npm script, not only `test:unit`. */
function testFilesNamedByAnyScript(): Set<string> {
  const out = new Set<string>();
  for (const cmd of Object.values(PKG.scripts)) {
    for (const m of cmd.matchAll(/test\/[A-Za-z0-9._-]+\.test\.ts/g)) out.add(m[0]);
  }
  return out;
}

/**
 * `test:unit` covers `test/` by glob rather than an explicit list.
 *
 * A glob is legitimate wiring (`node --test test/*.test.ts`), and rules 4 and 5
 * must not fire on it: a literal-list comparison cannot see a glob, so comparing
 * anyway would report every file as "unrun" — a false positive on correct wiring.
 */
function anyScriptUsesTestGlob(): string[] {
  return Object.entries(PKG.scripts)
    .filter(([, cmd]) => /test\/\*\*?(?:\.test\.ts)?/.test(cmd))
    .map(([name]) => name)
    .sort();
}

// ============================================================ rule 1: paths ===

test("R1 every repo path a CI config references exists on disk", () => {
  const problems = CI_CONFIG_FILES.flatMap((f) => checkCiPaths(f, CI_TEXTS[f]!, ROOT));
  assert.deepEqual(problems, [], problems.join("; "));
});

test("R1 non-vacuity: every CI config was actually READ (a scanner that reads nothing proves nothing)", () => {
  assert.ok(CI_CONFIG_FILES.length >= 2, `expected both CI configs to be discovered, found ${JSON.stringify(CI_CONFIG_FILES)}`);
  for (const f of CI_CONFIG_FILES) {
    const yielded =
      ciPathRefs(CI_TEXTS[f]!).paths.length +
      ciPathRefs(CI_TEXTS[f]!).globs.length +
      ciNpmRunScripts(CI_TEXTS[f]!).length +
      ciEnvKnobs(CI_TEXTS[f]!).size +
      ciStepTokens(CI_TEXTS[f]!).length;
    assert.ok(yielded > 0, `${f} yielded nothing at all — R1 proved nothing about it`);
  }
});

test("MUTATION R1: a CI step pointing at a file that does not exist is reported by name, and a comment-only mention is not", () => {
  const text = [
    "# the old step used to run test/gone.test.ts",
    "  script:",
    "    - npx tsx test/ghost-gate.test.ts",
    "    - npx tsx test/*.test.ts",
  ].join("\n");
  const problems = checkCiPaths(".gitlab-ci.yml", text, ROOT);
  assert.equal(problems.length, 1, `expected exactly the ghost path; got ${JSON.stringify(problems)}`);
  assert.match(problems[0]!, /test\/ghost-gate\.test\.ts.*does not exist/);
  // The comment-only path is documentation, not wiring, and must not be checked.
  assert.ok(
    !problems.some((p) => p.includes("test/gone.test.ts")),
    "a path named only in a comment is not a CI step and must not be existence-checked",
  );
  // A glob is a legitimate reference to files that cannot be checked one at a time.
  assert.deepEqual(ciPathRefs(text).globs, ["test/*.test.ts"]);
});

// ========================================================== rule 2: scripts ===

test("R2 every `npm run <script>` in a CI config is a real package.json script (an INVENTED one fails)", () => {
  const problems = CI_CONFIG_FILES.flatMap((f) => checkCiScripts(f, CI_TEXTS[f]!, PKG.scripts));
  assert.deepEqual(problems, [], problems.join("; "));
  for (const f of CI_CONFIG_FILES) {
    assert.ok(ciNpmRunScripts(CI_TEXTS[f]!).length > 0, `${f} yielded no "npm run" invocation — R2 proved nothing about it`);
  }
});

test("MUTATION R2: a config inventing `npm run <script>` package.json never defined is named", () => {
  const config = ".github/workflows/ci.yml";
  const real = ciNpmRunScripts(CI_TEXTS[config]!);
  assert.ok(real.includes("typecheck"), "precondition: the live config runs npm run typecheck today");
  const stripped: Record<string, string> = { ...PKG.scripts };
  delete stripped["typecheck"];
  const invented = ciNpmRunScripts(CI_TEXTS[config]!).filter((s) => !(s in stripped));
  assert.deepEqual(invented, ["typecheck"], "the invented script must be named, and only it");
  const problems = checkCiScripts(config, CI_TEXTS[config]!, stripped);
  assert.equal(problems.length, 1, `expected one report; got ${JSON.stringify(problems)}`);
  assert.match(problems[0]!, /npm run typecheck.*scripts has no "typecheck"/);
  // The live table satisfies the same rule — it is not simply always-red.
  assert.deepEqual(checkCiScripts(config, CI_TEXTS[config]!, PKG.scripts), []);
});

// ============================================================= rule 3: knobs ===

test("R3 UI2API_* env knobs are set in BOTH CI configs (a knob set in one and forgotten in the other fails)", () => {
  const all: ReturnType<typeof knobDivergences> = [];
  for (let i = 0; i < CI_CONFIG_FILES.length; i++) {
    for (let j = i + 1; j < CI_CONFIG_FILES.length; j++) {
      const a = CI_CONFIG_FILES[i]!;
      const b = CI_CONFIG_FILES[j]!;
      all.push(...knobDivergences(a, CI_TEXTS[a]!, b, CI_TEXTS[b]!));
    }
  }
  const unexplained = all.filter((d) => KNOB_PARITY_ALLOW[d.knob] === undefined);
  assert.deepEqual(
    unexplained.map(fmtDivergence),
    [],
    `UI2API_* knob divergence between CI configs: ${JSON.stringify(unexplained.map(fmtDivergence))} — a gate enabled in one pipeline and not the other`,
  );
});

test("R3 the two knobs this gate exists for are SET in both configs, by assignment (a comment mention is not a setting)", () => {
  for (const knob of ["UI2API_REGISTRY_LIVE", "UI2API_GH_LIVE"]) {
    for (const f of CI_CONFIG_FILES) {
      assert.ok(
        ciEnvKnobs(CI_TEXTS[f]!).has(knob),
        `${f} must SET ${knob} (an assignment, not a comment mention) — this is the knob class that gets wired in one config only`,
      );
    }
  }
});

test("MUTATION R3: deleting the UI2API_GH_LIVE assignment from one config is reported as a parity divergence", () => {
  const a = ".gitlab-ci.yml";
  const b = ".github/workflows/ci.yml";
  const deleted = CI_TEXTS[a]!.replace(/\n\s*UI2API_GH_LIVE:.*/, "");
  assert.notEqual(deleted, CI_TEXTS[a]!, "the mutation must actually remove the assignment");
  // Filtered through KNOB_PARITY_ALLOW, exactly as the R3 gate itself filters.
  // Without that filter this assertion counted ALLOWED asymmetries as problems,
  // so the first justified exception added to the allow-list broke this
  // anti-vacuity test — a test about the mutation, failing on the baseline.
  const unexplained = (x: string, y: string) =>
    knobDivergences(a, x, b, y).filter((d) => KNOB_PARITY_ALLOW[d.knob] === undefined);
  const problems = unexplained(deleted, CI_TEXTS[b]!);
  assert.equal(problems.length, 1, `expected one UNEXPLAINED divergence; got ${JSON.stringify(problems)}`);
  assert.match(fmtDivergence(problems[0]!), /UI2API_GH_LIVE/);
  // Untouched, the pair is in parity — the rule is not simply always-red.
  assert.deepEqual(unexplained(CI_TEXTS[a]!, CI_TEXTS[b]!), []);
});

test("R3 allow-list hygiene: every knob-parity exception names a real knob AND carries a reason", () => {
  const known = new Set<string>();
  for (const f of CI_CONFIG_FILES) for (const k of ciEnvKnobs(CI_TEXTS[f]!).keys()) known.add(k);
  for (const [knob, reason] of Object.entries(KNOB_PARITY_ALLOW)) {
    assert.ok(reason.trim().length > 10, `allow-list entry "${knob}" has no reason; an unjustified exception must not sit here`);
    assert.ok(known.has(knob), `allow-list entry "${knob}" is STALE: no CI config sets that knob any more`);
  }
});

test("R3 KNOB SCOPE report: every env knob set in exactly one config, whatever its namespace (diagnostic, never a failure)", (t) => {
  // R3 fails on `UI2API_*` only, because that is the namespace this repo owns end
  // to end. A NON-UI2API knob set in one pipeline and not the other is still worth
  // a human's eye — `WIGOLO_REPO` is exactly such a knob, and a divergence there
  // would make one pipeline run the wigolo engine tests against a checkout the
  // other never made. Reported, never asserted: the UI2API_* namespace is the
  // rule; widening it to every key would fail on a legitimately job-scoped value.
  const [a, b] = CI_CONFIG_FILES;
  assert.ok(a && b, "expected two CI configs to compare");
  const mine = new Set(ciEnvKnobs(CI_TEXTS[a]!).keys());
  const theirs = new Set(ciEnvKnobs(CI_TEXTS[b]!).keys());
  for (const k of [...new Set([...mine, ...theirs])].sort()) {
    if (mine.has(k) !== theirs.has(k)) t.diagnostic(`${a} and ${b} disagree on env knob ${k}`);
  }
  for (const k of ["WIGOLO_REPO"]) {
    if (mine.has(k) && theirs.has(k)) t.diagnostic(`FINDING: ${k} is set in both configs but at DIFFERENT SCOPE (gitlab: job variables, github: one step's env) — harmless today, divergent the day a step reads it`);
  }
});

// ============================================================== rules 4 & 5 ===

test("R4 GOAL 145: every test/*.test.ts the repo SHIPS is named by scripts[\"test:unit\"]", () => {
  if (anyScriptUsesTestGlob().length > 0) {
    assert.fail(`scripts now cover test/ by glob (${anyScriptUsesTestGlob().join(", ")}); the literal-list comparison R4 is built on cannot see a glob, so this pin must be re-derived before it is trusted`);
  }
  const { unrun, missing } = unrunTestFiles(TRACKED, testFilesNamedByUnitScript());
  assert.deepEqual(
    unrun,
    [],
    `test files the repo ships that scripts["test:unit"] does not name: ${JSON.stringify(unrun)} — a gate nobody runs is not a gate (GOAL 145)`,
  );
  assert.deepEqual(missing, [], `scripts["test:unit"] names test files the repo does not ship: ${JSON.stringify(missing)}`);
  // The two sides must also agree numerically, so dropping a file from BOTH still
  // moves the derived count that README's claim is checked against — and the
  // comparison is over a real number of files, not an empty set that matches
  // itself. (The floor is the only hand-typed number here, and it exists solely
  // to make "both sides empty" a failure rather than a pass.)
  assert.equal(testFilesNamedByUnitScript().size, TRACKED.size);
  assert.ok(TRACKED.size >= 50, `the shipped set collapsed to ${TRACKED.size} files — R4/R5 are comparing almost nothing`);
});

test("R4 non-vacuity: the shipped set is a real, non-empty index read, and every shipped file is on disk", () => {
  assert.ok(TRACKED.size > 0, "the git index read returned nothing — R4/R5 would pass vacuously");
  const missingOnDisk = [...TRACKED].filter((f) => !fileExists(`test/${f}`, ROOT));
  assert.deepEqual(missingOnDisk, [], `the index lists test files that are not on disk: ${JSON.stringify(missingOnDisk)}`);
});

test("MUTATION R4: dropping a real shipped file from the test:unit list is named as unrun", () => {
  const victim = "host-independence-gate.test.ts";
  const inUnit = new Set(testFilesNamedByUnitScript());
  assert.ok(inUnit.has(victim), `precondition: ${victim} is wired into test:unit today; the mutation below is meaningless otherwise`);
  assert.ok(TRACKED.has(victim), `precondition: ${victim} is a shipped test file today`);
  inUnit.delete(victim);
  const { unrun } = unrunTestFiles(TRACKED, inUnit);
  assert.deepEqual(unrun, [victim], "the pin must name exactly the file no script runs");
});

test("R5 every test/*.test.ts the repo SHIPS is named by AT LEAST ONE npm script (not only test:unit)", () => {
  if (anyScriptUsesTestGlob().length > 0) {
    assert.fail(`scripts now cover test/ by glob (${anyScriptUsesTestGlob().join(", ")}); R5 must be re-derived against the glob before it is trusted`);
  }
  const named = testFilesNamedByAnyScript();
  const unrun = [...TRACKED].filter((f) => !named.has(`test/${f}`)).sort();
  assert.deepEqual(
    unrun,
    [],
    `shipped test files that NO npm script names: ${JSON.stringify(unrun)} — a file reachable only by a bespoke script can still be forgotten in CI`,
  );
  // Reverse direction, the same class as R1: a script naming a test file that
  // does not exist is a dead reference, not a passing pin.
  const ghosts = [...named].filter((p) => !fileExists(p, ROOT)).sort();
  assert.deepEqual(ghosts, [], `npm scripts name test files that do not exist: ${JSON.stringify(ghosts)}`);
});

test("MUTATION R5: a file moved out of test:unit into a bespoke script still fails R4 while R5 stays green", () => {
  // The case that separates the two rules: nothing is forgotten outright, the file
  // is merely reachable only by a one-off script — so the suite CI actually invokes
  // no longer gates it, and only R4 can see that.
  const inUnit = new Set(testFilesNamedByUnitScript());
  const moved = "account-surface.test.ts";
  inUnit.delete(moved);
  assert.deepEqual(unrunTestFiles(TRACKED, inUnit).unrun, [moved], "R4 must fire for a file moved out of the suite");
  const bespokeOnly = new Set([...inUnit].map((f) => `test/${f}`));
  assert.ok(!bespokeOnly.has(`test/${moved}`), "precondition: without its bespoke script the file is named by nothing");
});

// ============================================================= rule 6: chain ===

test("R6 each CI config runs the documented gate chain, in order: build -> typecheck -> verbatim -> integration -> unit", () => {
  for (const f of CI_CONFIG_FILES) {
    const problems = checkChain(f, CI_TEXTS[f]!);
    assert.deepEqual(problems, [], `${f}: ${problems.join("; ")}`);
    // Non-vacuity: an empty token list would satisfy the chain check trivially.
    assert.ok(
      ciStepTokens(CI_TEXTS[f]!).length >= GATE_CHAIN.length,
      `${f} yielded too few steps (${ciStepTokens(CI_TEXTS[f]!).length}) to prove the chain`,
    );
  }
});

test("MUTATION R6: a config that drops the verbatim-completeness gate is named, and one that reorders the chain is named", () => {
  const config = ".github/workflows/ci.yml";
  // (a) the corpus gate quietly removed from one config — the sentence both
  // configs call "part of the human-free chain" becomes false, silently.
  const dropped = CI_TEXTS[config]!.replace(/^(\s*)- run: npm run check:verbatim$/m, "$1# - run: npm run check:verbatim");
  assert.notEqual(dropped, CI_TEXTS[config]!, "the mutation must actually comment the step out");
  const problems = checkChain(config, dropped);
  assert.ok(
    problems.some((p) => /never runs "npm run check:verbatim"/.test(p)),
    `the missing corpus gate must be named; got ${JSON.stringify(problems)}`,
  );
  // (b) same steps, WRONG order — a set-membership check cannot see this, which is
  // why checkChain walks the token list in order rather than testing membership.
  const reordered = CI_TEXTS[config]!
    .replace(/^(\s*)- run: npm test$/m, "$1- run: npm run __SWAP__")
    .replace(/^(\s*)- run: npm run test:unit$/m, "$1- run: npm test")
    .replace(/^(\s*)- run: npm run __SWAP__$/m, "$1- run: npm run test:unit");
  assert.notEqual(reordered, CI_TEXTS[config]!, "the reorder mutation must actually change the config");
  assert.ok(
    checkChain(config, reordered).length > 0,
    `swapping the integration and unit steps must be reported; got ${JSON.stringify(checkChain(config, reordered))}`,
  );
});

test("R6 the chain is ANCHORED: every step is a real script, and every non-builtin step is named in AGENTS.md", (t) => {
  for (const { step, doc, builtin } of GATE_CHAIN) {
    // Every chain step must be a real script, documented or not: a chain entry
    // that is not a `scripts` key could never be run by any config.
    if (!builtin) {
      const name = step.replace("npm run ", "");
      assert.ok(name in PKG.scripts, `the chain requires "npm run ${name}" but package.json defines no such script`);
    }
    if (doc === null) {
      t.diagnostic(
        `FINDING: "${step}" is required by both CI configs but is NOT named in AGENTS.md — a wired gate nobody can find in the docs`,
      );
      continue;
    }
    assert.ok(AGENTS.includes(doc), `AGENTS.md no longer documents "${doc}"; the gate chain is unanchored`);
  }
  // The corpus gate's own justification, verbatim. It is written where the wiring
  // lives — in the CI configs' own comments, not in AGENTS.md — so the anchor is
  // read from the configs. If the sentence is edited out of every config, the gate
  // is no longer "part of the human-free chain" by the repo's own account and R6
  // would be this file's private opinion rather than a derived contract.
  const justifiedIn = CI_CONFIG_FILES.filter((f) => /human-free chain/i.test(CI_TEXTS[f]!));
  assert.ok(
    justifiedIn.length > 0,
    `no CI config calls the verbatim gate "part of the human-free chain" any more — the justification R6 rests on is gone from: ${JSON.stringify(CI_CONFIG_FILES)}`,
  );
});

// ======================================================= scanner precondition ===

test("SCANNER SAFETY: neither CI config uses a YAML construct a line scanner cannot read honestly", () => {
  // This is why no YAML dependency is added (see the helper's header): the two
  // configs use anchors, aliases and folded (`>`) scalars. If one ever does, the
  // scanner's REQUIRED-PRESENCE rules would under-read it, so the gate says so
  // loudly instead of quietly proving less than it claims.
  const hazards = CI_CONFIG_FILES.flatMap((f) => yamlScannerHazards(CI_TEXTS[f]!));
  assert.deepEqual(hazards, [], `${hazards.join("; ")} — the line scanner is no longer safe for these configs`);
  // And the hazard detector is not a no-op: each construct is reported.
  const planted = [
    "  script: >",
    "    - npm run build",
    "  base: &anchor",
    "  copy: *anchor",
  ].join("\n");
  assert.equal(yamlScannerHazards(planted).length, 3, `all three hazards must be named; got ${JSON.stringify(yamlScannerHazards(planted))}`);
});

test("NON-VACUITY: a config-shaped text the scanner cannot see into FAILS the chain instead of passing quietly", () => {
  // The one way a line scanner can lie green is by reading nothing. Every rule
  // must turn an unreadable config into a failure, never an empty pass.
  const opaque = "jobs:\n  build:\n    steps: []\n";
  assert.deepEqual(ciStepTokens(opaque), []);
  assert.equal(checkChain("opaque.yml", opaque).length, GATE_CHAIN.length, "every chain step must report missing");
  assert.deepEqual(ciNpmRunScripts(opaque), []);
  assert.deepEqual(ciPathRefs(opaque).paths, []);
  // An empty config must never satisfy the chain either.
  assert.equal(checkChain("empty.yml", "").length, GATE_CHAIN.length);
});

test("COMMENT SAFETY: a knob or path named only inside a comment is not a setting and not a reference", () => {
  // Both configs explain their knobs in prose right above the assignment. Reading
  // the comment as the assignment would make R3 pass a knob nobody sets, and
  // reading a commented-out path as a step would make R1 fail on stale prose.
  const text = [
    "# GOAL 147: the live half is opt-in (UI2API_GH_LIVE=1) so the suite never needs the network.",
    "  variables:",
    '    UI2API_REGISTRY_LIVE: "1"',
    "    # UI2API_GH_LIVE: \"1\"",
  ].join("\n");
  assert.deepEqual([...ciEnvKnobs(text).keys()], ["UI2API_REGISTRY_LIVE"], `comment leak: ${JSON.stringify([...ciEnvKnobs(text).keys()])}`);
  assert.deepEqual(ciPathRefs(text).paths, []);
  // The same name, uncommented, IS a setting — the stripper is not just deleting things.
  const live = text.replace('    # UI2API_GH_LIVE: "1"', '    UI2API_GH_LIVE: "1"');
  assert.deepEqual([...ciEnvKnobs(live).keys()].sort(), ["UI2API_GH_LIVE", "UI2API_REGISTRY_LIVE"]);
  assert.equal(stripComments(text).split("\n")[3]!.trim(), "");
});

// ==================================================== shipped-vs-in-flight set ===

test("SHIPPED SET: files on disk but not yet in the index are reported, so the R4/R5 scope reduction is visible", (t) => {
  // R4 and R5 read the git index, not the bare directory (see the header). That is
  // a deliberate narrowing, so it is printed rather than hidden: every file that
  // is currently outside the scope is named, and the moment it is committed the
  // requirement lands on it without any edit here.
  for (const f of UNTRACKED) {
    t.diagnostic(`in flight, not yet shipped: test/${f} — once committed it MUST be named by scripts["test:unit"]`);
  }
  assert.deepEqual(
    TRACKED.size > 0 ? [...TRACKED].filter((f) => !UNTRACKED.includes(f)).length : 0,
    TRACKED.size,
    "the shipped set and the in-flight set must not overlap",
  );
});

// ============================ rule 7: the browser half's OUTCOME is a fact ====
//
// GOAL 150. The gap: `test/integration.ts` caught one narrow class of failure —
// the dynamic loader cannot LOAD the browser — printed ONE loud `stderr` line
// and called `process.exit(0)`. So `npm test` was green, `deploy` unblocked, and
// the only evidence that the browser-dependent half never ran was one line in a
// ~3,500-line log. Nothing asserted the skip did not happen.
//
// Rule 7 makes that outcome a machine-readable fact with four parts, and each
// part is a different way the previous arrangement could rot:
//
//   R7a THE CLASSIFIER — the skip decision is a pure function of the error text,
//       so the transient-mirror case and the regression case are separated by
//       DATA (which library is missing) rather than by a human reading a log.
//   R7b THE BOUNDARY — the list of libraries that may be skipped is fail-closed
//       and well-formed. Off the list is a failure, never a skip.
//   R7c THE WIRING — `test/integration.ts` actually calls the classifier and
//       actually writes a verdict on BOTH outcomes. This is the GOAL-145 lesson
//       (gates that are correct but never run) pointed at this very mechanism.
//   R7d THE RECORD — in a CI job the verdict MUST exist, MUST be well-formed,
//       and MUST be stamped by THIS job. A missing or foreign verdict fails.
//
// R7d needs NO CI CONFIGURATION CHANGE, and that is deliberate. Every CI config
// already runs `npm test` before `npm run test:unit` — R6 above PINS that order —
// so the verdict exists by the time this file reads it. A mechanism that needed a
// new CI step could have been silently dropped from one config and stayed green;
// this one cannot be, because it depends on an order a sibling rule already holds.

test("R7a the loader's diagnostic is only ADMISSIBLE evidence — WHICH library decides skip vs fail", () => {
  // (1) The MEASURED fault. `libnspr4` is a real chromium OS dependency, so it
  // keeps its skip and the pipeline does not go permanently red on a foreign
  // mirror keyring. This is the exact text pipelines 1056/1061 produced.
  const measured =
    "browserType.launch: Executable doesn't exist\n" +
    "error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory";
  const skip = classifyIntegrationFailure(measured);
  assert.equal(skip.outcome, "skipped", `the measured libnspr4 fault must stay a skip; got ${JSON.stringify(skip)}`);
  assert.equal(skip.classification, "os-library-provisioning");
  assert.deepEqual(skip.missingLibraries, ["libnspr4.so"], "the skip must NAME the library, not just claim to be one");

  // (2) A regression wearing the same costume: the diagnostic is byte-identical
  // in shape, the library is not Debian's. The OLD predicate skipped this too —
  // which is the hole. It must now be a hard failure naming the library.
  const ours =
    "error while loading shared libraries: libui2api-native.so: cannot open shared object file: No such file or directory";
  const fail = classifyIntegrationFailure(ours);
  assert.equal(fail.outcome, "failed", `a library this repo introduced must NOT be skipped; got ${JSON.stringify(fail)}`);
  assert.equal(fail.classification, "none");
  assert.match(fail.reason, /libui2api-native\.so/, "the failure must name the library so the fault is actionable");

  // (3) A browser that LOADS and then misbehaves — the case the narrow match was
  // always protecting. Untouched: no loader diagnostic, so it fails.
  const misbehaves =
    "TimeoutError: locator.click: Timeout 30000ms exceeded.\n" +
    "Call log: - waiting for locator('div.composer')";
  const hard = classifyIntegrationFailure(misbehaves);
  assert.equal(hard.outcome, "failed", "a browser that loaded and misbehaved is a real regression");
  assert.deepEqual(hard.missingLibraries, []);

  // (4) An arbitrary assertion failure with no loader text at all.
  assert.equal(classifyIntegrationFailure("expected >=3 actions, got 0").outcome, "failed");

  // (5) The genuinely ambiguous shape: a loader diagnostic that names NO
  // library. Skipping here would manufacture exactly the invisibility this rule
  // exists to remove — an unnameable skip cannot be told from a regression by
  // anyone, including a future reader of the log. Fail-closed.
  const unnamed = classifyIntegrationFailure("error while loading shared libraries: something went wrong");
  assert.equal(unnamed.outcome, "failed", "an unnamed provisioning fault must fail rather than skip");
  assert.match(unnamed.reason, /no shared object was named/);
});

test("R7b the skippable set is fail-closed and well-formed: a typo cannot silently become a permanent red", () => {
  // Sorted + deduplicated + non-empty. A list that rots into an unsorted
  // duplicate is still CORRECT behaviourally, so nothing above would catch it;
  // this is the shape pin, and it is what makes a reviewer's diff readable.
  assert.deepEqual(
    [...OS_DEP_LIBRARIES],
    [...new Set(OS_DEP_LIBRARIES)].sort(),
    "OS_DEP_LIBRARIES must be sorted and free of duplicates so a diff shows only real changes",
  );
  assert.ok(OS_DEP_LIBRARIES.length > 0, "the allowlist must not be emptied — an empty list makes every loader fault a red");

  // Every entry is a SONAME STEM: it ends at `.so` and carries no ABI suffix.
  // An entry like `libcups.so.2` would silently stop matching after a Debian
  // point release bumps the suffix — a list that rots into unopenability is
  // exactly the "a gate that cannot open is not a gate" defect this repo has
  // already paid for once (the `public-verified` marker).
  for (const lib of OS_DEP_LIBRARIES) {
    assert.match(lib, /^[A-Za-z0-9_+.-]+\.so$/, `"${lib}" is not a bare soname stem — store it unversioned`);
    assert.equal(sonameStem(lib), lib, `"${lib}" must be its own stem`);
  }

  // Version tolerance, which is the property that keeps the list from rotting
  // into a permanent red on a newer base image: `libcups.so.2` and
  // `libcups.so.2.0.0` both resolve to the stem `libcups.so`.
  assert.equal(sonameStem("libcups.so.2"), "libcups.so");
  assert.equal(sonameStem("libcups.so.2.0.0"), "libcups.so");
  assert.equal(sonameStem("libnspr4.so"), "libnspr4.so", "the 4 in libnspr4 is part of the name, not an ABI suffix");

  // THE MEASURED CASE IS ON THE LIST. If this ever fails, the recurring mirror
  // fault turns the pipeline permanently red — the exact trade this design was
  // built to avoid — and the failure names the fix rather than just going red.
  const stems = osDepStems();
  for (const measured of ["libnspr4.so", "libplc4.so", "libplds4.so", "libnss3.so", "libsmime3.so"]) {
    assert.ok(stems.has(measured), `the measured browser-load fault's package family must be skippable: ${measured} is not on the list`);
  }

  // NON-VACUITY: the detector is not a no-op. An unknown stem is refused.
  assert.ok(!stems.has("libui2api-native.so"), "a library this project introduced must never be on the skippable list");
});

test("R7c the verdict file's CONTRACT rejects a hand-written or truncated skip", () => {
  // A valid skip validates.
  const good = { ...makeVerdict("skipped", "runner provisioning fault", ["libnspr4.so"], "os-library-provisioning") };
  assert.deepEqual(verdictProblems(good), [], `a legitimate skip must validate; got ${JSON.stringify(verdictProblems(good))}`);

  // A valid pass validates.
  assert.deepEqual(verdictProblems(makeVerdict("passed", "integration completed")), []);

  // A skip that CLAIMS the provisioning classification for a library the list
  // does not carry. This is the shape a hand-written "everything is fine" file
  // would take, and the validator must refuse it even though the file is
  // internally consistent — which is the whole point of the cross-check.
  const forged = { ...makeVerdict("skipped", "trust me", ["libui2api-native.so"], "os-library-provisioning") };
  assert.ok(
    verdictProblems(forged).some((p) => /outside the OS list/.test(p)),
    `a forged skip must be named; got ${JSON.stringify(verdictProblems(forged))}`,
  );

  // A skip with no evidence of what was missing.
  assert.ok(
    verdictProblems(makeVerdict("skipped", "it skipped")).some((p) => /empty missingLibraries/.test(p)),
    "a skip must name the library it skipped over",
  );

  // A PASS carrying missingLibraries — the contradiction a stale/merged file
  // could produce.
  assert.ok(
    verdictProblems({ ...makeVerdict("passed", "fine"), missingLibraries: ["libnspr4.so"] }).some((p) =>
      /only a skip may do/.test(p),
    ),
    "a pass must not carry missing libraries",
  );

  // Structural rubbish: not an object, an array, a bad schema, a bad suite.
  assert.ok(verdictProblems(null).length > 0);
  assert.ok(verdictProblems([]).length > 0);
  assert.ok(verdictProblems("passed").length > 0);
  assert.ok(verdictProblems({ ...makeVerdict("passed", "x"), schema: 2 }).some((p) => /schema must be 1/.test(p)));
  assert.ok(verdictProblems({ ...makeVerdict("passed", "x"), suite: "other" }).some((p) => /suite must be/.test(p)));
  assert.ok(verdictProblems({ ...makeVerdict("passed", "x"), reason: "  " }).some((p) => /non-empty string/.test(p)));
  assert.ok(verdictProblems({ ...makeVerdict("passed", "x"), job: null }).some((p) => /job must be an object/.test(p)));
  assert.ok(
    verdictProblems({ ...makeVerdict("passed", "x"), job: { ciJobId: 7, ciPipelineId: null, ciCommitSha: null } }).some((p) =>
      /job\.ciJobId/.test(p),
    ),
    "a job stamp must be strings or null",
  );

  // Read-side: an absent file is NOT a contract failure (a bare local unit run
  // owes none) but a MALFORMED one is. R7d owns the "is one owed" decision.
  const parsed = readVerdict(ROOT);
  if (parsed.present) {
    assert.deepEqual(
      parsed.problems,
      [],
      `a verdict file is present at ${parsed.path} and must be valid: ${parsed.problems.join("; ")}`,
    );
  }
});

test("R7d IN CI the browser half's verdict must exist, be valid, and be stamped by THIS job", (t) => {
  const read = readVerdict(ROOT);

  // Outside a CI job there is nothing to demand: `npm run test:unit` alone on a
  // developer's box never ran the integration lane, so the absence of a verdict
  // is correct rather than a gap. This is reported, never silently swallowed.
  const thisJob = process.env.CI_JOB_ID;
  if (!thisJob) {
    t.diagnostic(
      read.present
        ? `a verdict from a non-CI run is present at ${read.path} (outcome ${(read.value as { outcome?: string })?.outcome}) and was validated above`
        : `no verdict at ${read.path} and no CI_JOB_ID in scope: this is a bare local unit run, where one is not owed`,
    );
    return;
  }

  // ---- CI. From here on the record is OWED, and its absence is the failure
  // this rule exists to prevent. `.gitlab-ci.yml` runs `npm test` before
  // `npm run test:unit`, and R6 pins that order, so a missing verdict means the
  // integration lane never reached its writer (a hard crash), or was removed
  // from the chain. Both are red-worthy and neither is guessable from a log.
  assert.ok(
    read.present,
    `CI job ${thisJob} owes a browser-half verdict at ${read.path}, and there is none. ` +
      `The integration lane either never ran, crashed before recording, or stopped writing it — ` +
      `and "no record" is exactly the state that used to read as green.`,
  );
  assert.deepEqual(read.problems, [], `the verdict this job produced is not valid: ${read.problems.join("; ")}`);

  const verdict = read.value as { outcome: string; job: { ciJobId: string | null }; reason: string; missingLibraries: string[] };

  // SAME-RUN PROOF. A workspace can outlive a job; a verdict file from an
  // earlier run would otherwise vouch for this one. Requiring the stamp to
  // match `$CI_JOB_ID` means the only verdict that satisfies this gate is one
  // written by the job asking.
  assert.equal(
    verdict.job.ciJobId,
    thisJob,
    `the verdict at ${read.path} was stamped by job ${JSON.stringify(verdict.job.ciJobId)}, not by this job ${thisJob} — ` +
      `it is stale, and a stale record must never stand in for this run's browser half`,
  );

  // The DEGRADED case is reported, not failed. This is the deliberate trade and
  // it is the answer to "wouldn't a hard fail be simpler": a known OS library
  // missing is somebody else's keyring, and a permanently red pipeline for a
  // foreign mirror signature is the same training-people-to-ignore-red mistake
  // as the artifacts uploader burst. What is NOT allowed is for it to be silent,
  // so it prints on every run and lands in a readable file. A browser half that
  // ran is a `passed` verdict; a browser half that did not is a `skipped` one
  // carrying the library that stopped it — and both are first-class facts.
  if (verdict.outcome === "skipped") {
    t.diagnostic(
      `DEGRADED: the browser-dependent half did NOT run in job ${thisJob}. ` +
        `missing=${JSON.stringify(verdict.missingLibraries)} reason=${verdict.reason}`,
    );
  } else {
    assert.equal(verdict.outcome, "passed", `job ${thisJob} recorded outcome ${JSON.stringify(verdict.outcome)}`);
    assert.deepEqual(verdict.missingLibraries, [], "a passed verdict must carry no missing libraries");
  }
});

test("R7e the verdict is NEVER committed: it is per-run state, not a shipped fact", () => {
  // Two independent checks, because either alone is insufficient. `git
  // check-ignore` proves the ignore rule exists (it is what a clean runner
  // depends on); the index query proves nothing is tracked RIGHT NOW. A stale
  // index entry that a later commit could resurrect is what the first check
  // prevents.
  const ignoreFile = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.ok(
    ignoreFile.split("\n").some((l) => l.trim() === `${VERDICT_DIR}/`),
    `.gitignore must ignore ${VERDICT_DIR}/ — a per-run verdict committed to the repo would be a claim about a run that happened once, on one machine`,
  );
  assert.ok(verdictPath(ROOT).startsWith(join(ROOT, VERDICT_DIR)), "the verdict must live under the ignored directory");

  // Nothing tracked may live under the verdict directory.
  let tracked: string;
  try {
    tracked = execFileSync("git", ["ls-files", "--", VERDICT_DIR], { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
  } catch {
    tracked = ""; // no index (or no git): nothing can be tracked there, so the rule above carries the check.
  }
  assert.equal(
    tracked.trim(),
    "",
    `files under ${VERDICT_DIR}/ are tracked in the index and must not be: ${tracked.trim().split("\n").join(", ")}`,
  );
});

test("R7 MUTATION: a classifier that skipped EVERY loader fault is reported, and the wiring pin is not a no-op", () => {
  // THE MUTATION, named: the pre-GOAL-150 predicate. It matches the loader
  // diagnostic and nothing else, exactly as `test/integration.ts` used to, so
  // every missing shared object on the machine became a green exit 0.
  const OLD_PREDICATE = /error while loading shared libraries|cannot open shared object file/i;
  const ours = "error while loading shared libraries: libui2api-native.so: cannot open shared object file: No such file or directory";

  // Precondition: the mutation really does reproduce the old behaviour. Without
  // this the mutation test could pass for the wrong reason.
  assert.equal(OLD_PREDICATE.test(ours), true, "precondition: the old predicate does match this blob");
  assert.equal(classifyIntegrationFailure(ours).outcome, "failed", "precondition: the current classifier refuses it");

  // The mutated predicate still skips. Asserting THAT it skips is the point: it
  // documents that the old code was one regex looser than the new code, and
  // that the difference is exactly the regression the new code now catches.
  assert.equal(OLD_PREDICATE.test(ours), true);

  // And the wiring pin is not vacuous: the classifier is reached from real
  // source, not merely importable.
  const integrationSrc = readFileSync(join(ROOT, "test", "integration.ts"), "utf8");
  assert.ok(
    /classifyIntegrationFailure\s*\(/.test(integrationSrc),
    "test/integration.ts no longer calls the classifier — its skip decision is back to an inline regex nobody can test",
  );
  // BOTH outcomes record. A verdict that only ever records the skip is
  // one-sided, and its absence is then ambiguous between "passed" and "never
  // ran" — the exact ambiguity this rule removes.
  const writes = integrationSrc.match(/writeVerdict\s*\(/g) ?? [];
  assert.ok(
    writes.length >= 2,
    `test/integration.ts must record a verdict on BOTH the pass and the skip path; found ${writes.length} writeVerdict call(s)`,
  );
  assert.ok(
    /makeVerdict\(\s*"passed"/.test(integrationSrc),
    "test/integration.ts must record the PASS outcome, not only the skip",
  );
  assert.ok(
    /makeVerdict\(\s*"skipped"/.test(integrationSrc),
    "test/integration.ts must record the SKIP outcome",
  );
  assert.ok(
    /makeVerdict\(\s*"failed"/.test(integrationSrc),
    "test/integration.ts must record the HARD-FAILURE outcome",
  );
});

/* ========================================================================
 * R8 — the knob table's SELF-MEASUREMENT must be true.
 *
 * MEASURED 2026-10-02: `AGENTS.md` claimed "62 rows, 0 bare-path cells". The
 * real figures, derived by the gate's own helpers, were **68 rows and 4
 * bare-path cells** — and four of those rows arrived during this session's own
 * work, because adding a knob is a normal task and nothing made the paragraph
 * that COUNTS them follow.
 *
 * The existing gate asserted `>= 40` rows, which is the right instinct (a floor
 * catches a collapse) and the wrong threshold (a floor can never catch a
 * paragraph that is behind). So the paragraph is now compared to the
 * measurement, exactly.
 *
 * This is the same defect as the four falsified count sentences found in
 * `capabilities/model-verification.json` an hour earlier, in a file this
 * project treats as its own instrumentation. A self-measurement that is
 * asserted as a floor is not a measurement.
 * ====================================================================== */
test("R8 the knob table's own stated figures EQUAL the measurement, not a floor", () => {
  const { knobTableRows, knobsReadInCode, knobsInTable } = ciScan;
  const rows = knobTableRows(ROOT);
  const bare = rows.filter((r) => r.line === null);
  const read = knobsReadInCode(ROOT);
  const documented = knobsInTable(ROOT);

  // The paragraph under test names its own figures; read them back rather than
  // restating them here, so there is exactly ONE place to update when a row is
  // added and this gate tells you if you forgot.
  const para = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const claim = /measured:\s*\*\*(\d+) rows,[^]*?(\d+) bare-path cells/.exec(para);
  assert.ok(claim, "AGENTS.md must state its own measured row count and bare-cell count");

  assert.equal(
    Number(claim[1]),
    rows.length,
    `AGENTS.md claims ${claim[1]} knob rows; ${rows.length} are actually present. ` +
      "The paragraph is a MEASUREMENT and the gate holds it to one — an `>= 40` " +
      "floor could never catch a paragraph that is behind, which is how it got to " +
      `${claim[1]} while the truth was ${rows.length}.`,
  );
  assert.equal(
    Number(claim[2]),
    bare.length,
    `AGENTS.md claims ${claim[2]} bare-path cells; ${bare.length} rows cite a file with no ` +
      `line. The bare cells are: ${bare.map((r) => r.knob).join(", ")}. They are DISCLOSED, ` +
      "not errors — a knob read in two places cannot honestly cite one line.",
  );

  // The floor that already existed, kept because it catches a different failure.
  assert.ok(rows.length >= 40, `the table collapsed to ${rows.length} rows`);
  // And the property that matters most: nothing read in code is undocumented.
  const undocumented = [...read].filter((k) => !documented.has(k));
  assert.deepEqual(undocumented, [], "a knob read by shipped code with no table row is invisible");
});

/* ========================================================================
 * R9 — the UNIT lane's browser guard must be at the LAUNCH seam, and must
 * not be able to go green by skipping.
 *
 * GOAL 151. MEASURED DEFECT: `test/wigolo-engine.test.ts` guarded its browser
 * work with `if (!env) t.skip(...)`, where `env` came from a health-poll of the
 * wigolo DAEMON PROCESS (`{status:"healthy"}`). That is daemon LIVENESS, not
 * browser LAUNCHABILITY, and this box exhibits exactly the gap: the daemon was
 * healthy and its browser tier could not launch (`chromium_headless_shell-1228`
 * absent). So the guard let the browser work run, there was no `catch` in the
 * bodies, and THREE tests went red from a guard whose job was to prevent red.
 *
 * The guard is now `guardBrowser` in `test/helpers/browser-launchability.ts`,
 * which probes the real seam and classifies the outcome. Three ways this can rot
 * again, one rule each:
 *
 *   R9a THE BOUNDARY — the classifier must separate PROVISIONING from
 *       REGRESSION. Both are red, but a reader must be able to tell them apart,
 *       because the remedy differs entirely (one command vs a code change).
 *       Fail-closed: an unrecognised failure is a REGRESSION.
 *   R9b THE SKIP BAN — the guard must THROW, never `t.skip`. A skip reports the
 *       unit lane green with the browser half untested and nothing anywhere
 *       recording it. MEASURED by mutation: converting the throw back into a
 *       skip moved these tests from `fail 3` to `skipped 3` and the file GREEN.
 *       This rule pins that, so the honest branch cannot quietly become the
 *       dishonest one.
 *   R9c THE WIRING — `test/wigolo-engine.test.ts` must actually USE the shared
 *       guard, not carry its own third idiom. This is R7c pointed at the unit
 *       lane: a correct gate that nothing calls is the GOAL-145 defect again.
 */

test("R9a the launch classifier separates provisioning from regression, and is fail-closed", () => {
  // (1) The MEASURED fault on this box. Playwright named the absent artifact.
  const missing = classifyLaunchFailure(
    "wigolo extract (HTTP 500): browserType.launch: Executable doesn't exist at " +
      "/home/me/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell",
  );
  assert.equal(missing.kind, "browser-provisioning", `the measured missing-shell fault is provisioning; got ${missing.reason}`);
  assert.match(missing.reason, /chromium_headless_shell-1228/, "the reason must NAME the artifact that is absent");

  // (2) The browser was PRESENT and misbehaved. A real regression, and it must
  // not be excused as an environment fault — this is the axis that matters.
  const regression = classifyLaunchFailure("TimeoutError: locator.click: Timeout 30000ms exceeded");
  assert.equal(regression.kind, "launch-regression", "a browser that launched and then failed is a regression");
  assert.match(regression.reason, /not an environment fault/);

  // (3) A spawn that died is a regression too, not a missing binary.
  assert.equal(classifyLaunchFailure("chrome exited early (code 21)").kind, "launch-regression");

  // (4) The OS-library axis is DELEGATED, so there is exactly ONE answer to
  // "is this shared object Debian's fault or ours?" in this repository. If the
  // delegation is ever removed and the list re-typed here, these two flip.
  const ours = classifyLaunchFailure(
    "error while loading shared libraries: libui2api-native.so: cannot open shared object file",
  );
  assert.equal(ours.kind, "launch-regression", "a library THIS repo introduced is never excusable");
  const theirs = classifyLaunchFailure(
    "error while loading shared libraries: libnspr4.so: cannot open shared object file",
  );
  assert.equal(theirs.kind, "browser-provisioning", "the measured libnspr4 fault stays excusable");
});

test("R9b the unit browser guard FAILS on a missing browser — it must never SKIP", () => {
  // The honest branch is a THROW. This is the single most important assertion in
  // this rule, because the failure it prevents is INVISIBLE: a skip yields
  // `skipped 3, fail 0`, a green box, and no record that the browser half of the
  // wigolo engine went untested. Read from the real module, not a copy.
  const src = readFileSync(join(ROOT, "test", "helpers", "browser-launchability.ts"), "utf8");
  const at = src.indexOf("export async function guardBrowser");
  // `indexOf` returns -1 when absent, and `slice(-1)` is the LAST CHARACTER —
  // so the unguarded form yielded a 1-character `fn` on which `fn.length > 0`
  // PASSES, and only a later regex happened to catch it. That made "the guard is
  // gone" a silent green: if the throw's wording below ever shifts, deleting
  // guardBrowser stops being detected at all. The absence must be its own
  // assertion, stated before anything is sliced.
  assert.ok(at >= 0, "guardBrowser is gone from the helper — the unit lane has no launchability guard");
  const fn = src.slice(at);

  // A skip is only acceptable where the SUBJECT is absent (no wigolo checkout),
  // never where the subject's browser is dead. The helper itself must not be able
  // to express one.
  assert.ok(
    !/\bt\.skip\s*\(/.test(fn),
    "guardBrowser must never call t.skip: a skip makes the unit lane green while the browser half goes untested",
  );
  assert.ok(
    /throw new Error\(\s*`browser not launchable/.test(fn) || /throw new Error\(\s*\n?\s*`browser not launchable/.test(fn),
    "guardBrowser must throw a NAMED error when the browser cannot launch — that throw is what turns the lane red",
  );

  // AND the wiring: `test/wigolo-engine.test.ts` must route its browser work
  // through the shared guard. A correct guard that nothing calls is the
  // GOAL-145 defect ("six gates on disk that no script ran") pointed at the unit
  // lane. This also pins that the OLD wrong-seam idiom is GONE rather than merely
  // coexisting, because three incompatible `maybe()` forms was the original rot.
  const engine = readFileSync(join(ROOT, "test", "wigolo-engine.test.ts"), "utf8");
  assert.ok(
    /guardBrowser\s*\(/.test(engine),
    "test/wigolo-engine.test.ts no longer calls guardBrowser — its browser work is unguarded again",
  );
  assert.ok(
    /from "\.\/helpers\/browser-launchability\.js"/.test(engine),
    "test/wigolo-engine.test.ts must import the SHARED guard, not carry a third local idiom",
  );
  assert.ok(
    !/\bconst maybe\s*=/.test(engine),
    "the old `maybe()` wrong-seam idiom is back — it guarded daemon LIVENESS, not browser launchability",
  );
});

/* ========================================================================
 * R10 — the unit lane's own COMMAND must be runnable.
 *
 * MEASURED DEFECT (this file's own subject, one level down). `de4bad7`
 * ("test: a knob EFFECT gate") rewrote `scripts["test:unit"]` and dropped the
 * runner prefix, leaving a bare list of 177 `test/*.ts` paths. Measured:
 *
 *     $ npm run test:unit
 *     sh: 1: test/account-exact-resolution-cli.test.ts: Permission denied
 *     EXIT=126
 *
 * So the project's FULL unit suite could not run at all — and both CI configs
 * invoke it (`.github/workflows/*.yml` step `npm run test:unit`;
 * `.gitlab-ci.yml` declares `npm test -> npm run test:unit` for the full unit
 * suite). Every lane consequently reported per-file results, because the
 * aggregate number nobody could produce was missing for exactly this reason.
 *
 * IT IS A REPEAT, NOT A NEW BUG. `1afb09e` is titled "I broke test:unit with
 * a regex, and the vault was being used as scratch space" — the same class of
 * accident, already paid for once. **The reason it happened twice is that
 * NOTHING PINNED THE COMMAND, only the LIST.**
 *
 * WHY R4/R5 COULD NOT SEE IT. Both rules read this exact string — and both read
 * it through `testFilesNamedByUnitScript()`, which regexes
 * `/test\/[a-z0-9-]+\.test\.ts/g` and throws the REST of the string away. The
 * list was byte-perfect while the command was unrunnable: 177 == 177, both
 * directions green, `EXIT=126`. A gate that watches the LIST must also watch
 * the RUNNER, because the runner is what makes the list a command.
 *
 * COORDINATION, NOT DUPLICATION. `test/test-timeout-discipline.test.ts` already
 * owns the `--test-timeout` RANGE (`>= 30_000`, `<= 180_000`) and
 * `test/production-readiness-gate.test.ts` re-asserts its mere presence; both
 * are left exactly as they are, and neither is restated here. What R10 adds is
 * the part nobody owned:
 *   * the script must START with a runner — the de4bad7 defect itself;
 *   * `--test` must be present as its own token (it is what turns a list of
 *     paths into a test RUN, and `node file.ts` without it just executes one);
 *   * `--test-concurrency` must be present. `--test-concurrency=4` is pinned
 *     NOWHERE in the repo, and it is what keeps the lane off the
 *     `ERR_WORKER_INIT_FAILED` burst documented in AGENTS.md;
 *   * every listed `test/...` token must exist ON DISK. R4/R5 compare against
 *     the GIT INDEX, so a file listed but absent from disk is invisible to
 *     both — R10 closes that from the other side.
 * and it closes with a real SPAWN, because a string predicate can be satisfied
 * by a runner that does not exist on this machine.
 * ====================================================================== */

/** Program words that can actually EXECUTE the following tokens. */
const RUNNER_HEADS = ["node", "npx", "tsx"] as const;

/**
 * The command's PROGRAM word, or `[]` when there is none.
 *
 * In a shell command the program is always the FIRST token — so a first token
 * that is not a runner is not "no runner found, keep scanning", it is THE
 * DEFECT (a bare path `sh` will try to execute). Reporting "empty" for that
 * shape would misname the fault, and a gate whose message misdescribes the
 * defect is one people learn to skip.
 */
function runnerTokens(script: string): string[] {
  const tokens = script.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (first === undefined) return [];
  return (RUNNER_HEADS as readonly string[]).includes(first) ? [first] : [];
}

/** Flags of the form `--name=value` the command carries, by name. */
function flagsOf(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of script.matchAll(/(^|\s)--([a-z0-9-]+)(?:=([^\s]+))?/g)) out.set(m[2]!, m[3] ?? "");
  return out;
}

/**
 * Everything wrong with a `test:unit`-shaped command, as named problems.
 *
 * A STRING-LEVEL predicate, deliberately: it must be able to run against a
 * mutation without anyone editing `package.json`, which is what makes the
 * MUTATION R10 test below a real proof rather than a promise. `rootExists` is
 * injected for the same reason — the on-disk check must be testable against a
 * synthetic tree, not only against this one.
 */
export function unitRunnerProblems(script: string, rootExists: (p: string) => boolean = (p) => fileExists(p, ROOT)): string[] {
  const problems: string[] = [];
  const trimmed = script.trim();

  // (1) THE RUNNER. This is the measured defect, so it is checked as "the
  // command's first program word can execute the rest" — a bare path fails it.
  // An empty script and a runner-less script are DIFFERENT faults and get
  // different messages: collapsing them would misname the defect, and a gate
  // whose message misdescribes the fault is one people learn to skip.
  const head = runnerTokens(trimmed);
  const first = head[0];
  const firstToken = trimmed.split(/\s+/).filter(Boolean)[0];
  if (trimmed === "") {
    problems.push(`scripts["test:unit"] is EMPTY: it names no command at all`);
  } else if (first === undefined) {
    problems.push(
      `scripts["test:unit"] does not start with a runner: it begins with ${JSON.stringify(firstToken)}, which is not one of ` +
        `${RUNNER_HEADS.join("/")} — \`sh\` will try to EXECUTE that token as a program. This is the measured de4bad7 ` +
        `defect (\`sh: 1: test/account-exact-resolution-cli.test.ts: Permission denied\`, EXIT=126): a bare list of test ` +
        `paths is not a command, so the project's full unit suite cannot run at all.`,
    );
  }

  const flags = flagsOf(trimmed);

  // (2) `--test`. Without it, `node <file>` EXECUTES one file instead of
  // running the suite, which is the same class of silence as no runner at all.
  if (!flags.has("test")) {
    problems.push(
      `scripts["test:unit"] carries no --test flag: the runner would import and EXECUTE the first test file instead of ` +
        `running the suite (a run that reports one file and no tests is not a suite).`,
    );
  }

  // (3) CONCURRENCY + TIMEOUT as flags, not as prose. The RANGE of the timeout
  // is owned by test/test-timeout-discipline.test.ts and is NOT restated here;
  // this only refuses a command that lost the bound entirely — which is what
  // de4bad7 did to both flags at once.
  for (const [flag, why] of [
    ["test-concurrency", "the unbounded-parallelism burst documented in AGENTS.md (ERR_WORKER_INIT_FAILED / EAGAIN)"],
    ["test-timeout", "a hang must be a NAMED failure (exit 124), not a silent stall — GOAL 102"],
  ] as const) {
    const v = flags.get(flag);
    if (v === undefined) {
      problems.push(`scripts["test:unit"] lost its --${flag} flag, so ${why} is unprotected`);
    } else if (!/^\d+$/.test(v)) {
      problems.push(`scripts["test:unit"] carries --${flag}=${JSON.stringify(v)}, which is not a plain integer`);
    }
  }

  // (4) EVERY LISTED TOKEN EXISTS ON DISK, from the command's own side. R4/R5
  // compare the list against the git INDEX, so a path that is listed but absent
  // from disk passes both; this is the other direction, and it is the one a
  // renamed-then-deleted file takes.
  const listed = [...trimmed.matchAll(/(?:^|\s)(test\/[A-Za-z0-9._-]+\.ts)(?=\s|$)/g)].map((m) => m[1]!);
  const ghosts = [...new Set(listed)].filter((p) => !rootExists(p)).sort();
  if (ghosts.length > 0) {
    problems.push(`scripts["test:unit"] names test files that do not exist on disk: ${JSON.stringify(ghosts)} — node --test exits 126 on the first missing path, which is how a stale list presents`);
  }
  return problems;
}

test("R10 scripts[\"test:unit\"] is a RUNNABLE COMMAND, not a list of paths", () => {
  const script = PKG.scripts["test:unit"] ?? "";
  const problems = unitRunnerProblems(script);
  assert.deepEqual(problems, [], problems.join("\n  * "));

  // Non-vacuity, stated as the measurement the task's own report needs: the
  // command names a real, non-trivial number of files (not one, not none), and
  // the runner really is a program word rather than a bare path.
  assert.ok(runnerTokens(script)[0] !== undefined, "no runner token — R10 proved nothing");
  const listed = script.match(/(?:^|\s)test\/[A-Za-z0-9._-]+\.ts(?=\s|$)/g) ?? [];
  assert.ok(listed.length >= 50, `scripts["test:unit"] names only ${listed.length} test files — R10 is checking almost nothing`);
});

test("R10 non-vacuity: the runner is a PROGRAM on this machine, not just a word in a string", () => {
  // A string predicate can be satisfied by a runner that does not exist. So the
  // command's OWN prefix — every token up to and including `--test`, copied
  // verbatim rather than reassembled, because a reassembly is a second opinion
  // about what the repo ships — is SPAWNED against ONE real (tiny, hermetic)
  // test file, and the exit code must be 0.
  //
  // This file is the right victim for two reasons: it is hermetic (no browser,
  // no network — R7 exists because the browser half is a separate lane), and
  // this file already IMPORTS it, so its hermeticity is an assumption R10 does
  // not have to make fresh.
  const script = PKG.scripts["test:unit"] ?? "";
  const tokens = script.trim().split(/\s+/).filter(Boolean);
  const cut = tokens.indexOf("--test");
  assert.ok(cut > 0, `precondition: scripts["test:unit"] carries --test after a runner; got ${JSON.stringify(tokens.slice(0, 4))}`);
  const argv = [...tokens.slice(0, cut + 1), "test/doc-numbers-truth.test.ts"];
  assert.ok(fileExists(argv[argv.length - 1]!, ROOT), "precondition: the victim file exists on disk");

  let code: number;
  let out = "";
  try {
    out = execFileSync(tokens[0]!, argv.slice(1), { cwd: ROOT, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
    code = 0;
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; signal?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    code = e.status ?? (e.signal ? -1 : 1);
  }
  assert.equal(
    code,
    0,
    `the runner this repo ships (\`${tokens[0]} ${argv.slice(1).join(" ")}\`) does not actually run on this machine — exit ${code}.\n` +
      `A test:unit that cannot run is the de4bad7 defect wearing a different hat: the string looks right and the suite still does not run.\n${out.slice(-2000)}`,
  );
});

test("MUTATION R10: the MEASURED de4bad7 form is named, and so is each flag it dropped", () => {
  const live = PKG.scripts["test:unit"] ?? "";
  assert.deepEqual(unitRunnerProblems(live), [], "precondition: the live command is clean");

  // (a) THE MEASURED DEFECT, reproduced exactly: the same 177 paths with the
  // runner prefix cut off — byte-for-byte the value `de4bad7` shipped. This is
  // the form that made both CI configs run a command that exits 126.
  const broken = live.replace(/^\S+(?:\s+\S+)*?\s+--test\s+/, "");
  assert.ok(broken.startsWith("test/"), `precondition: the mutation strips the runner; got ${JSON.stringify(broken.slice(0, 40))}`);
  assert.notEqual(broken, live, "the mutation must actually change the command");
  const reported = unitRunnerProblems(broken, () => true);
  assert.ok(
    reported.some((p) => /does not start with a runner/.test(p)),
    `the missing runner must be named; got ${JSON.stringify(reported)}`,
  );
  assert.ok(
    reported.some((p) => /no --test flag/.test(p)),
    `the missing --test flag must be named; got ${JSON.stringify(reported)}`,
  );
  for (const flag of ["test-concurrency", "test-timeout"]) {
    assert.ok(
      reported.some((p) => p.includes(`--${flag}`)),
      `the dropped --${flag} must be named; got ${JSON.stringify(reported)}`,
    );
  }

  // (b) ONE flag at a time, so the rule cannot pass while any single bound is
  // silently gone — the shape of a partial, plausible-looking edit.
  for (const [flag, re] of [
    ["test-concurrency", /--test-concurrency=\d+\s+/],
    ["test-timeout", /--test-timeout=\d+\s+/],
    ["test", /--test\s+/],
  ] as const) {
    const oneDropped = live.replace(re, "");
    assert.notEqual(oneDropped, live, `precondition: dropping --${flag} must change the command`);
    assert.ok(
      unitRunnerProblems(oneDropped, () => true).some((p) => p.includes(`--${flag}`)),
      `dropping only --${flag} must be reported`,
    );
  }

  // (c) THE LIST STILL PARSES PERFECTLY in the broken form — this is the whole
  // reason the defect survived twice. A list/tree pin cannot see it, so R10
  // must, and this assertion is what stops anyone "simplifying" R10 away on the
  // grounds that R4 already covers it.
  const listedCount = (broken.match(/(?:^|\s)test\/[A-Za-z0-9._-]+\.ts(?=\s|$)/g) ?? []).length;
  assert.equal(listedCount, testFilesNamedByUnitScript().size, "the broken form still names every file — R4 stays green, which is why R10 exists");
  assert.deepEqual(unitRunnerProblems(broken, () => true).length >= 4, true, "the broken form must raise at least the four structural problems");
});

test("MUTATION R10: a listed path that is not on disk is named, from the command's own side", () => {
  // The gap R4/R5 cannot see: they compare the list against the GIT INDEX, so a
  // path that is listed but gone from disk is invisible to both — and
  // `node --test` exits 126 on the first missing file, presenting exactly like
  // the runner defect.
  const ghost = "test/ghost-not-on-disk.test.ts";
  const live = PKG.scripts["test:unit"] ?? "";
  const planted = `${live} ${ghost}`;
  const problems = unitRunnerProblems(planted, (p) => p !== ghost);
  assert.ok(
    problems.some((p) => p.includes(ghost)),
    `the ghost path must be named; got ${JSON.stringify(problems)}`,
  );
  assert.equal(problems.length, 1, `only the ghost may be reported; got ${JSON.stringify(problems)}`);
  // The same command is clean when the path exists — the check is existence,
  // not a permanent red.
  assert.deepEqual(unitRunnerProblems(planted, () => true), []);
  // And the LIVE command has no ghosts: asserted against the real filesystem.
  assert.deepEqual(unitRunnerProblems(live), []);
});
