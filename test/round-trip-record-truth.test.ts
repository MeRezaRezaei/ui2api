import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  chatSurfaceStatus,
  listInstalledPackageIds,
  findPackageDir,
  readRoundTripRecord,
  measuredRoundTripFor,
} from "../src/prompt/registry.js";
import { classifyOutcome, VERIFICATION_CLASSES, type VerificationClass } from "../src/prompt/verification-class.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE ROUND-TRIP RECORD-TRUTH GATE
//
// WHAT THIS IS NOT, stated first because the sibling gate is explicit about it:
// this does NOT prove any site answers. A hermetic "does it answer" test is not
// buildable here — CI has no vault session, no Chrome owner and no browser, and
// shipping one would fabricate the answer, the exact class
// test/no-fabricated-traffic.test.ts exists to forbid. So this gate proves
// something narrower and still load-bearing:
//
//   A PUBLISHED `verified` claim and a MEASURED round trip can never disagree.
//
// THE DEFECT THIS KILLS. `capabilities/model-verification.json` looked like the
// machine-derivable round-trip record and was not one. Measured before this
// gate: nothing in the repo writes it (`scripts/audit/measure-models.mjs:101`
// only `console.log`s its result, and its `source.harness` names a `/tmp`
// script), its decisive field is PROSE (`evidence` quotes the answer), and its
// two ANSWERS rows carry no `answerText` field at all even though the reader
// prefers `r.answerText` (test/model-verification-consistent.test.ts:255) and
// falls back to a regex over that prose. So all 22 rows were hand-transcribed,
// and a `verified` claim in capabilities/README.md rested on nothing a machine
// can check. `test/site-status-truth.test.ts` already named this as its own
// HONEST LIMIT (its header, lines 53-75: "the round-trip EVIDENCE is prose…
// isCompleteVerifiedRecord is therefore a RECORD-SHAPE gate, not proof a round
// trip happened"). This file is that named limit, closed.
//
// THE THREE SETS, and they are three DIFFERENT claims:
//   CLAIMED   — the package's own capabilities/<id>/metadata.json carries a
//               complete verified receipt (verified.since/evidence/via non-empty).
//   PUBLISHED — capabilities/README.md's status cell claims a live round trip.
//   MEASURED  — capabilities/roundtrip.json carries a row that is genuinely
//               measured: provenance=harness AND probeNonceMatched=true AND
//               class=ANSWERS AND a 2xx AND answerChars>0 AND doneReason=stable
//               AND measuredAt inside the staleness window.
//
// WHY THE UNIVERSE IS DERIVED (installed packages ∪ README rows) and never a
// literal: a hand-typed list in a test file is a snapshot, and a snapshot rots
// the moment a gate tightens — the "11 builtins vs 10 surfaced" error, made and
// fixed repeatedly in AGENTS.md. A new package is inside this check on arrival.
//
// WHY THIS GATE IS EXPECTED TO BE RED, stated up front so a red run is not read
// as a bug in the gate: as shipped, 7 packages hold a receipt and publish the
// claim, and 0 of them have a MEASURED row — because measuring them requires a
// live daemon with a real vault session and a Chrome owner, which no agent and
// no CI can supply. The gap is named per-site in `knownGaps` in the record, and
// the gate asserts that named set equals the gap it derives. So the RED is the
// finding, not a relaxed predicate: the alternative — weakening the predicate
// until it passes — would recreate exactly the defect this file exists to kill.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const RECORD_PATH = resolve(ROOT, "capabilities/roundtrip.json");
const README_PATH = resolve(ROOT, "capabilities/README.md");

const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;

// ── the record ──────────────────────────────────────────────────────────────
const record = readRoundTripRecord();
const raw = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as Record<string, unknown>;
const rows = (Array.isArray(raw.rows) ? raw.rows : []) as Record<string, unknown>[];
const windowDays = record.stalenessWindowDays;

// ── the other two sources ───────────────────────────────────────────────────
function parseStatusRows(doc: string): { id: string; status: string }[] {
  const out: { id: string; status: string }[] = [];
  for (const m of doc.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]*)\|/gm)) out.push({ id: m[1]!, status: m[2]! });
  return out;
}
const readme = readFileSync(README_PATH, "utf8");

