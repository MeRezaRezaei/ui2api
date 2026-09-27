// GOAL 110, extended past the two files it used to read.
//
// THE DEFECT THIS FILE EXISTS FOR: `test/doc-numbers-truth.test.ts` called
// `findForbidden(AGENTS)` and nothing else. The rule — a hand-typed suite total
// is unobservable from the repo, so it must be gone — was therefore enforced on
// `README.md` + `AGENTS.md` and FREE everywhere else, and it did rot: two docs
// ship a `N tests / M suites` line and a `*.test.ts (18/18)` ratio right now. A
// rule that is only enforced where someone remembered to enforce it is not a
// rule; the file set is now a `readdirSync` walk of every markdown surface the
// project ships (`markdownSurfaces()`), so the next doc added is covered the day
// it lands.
//
// ---------------------------------------------------------------- the tiers --
//
// The reason a number is banned is not that numbers go stale — plenty of numbers
// in these docs are meant to be stale — it is that the count is UNVERIFIABLE from
// the repo. `test/*.test.ts` hold a handful of literal `test(` calls and generate
// the rest from `for` loops, so a per-file total cannot be checked against
// anything: a loop that stops early keeps the file green while the number lies.
// That gives two tiers, and the split is the whole answer to "what about a doc
// that legitimately cites a historical count".
//
// TIER 1 — the shape itself is unverifiable, so it is refused in every surface,
// with no exemption and no escape hatch:
//   `N tests / M suites`, `(N pass + M env skip)`, `(N+ tests)`, `foo.test.ts (N/M)`.
//   None of these is worth keeping under any reading. `docs/AUDIT.md` says so
//   itself: the live figure is a runtime-only fact, so "get it from a run".
//
// TIER 2 — the shape is ordinary (a bare `418/418`, or `<test-basename> 26`) and
// the number is merely STALE. A stale number that is ATTRIBUTED is a record; an
// unattributed one is a claim, and a claim is what rots into a lie. A hit is a
// record only when BOTH hold:
//   * the enclosing markdown PASSAGE names a specific run — an ISO date, a
//     `fold #N`, a `GOAL N`, a `CI run <id>`; and
//   * the document either tells the reader where the LIVE number comes from, or
//     is a record by role (CHANGELOG, docs/handoffs/**, docs/superpowers/specs/**).
//
// ------------------------------------------------- is the dated tier a bypass? --
//
// A weaker version of this rule — "a dated claim is fine" — IS trivially
// bypassable: write `(2026-09-27)` and the number rides free, and a date is one
// cheap edit. So the tier deliberately does NOT accept a date as the
// discriminator. It requires a run reference PLUS a standing instruction to read
// the live number from a run, and it requires the reference to be SPECIFIC (a
// fold number, a GOAL number, a CI run id — not the words "dated" or "record",
// which describe an intent and are exactly what a bypass would type).
//
// The honest limit, stated so nobody mistakes this for a proof: the remaining
// discriminator is still prose. Someone who writes "fold #12" above a number they
// just made up has defeated it. What that costs is bounded and it is disclosed —
// every attributed hit is printed by the test below with the exact reference that
// excused it, so the classification is a short, auditable list rather than a
// silent one, and a fabricated reference is visible in that list. A
// non-prose discriminator does not exist for a markdown file, and the alternative
// worth having is not a smarter regex but the code-side registry: an allow-list
// entry in a test file, which is what the sibling gate in
// `test/doc-allow-list-liveness.test.ts` pins to be non-obsolete. This file
// registers NO such entry, on purpose — the two allow-lists this repo just
// emptied on purpose are the precedent, and populating a third to make a wall go
// green is the move the empty ones were made to end.
import { test as t, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_NUMBER_POINTER,
  MEASUREMENT_CTX,
  RUN_REF,
  TIER1_COUNT_RULES,
  nonVacuityProblems,
  passageStart,
  scanUnverifiableCounts,
  type CountHit,
} from "./helpers/doc-scan.js";

// ------------------------------------------------------------------ corpus ---

