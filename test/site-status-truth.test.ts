import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chatSurfaceStatus, findPackageDir, listInstalledPackageIds } from "../src/prompt/registry.js";

/**
 * GOAL 92: the shipped site inventory's status column is a consumer-facing
 * VERDICT, so it must not be able to say "works" when the machine record
 * says "not verified".
 *
 * ── THE REVERSE DIRECTION, AND WHY THE SET IS DERIVED (not "the 7") ──────────
 *
 * This file used to pin ONE direction and then *hand-type* the other side:
 *
 *   const machine = ["araprat","deepseek","duckduckgo","gemini","kimi",
 *                    "tencent-aistudio","youtube"];
 *   for (const id of machine) assert.equal(claimed.has(id), true, …)
 *
 * Two defects, both the "extend a hand-typed list" class two sibling lanes just
 * closed elsewhere (`capability-untested-critical-path`'s ten chat names,
 * `capability-output-truth`'s tail set):
 *
 *  1. ONE-WAY. `claimed.has(id)` asks only "is this hand-typed id claimed?".
 *     A site PUBLISHED as verified with no record, and a site with a real
 *     record the hand-typed list never named, were both invisible to it.
 *  2. HAND-TYPED. The 7 were literals in a test file with no edge to the
 *     machine set: a package that earned a real record (or a table that dropped
 *     a real one) outside those seven names moved the truth and left the gate
 *     green. "Today the 7 equal the derived set" was a coincidence nothing
 *     enforced — DERIVE, do not extend a list.
 *
 * So the round-trip set is DERIVED from the record the repo already keeps, and
 * checked as a set EQUALITY in both directions:
 *
 *   RECORDED (structured) := for every id in the DERIVED universe, read that
 *                            package's OWN `capabilities/<id>/metadata.json`
 *                            and apply the receipt shape
 *                            `verified.{since,evidence,via}` non-empty — the
 *                            SAME predicate `chatSurfaceStatus()` applies
 *                            (`isCompleteVerifiedRecord`,
 *                            src/prompt/registry.ts:242, reached through
 *                            `packageStatusOf` at src/prompt/registry.ts:521),
 *                            re-applied here INDEPENDENTLY so the resolver is
 *                            cross-checked rather than trusted.
 *   PUBLISHED (prose)     := `capabilities/README.md` status cells that read
 *                            as a round-trip claim, the way a consumer
 *                            scanning the table reads them.
 *
 * The universe is derived too (installed packages ∪ README rows), so a brand
 * new package is inside this check on the day it lands, with no edit here.
 *
 * WHY metadata.json AND NOT capabilities/model-verification.json: the latter is
 * a MODEL-level record of which chat model answers (`ANSWERS` class only — 4 of
 * 22 at last measure), owned by `test/model-verification-consistent.test.ts`. It
 * is deliberately NARROWER than the site-level verdict: `youtube` and `araprat`
 * are verified capability surfaces with no chat model at all. Using it as the
 * site record would understate the verified set and manufacture three false
 * "record with no claim" findings, so the two records are not interchangeable
 * and this gate pins the site-level one.
 *
 * HONEST LIMIT — a named finding, not papered over: the round-trip EVIDENCE is
 * prose. `metadata.json` carries `since` + free-text `evidence` + `via`, and the
 * dated round-trips themselves live in `.brain/verbatim-goals.md` and the
 * package CAPABILITIES.md notes. Nothing machine-checkable records "this prompt
 * came back with this answer". `isCompleteVerifiedRecord` is therefore a
 * RECORD-SHAPE gate, not proof a round trip happened. What this file can
 * honestly guarantee is the narrower and still load-bearing statement:
 * **a published claim and a recorded receipt can never disagree, in either
 * direction.** Closing the prose gap needs a new record format (a measured
 * round-trip log per package) and is NOT done here — inventing one inside a
 * test file would be a worse lie than the honest limit.
 */

const README = readFileSync("capabilities/README.md", "utf8");