/** A README status cell reads as a round-trip claim the way a consumer scanning
 *  the table reads it. Reuses the sibling gate's own predicate via its exported
 *  helpers is NOT possible (it is a test file), so this mirrors it exactly —
 *  and the mirror is itself checked below against chatSurfaceStatus. */
const CLAIM_RE = /\bverified\b|\bround-?trip\b/i;
const CLAIM_EXCLUDE = /never claimed verified|unverified-candidate|not verified|auth verified|auth-verified|no chat surface|dead-?end|dormant|scaffold/i;
const publishedRoundTripIds = (): string[] =>
  [...new Set(parseStatusRows(readme).filter((r) => CLAIM_RE.test(r.status) && !CLAIM_EXCLUDE.test(r.status)).map((r) => r.id))].sort();

/** The receipt predicate, applied INDEPENDENTLY to each package's own file, so
 *  the resolver in src/prompt/registry.ts is cross-checked rather than trusted. */
function hasCompleteReceipt(id: string): boolean {
  const dir = findPackageDir(id);
  if (!dir) return false;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const v = meta.verified as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return false;
  return nonEmptyStr(v.since) && nonEmptyStr(v.evidence) && nonEmptyStr(v.via);
}

const universe = (): string[] =>
  [...new Set([...listInstalledPackageIds(), ...parseStatusRows(readme).map((r) => r.id)])].sort();

const claimedIds = (): string[] => universe().filter(hasCompleteReceipt).sort();
const publishedIds = (): string[] => publishedRoundTripIds();

/** MEASURED — the same predicate the READ SEAM uses (registry.ts
 *  `measuredRoundTripFor`), called over the derived universe. Derived from the
 *  reader rather than re-implemented, so the gate and the resolver cannot
 *  disagree about what counts as measured. */
const measuredIds = (): string[] => universe().filter((id) => measuredRoundTripFor(id).measured).sort();

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE THREE-WAY SET EQUALITY
// ─────────────────────────────────────────────────────────────────────────────

/** A readable, one-line-per-site report of all three sides, so a red run names
 *  the divergence instead of just saying the sets differ.
 *
 *  THE FOURTH READING, and why the MEASURED cell is not a yes/no. `measuredRoundTripFor`
 *  distinguishes THREE states, because a refused measurement is not evidence of
 *  absence: a site whose freshest row is an honest NAMED FAILURE was asked and
 *  did not work, which is a different fact from never having been asked, and a
 *  report that printed both as `MEASURED no` would be the understatement this
 *  lane exists to remove. MEASURED, before this gate could say it: `kimi` and
 *  `tencent-aistudio` carried `UNATTRIBUTED-NO-ANSWER` rows and `deepseek` an
 *  `UNATTRIBUTED-NO-COMPOSER` one, and every one of them printed as plain
 *  `MEASURED no` — indistinguishable from a site with no row at all. */
function threeWayReport(): string[] {
  const claimed = new Set(claimedIds());
  const published = new Set(publishedIds());
  const measured = new Set(measuredIds());
  return universe()
    .filter((id) => claimed.has(id) || published.has(id) || measured.has(id))
    .map((id) => {
      const verdict = measuredRoundTripFor(id);
      const measuredCell = verdict.measured
        ? "yes"
        : verdict.contradicted
          ? `no — CONTRADICTED by ${String(verdict.failureClass)}`
          : "no ";
      const sides = [
        `CLAIMED ${claimed.has(id) ? "yes" : "no "}`,
        `PUBLISHED ${published.has(id) ? "yes" : "no "}`,
        `MEASURED ${measuredCell}`,
      ].join(" | ");
      return `  ${id.padEnd(20)} ${sides}`;
    });
}