const SURFACES = scanUnverifiableCounts();
const fmt = (h: CountHit): string => `${h.file}:${h.line}  [${h.rule}] ${JSON.stringify(h.text)}`;

// ------------------------------------------------------------------- rules ---

t("TIER 1: no doc surface ships a test/suite count whose shape nothing can re-derive", (ctx: TestContext) => {
  const problems = [...nonVacuityProblems(SURFACES), ...SURFACES.tier1.map(fmt)];
  assert.deepEqual(
    problems,
    [],
    `unverifiable counts in shipped docs — the shape is refused in EVERY surface, with no date escape:\n  ${problems.join("\n  ")}\n` +
      `Fix each in the doc, not here: replace the count with the instruction to read it from a run, ` +
      `the way docs/AUDIT.md already does ("that figure is a runtime-only fact … get it from a run").`,
  );
  ctx.diagnostic(
    `tier-1 scan: ${SURFACES.tier1.length} hits across ${SURFACES.files.length} derived doc surfaces ` +
      `(${TIER1_COUNT_RULES.map((r) => r.id).join(", ")})`,
  );
});

t("TIER 2: no doc surface states a CURRENT test/suite count — an undated one is a claim, and claims rot", (ctx: TestContext) => {
  const problems = [...nonVacuityProblems(SURFACES), ...SURFACES.tier2Undated.map(fmt)];
  assert.deepEqual(
    problems,
    [],
    `these counts are stated with no run reference in their passage and no instruction to read the live number:\n  ${problems.join("\n  ")}\n` +
      `Either attribute the count to the run that produced it, or delete it and point at \`npm run test:unit\`.`,
  );
  // The attributed half is disclosed in full, with the reference that excused it,
  // so the classification is auditable rather than a silent permission slip.
  ctx.diagnostic(
    `tier-2 scan: ${SURFACES.tier2Records.length} attributed historical records, ` +
      `${SURFACES.tier2Undated.length} undated claims.\n` +
      SURFACES.tier2Records.map((h) => `    record  ${fmt(h)}  <- ${h.attributedBy}`).join("\n"),
  );
});

t("non-vacuity: the doc-surface set is DERIVED from disk and covers the surfaces the old AGENTS-only rule missed", () => {
  assert.ok(
    SURFACES.files.length >= 40,
    `non-vacuity: the walk found only ${SURFACES.files.length} markdown surfaces — a smaller set means the derivation stopped reading, and every rule above would pass on nothing`,
  );
  // Named individually, because "40 files" would still be true if the walk had
  // lost exactly the file the whole pin was written about.
  for (const required of [
    "README.md",
    "AGENTS.md",
    "docs/AUDIT.md",
    "docs/function-api-ui-map.md",
    "capabilities/README.md",
  ]) {
    assert.ok(
      SURFACES.files.includes(required),
      `non-vacuity: the derived doc set does not include ${required} — the walk is missing a surface, so these rules would pass without reading it`,
    );
  }
  assert.ok(
    SURFACES.files.some((f) => f.startsWith("docs/")),
    "non-vacuity: no docs/ surface was derived at all",
  );
  assert.ok(
    SURFACES.files.some((f) => f.startsWith("capabilities/")),
    "non-vacuity: no capabilities/ surface was derived — the per-package CAPABILITIES.md files are doc surfaces too",
  );
});

t("non-vacuity: an EMPTY derivation is a FAILURE, never a pass", () => {
  // The failure mode that let a sibling report "4/4 entries in use" while one
  // entry was dead: a rule that finds nothing because it read nothing looks
  // exactly like a rule that found nothing because there is nothing to find.
  // The only thing that separates them is a check that the derivation is real,
  // so the check exists and this test proves it FIRES on an empty set.
  const empty = scanUnverifiableCounts({ files: [] });
  const problems = nonVacuityProblems(empty);
  assert.ok(
    problems.length > 0,
    "a scan whose doc-surface derivation returned an empty set must report a non-vacuity failure; it currently reports none, so an empty walk would pass this whole file",
  );
  assert.match(problems.join("; "), /0 markdown|derivation|empty/i);
  assert.deepEqual(nonVacuityProblems(SURFACES), [], "precondition: the real corpus is not empty");
});

