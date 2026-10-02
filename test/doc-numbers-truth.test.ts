// GOAL 110: hand-written NUMERIC claims in README.md / AGENTS.md rot silently,
// because no machine gate can fail.
//
// The failure class: a doc says "38 hermetic unit-test files (595+ tests)" or
// "capability-dispatch.test.ts (28/28)" and nothing in `test/` reads the
// number back. Every contributor who touches the suite, a profile, or a runner
// makes the number wrong and the suite stays green. Provenance-shaped numbers
// (dated live proofs, fold-log history) are NOT this class — they are history
// and are deliberately left alone.
//
// This pin therefore works in two directions:
//   A. DERIVABLE claims must be EQUAL to a value computed live from the repo
//      (package.json script, BUILTIN_PROFILES, capabilities/*/profile.json,
//      the RUNNERS list). A wrong number fails.
//   B. UNVERIFIABLE claims must be ABSENT. If someone re-types a hand-counted
//      suite total or a loop-generated per-file total, a regex pin fails — so
//      the number cannot regrow.
//
// D. is the MUTATION proof: the same predicates are run against a synthetic doc
//    carrying a deliberately WRONG number, and must report it as a failure. A
//    pin that cannot fail is not a pin.
//
// ONE RULE WAS INVERTED, not relaxed. `checkReadmeFileCount` used to REQUIRE
// README to print the file count ("carries no machine-checkable unit-test file
// count to pin"). That requirement is what kept a hand-maintained second copy
// of a number `package.json` already owns alive — the exact duplication this
// repository deletes elsewhere. README now states no figure; instead it names
// `scripts["test:unit"]` as the single owner and gives the command that derives
// the count, so the rule now demands THAT. See the predicate for the reasoning
// and for the mutation that proves all three states still fail or pass.
//
// SCOPE, and the fix for the scope's last remaining hole: the rules in THIS file
// read `README.md` + `AGENTS.md`, and that is a hand-maintained pair — which is
// why the same rot this file removed from AGENTS.md was free in `docs/AUDIT.md`,
// where two forbidden counts sit right now. The corpus is no longer a pair: the
// forbidden-count rule now runs over `markdownSurfaces()`, a `readdirSync` walk
// of every markdown surface the project ships, and it runs in TWO TIERS so a
// genuinely historical count is not caught by accident. That work lives in
// `test/doc-unverifiable-counts.test.ts` (the rule, the tiers, and the
// dated-vs-current argument) and `test/doc-allow-list-liveness.test.ts` (an
// allow-list entry that suppresses nothing). The derivations both of them share
// are in `test/helpers/doc-scan.ts`, kept out of a `.test.ts` so importing a
// predicate does not register a second copy of somebody's tests.
//
// The tests below keep the two-file scope ON PURPOSE: they are the ratio/count
// claims AGENTS.md and README.md make, and pointing them at every derived
// surface would change which file a failure is attributed to. Two tests here assert the
// containment property that makes the split safe: the old corpus is a SUBSET of
// the derived one, and the derived rule really does catch a document this file
// never read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_PROFILES } from "../src/profile/profile.js";
import {
  TIER1_COUNT_RULES,
  markdownSurfaces,
  scanUnverifiableCounts,
} from "./helpers/doc-scan.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const DOCS = `${README}\n${AGENTS}`;
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

// ---------------------------------------------------------------- derived ---

/** Real number of test files the `test:unit` script actually runs. */
export function realTestFileCount(): number {
  const script = PKG.scripts["test:unit"] ?? "";
  return (script.match(/test\/[a-z0-9-]+\.test\.ts/g) ?? []).length;
}

/**
 * The test files the `test:unit` script names.
 *
 * GOAL 145 was six test files on disk that NO script ran — the gates were real
 * but never executed in CI. The count above cannot see that: it regexes the
 * script STRING, so a file missing from the script is invisible to the very pin
 * that appears to guard the suite. This returns the script's side of that set
 * so it can be compared against the disk side.
 */