test("THREE-WAY: every published round-trip claim is backed by a MEASURED row, and every measured row backs a published claim", () => {
  const gaps: string[] = [];
  const unbackedClaims = claimedIds().filter((id) => !measuredIds().includes(id));
  for (const id of unbackedClaims) {
    const v = measuredRoundTripFor(id);
    // THE REMEDY IS NOT THE SAME for the two negatives, and printing one remedy
    // for both is how a measured failure gets "fixed" by re-running the same
    // measurement forever.
    const remedy = v.contradicted
      ? `A round trip WAS measured for \`${id}\` and it FAILED (${String(v.failureClass)}), which CONTRADICTS the published claim rather than qualifying it — ` +
        `re-measure only after the named condition is addressed; re-running the same probe reproduces the same honest failure.`
      : `Close it by running \`node scripts/audit/record-roundtrip.mjs --site ${id} --capability chat\` against a live daemon — never by editing the record by hand.`;
    gaps.push(
      `\`${id}\` holds a complete verified receipt AND publishes a live round-trip claim in capabilities/README.md, ` +
        `but capabilities/roundtrip.json carries no MEASURED row: ${v.reason}. ${remedy}`,
    );
  }
  assert.deepEqual(
    gaps,
    [],
    `claims with no measured round trip (${unbackedClaims.length} of ${claimedIds().length} claimed):\n` +
      threeWayReport().join("\n") +
      `\n\nEach gap above is a REAL, currently-published claim the record cannot back.`,
  );
});

test("THREE-WAY: a site whose round trip was MEASURED and FAILED is never published as verified", () => {
  // THE TEETH OF THE DISTINCTION. A contradicted site must not reach a consumer
  // as `verified`: `packageStatusOf` mints `unverified-candidate` for both
  // negatives, and this asserts that for the negative that HAS a row — so a
  // reader of `/registry` cannot be told a surface works when the freshest
  // measurement of it says it did not.
  const contradicted = universe()
    .map((id) => ({ id, v: measuredRoundTripFor(id) }))
    .filter((x) => x.v.contradicted)
    .map((x) => x.id)
    .sort();
  if (contradicted.length === 0) {
    // Not a pass by default: a record where nothing has ever failed cannot
    // exercise this assertion, so say so rather than let a green run imply the
    // branch was checked.
    assert.ok(
      rows.length > 0,
      "capabilities/roundtrip.json carries no rows at all — the contradicted branch below is unexercised, so a green run here would prove nothing about it",
    );
    return;
  }
  const publishedVerified = contradicted.filter((id) => chatSurfaceStatus(id) === "verified");
  assert.deepEqual(
    publishedVerified,
    [],
    `these sites were MEASURED and the measurement FAILED, yet the resolver still publishes them as verified:\n  ${contradicted.join(", ")}\n${threeWayReport().join("\n")}`,
  );
});

test("THREE-WAY: a MEASURED row never exists for a site with no published claim (the record may not promote)", () => {
  const orphans = measuredIds().filter((id) => !publishedIds().includes(id) || !claimedIds().includes(id));
  assert.deepEqual(
    orphans,
    [],
    `a measurement exists for ${orphans.join(", ")} but no receipt/published claim does — a measurement may only ever DEMOTE, never PROMOTE:\n` +
      threeWayReport().join("\n"),
  );
});