t("non-vacuity: every TIER-1 rule fires on a synthetic line, so none of them is dead weight", () => {
  const samples: Record<string, string> = {
    "suite-total": "Suite: 961 tests / 58 suites green today.",
    "pass-plus-skip": "Result (961 pass + 1 env skip) on the box.",
    "test-count-plus": "The README claims (595+ tests) across the suite.",
    "per-file-ratio": "Enforced by `test/capability-dispatch.test.ts` (28/28).",
  };
  for (const rule of TIER1_COUNT_RULES) {
    const sample = samples[rule.id];
    assert.ok(sample, `no synthetic sample is registered for TIER-1 rule "${rule.id}"`);
    const scan = scanUnverifiableCounts({ files: ["README.md"], overrides: { "README.md": sample } });
    assert.ok(
      scan.tier1.some((h) => h.rule === rule.id),
      `TIER-1 rule "${rule.id}" (${rule.why}) did not fire on its own documented shape: ${JSON.stringify(sample)}`,
    );
  }
});

t("non-vacuity: the dated/current classifier is not degenerate in either direction", () => {
  // 1. UNDATED must be reachable: a bare suite ratio with no run reference is a
  //    claim. If this ever classifies as a record, the tier is a free pass.
  const undated = scanUnverifiableCounts({
    files: ["docs/ONBOARDING.md"],
    overrides: {
      "docs/ONBOARDING.md": "## Suite\n\nThe suite stands at 961 tests / 58 suites right now.\n",
    },
  });
  assert.ok(
    undated.tier2Undated.length > 0 || undated.tier1.length > 0,
    "a synthetic doc asserting a CURRENT total with no run reference was accepted — the dated tier is not discriminating",
  );

  // 2. RECORD must be reachable: a real classified record exists in the corpus, so
  //    the record branch is not unreachable code that would silently stop working.
  assert.ok(
    SURFACES.tier2Records.length > 0,
    "no count anywhere in the corpus was classified as an attributed record — the record branch is unreachable, so the tier-2 rule is not being exercised at all",
  );

  // 3. And the two must not be the same answer: every record carries a reference
  //    that actually matches RUN_REF, not a label.
  for (const h of SURFACES.tier2Records) {
    assert.ok(
      h.attributedBy && RUN_REF.test(h.attributedBy.split(": ").slice(1).join(": ")),
      `a record was excused by something that is not a run reference: ${fmt(h)} <- ${h.attributedBy}`,
    );
  }
});

t("a passage boundary is a real markdown boundary, so a count inherits its own bullet's date and no other", () => {
  const lines = [
    "Get the truth from the run, never from prose.",
    "",
    "- **VERIFIED (GOAL 15, 2026-09-23)**:",
    "  the answer came back 418/418 green on that run.",
    "- **A DIFFERENT BULLET**:",
    "  an unrelated suite total 430/430 that owns no date.",
  ];
  assert.equal(passageStart(lines, 4) + 1, 3, "a count inside a dated bullet belongs to that bullet");
  assert.equal(passageStart(lines, 6) + 1, 5, "the next bullet opens its own passage");
  // The classification, end to end: only the first bullet's count is a record.
  const scan = scanUnverifiableCounts({
    files: ["docs/ONBOARDING.md"],
    overrides: { "docs/ONBOARDING.md": lines.join("\n") },
  });
  const records = scan.tier2Records.map((h) => h.text);
  const undated = scan.tier2Undated.map((h) => h.text);
  assert.ok(records.includes("418/418"), "the dated bullet's count must be a record");
  assert.ok(undated.includes("430/430"), "an undated bullet's count must be reported as a claim");
  assert.ok(
    !records.includes("430/430"),
    "a date in a NEIGHBOURING bullet must not excuse this one — that would be attribution by coincidence",
  );
});

// --------------------------------------------------------------- mutations ---

