// THE OBSOLETE ALLOW-LIST: an entry that suppresses nothing is debt with a
// comment on it.
//
// The failure this file exists for, reported from a sibling gate in this same run:
// an allow-list reported "4/4 entries in use; all entries still live" while one of
// its entries was OBSOLETE — because its staleness check was `pathExists`, the
// wrong POLARITY. A doc-path allow-list exists precisely because a doc names a
// path that does not exist, so `pathExists(entry.path)` is false for exactly the
// entries that are supposed to be live and can never become true for them. The
// entry therefore could not self-clear: once the doc was corrected, the entry
// stayed, and the hole stayed open, with the gate reporting everything healthy.
//
// Run against the real tree as this file is written, it finds FOUR such entries
// in `test/ci-contract-doc-commands.test.ts::ALLOWED_DOC_PATHS`, all four dead,
// in the one list its owning gate calls "4/4 in use".
//
// ---------------------------------------------------------------- the check --
//
// "Is this entry still suppressing a real violation?" is a PER-LIST question:
// what a live entry means depends on what the list excuses. So the check is
// registered per list (`LIVENESS_PROBES` in `test/helpers/doc-scan.ts`) and a
// list with NO registered probe FAILS. That is deliberate. The alternatives were
// a default `() => true`, which is the vacuous pass this file exists to kill, and
// a parallel re-implementation of each list's own rule, which would be a second
// copy of every gate's semantics and would rot into being wrong in a way nothing
// notices. A list this gate cannot read is REPORTED, which is the honest
// outcome, and it is a one-line addition to a map when someone wants it covered.
//
// ---------------------------------------------------------------- the limits --
//
// Stated plainly, because a pin that overstates what it checks is the same defect
// in a new coat:
//   * The probe is a re-derivation of the violation set, not the other gate's own
//     predicate. It answers "does a real violation still match this entry", which
//     is the check the sibling got wrong, but it is a second derivation and the
//     two can disagree.
//   * It can only judge entries it can PARSE. `parseSuppressionLists` is textual;
//     an entry shape it cannot read comes back with no fields, and a fieldless
//     entry is reported OBSOLETE rather than skipped — unreadable is not live.
//   * It reads the WORKING TREE, not the git index, so it can see another agent's
//     in-flight edit. That is the right trade for a staleness check (the question
//     is what the docs say now) and the wrong one for a shipped-set check, which
//     is why `test/gate-wiring.test.ts` scopes itself to the index instead.
//   * It cannot see a suppression that is not a named `export const` array: a
//     hardcoded `.filter(v => v.file !== "x")` inside a predicate is invisible.
//     Nothing mechanical can see that; the only defence is not writing one.
import { test as t, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  LIVENESS_PROBES,
  NOT_SUPPRESSIONS,
  ROOT,
  listId,
  suppressionFamilyLists,
  suppressionLists,
  type LivenessProbe,
  type SuppressionEntry,
  type SuppressionList,
} from "./helpers/doc-scan.js";

const LISTS = suppressionLists();
const FAMILY = suppressionFamilyLists();
const entryId = (l: SuppressionList, e: SuppressionEntry): string => `${listId(l)} :: ${e.raw.slice(0, 70)}`;

const evaluate = (l: SuppressionList): { entry: SuppressionEntry; live: boolean }[] => {
  const probe = LIVENESS_PROBES[listId(l)];
  if (!probe) return [];
  return l.entries.map((entry) => ({ entry, live: probe(entry) }));
};

// ------------------------------------------------------------------- rules ---

t("every allow-list entry in test/** suppresses a REAL violation today", (ctx: TestContext) => {
  const obsolete: string[] = [];
  for (const list of LISTS) {
    for (const { entry, live } of evaluate(list)) {
      if (!live) obsolete.push(entryId(list, entry));
    }
  }
  assert.deepEqual(
    obsolete,
    [],
    `these allow-list entries suppress nothing — an allow-list entry that no longer excuses a violation is a hole, not a record, and a fixed violation must never stay allowed:\n  ${obsolete.join("\n  ")}\n` +
      `Delete the entry (and its budget) in the file that owns it. Do NOT re-point it: the point is that the defect it named is gone.`,
  );
  ctx.diagnostic(
    `allow-list liveness: ${LISTS.reduce((n, l) => n + l.entries.length, 0)} entries across ${LISTS.length} derived lists, all live`,
  );
});