test("THREE-WAY: the gap this gate derives is exactly the gap the record NAMES (both directions)", () => {
  const declared = ((raw.knownGaps as { sites?: unknown } | undefined)?.sites ?? []) as unknown;
  assert.ok(Array.isArray(declared), "capabilities/roundtrip.json must carry a `knownGaps.sites` array naming every unmeasured published claim");
  const named = (declared as string[]).slice().sort();
  const derived = claimedIds().filter((id) => !measuredIds().includes(id)).sort();
  assert.deepEqual(
    named,
    derived,
    `the record's named gaps and the gap the gate derives must be the same set, so a gap APPEARING and a gap being ` +
      `quietly CLOSED are both build failures:\n  named:   [${named.join(", ")}]\n  derived: [${derived.join(", ")}]`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CLASS RE-DERIVATION — the anti-hand-typing core
// ─────────────────────────────────────────────────────────────────────────────

/** Re-derive a row's class from its OWN machine fields, through the shipped
 *  classifier. The nonce gate is what stops a hand-typed ANSWERS from buying a
 *  `verified` status: a row that claims ANSWERS while its own fields cannot
 *  produce ANSWERS is caught HERE, by re-derivation — not by a name check,
 *  which a determined editor could satisfy by also renaming the fields.
 *
 *  THE CAPABILITY FACTS ARE FED TOO, and that is not optional bookkeeping. The
 *  first version of this re-derivation passed only the chat fields, because the
 *  chat fields were all the vocabulary could use — so when `RETURNS-DATA` landed
 *  (a capability surface that returned real data over the wire), every capability
 *  row would have re-derived UNCLASSIFIED no matter what it claimed, and the
 *  gate would have failed every true measurement while a hand-typed class on the
 *  same fields would have passed the OTHER assertions. A re-derivation that
 *  cannot see the decisive fields is not a re-derivation of that class. */
function rederive(row: Record<string, unknown>): string {
  const nonceOk = row.probeNonceMatched === true;
  const answerText = nonceOk ? "x".repeat(Number(row.answerChars) || 1) : "";
  const pool = row.poolAtRequest as { busy?: unknown; total?: unknown; queued?: unknown } | undefined;
  return classifyOutcome({
    httpStatus: typeof row.httpStatus === "number" ? row.httpStatus : 0,
    message: typeof row.evidence === "string" ? row.evidence : "",
    answerText,
    noResponse: row.httpStatus === 0,
    poolAtRequest: pool ? { busy: pool.busy, total: pool.total, queued: pool.queued } : undefined,
    page: (row.observedPage ?? undefined) as never,
    capabilityOk: row.capabilityOk,
    resultShape: (row.resultShape ?? null) as never,
  }).cls;
}

test("CLASS: every row's class is what classifyOutcome re-derives from that row's OWN machine fields", () => {
  const wrong = rows
    .filter((r) => r.provenance === "harness")
    .filter((r) => rederive(r) !== r.class)
    .map((r) => `\`${String(r.site)}\`: row claims class ${String(r.class)} but its own fields re-derive ${rederive(r)} — a class that disagrees with the measurement is the defect this gate exists to catch`);
  assert.deepEqual(wrong, [], `hand-typed classes:\n${wrong.join("\n")}`);
});

test("CLASS: a row may not claim ANSWERS unless its nonce matched, it was 2xx, it carried answer text, and it stabilised", () => {
  const lying = rows
    .filter((r) => r.class === "ANSWERS")
    .filter((r) => {
      const st = typeof r.httpStatus === "number" ? r.httpStatus : 0;
      const chars = typeof r.answerChars === "number" ? r.answerChars : 0;
      return !(r.probeNonceMatched === true && st >= 200 && st < 300 && chars > 0 && r.doneReason === "stable");
    })
    .map((r) => `\`${String(r.site)}\` claims ANSWERS but probeNonceMatched=${String(r.probeNonceMatched)}, httpStatus=${String(r.httpStatus)}, answerChars=${String(r.answerChars)}, doneReason=${String(r.doneReason)} — ANSWERS requires a MATCHED per-measurement nonce (the anti-stale-echo core), a 2xx, real answer text and a stable read`);
  assert.deepEqual(lying, [], `ANSWERS claimed without the fields that produce it:\n${lying.join("\n")}`);
});

// ── the CAPABILITY-SURFACE class ─────────────────────────────────────────────
//
// THE DEFECT THIS KILLS, restated because it is the whole lane: every member of
// the verification vocabulary keyed on a CHAT answer, so `araprat_search`
// answering HTTP 200 `ok:true` with 29 real rows derived UNCLASSIFIED — not a
// class — and the write seam refuses to write an UNCLASSIFIED row at all. So NO
// capability surface could ever be recorded as MEASURED and the three-way gate
// below was red on every capability-only package no matter how many times the
// harness ran. A vocabulary that cannot express the thing it is asked to check.

test("ANTI-VACUITY: the shipped record actually EXERCISES the capability class — the vocabulary is not unexercised", () => {
  const capabilityRows = rows.filter((r) => r.capability !== "chat" && r.provenance === "harness");
  const returnsData = capabilityRows.filter((r) => r.class === "RETURNS-DATA");
  assert.ok(
    capabilityRows.length > 0,
    "capabilities/roundtrip.json carries no capability-surface row at all — the capability write path is " +
      "never exercised in the shipped record, so RETURNS-DATA would be a class nothing can ever reach (the " +
      "same 'a gate that cannot fire' defect, one level down from the one this class closes)",
  );
  assert.ok(
    returnsData.length > 0,
    `capability rows exist (${capabilityRows.map((r) => `${String(r.site)}/${String(r.capability)}=${String(r.class)}`).join(", ")}) ` +
      `but NONE derives RETURNS-DATA — so no capability surface can be recorded as MEASURED. Measure one with ` +
      `\`node --import tsx scripts/audit/record-roundtrip.mjs --site <id> --capability <cap> --args '<json>'\` against a live daemon.`,
  );
});

test("CLASS: a capability row claiming RETURNS-DATA must have the fields that produce it (the hand-typing case)", () => {
  // A row with the DECLARED half of the evidence only, the COUNTED half absent.
  const declaredOnly = rederive({
    class: "RETURNS-DATA",
    httpStatus: 200,
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "ok", "data"], rowsPath: "data.results", count: 12, rows: null },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "class derived by classifyOutcome()",
  });
  assert.notEqual(
    declaredOnly,
    "RETURNS-DATA",
    `a runner's DECLARED count alone derived RETURNS-DATA — the class must require the counted rows to agree with it, got ${declaredOnly}`,
  );

  // The two halves DISAGREEING: a runner claiming 12 over 0 records.
  const disagreeing = rederive({
    class: "RETURNS-DATA",
    httpStatus: 200,
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "ok", "data"], rowsPath: "data.results", count: 12, rows: 0 },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "class derived by classifyOutcome()",
  });
  assert.notEqual(disagreeing, "RETURNS-DATA", `a self-contradicting result derived RETURNS-DATA (${disagreeing})`);
});