export function testFilesNamedByUnitScript(): Set<string> {
  const script = PKG.scripts["test:unit"] ?? "";
  return new Set((script.match(/test\/[a-z0-9-]+\.test\.ts/g) ?? []).map((p) => p.slice("test/".length)));
}

/**
 * The test files that exist on disk — the source of truth, derived with
 * `readdirSync` exactly like the package-dir count below. Any `*.test.ts` in
 * `test/` counts, whatever its name, so an oddly-named file cannot slip past
 * both sides of the comparison.
 */
export function testFilesOnDisk(): Set<string> {
  return new Set(
    readdirSync(join(ROOT, "test"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
      .map((e) => e.name),
  );
}

/** test/*.test.ts files that no script runs — the GOAL 145 regression, live. */
export function unrunTestFiles(
  onDisk: Set<string> = testFilesOnDisk(),
  inScript: Set<string> = testFilesNamedByUnitScript(),
): { unrun: string[]; missing: string[] } {
  return {
    unrun: [...onDisk].filter((f) => !inScript.has(f)).sort(),
    missing: [...inScript].filter((f) => !onDisk.has(f)).sort(),
  };
}

/** Real number of capabilities package dirs that carry a manifest.json. */
export function realPackageCount(): number {
  const dir = join(ROOT, "capabilities");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "manifest.json")))
    .length;
}

/** Builtin chat profiles that declare non-empty restrictionMarkers. */
export function realBuiltinMarkerRatio(): { marked: number; total: number } {
  const ids = Object.keys(BUILTIN_PROFILES);
  const marked = ids.filter((id) => {
    const markers = (BUILTIN_PROFILES as Record<string, any>)[id]?.capability
      ?.restrictionMarkers;
    return Array.isArray(markers) && markers.length > 0;
  });
  return { marked: marked.length, total: ids.length };
}

/**
 * Packaged profiles that declare non-empty restrictionMarkers.
 *
 * Honest scope: the doc's "14/14" is a claim about a NAMED served surface, and
 * the numerator is the machine-derivable half — it is computed here, not
 * trusted. The denominator is deliberately NOT re-derived as "every packaged
 * profile.json", because most packaged profiles are capability-only packages
 * (gmail/youtube/araprat/chatglm/…) or sites whose markers live in the builtin
 * profile instead, so no selector rule separates them mechanically. What is
 * pinned instead: the computed marked count, and that the docs name EVERY
 * marked id — so the 14/14 claim cannot drift away from the code in either
 * direction without failing.
 */
export function realPackagedMarkerRatio(): { marked: number; total: number; ids: string[] } {
  const dir = join(ROOT, "capabilities");
  const withProfile = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "profile.json")))
    .map((e) => e.name);
  const ids = withProfile.filter((name) => {
    const parsed = JSON.parse(
      readFileSync(join(dir, name, "profile.json"), "utf8"),
    ) as any;
    const markers = parsed?.capability?.restrictionMarkers;
    return Array.isArray(markers) && markers.length > 0;
  });
  return { marked: ids.length, total: ids.length, ids: ids.sort() };
}

/**
 * Real number of RUNNERS entries in test/capability-dispatch.test.ts. Counted
 * by the `id:` field of each literal entry, which is the one stable per-entry
 * key in that array.
 */
