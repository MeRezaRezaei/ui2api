// OPEN ITEM #5 (docs/ACTIVE-WAVE.md) — the commit-map PRODUCER had no CONSUMER.
//
// scripts/ci/make-public-repo.sh writes the commit-map (private-full at :189,
// public-sanitized copied out of filter-repo at :354-359) and
// docs/RECONSTRUCTION-RUNBOOK.md §2 documents its format, but nothing in the
// tree ever CHECKED those bytes. That is not cosmetic: the runbook's own §2.3
// records that the producer's ORIENTATION COMMENT claimed `REWRITTEN->OLD` and
// was WRONG until 2026-10-01. An unexecuted prose claim is an assertion, and an
// assertion rots silently — the reason the runbook says the orientation must be
// a TEST (P7) rather than a comment. P7 runs real filter-repo over the real
// repository; this file covers the complement P7 cannot: that the ARTIFACT, as
// bytes, is shaped the way §2 documents.
//
// DELIBERATELY NOT IN SCOPE, and this is the design, not an omission:
//   * it runs NO git and NO filter-repo, and touches no repository. P7 owns the
//     repository-side claims (which shas exist, set membership on both sides,
//     every source commit having a row). This file owns the FILE-side claims.
//   * it does NOT verify counts. The runbook's count claim is the very prose
//     that was wrong before 2026-10-01, so a count pin here would re-encode the
//     defect. The script PRINTS what it measured and trusts the caller.
//   * it does NOT verify the forty-zero pruned shape is CORRECT (that the
//     pruned commit really is absent from the sanitized side). It verifies only
//     that it is ACCEPTED — a real filter-repo run emits it, so rejecting it
//     would fire on good maps.
//
// Every fixture below is SYNTHETIC, written to a temp dir, and the script only
// ever reads the file path it is given. Nothing here can mutate real history.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SCRIPT = join(ROOT, "scripts", "ci", "verify-commit-map.sh");

/** The literal header git filter-repo writes: "%-40s %s" over "old","new". */
const HEADER = `old                                      new`;
const OLD_A = "a".repeat(40);
const OLD_C = "c".repeat(40);
const NEW_B = "b".repeat(40);
/** filter-repo's deleted_hash — a REAL state, not corruption. */
const PRUNED = "0".repeat(40);

function fixture(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "commit-map-"));
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function verify(path: string) {
  return spawnSync("bash", [SCRIPT, path], {
    encoding: "utf8",
    timeout: 20_000,
  });
}

// ------------------------------------------------------- it accepts a good map ---

test("verify-commit-map accepts a conforming map and reports the three row shapes", () => {
  // One row of each documented shape (§2.1): rewritten, untouched (old == new),
  // and pruned (new == forty zeros). The pruned row MUST pass — it is emitted by
  // a real filter-repo run, so a gate that refused it would fire on good maps.
  const good = fixture(
    "good.map",
    [
      HEADER,
      `${OLD_A} ${NEW_B}`,
      `${OLD_A} ${OLD_A}`,
      `${OLD_C} ${PRUNED}`,
      "",
    ].join("\n"),
  );
  const r = verify(good);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /OK /);
  assert.match(r.stdout, /3 row\(s\)/);
  assert.match(r.stdout, /1 pruned/);
});

// --------------------------------------- it refuses a transposed header ---

test("verify-commit-map refuses a flipped header orientation with a named reason", () => {
  // THE regression this consumer exists for. `new old` is what the pre-2026-10-01
  // comment claimed; accepting it would silently invert the operator's only
  // reconstruction key, so the refusal must be NAMED, not a bare non-zero.
  const flipped = fixture(
    "flipped.map",
    [`new                                      old`, `${OLD_A} ${NEW_B}`, ""].join("\n"),
  );
  const r = verify(flipped);
  assert.notEqual(r.status, 0, "a transposed map must not pass");
  assert.equal(r.status, 1, "a content refusal is exit 1, not a usage error");
  assert.match(r.stderr, /header-orientation/);
  assert.match(r.stderr, /expected "old"/);
});

// ------------------------------------------ it refuses a malformed row ---

test("verify-commit-map refuses a row that is missing its second field", () => {
  const short = fixture("short.map", [HEADER, OLD_A, ""].join("\n"));
  const r = verify(short);
  assert.notEqual(r.status, 0, "a one-field row must not pass");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /row-shape/);
  assert.match(r.stderr, /line 2/);
});

// --------------------------------------- the refusal names the offending line ---

test("verify-commit-map names the offending line, not just that it failed", () => {
  // A gate that cannot say WHERE is a gate the operator learns to bypass.
  const corrupt = fixture(
    "corrupt.map",
    [HEADER, `${OLD_A} ${NEW_B}`, `${OLD_C} not-a-sha`, ""].join("\n"),
  );
  const r = verify(corrupt);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /row-shape/);
  assert.match(r.stderr, /line 3/);
  assert.match(r.stderr, /40-char hex sha/);
});
