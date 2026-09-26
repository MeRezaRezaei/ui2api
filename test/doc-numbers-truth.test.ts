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
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { BUILTIN_PROFILES } from "../src/profile/profile.ts";

const ROOT = join(import.meta.dirname, "..");
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

/** Real number of capabilities/*/ dirs that carry a manifest.json. */
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

/** Packaged chat-shaped profiles that declare non-empty restrictionMarkers. */
export function realPackagedMarkerRatio(): { marked: number; total: number } {
  const dir = join(ROOT, "capabilities");
  const withProfile = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "profile.json")))
    .map((e) => e.name);
  const marked = withProfile.filter((name) => {
    const parsed = JSON.parse(
      readFileSync(join(dir, name, "profile.json"), "utf8"),
    ) as any;
    const markers = parsed?.capability?.restrictionMarkers;
    return Array.isArray(markers) && markers.length > 0;
  });
  return { marked: marked.length, total: withProfile.length };
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
 */
export function readmeFileCountClaim(doc: string): number[] {
  const out: number[] = [];
  for (const m of doc.matchAll(/hermetic unit-test files \((\d+)/g)) {
    out.push(Number(m[1]));
  }
  return out;
}

export function checkReadmeFileCount(doc: string): string[] {
  const real = realTestFileCount();
  const problems: string[] = [];
  for (const claimed of readmeFileCountClaim(doc)) {
    if (claimed !== real) {
      problems.push(
        `README claims ${claimed} hermetic unit-test files; package.json scripts["test:unit"] actually references ${real}`,
      );
    }
  }
  if (readmeFileCountClaim(doc).length === 0) {
    problems.push("README carries no machine-checkable unit-test file count to pin");
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

test("README's unit-test file count equals the real package.json test:unit file list", () => {
  const problems = checkReadmeFileCount(README);
  assert.deepEqual(problems, [], problems.join("; "));
  assert.equal(
    readmeFileCountClaim(README)[0],
    realTestFileCount(),
    "README must print the derived count, not a remembered one",
  );
});

test("README's test-file claim does not hand-type an unverifiable test COUNT", () => {
  const hits = findForbidden(README);
  assert.deepEqual(hits, [], `README reintroduced unverifiable counts: ${hits.join("; ")}`);
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
  const mutated = README.replace(
    `${real} hermetic unit-test files`,
    `${real + 1} hermetic unit-test files`,
  );
  assert.notEqual(mutated, README, "the mutation must actually alter the doc text");
  const problems = checkReadmeFileCount(mutated);
  assert.equal(problems.length, 1, `the pin must catch a wrong count; got ${JSON.stringify(problems)}`);
  assert.match(problems[0], new RegExp(`claims ${real + 1}[\\s\\S]*actually references ${real}`));
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
