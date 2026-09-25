// GOAL 45: model-selection fidelity — the pure row matcher behind
// ChatDriver.selectModel. driver.ts's contract says "open the picker and click
// it, then VERIFY it took … never a silent wrong-model prompt", but the old
// click target was locator(sel).filter({ hasText: found.name.slice(0, 40) })
// .first() — Playwright hasText is a whitespace-normalized case-insensitive
// SUBSTRING match, and .first() is DOM order. Requesting "Gemini" against
// observed ["Gemini Pro", "Gemini"] (both rows contain "Gemini") clicked
// "Gemini Pro" — the wrong model — with zero verification and the prompt
// proceeded. pickModelRowIndex fixes the match order: exact first-line →
// attr-id (data-model-id/data-value/id) → substring LAST resort. Pure row
// matching — no browser, no network, no env (same pattern as the GOAL-44 pins
// in test/cli-argv.test.ts).
//
// BEFORE/AFTER QUOTE PAIR (the ambiguous-prefix mock-proof, pure):
//   BEFORE — old filter(hasText).first(): rows.filter(r => r.includes("Gemini"))[0]
//            → index 0 → "Gemini Pro"  (the silent wrong-model click)
//   AFTER  — pickModelRowIndex(rows, "Gemini") → index 1 → "Gemini"  (exact)
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pickModelRowIndex, type PickerRow } from "../src/prompt/driver.js";

test("GOAL 45: ambiguous-prefix pin — exact row wins over the prefix-sharing row (substring + .first() used to click the WRONG one)", () => {
  const rows: PickerRow[] = [{ text: "Gemini Pro" }, { text: "Gemini" }];
  // AFTER — the pure matcher: exact first-line === "Gemini" → index 1.
  assert.equal(pickModelRowIndex(rows, "Gemini"), 1);
  // BEFORE — the old locator.filter({ hasText: "Gemini" }).first() logic
  // (substring, DOM order): both rows contain "Gemini" → first() = index 0.
  const oldSubstringFirst = rows.findIndex((r) => r.text.includes("Gemini"));
  assert.equal(oldSubstringFirst, 0);
  assert.equal(rows[oldSubstringFirst].text, "Gemini Pro");
});

test("GOAL 45: id-vs-name — attr-id match decides when the target is the row's id and no row's text equals it", () => {
  const rows: PickerRow[] = [
    { text: "Gemini Pro", id: "gemini-pro" },
    { text: "Gemini", id: "gemini" },
  ];
  // target "gemini-pro" (found.id !== found.name → the click targets the id):
  // exact text match misses (no row DISPLAYS "gemini-pro"), the attr-id step
  // finds the row carrying data-model-id="gemini-pro" → index 0.
  assert.equal(pickModelRowIndex(rows, "gemini-pro"), 0);
  // And the common case: target = the name (id === name) resolves by exact text.
  assert.equal(pickModelRowIndex(rows, "Gemini"), 1);
  // A row whose id merely equals its own text carries no attr signal and must
  // never win the attr step over an exact/attr match.
  assert.equal(pickModelRowIndex([{ text: "Gemini", id: "Gemini" }, { text: "Gemini Pro", id: "gemini-pro" }], "gemini-pro"), 1);
});

test("GOAL 45: no matching row → null (never a silent substring guess when nothing matches)", () => {
  assert.equal(pickModelRowIndex([], "Gemini"), null);
  assert.equal(pickModelRowIndex([{ text: "Mode A" }, { text: "Mode B" }], "Nope"), null);
  assert.equal(pickModelRowIndex([{ text: "Gemini Pro", id: "gemini-pro" }], "gemini-2.5-pro"), null);
});

test("GOAL 45: substring is the explicit LAST resort — no exact/attr match, first substring row wins (old behavior retained only here)", () => {
  const rows: PickerRow[] = [{ text: "Mode A" }, { text: "Mode B" }];
  assert.equal(pickModelRowIndex(rows, "Mode"), 0);
  // Exact still beats substring when BOTH are present (the exact row is later).
  assert.equal(pickModelRowIndex([{ text: "Mode A" }, { text: "Mode" }], "Mode"), 1);
  // Wiring anchors: selectModel clicks through the pure matcher (exact first,
  // substring demoted), the fallback's boolean is honored, the verify-it-took
  // throw exists, and the suite is wired into test:unit.
  const driver = readFileSync("src/prompt/driver.ts", "utf8");
  assert.match(driver, /export function pickModelRowIndex/);
  assert.match(driver, /export interface PickerRow/);
  assert.match(driver, /pickModelRowIndex\(rows, target\)/);
  assert.match(driver, /model "\$\{model\}" did not take — no picker row matched/);
  assert.match(driver, /did not take \(still on "\$\{current\}"\)/);
  assert.match(driver, /export interface PickerRow[\s\S]*?exact[\s\S]*?substring LAST resort/s);
  // The old blind substring-first click is gone from the driver.
  assert.ok(!driver.includes("filter({\n            hasText"), "old filter(hasText).first() click must be gone");
  assert.match(readFileSync("package.json", "utf8"), /test\/model-select\.test\.ts/);
});