/** The load-bearing status cell of a row: a row reads as a round-trip claim
 *  when its status cell contains VERIFIED / live-verified / round-trip (in any
 *  case), the way a production consumer scanning the table would read it. */
export function rowClaimsRoundTrip(statusCell: string): boolean {
  const EXCLUDED = /never claimed verified|unverified-candidate|not verified|auth verified|auth-verified|no chat surface|dead-?end|dormant|scaffold/i;
  return /\bverified\b|\bround-?trip\b/i.test(statusCell) && !EXCLUDED.test(statusCell);
}

/** Every `| `id` | STATUS | … ` row -> { id, status }. */
export function parseStatusRows(doc: string): { id: string; status: string }[] {
  const out: { id: string; status: string }[] = [];
  for (const m of doc.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]*)\|/gm)) out.push({ id: m[1]!, status: m[2]! });
  return out;
}

/** The PUBLISHED half: ids the shipped table claims a live round-trip for. */
export function publishedRoundTripIds(doc: string): string[] {
  return [...new Set(parseStatusRows(doc).filter((r) => rowClaimsRoundTrip(r.status)).map((r) => r.id))].sort();
}

/** FORWARD direction — every published round-trip claim must be backed by a
 *  real `verified` machine record. Exported so the falsifier reuses it. */
export function roundTripGaps(doc: string): string[] {
  const gaps: string[] = [];
  for (const { id, status } of parseStatusRows(doc)) {
    if (!rowClaimsRoundTrip(status)) continue;
    const machine = chatSurfaceStatus(id);
    if (machine !== "verified") gaps.push(`\`${id}\` claims a live round-trip in the shipped table but the machine status is "${machine}" (no verified metadata record)`);
  }
  return gaps;
}

const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

/** The receipt a package's own metadata.json carries for a real round trip. */
export interface RoundTripRecord {
  since: string;
  evidence: string;
  via: string;
  scope?: string;
}

/** Read one package's own `metadata.json` receipt — no resolver involved. */
export function readRoundTripRecord(id: string): RoundTripRecord | null {
  const dir = findPackageDir(id);
  if (!dir) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8"));
  } catch {
    return null; // no metadata.json / unparseable -> scaffold, unverified
  }
  const v = (meta as { verified?: Record<string, unknown> } | null)?.verified;
  if (!v || typeof v !== "object") return null;
  const { since, evidence, via, scope } = v as Record<string, unknown>;
  if (!nonEmptyStr(since) || !nonEmptyStr(evidence) || !nonEmptyStr(via)) return null;
  return { since, evidence, via, scope: nonEmptyStr(scope) ? scope : undefined };
}

/** Injectable so a falsifier can present a record the filesystem does not have. */
export type RecordLookup = (id: string) => RoundTripRecord | null;

/** THE DERIVED UNIVERSE — every installed package UNION every id the shipped
 *  table lists, so a new site is inside the check on arrival and a table-only
 *  site cannot hide a record by being absent from `capabilities/`. */
export function derivedUniverse(doc: string = README): string[] {
  return [...new Set([...listInstalledPackageIds(), ...parseStatusRows(doc).map((r) => r.id)])].sort();
}

/** THE RECORDED half — ids whose own metadata.json carries a receipt. */
export function recordedRoundTripIds(universe: string[] = derivedUniverse(), lookup: RecordLookup = readRoundTripRecord): string[] {
  return universe.filter((id) => lookup(id) !== null).sort();
}

/** The RESOLVER's own answer, over the same universe. */
export function resolverVerifiedIds(universe: string[] = derivedUniverse()): string[] {
  return universe.filter((id) => chatSurfaceStatus(id) === "verified").sort();
}

/** REVERSE direction — a real record the shipped table does not publish. */
export function unPublishedGaps(doc: string, universe: string[] = derivedUniverse(doc), lookup: RecordLookup = readRoundTripRecord): string[] {
  const published = new Set(publishedRoundTripIds(doc));
  return recordedRoundTripIds(universe, lookup)
    .filter((id) => !published.has(id))
    .map((id) => `\`${id}\` has a real round-trip record in its metadata.json but the shipped table publishes no round-trip claim for it`);
}