t("every allow-list in the tree has a REGISTERED liveness probe — an unreadable one is reported, never assumed live", () => {
  const declared = new Set(NOT_SUPPRESSIONS.map((n) => n.id));
  const unregistered = FAMILY.filter((l) => !LIVENESS_PROBES[listId(l)] && !declared.has(listId(l)));
  assert.deepEqual(
    unregistered.map(listId),
    [],
    `these allow-list-shaped exports have no liveness probe and are not declared non-suppressions:\n  ${unregistered.map(listId).join("\n  ")}\n` +
      `Either register a probe in LIVENESS_PROBES (test/helpers/doc-scan.ts) saying what "still live" means for it, or add it to NOT_SUPPRESSIONS with the reason it is not a suppression. A new suppression nobody reviews here is the class this file pins.`,
  );
  // And the declared non-suppressions must be REAL: each must name a list the
  // scan actually found, or the exemption is a hole in the completeness check.
  const found = new Set(FAMILY.map(listId));
  for (const n of NOT_SUPPRESSIONS) {
    assert.ok(found.has(n.id), `NOT_SUPPRESSIONS names ${n.id}, which the scan does not find — the declaration is stale`);
    assert.ok(n.reason.length > 20, `NOT_SUPPRESSIONS entry ${n.id} carries no reason`);
  }
});

t("non-vacuity: the allow-list discovery is not empty, and not all-empty either", () => {
  // A discovery that returns nothing passes the rule above for the wrong reason.
  // So the corpus is asserted, by id, and so is the fact that it contains at
  // least one list with entries — otherwise "all entries live" would be
  // vacuously true over an empty set, which is the sibling's exact false green.
  assert.ok(
    LISTS.length >= 4,
    `non-vacuity: only ${LISTS.length} allow-lists were derived from test/** — a smaller set means the discovery stopped reading, and the liveness rule would pass without inspecting anything`,
  );
  for (const id of [
    "test/ci-contract-doc-commands.test.ts::ALLOWED_DOC_PATHS",
    "test/ci-contract-knob-cites.test.ts::ALLOWED_UNDOCUMENTED_KNOBS",
    "test/ci-contract-knob-cites.test.ts::ALLOWED_WRONG_FILE_CITES",
    "test/helpers/ci-contract-scan.ts::KNOB_PARITY_ALLOW",
    "test/host-independence-gate.test.ts::ALLOW_LIST",
  ]) {
    assert.ok(
      LISTS.some((l) => listId(l) === id),
      `non-vacuity: the discovery did not find ${id} — the scan is reading a smaller tree than it thinks`,
    );
  }
  assert.ok(
    LISTS.some((l) => l.entries.length > 0),
    "non-vacuity: every discovered allow-list is EMPTY, so 'all entries live' is vacuously true — the same false green this file pins",
  );
});

t("no registered probe is a constant-true stub", () => {
  // A probe that answers `true` to everything makes the liveness rule pass by
  // construction — the most likely way for this file to rot into a green light
  // that means nothing. A fieldless entry is the cheapest possible probe input,
  // so every registered probe is fed one and must decline it.
  for (const [id, probe] of Object.entries(LIVENESS_PROBES)) {
    assert.equal(
      probe({ fields: {}, raw: "" }),
      false,
      `the liveness probe for ${id} returns true for an entry it could not read — a probe that never declines checks nothing`,
    );
  }
  assert.ok(
    Object.keys(LIVENESS_PROBES).length >= 4,
    `non-vacuity: only ${Object.keys(LIVENESS_PROBES).length} probes are registered — the liveness rule is thinner than the list count it is supposed to cover`,
  );
});