test("CLASS: an EMPTY capability result is a measurement of NOTHING and must not derive the data-returned class", () => {
  // MEASURED against the live daemon: `duckduckgo_chat_history` answers HTTP 200
  // `ok:true` with `{count: 0, chats: []}` for a session with no history — a real
  // round trip that returned no records.
  const empty = rederive({
    class: "RETURNS-DATA",
    httpStatus: 200,
    capabilityOk: true,
    resultShape: { topLevelKeys: ["capability", "ok", "data"], rowsPath: "data.chats", count: 0, rows: 0 },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "class derived by classifyOutcome()",
  });
  assert.notEqual(empty, "RETURNS-DATA", `an empty result set derived the data-returned class (${empty})`);
  assert.equal(
    empty,
    "UNCLASSIFIED",
    `an empty result set should land on the classifier's refusal so the write seam REPORTS it and writes nothing — a class that admitted it would let the gate be satisfied by a surface that returns nothing forever. Got ${empty}`,
  );
});

test("CLASS: a capability REFUSAL (ok:false with a named reason) must not derive the data-returned class", () => {
  // The login-gated shape, measured in src/capabilities/gated.ts:38
  // (`loginGatedResult`) — `{ok:false, loginGated:true, error:"login-required: …"}`.
  const refused = rederive({
    class: "RETURNS-DATA",
    httpStatus: 502,
    capabilityOk: false,
    resultShape: { topLevelKeys: ["capability", "ok", "error", "loginGated"], rowsPath: null, count: null, rows: null },
    poolAtRequest: { busy: 0, total: 2, queued: 0 },
    evidence: "POST /capability/araprat -> HTTP 502 login-required: araprat_comment needs an authorized captured araprat session",
  });
  assert.notEqual(refused, "RETURNS-DATA", `a login-gated refusal derived the data-returned class (${refused})`);

  // …and it must not be the classifier's silent fallback either: a refusal that
  // reached the wire is a MEASUREMENT, so it lands in the vocabulary or it is
  // reported as a finding — never filed as a success.
  assert.notEqual(refused, "ANSWERS", "a refusal is not an answer");
  assert.notEqual(refused, "UNMEASURED", "UNMEASURED means never reached; this response WAS reached");
});

