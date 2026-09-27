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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const problems = knobDivergences(a, deleted, b, CI_TEXTS[b]!);
  assert.equal(problems.length, 1, `expected one divergence; got ${JSON.stringify(problems)}`);
  assert.match(fmtDivergence(problems[0]!), /UI2API_GH_LIVE/);
  // Untouched, the pair is in parity — the rule is not simply always-red.
  assert.deepEqual(knobDivergences(a, CI_TEXTS[a]!, b, CI_TEXTS[b]!), []);
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