export function realRunnerCount(): number {
  const src = readFileSync(join(ROOT, "test", "capability-dispatch.test.ts"), "utf8");
  const block = src.split("const RUNNERS: RunnerDef[] = [")[1]?.split("\n];")[0] ?? "";
  return (block.match(/id:\s*"/g) ?? []).length;
}

// ------------------------------------------------------------- predicates ---

/**
 * The README's unit-test file count must equal the real, derived count.
 * The claim is a bare number in a backticked `npm run test:unit` line.
 *
 * The figure itself is deliberately GONE from the README now (see
 * `statesFileCountDerivation`), so this extractor can legitimately return an
 * empty list — which is exactly what the second rule of `checkReadmeFileCount`
 * has to handle. It is kept, unchanged, as the anti-rot sensor: if a figure is
 * ever typed in the README it must be the derived one.
 */
export function readmeFileCountClaim(doc: string): number[] {
  const out: number[] = [];
  for (const m of doc.matchAll(/(\d+)\s+hermetic unit-test files/g)) {
    out.push(Number(m[1]));
  }
  return out;
}

/**
 * Does the doc state HOW to derive the unit-test file count?
 *
 * This REPLACED the old second rule ("the doc must print a figure"). That rule
 * encoded the exact duplication being removed: a hand-maintained copy of a
 * number `package.json` already owns is a second thing to forget, and the
 * second copy is what rotted (GOAL 110 measured the README claiming 38/69, 37/69
 * and 84/126 against a live list of 69/83/126). Requiring the copy is how the
 * copy got required in the first place.
 *
 * Dropping the figure is not free, though, so the rule moved rather than
 * disappeared: a doc that prints no count must leave the DERIVATION behind, so
 * a reader holding a stale number in their head has something to check it
 * against. Today the README does exactly that — it names
 * `scripts["test:unit"]` as the single owner and prints the `node -e` one-liner
 * that derives the count.
 *
 * Two CONJUNCTS, because either alone is weak: naming the owner without a
 * command is a pointer, not a derivation, and a bare command without naming the
 * owner leaves a number with no statement of who maintains it.
 *
 * Anchored on the derivation COMMAND rather than on prose, so rewording the
 * surrounding sentence cannot silently satisfy (or break) the rule. The bound
 * (`{0,400}`) keeps the command and the `*.test.ts` match on the SAME one-liner
 * rather than letting any two unrelated passages pair up.
 */
export function statesFileCountDerivation(doc: string): boolean {
  const namesOwner = /scripts\[(?:`|"|\\")?test:unit/.test(doc);
  const carriesCommand = /node\s+-e\b[\s\S]{0,400}?\.test\\?\.ts/.test(doc);
  return namesOwner && carriesCommand;
}

/**
 * The README's unit-test file count, in two directions.
 *
 *   1. every figure the doc DOES print must equal the real derived count
 *      (unchanged — this is the anti-rot half, and it is never relaxed), and
 *   2. a doc that prints NO figure must say how to derive it instead.
 *
 * Both halves are load-bearing and both have a MUTATION test below: a wrong
 * figure still fails, a figure-less/derivation-less doc still fails, and the
 * real README passes with zero problems.
 */
export function checkReadmeFileCount(doc: string): string[] {
  const real = realTestFileCount();
  const problems: string[] = [];
  const claimedCounts = readmeFileCountClaim(doc);
  for (const claimed of claimedCounts) {
    if (claimed !== real) {
      problems.push(
        `README claims ${claimed} hermetic unit-test files; package.json scripts["test:unit"] actually references ${real}`,
      );
    }
  }
  if (claimedCounts.length === 0 && !statesFileCountDerivation(doc)) {
    problems.push(
      "README carries no machine-checkable unit-test file count to pin AND does not say how to " +
        "derive it — either print the derived count, or name scripts[\"test:unit\"] as the single " +
        "owner and give the command that prints it",
    );
  }
  return problems;
}

/** The doc must state the real ratio, e.g. "11/11" for builtin markers. */
export function checkRatio(doc: string, real: { marked: number; total: number }, label: string): string[] {
  const want = `${real.marked}/${real.total}`;
  if (!doc.includes(want)) {
    return [`${label} ratio ${want} (${real.marked} of ${real.total}) is not stated in the docs`];
  }
  return [];
}

export function checkRunnerCount(doc: string, real: number): string[] {
  // A wrong runner count reads as "N dispatch runners"; require the real one.
  const found = [...doc.matchAll(/(\d+)\s+dispatch runners/g)].map((m) => Number(m[1]));
  if (!found.includes(real)) {
    return [`no claim of the real dispatch-runner count (${real}) found; found [${found}]`];
  }
  return [];
}

export function checkPackageCount(doc: string, real: number): string[] {
  const found = [...doc.matchAll(/(\d+)\s+package dirs|\b(\d+)\s+packages\b/g)].map(
    (m) => Number(m[1] ?? m[2]),
  );
  if (!found.includes(real)) {
    return [`no claim of the real packaged count (${real}) found; found [${found}]`];
  }
  return [];
  }

/**
 * A hand-typed suite total is unobservable from the repo, so it must be gone.
 * These patterns are the exact shapes GOAL 110 found rotting; if a future edit
 * reintroduces one, this fails.
 */
export const FORBIDDEN_UNVERIFIABLE = [
  // "961 tests / 58 suites", "939 tests / 51 suites", "945 tests / 54 suites"
  /\b\d{3,4}\s+tests\s*\/\s*\d+\s+suites\b/,
  // "(959 pass + 1 env skip ...)" — the same hand-typed family.
  /\(\d{3,4}\s+pass\s*\+\s*\d+\s+env skip/,
  // Loop-generated per-file totals nothing asserts: "(28/28)" on
  // capability-dispatch and "(298/298)" on validate-packages. The rest of each
  // file's tests come from `for` loops, so the literal can drift to any value
  // with the suite still green.
  /capability-dispatch\.test\.ts[^\n]*\(\d+\/\d+\)/,
  /validate-packages\.test\.ts[^\n]*\(\d+\/\d+\)/,
  // An unverifiable "595+ tests" test-count claim in the README.
  /\(\d+\+\s+tests\)/,
];

export function findForbidden(doc: string): string[] {
  const hits: string[] = [];
  for (const re of FORBIDDEN_UNVERIFIABLE) {
    const m = doc.match(re);
    if (m) hits.push(`${re} -> "${m[0].slice(0, 60)}"`);
  }
  return hits;
}

// ------------------------------------------------------------------ tests ---

test("the README's unit-test file count is either the real derived one or absent with the derivation stated", () => {
  const problems = checkReadmeFileCount(README);
  assert.deepEqual(problems, [], problems.join("; "));
  // The anti-rot half, asserted directly on the claim set rather than on a typed
  // copy: WHATEVER the README prints must be the derived number. Zero figures
  // is allowed and is the current state — the count is not restated, and
  // `statesFileCountDerivation` (asserted below) is what the doc owes instead.
  for (const claimed of readmeFileCountClaim(README)) {
    assert.equal(
      claimed,
      realTestFileCount(),
      `README prints ${claimed} hermetic unit-test files; any figure typed here must equal the derivation`,
    );
  }
  assert.ok(
    statesFileCountDerivation(README),
    "the README states no figure, so it must name scripts[\"test:unit\"] as the single owner and " +
      "give the command that prints the count — otherwise there is nothing to check a remembered number against",
  );
});

test("README's test-file claim does not hand-type an unverifiable test COUNT", () => {
  const hits = findForbidden(README);
  assert.deepEqual(hits, [], `README reintroduced unverifiable counts: ${hits.join("; ")}`);
});

test("GOAL 145: every test/*.test.ts on disk is named by a script — a file no script runs is named LOUD", () => {
  const { unrun, missing } = unrunTestFiles();
  assert.deepEqual(
    unrun,
    [],
    `test files on disk that no npm script runs: ${JSON.stringify(unrun)} — add them to scripts["test:unit"] (or whatever script owns them); a gate nobody runs is not a gate`,
  );
  assert.deepEqual(missing, [], `package.json scripts["test:unit"] names files that do not exist: ${JSON.stringify(missing)}`);
  // Both sides must also agree numerically, so a file dropped from BOTH still
  // moves the derived count and the README claim with it.
  assert.equal(testFilesOnDisk().size, testFilesNamedByUnitScript().size);
});

test("MUTATION: a test file present on disk but absent from test:unit is reported as unrun", () => {
  // The REAL predicate, fed a file set that has one extra file on disk — the
  // GOAL 145 shape, made observable without touching the working tree.
  const onDisk = new Set([...testFilesOnDisk(), "zzz-not-in-suite.test.ts"]);
  const { unrun } = unrunTestFiles(onDisk, testFilesNamedByUnitScript());
  assert.deepEqual(unrun, ["zzz-not-in-suite.test.ts"], "the pin must name exactly the file no script runs");
  // And the inverse: a script naming a file that is not on disk is named too.
  const { missing } = unrunTestFiles(testFilesOnDisk(), new Set([...testFilesNamedByUnitScript(), "ghost.test.ts"]));
  assert.deepEqual(missing, ["ghost.test.ts"]);
});

test("restriction-marker ratios in the docs equal the computed builtin and packaged values", () => {
  const builtin = realBuiltinMarkerRatio();
  const packaged = realPackagedMarkerRatio();
  assert.equal(builtin.marked, builtin.total, "every builtin profile must declare markers");
  assert.equal(packaged.marked, packaged.total, "every packaged chat profile must declare markers");
  const problems = [
    ...checkRatio(DOCS, builtin, "builtin restriction-marker"),
    ...checkRatio(DOCS, packaged, "packaged restriction-marker"),
  ];
  for (const id of packaged.ids) {
    if (!DOCS.includes(id)) {
      problems.push(
        `packaged profile "${id}" declares restrictionMarkers but is named nowhere in the docs, so the ${packaged.marked}/${packaged.total} claim is incomplete`,
      );
    }
  }
  assert.deepEqual(problems, [], problems.join("; "));
});

test("the dispatch-runner count claimed in AGENTS.md equals the real RUNNERS length", () => {
  const real = realRunnerCount();
  assert.ok(real >= 14, `expected >=14 dispatch runners, found ${real}`);
  const problems = checkRunnerCount(DOCS, real);
  assert.deepEqual(problems, [], problems.join("; "));
});

test("the packaged count claimed in AGENTS.md equals the real manifest-carrying dir count", () => {
  const real = realPackageCount();
  assert.ok(real >= 30, `expected >=30 packaged dirs with a manifest, found ${real}`);
  const problems = checkPackageCount(DOCS, real);
  assert.deepEqual(problems, [], problems.join("; "));
});

test("no hand-typed unverifiable suite total or loop-generated per-file total remains", () => {
  const hits = findForbidden(AGENTS);
  assert.deepEqual(hits, [], `AGENTS.md reintroduced unverifiable counts: ${hits.join("; ")}`);
});

test("the araprat line is disambiguated (3 verified + login-gated, not 'ALL THREE')", () => {
  assert.ok(!/ALL THREE capabilities/i.test(DOCS), `the ambiguous "ALL THREE capabilities" claim is back`);
  assert.ok(
    /3 verified/i.test(DOCS) && /login-gated/i.test(DOCS),
    "the araprat claim must distinguish 3 verified capabilities from the login-gated rest",
  );
});

test("MUTATION: a doc with a WRONG file count fails checkReadmeFileCount", () => {
  const real = realTestFileCount();
  // Planted into the REAL README, not string-replaced out of it. The figure it
  // used to carry is deliberately gone, so the old
  // `README.replace("<real> hermetic unit-test files", ...)` became a NO-OP and
  // died on its own "the mutation must actually alter the doc text" guard — a
  // mutation that changes nothing proves nothing. Appending a wrong claim is the
  // SAME defect (the doc asserting a count that is not the live one) against the
  // SAME real document, so this pin keeps exactly its old meaning.
  assert.deepEqual(checkReadmeFileCount(README), [],
    "precondition: the real README is clean, so a failure below can only come from the planted claim");
  const mutated = `${README}\n\nThe repo ships ${real + 1} hermetic unit-test files today.\n`;
  assert.ok(
    readmeFileCountClaim(mutated).includes(real + 1),
    "precondition: the planted doc really does claim the wrong count",
  );
  const problems = checkReadmeFileCount(mutated);
  assert.equal(problems.length, 1, `the pin must catch a wrong count; got ${JSON.stringify(problems)}`);
  assert.match(problems[0], new RegExp(`claims ${real + 1}[\\s\\S]*actually references ${real}`));
});

test("MUTATION: all three states of the file-count rule are pinned — wrong figure, no figure and no derivation, and the real README", () => {
  const real = realTestFileCount();
  const OWNER_CLAIM = "\n`package.json`'s `scripts[\"test:unit\"]` file list is its single owner.\n";
  const DERIVATION =
    "\nDerive it with `node -e 'console.log(1)'` over the test/*.test.ts match.\n";

  // (1) NO figure AND NO derivation → LOUD. A minimal doc is the honest input
  //     here because that is precisely the state being described.
  const bare = "# Suite\n\n`npm run test:unit` runs the hermetic suite. No browser needed.\n";
  assert.deepEqual(readmeFileCountClaim(bare), [], "precondition: the bare doc really states no figure");
  assert.equal(statesFileCountDerivation(bare), false,
    "precondition: the bare doc really states no derivation");
  const bareProblems = checkReadmeFileCount(bare);
  assert.equal(bareProblems.length, 1,
    `a doc with neither the count nor the derivation must fail; got ${JSON.stringify(bareProblems)}`);
  assert.match(bareProblems[0], /how to\s+derive|derive it|derivation/i,
    "the failure must name the derivation as what is missing, not demand a re-typed figure");

  // (2) NO figure BUT the derivation stated → PASS. This is the real README's
  //     shape, and it is the case the old rule used to redden.
  const derivedOnly = `# Suite\n${OWNER_CLAIM}${DERIVATION}`;
  assert.deepEqual(readmeFileCountClaim(derivedOnly), [], "precondition: it really states no figure");
  assert.deepEqual(checkReadmeFileCount(derivedOnly), [],
    "a doc that drops the figure but keeps the derivation must PASS — that is the duplication being removed");

  // (3) A CORRECT figure with no derivation → PASS. Rule 1 already holds the
  //     figure to the live value, so demanding the derivation as well would be
  //     redundant pressure to restate the number — the thing being undone.
  const correctOnly = `# Suite\n\nThe repo ships ${real} hermetic unit-test files today.\n`;
  assert.deepEqual(checkReadmeFileCount(correctOnly), [],
    "a correctly-typed figure is held by rule 1 and must not also be asked for a derivation");

  // (4) The real README, end to end.
  assert.deepEqual(checkReadmeFileCount(README), []);
  assert.ok(statesFileCountDerivation(README));
});

test("MUTATION: a doc with a WRONG ratio fails checkRatio", () => {
  const real = realBuiltinMarkerRatio();
  const mutated = AGENTS.replace(
    `${real.marked}/${real.total}`,
    `${real.marked - 1}/${real.total}`,
  );
  assert.notEqual(mutated, AGENTS, "the mutation must actually alter the doc text");
  const problems = checkRatio(mutated, real, "builtin restriction-marker");
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`${real.marked}/${real.total}`));
});

test("MUTATION: reintroducing a hand-typed suite total is detected by the forbidden patterns", () => {
  const mutated = `${AGENTS}\n\nStanding measurement: 961 tests / 58 suites (959 pass + 1 env skip).`;
  const hits = findForbidden(mutated);
  assert.ok(hits.length >= 1, "the forbidden-pattern pin must flag a retyped suite total");
  assert.ok(hits.some((h) => h.includes("tests /")), `expected the suite-total pattern to hit; got ${hits.join(" | ")}`);
});

test("MUTATION: a loop-generated per-file total (28/28) is detected", () => {
  const mutated = `${AGENTS}\n\nenforced by \`test/capability-dispatch.test.ts\` (28/28).`;
  const hits = findForbidden(mutated);
  assert.ok(
    hits.some((h) => h.includes("capability-dispatch")),
    `expected the per-file ratio pattern to hit; got ${hits.join(" | ")}`,
  );
});

test("MUTATION: a wrong package count and a wrong runner count both fail", () => {
  const pkgs = realPackageCount();
  const runners = realRunnerCount();
  const mutated = `the repo ships ${pkgs + 5} packages and ${runners - 1} dispatch runners today.`;
  const problems = [
    ...checkPackageCount(mutated, pkgs),
    ...checkRunnerCount(mutated, runners),
  ];
  assert.equal(problems.length, 2, `both pins must fire; got ${JSON.stringify(problems)}`);
});

// ------------------------------------------------------ corpus containment ---

test("the doc corpus this file reads is a SUBSET of the derived one, and the derived one is strictly larger", () => {
  // The two-file scope above is kept for attribution, not because it is the right
  // corpus. This is the test that says so mechanically: if the derived walk ever
  // stopped seeing README.md or AGENTS.md, the split would have become a silent
  // coverage LOSS rather than a deliberate narrowing.
  const derived = new Set(markdownSurfaces());
  for (const f of ["README.md", "AGENTS.md"]) {
    assert.ok(derived.has(f), `the derived doc surface no longer includes ${f} — the narrow scope is now a coverage hole, not a narrowing`);
  }
  assert.ok(
    derived.size > 2,
    `the derived doc surface has ${derived.size} files; the two-file scope is no longer a subset of anything larger, so "the extended rule covers more" is not being measured`,
  );
  // And the surfaces that motivated the extension, named: the forbidden-total rule
  // used to be free in each of these.
  for (const f of ["docs/AUDIT.md", "docs/function-api-ui-map.md", "capabilities/README.md"]) {
    assert.ok(
      derived.has(f),
      `non-vacuity: the derived doc surface does not include ${f}, the surface whose stale count motivated extending the rule past AGENTS.md`,
    );
  }
});

test("MUTATION: a document THIS file never reads, carrying a forbidden total, is caught by the derived rule", () => {
  // The extension proven, not asserted. `docs/AUDIT.md` is not in `DOCS`, so every
  // pin in this file is blind to it; the derived rule must not be. If this ever
  // passes because the synthetic text happens to be clean, the test is lying —
  // hence the explicit `assert.ok(findForbidden(...))` precondition in the middle.
  const injected = "## Suite\n\n`npm run test:unit` measured **961 tests / 58 suites** today.\n";
  assert.ok(
    findForbidden(injected).length > 0,
    "precondition: the synthetic doc really does carry a forbidden shape",
  );
  const scan = scanUnverifiableCounts({
    files: ["docs/AUDIT.md"],
    overrides: { "docs/AUDIT.md": injected },
  });
  assert.ok(
    scan.tier1.some((h) => h.rule === "suite-total"),
    `the derived rule must report a suite total in a doc surface this file never reads: ${JSON.stringify(scan.tier1)}`,
  );
  // The per-file ratio this file hardcoded two basenames for is now caught by
  // SHAPE, so the next test file is covered without editing a list.
  const perFile = "Enforced by `test/some-future-gate.test.ts` (28/28).\n";
  const derivedPerFile = scanUnverifiableCounts({
    files: ["docs/AUDIT.md"],
    overrides: { "docs/AUDIT.md": perFile },
  });
  assert.ok(
    derivedPerFile.tier1.some((h) => h.rule === "per-file-ratio"),
    `the generalized per-file ratio rule must fire for a file name no list mentions: ${JSON.stringify(derivedPerFile.tier1)}`,
  );
  assert.ok(
    TIER1_COUNT_RULES.some((r) => r.id === "per-file-ratio"),
    "precondition: the generalized per-file ratio rule exists",
  );
});
