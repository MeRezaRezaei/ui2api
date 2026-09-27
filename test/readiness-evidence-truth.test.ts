/**
 * ROUND N+98: the readiness file's EVIDENCE column is now machine-checked.
 *
 * WHY THIS FILE EXISTS — the finding is the shape of the gap, not the two cells.
 *
 * `.brain/PRODUCTION_READINESS.md` is what an operator reads to decide whether to
 * ship. `test/production-readiness-gate.test.ts` passes 12/12 because it recomputes
 * the VERDICTS in sections 1-4. It never reads the EVIDENCE column beside them —
 * which is unverified prose, and which had rotted at least twice while the gate
 * stayed green:
 *
 *   - criterion 4.1 cited the hermetic test-file count as `84`; the real derived
 *     figure was 126;
 *   - criterion 4.2 asserted the exact opposite of the world — that the advertised
 *     registry "does NOT exist" and "no registry is published" — while it answers
 *     HTTP 200. The DOCS had been corrected when the registry was published; this
 *     file had not.
 *
 * A gate that checks a column is not a gate on the table. So this one reads the
 * evidence column.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. This file records a LIVE system. A pin that
 * demands a permanently-true fact about the outside world would be a pin that
 * forces a lie, and that mistake has been made and fixed twice in this repository
 * already (the registry doc-truth pin among them). So nothing here hardcodes a
 * world-state: the 4.2 cell must name how to re-derive, not what the answer is
 * forever. The corpus gate (below) is the only structural pin, and it is derived.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = join(ROOT, ".brain", "PRODUCTION_READINESS.md");

function readiness(): string {
  return readFileSync(FILE, "utf8");
}

/** The `| <id> | ... |` rows of the criteria tables, by criterion id. */
function cells(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of src.split("\n")) {
    const m = /^\|\s*(\d+\.\d+)\s*\|/.exec(line);
    if (m) out.set(m[1], line);
  }
  return out;
}

test("GOAL 149: the criteria table was actually parsed (anti-vacuity)", () => {
  const found = cells(readiness());
  // Sections 1-4 are the criteria the READY rule depends on. If this count ever
  // collapses, every assertion below is inspecting nothing and reporting success.
  for (const id of ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7",
    "2.1", "2.2", "2.3", "2.4", "2.5", "2.6",
    "3.1", "3.2", "3.3", "3.4", "3.5",
    "4.1", "4.2", "4.3"]) {
    assert.ok(found.has(id), `criterion ${id} row not found — the parser is broken, not the file`);
  }
  assert.ok(found.size >= 21, `expected >=21 criteria rows, parsed ${found.size}`);
});

test("GOAL 149: 4.1's cited test-file count equals the live package.json list", () => {
  const live = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    .scripts["test:unit"] as string)
    .split(/\s+/)
    .filter((t) => t.endsWith(".test.ts")).length;
  const cell = cells(readiness()).get("4.1") ?? "";
  // Every `(<n>)` in the cell must be the live number, so the count cannot rot
  // silently again. This is the cell that said 84 while the truth was 126.
  const cited = [...cell.matchAll(/\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(cited.length > 0, "4.1 cites no parenthesised count any more — re-pin it");
  for (const n of cited) {
    assert.equal(n, live,
      `4.1 cites (${n}) but package.json lists ${live} test files`);
  }
});

test("GOAL 149: 4.2 names how to re-derive the registry, never a frozen world-state", () => {
  const cell = cells(readiness()).get("4.2") ?? "";
  assert.ok(cell.length > 0, "4.2 row missing");
  // The cell used to assert the registry "does NOT exist" — a permanently-false
  // claim about a third party. It may quote that as history, but it must not be
  // stated as current fact, and it must carry a re-derivation.
  const asCurrentFact = /the advertised `[^`]*` does NOT exist(?! \()/i.test(cell);
  assert.ok(!asCurrentFact,
    "4.2 states as current fact that the registry does not exist; it is reachable (HTTP 200)");
  assert.match(cell, /curl|re-derive|Re-derive/i,
    "4.2 makes a claim about a third party without saying how to re-derive it");
  // And the current state must be recorded, not just the method.
  assert.match(cell, /HTTP 200|reachable|EXISTS/i,
    "4.2 does not record the registry's measured current state");
});

test("GOAL 149: the vault-exposure claim is the measured scope, not one file", () => {
  const src = readiness();
  assert.match(src, /142 of 143/,
    "the vault exposure must be stated as the measured scope (142 of 143), " +
    "not as the single 0644 file it was previously recorded as");
  // The number must be traceable to the sensor that derives it, so a future
  // change to the vault is visible rather than silently contradicting this file.
  assert.match(src, /vault-permission-census\.test\.ts/,
    "the vault claim must name the census that measures it");
});

test("GOAL 149: no criterion row still cites the retired (84) file count", () => {
  const src = readiness();
  for (const [id, cell] of cells(src)) {
    assert.ok(!/\(84\)/.test(cell),
      `criterion ${id} still cites (84); the live count is derived from package.json`);
  }
});

test("GOAL 149: operator_ack is the operator's alone and this gate cannot satisfy it", () => {
  const src = readiness();
  // Sanity: the file still HAS the field (so this test can never pass vacuously by
  // the field being gone), and this test asserts nothing about its value.
  assert.match(src, /operator_ack/,
    "the operator_ack field is gone from the readiness file — investigate before continuing");
  // The gate must never be satisfiable by an agent: the READY condition is
  // verdict-gate + operator_ack, and only the verdicts are machine-derived here.
  const gate = readFileSync(join(ROOT, "test", "production-readiness-gate.test.ts"), "utf8");
  assert.ok(!/operator_ack[^\n]*=\s*["']?yes/i.test(gate),
    "production-readiness-gate.test.ts appears to SET operator_ack — that is the operator's line");
});