/** BOTH directions as ONE check, naming whichever side diverged. */
export function statusTruthGaps(doc: string, universe: string[] = derivedUniverse(doc), lookup: RecordLookup = readRoundTripRecord): string[] {
  return [...roundTripGaps(doc), ...unPublishedGaps(doc, universe, lookup)];
}

/** Rewrite the status cell of EVERY row for `id` (a site can have >1 row). */
export function setStatusCell(doc: string, id: string, cell: string): string {
  return doc.replace(/^(\|\s*`([a-z0-9-]+)`\s*\|)[^|]*/gm, (whole, head: string, rowId: string) => (rowId === id ? `${head} ${cell} ` : whole));
}

// ─────────────────────────────────────────────────────────────────────────────

d("GOAL 92: the shipped site-status column cannot claim a round-trip the machine record does not support", () => {
  t("every round-trip-claiming row is backed by a real verified record", () => {
    // non-vacuity: the table must actually have round-trip rows to check.
    const rows = parseStatusRows(README);
    assert.ok(rows.length >= 20, `expected the inventory table to carry >=20 site rows, found ${rows.length}`);
    const claims = rows.filter((r) => rowClaimsRoundTrip(r.status));
    assert.ok(claims.length >= 1, "expected at least one round-trip-claiming row (the youtube/araprat-style rows) so the check is not vacuous");
    assert.deepEqual(roundTripGaps(README), [], "the shipped status column and the machine verified-record must agree");
  });

  t("the recorded round-trip set is DERIVED from metadata.json, not hand-typed", () => {
    const universe = derivedUniverse();
    assert.ok(universe.length >= 30, `expected the derived universe to carry >=30 site ids, found ${universe.length}`);
    const recorded = recordedRoundTripIds(universe);
    assert.ok(recorded.length >= 1, "expected at least one site whose metadata.json carries a round-trip receipt");
    // the receipt lives in that package's OWN file, so a record cannot be prose alone
    for (const id of recorded) {
      assert.ok(existsSync(resolve(findPackageDir(id)!, "metadata.json")), `\`${id}\` is recorded round-trip but carries no metadata.json`);
    }
  });

  t("REVERSE: every site with a round-trip record is published as one", () => {
    assert.deepEqual(unPublishedGaps(README), [], "a real round-trip record with no published claim is a silent downgrade");
  });

  t("BOTH DIRECTIONS: published claims and recorded round-trips are the same set", () => {
    const universe = derivedUniverse();
    const published = publishedRoundTripIds(README);
    const recorded = recordedRoundTripIds(universe);
    assert.deepEqual(
      statusTruthGaps(README, universe),
      [],
      `published round-trip claims must equal recorded round-trips.\n` +
        `  published (${published.length}): ${published.join(", ") || "(none)"}\n` +
        `  recorded  (${recorded.length}): ${recorded.join(", ") || "(none)"}\n` +
        `  claims with no record: ${published.filter((id) => !recorded.includes(id)).join(", ") || "(none)"}\n` +
        `  records with no claim: ${recorded.filter((id) => !published.includes(id)).join(", ") || "(none)"}`,
    );
    // stated as a set equality too, so the sides cannot differ in size while
    // both gap lists happen to be empty.
    assert.deepEqual(published, recorded, "the published claim set and the recorded receipt set must be identical");
  });

  t("the resolver's own verdict matches the record it claims to read", () => {
    const byResolver = resolverVerifiedIds();
    const byRecord = recordedRoundTripIds();
    assert.deepEqual(byResolver, byRecord, `chatSurfaceStatus() and the metadata.json receipts disagree.\n  resolver: ${byResolver.join(", ") || "(none)"}\n  record:   ${byRecord.join(", ") || "(none)"}`);
  });

  t("each recorded receipt is a real dated record, not a placeholder", () => {
    for (const id of recordedRoundTripIds()) {
      const rec = readRoundTripRecord(id)!;
      assert.match(rec.since, /^\d{4}-\d{2}-\d{2}$/, `\`${id}\` receipt.since is not an ISO date: ${JSON.stringify(rec.since)}`);
      assert.ok(rec.evidence.trim().length >= 40, `\`${id}\` receipt.evidence is too short to be a round-trip record`);
      assert.ok(rec.via.trim().length >= 10, `\`${id}\` receipt.via is too short to name how it was verified`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FALSIFIERS — a gate that cannot go RED is not a gate. Both directions are
// proven able to fail, against scratch inputs built from the SHIPPED table.
// ─────────────────────────────────────────────────────────────────────────────

d("negative (a) FORWARD: publishing a round-trip with NO record is RED", () => {
  t("a scratch row claiming a round-trip for a site with no receipt is reported", () => {
    assert.deepEqual(statusTruthGaps(README), [], "precondition: the real table is green in BOTH directions");
    // a LISTED site with no receipt — e.g. claude's "✅ grounded + runner"
    const unrecorded = derivedUniverse().find(
      (id) => readRoundTripRecord(id) === null && chatSurfaceStatus(id) !== "verified" && parseStatusRows(README).some((r) => r.id === id),
    );
    assert.ok(unrecorded, "precondition: some listed site has no receipt to falsify with");
    const scratch = setStatusCell(README, unrecorded, "✅ live-verified (pretend)");
    assert.ok(rowClaimsRoundTrip(parseStatusRows(scratch).find((r) => r.id === unrecorded)!.status), "precondition: the scratch row really claims a round-trip");
    assert.ok(roundTripGaps(scratch).some((g) => g.includes(`\`${unrecorded}\``)), `an unsupported round-trip claim must be reported, got ${JSON.stringify(roundTripGaps(scratch))}`);
  });
});

d("negative (b) REVERSE: a round-trip record the table does not publish is RED", () => {
  t("(b1) demoting a RECORDED site in a scratch table is caught by the record, not by a literal list", () => {
    assert.deepEqual(statusTruthGaps(README), [], "precondition: the real table is green");
    const dropped = recordedRoundTripIds()[0];
    assert.ok(dropped, "precondition: at least one recorded site to drop");
    const scratch = setStatusCell(README, dropped, "active (analysis only)");
    const rows = parseStatusRows(scratch).filter((r) => r.id === dropped);
    assert.ok(rows.length > 0 && rows.every((r) => !rowClaimsRoundTrip(r.status)), "precondition: no row for the dropped site still claims a round-trip");
    assert.ok(
      unPublishedGaps(scratch).some((g) => g.includes(`\`${dropped}\``)),
      `dropping the claim must be reported, got ${JSON.stringify(unPublishedGaps(scratch))}`,
    );
  });

  t("(b2) a site that JUST earned a record is caught even though no human typed its name", () => {
    // This is the hole the hand-typed 7 left open: a package that earns a real
    // receipt today moves the RECORDED set, and nothing in the old file looked
    // there. Simulated with a REAL installed package that currently has no
    // receipt (so the id is a live one) plus a lookup that hands it one.
    assert.deepEqual(statusTruthGaps(README), [], "precondition: the real table is green");
    const newcomer = derivedUniverse().find((id) => readRoundTripRecord(id) === null && parseStatusRows(README).some((r) => r.id === id));
    assert.ok(newcomer, "precondition: a listed installed package with no receipt");
    assert.ok(!recordedRoundTripIds().includes(newcomer), `precondition: \`${newcomer}\` has no receipt today`);
    const earned: RecordLookup = (id) => (id === newcomer ? { since: "2026-10-05", evidence: "falsifier: a freshly earned round-trip record", via: "falsifier lookup" } : readRoundTripRecord(id));
    const gaps = statusTruthGaps(README, derivedUniverse(), earned);
    assert.ok(
      gaps.some((g) => g.includes(`\`${newcomer}\``) && g.includes("no round-trip claim")),
      `a freshly earned record with no published claim must be reported, got ${JSON.stringify(gaps)}`,
    );
  });
});