t("MUTATION: a real doc surface carrying a retyped suite total is reported", () => {
  // `docs/AUDIT.md`, perturbed IN MEMORY only — the working tree is never
  // touched, which matters here because four agents share it.
  const scan = scanUnverifiableCounts({
    files: ["docs/AUDIT.md"],
    overrides: {
      "docs/AUDIT.md": "## A. Gate summary\n\n`npm run test:unit` → **961 tests / 58 suites** (959 pass + 1 env skip).\n",
    },
  });
  const rules = scan.tier1.map((h) => h.rule);
  assert.ok(rules.includes("suite-total"), `the suite-total rule did not fire: ${JSON.stringify(scan.tier1)}`);
  assert.ok(rules.includes("pass-plus-skip"), `the pass-plus-skip rule did not fire: ${JSON.stringify(scan.tier1)}`);
  assert.equal(scan.tier1.length, 2, "both halves of the same retyped total must be reported");
});

t("MUTATION: a real doc surface carrying a per-file test count is reported", () => {
  const scan = scanUnverifiableCounts({
    files: ["AGENTS.md"],
    overrides: {
      "AGENTS.md":
        "## Conventions\n\nGet the truth from the run, never from prose.\n\nMeasured on 2026-09-27: validate-packages 211 cases pass.\n",
    },
  });
  assert.ok(
    scan.tier2Records.some((h) => h.rule === "per-file-count" && h.text.includes("validate-packages")),
    `a per-file count attributed to a real dated run must be classified as a RECORD: ${JSON.stringify(scan.tier2Records)}`,
  );
  // Same count, no date: a claim, and a claim is what the rule is for.
  const undated = scanUnverifiableCounts({
    files: ["AGENTS.md"],
    overrides: {
      "AGENTS.md": "## Conventions\n\nGet the truth from the run, never from prose.\n\nMeasured: validate-packages 211 cases pass.\n",
    },
  });
  assert.ok(
    undated.tier2Undated.some((h) => h.rule === "per-file-count" && h.text.includes("validate-packages")),
    `a per-file count with no run reference must be reported as a claim: ${JSON.stringify(undated.tier2Undated)}`,
  );
});

t("MUTATION: deleting the live-number instruction retires a document's dated records", () => {
  // The gate is not "a date is present". It is a date AND an instruction to read
  // the live number. Take the instruction away from docs/AUDIT.md — in memory —
  // and the passage is no longer allowed to carry counts it never measured.
  const real = (SURFACES.tier2Records.some((h) => h.file === "docs/AUDIT.md")) === true;
  assert.ok(real, "precondition: docs/AUDIT.md carries at least one attributed record today");
  const stripped = scanUnverifiableCounts({
    files: ["docs/AUDIT.md"],
    overrides: {
      "docs/AUDIT.md":
        "# Audit\n\n(re-verified 2026-09-21, fold #11)\n\n" +
        "| `npm run test:unit` | **PASS 418/418** | re-run at fold #11: tests 418, capability-dispatch 18 |\n",
    },
  });
  assert.ok(
    stripped.tier2Undated.length > 0,
    "a dated snapshot that no longer says where the live number comes from must have its counts reported as claims — the date alone is not the exemption",
  );
});

t("MUTATION: the measurement-context filter is what keeps status codes out of the ratio rule", () => {
  // `capabilities/gmail/CAPABILITIES.md` really does contain `301/302`, and
  // `conol` `401/404`. Without the context filter the ratio rule fires on HTTP
  // status pairs and the gate is noise nobody reads.
  assert.ok(!MEASUREMENT_CTX.test("the probe answered 301/302 for that endpoint"), "a status-code line must not read as a measurement");
  assert.ok(MEASUREMENT_CTX.test("the suite stands at 418/418"), "a suite line must read as a measurement");
  assert.ok(
    RUN_REF.test("re-verified 2026-09-21, fold #11"),
    "an ISO date and a fold number are run references",
  );
  assert.ok(
    !RUN_REF.test("this number is dated, honestly"),
    "`dated` is an intent word, not a run reference — accepting it is the bypass this rule refuses",
  );
  assert.ok(
    LIVE_NUMBER_POINTER.test("Get the truth from the run, never from prose."),
    "the live-number instruction must be recognisable, or a dated doc can never be a record",
  );
});