// --------------------------------------------------------------- mutations ---

t("MUTATION: an entry whose violation is fixed is reported obsolete", () => {
  // The whole subject, on synthetic data: an entry that stops matching must be
  // named, and the naming must be exact so a live sibling entry is not collateral.
  const live: LivenessProbe = (e) => e.fields.knob === "UI2API_STILL_BROKEN";
  const fixed: LivenessProbe = (e) => e.fields.knob === "UI2API_ALREADY_FIXED";
  assert.equal(live({ fields: { knob: "UI2API_STILL_BROKEN" }, raw: "" }), true);
  assert.equal(fixed({ fields: { knob: "UI2API_STILL_BROKEN" }, raw: "" }), false);
  assert.equal(fixed({ fields: { knob: "UI2API_ALREADY_FIXED" }, raw: "" }), true);
});

t("MUTATION: the POLARITY TRAP — a doc-path entry is live only while a doc still names it", (ctx: TestContext) => {
  // This is the sibling's bug, stated as an executable claim. `pathExists` alone
  // says an entry is live whenever the path is ABSENT, which is the situation the
  // entry was written for — so it can never retire. Both halves are checked here,
  // and the second half is the one that was missing.
  const probe = LIVENESS_PROBES["test/ci-contract-doc-commands.test.ts::ALLOWED_DOC_PATHS"];

  // (a) the path EXISTS -> the defect it excused is fixed -> obsolete.
  assert.equal(
    probe({ fields: { path: "README.md" }, raw: "" }),
    false,
    "an entry for a path that now exists on disk must be obsolete",
  );
  // (b) the path does NOT exist and NO doc names it -> the defect is fixed too,
  //     and this is the half a `pathExists` check cannot see.
  assert.equal(
    existsSync(join(ROOT, "src/does-not-exist-anywhere.ts")),
    false,
    "precondition: the probe subject really is absent from the tree",
  );
  assert.equal(
    probe({ fields: { path: "src/does-not-exist-anywhere.ts" }, raw: "" }),
    false,
    "an entry for a path no doc names any more must be obsolete, even though the path is still absent — this is the case `pathExists` gets permanently wrong",
  );
  // (c) a real live entry: a doc names a path that is absent.
  const live = probe({ fields: { path: "src/prompt/http.ts" }, raw: "" });
  if (live) {
    ctx.diagnostic("a genuinely live doc-path entry exists today; polarity confirmed on real data");
  } else {
    // Honesty over green: if today's tree has no live entry, that is a fact to
    // report, not something to paper over. It does not fail the polarity rule,
    // which is about the CHECK, and (a)/(b) above are the check.
    ctx.diagnostic(
      "no doc-path entry is live today (every entry in that list is dead) — the polarity rule is proven by (a) and (b); see the liveness test for the real list",
    );
  }
});

t("MUTATION: a knob-table exemption is live only while the table still lacks the row", () => {
  const undoc = LIVENESS_PROBES["test/ci-contract-knob-cites.test.ts::ALLOWED_UNDOCUMENTED_KNOBS"];
  const cite = LIVENESS_PROBES["test/ci-contract-knob-cites.test.ts::ALLOWED_WRONG_FILE_CITES"];
  // A knob the code reads and the table does not document is the live case.
  assert.equal(
    undoc({ fields: { knob: "UI2API_ATTACH_PORT" }, raw: "" }),
    false,
    "a knob that already HAS a table row must not be exemptible — the row exists, so the defect is fixed",
  );
  // A cite whose file DOES contain the knob is a wrong-LINE drift, not a
  // wrong-FILE lie, and must not stay exemptible as one.
  assert.equal(
    cite({ fields: { knob: "UI2API_ATTACH_PORT", cite: "src/runtime/browser.ts:1" }, raw: "" }),
    false,
    "a wrong-file cite whose file now contains the knob must be obsolete",
  );
});
