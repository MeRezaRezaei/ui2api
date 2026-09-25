import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chatSurfaceStatus } from "../src/prompt/registry.js";

/**
 * GOAL 92: the shipped site inventory's status column is a consumer-facing
 * VERDICT, so it must not be able to say "works" when the machine record
 * says "not verified".
 *
 * The code owns a five-value status (`ChatSurfaceStatus`) and a "verified"
 * status REQUIRES a real `metadata.json` record (since+evidence+via).
 * This pin cross-checks every `| `id` | STATUS |` row in
 * `capabilities/README.md`: a row whose status claims a live round-trip must
 * have `chatSurfaceStatus(id) === "verified"`. Free-form analysis wording
 * ("grounded", "runner", "scaffold") is NOT a round-trip claim and is allowed.
 *
 * Proven able to fail: the negative block feeds the same checker a scratch row
 * that claims a round-trip for a site with no verified record.
 */

const README = readFileSync("capabilities/README.md", "utf8");

/** The load-bearing status cell of a row: a row reads as a round-trip claim
 *  when its status cell contains VERIFIED / live-verified / round-trip (in any
 *  case), the way a production consumer scanning the table would read it. */
function rowClaimsRoundTrip(statusCell: string): boolean {
  const EXCLUDED = /never claimed verified|unverified-candidate|not verified|auth verified|auth-verified|no chat surface|dead-?end|dormant|scaffold/i;
  return /\bverified\b|\bround-?trip\b/i.test(statusCell) && !EXCLUDED.test(statusCell);
}

/** Every `| `id` | STATUS | … ` row -> { id, status }. */
export function parseStatusRows(doc: string): { id: string; status: string }[] {
  const out: { id: string; status: string }[] = [];
  for (const m of doc.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]*)\|/gm)) out.push({ id: m[1]!, status: m[2]! });
  return out;
}

/** The single source of truth: every round-trip-claiming row must be backed by
 *  a real `verified` machine status. Exported so the negative can reuse it. */
export function roundTripGaps(doc: string): string[] {
  const gaps: string[] = [];
  for (const { id, status } of parseStatusRows(doc)) {
    if (!rowClaimsRoundTrip(status)) continue;
    const machine = chatSurfaceStatus(id);
    if (machine !== "verified") gaps.push(`\`${id}\` claims a live round-trip in the shipped table but the machine status is "${machine}" (no verified metadata record)`);
  }
  return gaps;
}

d("GOAL 92: the shipped site-status column cannot claim a round-trip the machine record does not support", () => {
  t("every round-trip-claiming row is backed by a real verified record", () => {
    // non-vacuity: the table must actually have round-trip rows to check.
    const rows = parseStatusRows(README);
    assert.ok(rows.length >= 20, `expected the inventory table to carry >=20 site rows, found ${rows.length}`);
    const claims = rows.filter((r) => rowClaimsRoundTrip(r.status));
    assert.ok(claims.length >= 1, "expected at least one round-trip-claiming row (the youtube/araprat-style rows) so the check is not vacuous");
    assert.deepEqual(roundTripGaps(README), [], "the shipped status column and the machine verified-record must agree");
  });

  t("the 7 genuinely-verified sites are exactly the round-trip-claiming rows", () => {
    // the round-trip-claiming set must equal the set the machine calls verified
    const claimed = new Set(parseStatusRows(README).filter((r) => rowClaimsRoundTrip(r.status)).map((r) => r.id));
    const machine = ["araprat", "deepseek", "duckduckgo", "gemini", "kimi", "tencent-aistudio", "youtube"];
    for (const id of machine) assert.equal(claimed.has(id), true, `${id} has a real verified record but the table does not claim a round-trip for it`);
  });
});

d("negative: a table that claims a round-trip without a record falls RED (the pin CAN fail)", () => {
  t("a scratch row claiming a round-trip for an unverified site is reported", () => {
    // precondition: the real table is green.
    assert.deepEqual(roundTripGaps(README), [], "precondition: the real table is green");
    // claude carries a "✅ grounded + runner" analysis claim but NO verified record;
    // upgrade its status cell to a round-trip claim in a scratch copy and the
    // checker must flag it.
    const scratch = README.replace(/^(\|\s*`claude`\s*\|)[^|]*/m, "$1 ✅ live-verified (pretend)");
    assert.ok(rowClaimsRoundTrip(parseStatusRows(scratch).find((r) => r.id === "claude")!.status), "precondition: the scratch row really claims a round-trip");
    const gaps = roundTripGaps(scratch);
    assert.ok(gaps.some((g) => g.includes("`claude`") && g.includes("no verified metadata record")), `an unsupported round-trip claim must be reported, got ${JSON.stringify(gaps)}`);
  });
});