test("CLASS: the shipped capability rows re-derive from their OWN fields, and the read seam agrees", () => {
  for (const r of rows.filter((x) => x.provenance === "harness")) {
    assert.equal(rederive(r), r.class, `\`${String(r.site)}/${String(r.capability)}\` claims ${String(r.class)} and its own fields re-derive something else`);
  }
  for (const r of rows.filter((x) => x.class === "RETURNS-DATA")) {
    const site = String(r.site);
    assert.equal(
      measuredRoundTripFor(site).measured,
      true,
      `\`${site}\` carries a RETURNS-DATA row the classifier derived, but the read seam does not count it: ${measuredRoundTripFor(site).reason}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. AN UNMEASURED ROW MUST BE IDENTIFIABLE AS UNMEASURED
// ─────────────────────────────────────────────────────────────────────────────

test("PROVENANCE: every imported row says so, carries no nonce, and backs nothing", () => {
  const offenders = rows
    .filter((r) => r.provenance === "imported")
    .filter((r) => r.probeNonceMatched !== null || r.method !== "imported-from-prose" || measuredIds().includes(String(r.site)))
    .map((r) => `\`${String(r.site)}\` is provenance=imported but ${r.probeNonceMatched !== null ? "carries a nonce value" : "carries no nonce marker"} / method=${String(r.method)} — an imported row must be identifiable as unmeasured and must never count as MEASURED`);
  assert.deepEqual(offenders, [], `imported rows:\n${offenders.join("\n")}`);
});

test("PROVENANCE: no row is `imported` while carrying fields only a real probe could produce", () => {
  const impossible = rows
    .filter((r) => r.provenance === "imported")
    .filter((r) => r.probeNonceMatched !== null || r.doneReason !== null || r.elapsedMs !== null)
    .map((r) => `\`${String(r.site)}\`: an imported row cannot have probeNonceMatched=${String(r.probeNonceMatched)}, doneReason=${String(r.doneReason)}, elapsedMs=${String(r.elapsedMs)} — those come from a live probe, and inventing them is fabricating a measurement`);
  assert.deepEqual(impossible, [], `imported rows claiming probe-derived fields:\n${impossible.join("\n")}`);
});

test("PROVENANCE: a capability-surface row records resultShape, and never borrows the chat nonce rule", () => {
  const offenders = rows
    .filter((r) => r.capability !== "chat")
    .filter((r) => r.probeNonceMatched !== null)
    .map((r) => `\`${String(r.site)}/${String(r.capability)}\` is a capability surface but carries probeNonceMatched=${String(r.probeNonceMatched)} — a capability returns JSON, so a nonce proves nothing there and the row must record resultShape instead`);
  assert.deepEqual(offenders, [], `capability rows borrowing the chat nonce rule:\n${offenders.join("\n")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. STALENESS — a month-old measurement is not evidence about today
// ─────────────────────────────────────────────────────────────────────────────

test("STALENESS: every MEASURED row is inside the window the record declares", () => {
  const stale = rows
    .filter((r) => measuredIds().includes(String(r.site)))
    .filter((r) => {
      const age = (Date.now() - Date.parse(String(r.measuredAt))) / 86_400_000;
      return !(age >= 0 && age <= windowDays);
    })
    .map((r) => `\`${String(r.site)}\` measured ${String(r.measuredAt)} is outside the ${windowDays}-day window`);
  assert.deepEqual(stale, [], `stale measurements still counted:\n${stale.join("\n")}`);
});

test("STALENESS: every measured row names the daemon commit it was taken against", () => {
  const missing = rows
    .filter((r) => r.provenance === "harness" && r.probeNonceMatched === true)
    .filter((r) => !nonEmptyStr(r.daemonCommit))
    .map((r) => `\`${String(r.site)}\` has no daemonCommit — CI can never re-measure this (no session, no Chrome owner), so the build the row came from is the only provenance a reader will ever have`);
  assert.deepEqual(missing, [], `measured rows without a commit:\n${missing.join("\n")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE READ SEAM HONOURS THE MEASUREMENT
// ─────────────────────────────────────────────────────────────────────────────

test("READ SEAM: a site with a receipt but no MEASURED row is not published `verified`", () => {
  const overclaimed = claimedIds().filter((id) => !measuredIds().includes(id) && chatSurfaceStatus(id) === "verified");
  assert.deepEqual(
    overclaimed,
    [],
    `these sites publish \`verified\` on a receipt alone, with no measured round trip backing them:\n${threeWayReport().join("\n")}`,
  );
});

test("READ SEAM: the resolver's verdict for a site matches the gate's independent derivation", () => {
  const drift = universe()
    .filter((id) => {
      const resolverSaysVerified = chatSurfaceStatus(id) === "verified";
      return resolverSaysVerified !== measuredIds().includes(id);
    })
    .map((id) => `\`${id}\`: resolver says ${chatSurfaceStatus(id)}, gate derives ${measuredIds().includes(id) ? "verified" : "not verified"}`);
  assert.deepEqual(drift, [], `resolver vs gate:\n${drift.join("\n")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE RECORD'S OWN SHAPE + THE PRIVACY PROPERTY THAT MAKES IT PUBLISHABLE
// ─────────────────────────────────────────────────────────────────────────────

test("RECORD: the file declares its schema, and the reader agrees it is readable", () => {
  assert.equal(raw.schema, "ui2api/roundtrip/1", "capabilities/roundtrip.json must declare schema ui2api/roundtrip/1");
  assert.equal(record.refusal, null, `the record must be readable by the seam: ${record.refusal}`);
});

test("RECORD: no class outside the shipped vocabulary (a typo in a class is a lie)", () => {
  const unknown = rows.filter((r) => !VERIFICATION_CLASSES.includes(String(r.class) as VerificationClass));
  assert.deepEqual(
    unknown.map((r) => `${String(r.site)}: ${String(r.class)}`),
    [],
    `classes outside VERIFICATION_CLASSES`,
  );
});

test("PRIVACY: the published record carries no prompt text, no answer text, no account, and no cookie", () => {
  const offenders: string[] = [];
  for (const row of rows) {
    const text = JSON.stringify(row);
    for (const [field, value] of Object.entries(row)) {
      if (["answerText", "prompt", "account", "identity", "cookie", "cookies", "vaultPath", "snapshot"].includes(field)) {
        offenders.push(`\`${String(row.site)}\` carries a ${field} field`);
      }
    }
    // The record is published in the sanitized mirror, so it must not quote a
    // served answer either — only its length and a truncated digest.
    //
    // CHECKED BY SHAPE, NOT BY PHRASING, and that correction is load-bearing.
    // The first version of this test looked for the literal `answer text '...'`
    // and PASSED a record that still carried a second quote of the same answer in
    // the same sentence ("the SAME real answer '...'") — the exact text the file
    // promises not to publish. A phrasing check only catches the phrasing you
    // thought of, so this one looks for ANY quoted span inside a prose field.
    for (const proseField of ["evidence", "prereq", "notes"]) {
      const prose = row[proseField];
      if (typeof prose !== "string") continue;
      // A single-quoted span of 4+ chars inside prose is a quote of something
      // the service returned. The vocabulary literals that legitimately appear
      // ('harness', 'ANSWERS', 'imported') live in non-prose fields and are
      // checked by the class test above.
      //
      // AND THE APOSTROPHE IS NOT A QUOTE MARK, which this pattern only learned
      // by being WRONG first. The classifier's reason prose says "the runner's
      // own verdict" and "the runner's declared count", and the naive pattern
      // paired the two apostrophes into a 200-character "quote" and reported two
      // PRIVACY violations on two rows that carry no quoted service output at
      // all. A quoted span opens after a space or a bracket, never immediately
      // after a word character — so both boundaries are asserted, and a genuine
      // quote (which is what this gate exists to catch) still matches. Fixing it
      // the other way — deleting the check because it fired — would have left
      // the load-bearing property unguarded for the wrong reason.
      for (const m of prose.matchAll(/(?<![A-Za-z0-9_])'([^']{4,})'(?![A-Za-z0-9_])/g)) {
        offenders.push(`\`${String(row.site)}\` quotes ${m[0]} in its ${proseField} prose`);
      }
      if (/\bPONG-[0-9a-f]{8,}/i.test(prose)) offenders.push(`\`${String(row.site)}\` carries a literal probe nonce in ${proseField}`);
    }
    if (/"probe"\s*:\s*"PONG-/i.test(text)) offenders.push(`\`${String(row.site)}\` carries a literal probe nonce`);
  }
  assert.deepEqual(
    offenders,
    [],
    `the privacy property is load-bearing (.brain/ is stripped by scripts/ci/make-public-repo.sh:471 and data/ at :562, so a measurement kept only there is unreviewable):\n${offenders.join("\n")}`,
  );
});

test("WRITE SEAM: only the harness writes the record, and the service under measurement never certifies itself", () => {
  const src = readFileSync(resolve(ROOT, "src/prompt/http.ts"), "utf8");
  assert.ok(
    !/roundtrip\.json/.test(src),
    "src/prompt/http.ts must never write capabilities/roundtrip.json — a read-only service that certifies itself is not certified",
  );
  const harness = readFileSync(resolve(ROOT, "scripts/audit/record-roundtrip.mjs"), "utf8");
  assert.match(harness, /v1\/chat\/completions/, "the harness must measure over the daemon's own wire, never fabricate site traffic");
});