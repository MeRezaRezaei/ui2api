import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defaultChatSurface } from "../src/prompt/registry.js";
import {
  CLASS_PRECONDITIONS,
  VERIFICATION_CLASSES,
  classifyOutcome,
  classPrecondition,
  unmeasuredAfterMeasuredResponse,
  type ObservedPage,
  type VerificationClass,
} from "../src/prompt/verification-class.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL-VERIFICATION CONSISTENCY GATE
//
// WHAT THIS IS NOT, stated first because the audit is explicit about it: this
// gate does NOT prove any model ANSWERS. A hermetic "does it answer" test is
// not buildable here (audit §6: no fake-browser harness, every existing
// "answer" is a hardcoded stub, and a real daemon is started with the browser
// deliberately unreachable) and shipping one would fabricate the answer — the
// exact class test/no-fabricated-traffic.test.ts exists to forbid.
//
// WHAT IT DOES PROVE: the dated, checked-in RECORD
// (capabilities/model-verification.json) is honest and in sync with what the
// service actually advertises. It converts a prose claim ("proof PASS 13965",
// which no code parses) into a machine-checked, named, shrinking number.
//
// The defect it kills is Cause D of scripts/audit/model-answers-audit.md:
// `packageStatusOf` (src/prompt/registry.ts) stamps status "verified" from the
// SHAPE of a metadata.json `verified` object, never from a measurement, and
// nothing downgrades a model after an ok:false — so a site that breaks
// tomorrow still advertises "verified" forever.
//
// The advertised set is DERIVED, never hand-typed. A hardcoded list of ids is a
// snapshot and a snapshot in this file would rot the moment a gate tightened;
// that mistake (11 builtins vs 10 surfaced) was made and fixed repeatedly in
// AGENTS.md. The gate calls the same `defaultChatSurface()` the daemon calls.
// ─────────────────────────────────────────────────────────────────────────────

const RECORD_PATH = resolve(process.cwd(), "capabilities/model-verification.json");

/** The closed set. A class outside this set is a typo, and a typo is a lie.
 *  The set is NOT typed here: it is exported by src/prompt/verification-class.ts,
 *  the module that OWNS the classification rule, so the vocabulary and the rule
 *  that fills it cannot drift apart. Before GOAL 158 this was a local literal of
 *  four names, and the rule lived in a throwaway driver in /tmp — so a measured,
 *  per-model condition with its own remedy had nowhere to go and 7 rows were
 *  filed under the meaningless UNMEASURED. */
const CLASSES = VERIFICATION_CLASSES;
type Class = VerificationClass;

/** Classes that assert something about the MODEL, so they must carry proof.
 *  UNMEASURED is the only class whose whole meaning is "we do not know" — and
 *  RULE 9 is what keeps that claim true rather than rhetorical. */
const MEASURED_CLASSES: Class[] = [
  "ANSWERS",
  "SIGN-OUT",
  "CONTENDED-TIMEOUT",
  "WALL-CHALLENGE",
  "COMPOSER-DRIFT",
];

/** A claim with nothing behind it. The single most important rule here. */
const EVIDENCE_MIN_CHARS = 24;

interface ModelRecord {
  model?: unknown;
  measuredAt?: unknown;
  class?: unknown;
  evidence?: unknown;
  method?: unknown;
  prereq?: unknown;
  daemonCommit?: unknown;
  poolAtRequest?: unknown;
  observedPage?: unknown;
  httpStatus?: unknown;
}

interface RecordFile {
  schema?: unknown;
  stalenessWindowDays?: unknown;
  records?: ModelRecord[];
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

// ── the gate's own predicates, exported so the MUTATION proof can feed them ──

/** Advertised ids with NO record. */
export function missingRecords(advertised: string[], records: ModelRecord[]): string[] {
  const have = new Set(records.map((r) => (nonEmptyString(r.model) ? r.model : "")));
  return advertised.filter((id) => !have.has(id)).sort();
}

/** Records naming a model that is no longer advertised (a stale record). */
export function staleRecords(advertised: string[], records: ModelRecord[]): string[] {
  const live = new Set(advertised);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    const m = nonEmptyString(r.model) ? r.model : "<no model field>";
    if (live.has(m)) continue;
    if (seen.has(m)) continue; // one name is enough; duplicates are their own rule
    seen.add(m);
    out.push(m);
  }
  return out.sort();
}

/** A non-UNMEASURED class missing measuredAt / method / evidence. */
export function unprovenMeasurements(records: ModelRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (!nonEmptyString(r.class) || r.class === "UNMEASURED") continue;
    const model = nonEmptyString(r.model) ? r.model : "<no model field>";
    for (const field of ["measuredAt", "method", "evidence"] as const) {
      if (!nonEmptyString(r[field])) out.push(`${model}: missing ${field}`);
    }
  }
  return out.sort();
}

/** A record claiming a class outside the closed set. */
export function unknownClasses(records: ModelRecord[]): string[] {
  return records
    .filter((r) => !nonEmptyString(r.class) || !(CLASSES as readonly string[]).includes(r.class))
    .map((r) => `${nonEmptyString(r.model) ? r.model : "<no model field>"}: class=${JSON.stringify(r.class)}`)
    .sort();
}

/** A duplicate model entry — two records for one id means one of them is fiction. */
export function duplicateModels(records: ModelRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of records) if (nonEmptyString(r.model)) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([m, n]) => `${m} x${n}`).sort();
}

/** ANSWERS without real evidence behind it. */
export function evidenceFreeClaims(records: ModelRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.class !== "ANSWERS") continue;
    const model = nonEmptyString(r.model) ? r.model : "<no model field>";
    if (!nonEmptyString(r.evidence)) {
      out.push(`${model}: ANSWERS with NO evidence`);
      continue;
    }
    if (r.evidence.trim().length < EVIDENCE_MIN_CHARS) {
      out.push(`${model}: ANSWERS with a ${r.evidence.trim().length}-char evidence string`);
      continue;
    }
    // An ANSWERS claim must name a real measured outcome. A record that says
    // "it answers" without an HTTP status and a duration is a prose claim in
    // JSON clothing — precisely the defect Cause D describes.
    const ev = r.evidence;
    if (!/\b(200|2\d\d)\b/.test(ev)) out.push(`${model}: ANSWERS evidence names no HTTP 2xx`);
    else if (!/\d+\s*ms\b/.test(ev)) out.push(`${model}: ANSWERS evidence names no measured duration`);
  }
  return out.sort();
}

/** A CONTENDED-TIMEOUT with no pool state — the claim that distinguishes
 *  "the queue was busy" from "the model is broken" is exactly what goes. */
export function contentionWithoutPoolState(records: ModelRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.class !== "CONTENDED-TIMEOUT") continue;
    const model = nonEmptyString(r.model) ? r.model : "<no model field>";
    const p = r.poolAtRequest as { busy?: unknown; total?: unknown } | undefined;
    if (!p || typeof p.busy !== "number" || typeof p.total !== "number") {
      out.push(`${model}: CONTENDED-TIMEOUT without poolAtRequest {busy,total}`);
    } else if (p.busy <= 0) {
      out.push(`${model}: CONTENDED-TIMEOUT at an IDLE pool (busy=${p.busy}) — that is not contention`);
    }
  }
  return out.sort();
}

/** RULE 5 generalised over the closed set: each class declares its own
 *  machine-checkable precondition in the classification module, so a new class
 *  cannot land without stating what a record must carry for the claim to mean
 *  anything. This is what stops a new class from becoming a free-text escape
 *  hatch — it would have to declare a precondition, and the gate enforces it. */
export function preconditionViolations(records: ModelRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (!nonEmptyString(r.class) || !(CLASSES as readonly string[]).includes(r.class)) continue;
    const pre = classPrecondition(r.class as VerificationClass);
    const model = nonEmptyString(r.model) ? r.model : "<no model field>";
    for (const field of pre.requiredFields) {
      const v = r[field as keyof ModelRecord];
      if (field === "observedPage") {
        const p = v as ObservedPage | undefined;
        if (!p || !nonEmptyString(p.title) || !nonEmptyString(p.url)) out.push(`${model}: ${r.class} missing observedPage{title,url} the server reported`);
        continue;
      }
      if (!nonEmptyString(v)) out.push(`${model}: ${r.class} missing ${field}`);
    }
    if (pre.requiresPoolState) {
      const p = r.poolAtRequest as { busy?: unknown; total?: unknown } | undefined;
      if (!p || typeof p.busy !== "number" || typeof p.total !== "number") {
        out.push(`${model}: ${r.class} missing poolAtRequest {busy,total}`);
      }
    }
    if (pre.requiresIdlePool) {
      const p = r.poolAtRequest as { busy?: unknown; queued?: unknown } | undefined;
      if (p && typeof p.busy === "number" && p.busy > 0) {
        out.push(`${model}: ${r.class} filed at a BUSY pool (busy=${p.busy}) — a model property must be measured at an idle pool`);
      }
    }
  }
  return out.sort();
}

/** RULE 9: a row may not say "nothing was established" while quoting a measured
 *  HTTP status. UNMEASURED's strict meaning is "never reached"; a real response
 *  WAS reached on every one of the 7 rows this goal re-files, so the class was
 *  true-but-misleading by omission. The predicate is the module's, and it is
 *  mutation-proven below against the exact legacy row shape. */
export function unmeasuredAfterMeasured(records: ModelRecord[]): string[] {
  return unmeasuredAfterMeasuredResponse(records);
}

/** A row whose filed class disagrees with what the CLASSIFIER derives from the
 *  page the server itself reported. This is the rule that was previously a
 *  throwaway driver in /tmp: the same 502, the same idle pool and the same
 *  "no composer" message can only land in one class, and which one is a
 *  function of the reported page, not of an operator's judgement at 2am. */
export function classDisagreements(records: ModelRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (!nonEmptyString(r.class) || !(CLASSES as readonly string[]).includes(r.class)) continue;
    if (r.class === "UNMEASURED") continue; // nothing measured, nothing to re-derive
    const p = r.observedPage as ObservedPage | undefined;
    if (!p || !nonEmptyString(p.title) || !nonEmptyString(p.url)) continue; // no page reported; nothing to re-derive from
    const model = nonEmptyString(r.model) ? r.model : "<no model field>";
    const status = typeof r.httpStatus === "number" ? r.httpStatus : 0;
    const derived = classifyOutcome({
      httpStatus: status,
      message: nonEmptyString(r.evidence) ? r.evidence : "",
      page: { title: p.title, url: p.url },
      poolAtRequest: r.poolAtRequest as { busy?: unknown; total?: unknown; queued?: unknown } | undefined,
    });
    if (derived.cls !== r.class) {
      out.push(`${model}: filed ${r.class} but the classifier derives ${derived.cls} from the reported page "${p.title}" (${p.url}) — ${derived.reason}`);
    }
  }
  return out.sort();
}

/** Measured records older than the disclosed window, and the window itself. */
export function staleByAge(records: ModelRecord[], windowDays: number, now: number): { stale: string[]; window: number } {
  const stale: string[] = [];
  for (const r of records) {
    if (r.class === "UNMEASURED") continue;
    if (!nonEmptyString(r.measuredAt)) continue;
    const t = Date.parse(r.measuredAt);
    if (Number.isNaN(t)) {
      stale.push(`${r.model}: measuredAt ${JSON.stringify(r.measuredAt)} is not a parseable date`);
      continue;
    }
    const days = Math.floor((now - t) / 86_400_000);
    if (days > windowDays) stale.push(`${r.model}: measured ${days}d ago, window is ${windowDays}d`);
  }
  return { stale: stale.sort(), window: windowDays };
}

// ── the shipped record ───────────────────────────────────────────────────────

function load(): RecordFile {
  return JSON.parse(readFileSync(RECORD_PATH, "utf8")) as RecordFile;
}

/** THE ADVERTISED SET — derived, never typed. Same function the daemon calls. */
export function advertisedIds(): string[] {
  return defaultChatSurface().map((e) => e.id).sort();
}

/** The STALENESS BUDGET. Disclosed, counted, must not silently grow.
 *  It is 1, NOT 0, and that is an honest disclosure rather than a hole: the
 *  whole record is dated 2026-09-29 and this file's own window is 30 days, so
 *  the day the gate starts failing on age is the day the record must be
 *  re-measured. Raising this number to quiet the gate is the move it exists
 *  to prevent — it is a named constant, in one place, with the reason here. */
const STALE_BUDGET = 1;
const STALENESS_WINDOW_DAYS = 30;

const record = load();
const advertised = advertisedIds();
const records = Array.isArray(record.records) ? record.records : [];

// ── non-vacuity: everything below would pass on an empty world ───────────────

test("precondition: the advertised set, the record and the class set are all real", () => {
  assert.ok(
    advertised.length >= 20,
    `non-vacuity: expected to DERIVE >=20 advertised ids from defaultChatSurface(), got ${advertised.length} — a smaller set means the derivation broke and every rule below would pass vacuously`,
  );
  assert.equal(
    new Set(advertised).size,
    advertised.length,
    "non-vacuity: the derived advertised set contains a duplicate id",
  );
  assert.ok(records.length >= advertised.length, `non-vacuity: record carries ${records.length} entries for ${advertised.length} advertised ids`);
  // A tripwire, and deliberately NOT a bare count. Pinning `=== 6` (or any
  // exact number) makes the gate satisfiable only by editing the judge to fit
  // the data — the very thing a judge must not require. Two classes were added
  // with the GOAL 163 live measurement: NON-ANSWER-READ (a 200 whose text came
  // from a non-answer region the selector could not exclude) and
  // ANSWER-UNREADABLE (the driver's answer selector matched no node at all, so
  // the model may well answer and the driver simply cannot see it). The
  // invariant that actually matters is not the size of the set — it is that the
  // set can never GROW without every new member carrying a machine-checkable
  // precondition, which is the mechanism that stops a class from becoming a
  // free-text escape hatch. So: the set may only grow, and nothing grows
  // unaccounted for.
  assert.ok(
    CLASSES.length >= 8,
    `non-vacuity: the closed class set SHRANK (${CLASSES.length} < 8) — classes are only ever added deliberately, and removing one hides a measured condition`,
  );
  for (const added of ["NON-ANSWER-READ", "ANSWER-UNREADABLE"]) {
    assert.ok(
      (CLASSES as readonly string[]).includes(added),
      `non-vacuity: ${added} is missing from the class set this gate reads`,
    );
  }
  assert.deepEqual(
    [...(CLASSES as readonly string[])].sort(),
    [...VERIFICATION_CLASSES].sort(),
    "non-vacuity: this gate and the implementation disagree on the class set — one of them is reading a stale copy",
  );
  // Every advertised id must really be derivable, and the derivation must be
  // the registry's — a hardcoded list in this file would defeat the whole gate.
  assert.ok(advertised.includes("gemini"), "non-vacuity: the derived set must contain a known id (gemini)");
});

test("the record declares the schema and the staleness window this gate reads", () => {
  assert.equal(record.schema, "ui2api/model-verification/1", "the record's schema tag changed — the gate's reader is out of date");
  assert.equal(
    record.stalenessWindowDays,
    STALENESS_WINDOW_DAYS,
    `the record declares stalenessWindowDays=${String(record.stalenessWindowDays)} but the gate enforces ${STALENESS_WINDOW_DAYS} — the two must not disagree`,
  );
});

// ── the rules ────────────────────────────────────────────────────────────────

test("RULE 1: every advertised model has a record — an unrecorded model is an unmeasured one a consumer cannot see", () => {
  const missing = missingRecords(advertised, records);
  assert.deepEqual(
    missing,
    [],
    `advertised on /v1/models with NO record in capabilities/model-verification.json: ${missing.join(" ")} — a consumer reads this list and has no idea these were never measured`,
  );
});

test("RULE 2: no record names a model that is no longer advertised (a stale record rots the gate)", () => {
  const stale = staleRecords(advertised, records);
  assert.deepEqual(
    stale,
    [],
    `records for models the surface no longer advertises: ${stale.join(" ")} — delete the record, or fix the model id`,
  );
});

test("RULE 3: no duplicate record for one model", () => {
  const dupes = duplicateModels(records);
  assert.deepEqual(dupes, [], `two records for one model — one of them is fiction: ${dupes.join(", ")}`);
});

test("RULE 4: every class is drawn from the closed set", () => {
  const bad = unknownClasses(records);
  assert.deepEqual(
    bad,
    [],
    `records whose class is outside {${CLASSES.join(", ")}}: ${bad.join("; ")} — a class the gate cannot interpret is a claim nobody can check`,
  );
});

test("RULE 5: a record claiming anything about the model carries measuredAt + method + evidence", () => {
  const bad = unprovenMeasurements(records);
  assert.deepEqual(
    bad,
    [],
    `a non-UNMEASURED record missing its proof: ${bad.join("; ")} — only UNMEASURED ("we do not know") may be bare`,
  );
});

test("RULE 6: ANSWERS is never claimed without real measured evidence (a 2xx and a duration)", () => {
  const bad = evidenceFreeClaims(records);
  assert.deepEqual(
    bad,
    [],
    `ANSWERS claimed with nothing behind it: ${bad.join("; ")} — ANSWERS may only be recorded from a real measured round trip (Cause D: 'proof PASS 13965' is prose no code parses)`,
  );
});

test("RULE 7: CONTENDED-TIMEOUT carries the pool state that distinguishes contention from a broken model", () => {
  const bad = contentionWithoutPoolState(records);
  assert.deepEqual(
    bad,
    [],
    `contention claims without a busy pool (or at an idle one): ${bad.join("; ")} — a timeout at an idle pool is a model property, and must NOT be filed as contention`,
  );
});

test("RULE 9: a row may not be UNMEASURED while quoting a measured HTTP status — UNMEASURED means NEVER REACHED", () => {
  const bad = unmeasuredAfterMeasured(records);
  assert.deepEqual(
    bad,
    [],
    `rows that claim "nothing was established" beside a real measured status: ${bad.join("; ")} — the response WAS reached, so it is classified (classifyOutcome in src/prompt/verification-class.ts); UNMEASURED's honest meaning is "never reached"`,
  );
});

test(`RULE 10: every class's declared precondition holds — a new class cannot be a free-text escape hatch`, () => {
  const bad = preconditionViolations(records);
  assert.deepEqual(
    bad,
    [],
    `class preconditions violated: ${bad.join("; ")} — each class's precondition is declared in src/prompt/verification-class.ts (CLASS_PRECONDITIONS) and enforced here, so a class that can hold anything fails`,
  );
});

test("RULE 11: a row's filed class agrees with what the classifier derives from the page the server reported", () => {
  const bad = classDisagreements(records);
  assert.deepEqual(
    bad,
    [],
    `filed class disagrees with the classifier: ${bad.join("; ")} — the rule is CODE (src/prompt/verification-class.ts), not a sweep convention; if a row is wrong, fix the row or widen the rule on purpose, never by hand`,
  );
});

test(`RULE 8: measured records older than ${STALENESS_WINDOW_DAYS}d — a NAMED, COUNTED budget that must not silently grow`, (t) => {
  const { stale, window } = staleByAge(records, window0(), Date.now());
  assert.ok(
    stale.length <= STALE_BUDGET,
    `stale measurements grew past their budget: ${stale.length} > ${STALE_BUDGET} (window ${window}d) — ${stale.join("; ")}. Re-measure, or raise STALE_BUDGET with a named reason; never let it drift.`,
  );
  t.diagnostic(`stale measurements: ${stale.length}/${STALE_BUDGET} in use (window ${window}d)` + (stale.length ? ` — ${stale.join("; ")}` : ""));
});

/** The window the record itself declares is the one the gate uses. */
function window0(): number {
  return typeof record.stalenessWindowDays === "number" ? record.stalenessWindowDays : STALENESS_WINDOW_DAYS;
}

// ── MUTATION PROOF: the gate must be provably capable of failing ─────────────
// Every predicate above is fed a fabricated or corrupted record and MUST
// report it. If any of these ever passes, the gate is blind.

test("MUTATION: the gate's own predicates reject a fabricated ANSWERS claim", () => {
  const advertisedSet = advertisedIds();
  assert.deepEqual(evidenceFreeClaims(records), [], "precondition: the shipped record must have no evidence-free ANSWERS claim");

  // (a) prose claim in JSON clothing — the exact shape of Cause D.
  const proseClaim: ModelRecord = {
    model: "gemini",
    measuredAt: "2026-09-29",
    class: "ANSWERS",
    method: "live-v1-chat",
    evidence: "proof PASS 13965",
  };
  assert.ok(
    evidenceFreeClaims([proseClaim]).length > 0,
    "the gate must reject an ANSWERS claim whose evidence is prose with no measured outcome",
  );

  // (b) the claim deleted entirely.
  const delisted = records.filter((r) => r.model !== "gemini");
  assert.ok(
    missingRecords(advertisedSet, delisted).includes("gemini"),
    "the gate must notice an advertised model with no record at all",
  );

  // (c) a record for a model the surface does not advertise.
  const orphan = [...records, { model: "no-such-model-xyz", class: "UNMEASURED", method: "not-run" }];
  assert.ok(
    staleRecords(advertisedSet, orphan).includes("no-such-model-xyz"),
    "the gate must notice a record for a model that is no longer advertised",
  );

  // (d) a measured class stripped of its evidence.
  const stripped: ModelRecord = { model: "gemini", measuredAt: "2026-09-29", class: "SIGN-OUT", method: "live-v1-chat", evidence: "" };
  assert.ok(
    unprovenMeasurements([stripped]).some((s) => s.includes("missing evidence")),
    "the gate must notice a SIGN-OUT record with an empty evidence field",
  );

  // (e) a class the gate cannot interpret.
  assert.ok(
    unknownClasses([{ model: "gemini", class: "PROBABLY-FINE" }]).length > 0,
    "the gate must notice a class outside the closed set",
  );

  // (f) contention filed at an IDLE pool — the lie this record exists to kill.
  assert.ok(
    contentionWithoutPoolState([{ model: "kimi", class: "CONTENDED-TIMEOUT", poolAtRequest: { busy: 0, total: 4 } }]).length > 0,
    "the gate must reject a CONTENDED-TIMEOUT claim taken at an idle pool",
  );
  assert.ok(
    contentionWithoutPoolState([{ model: "kimi", class: "CONTENDED-TIMEOUT" }]).length > 0,
    "the gate must reject a CONTENDED-TIMEOUT claim with no pool state at all",
  );

  // (g) a measurement aged past the window.
  const aged = staleByAge([{ model: "gemini", class: "ANSWERS", measuredAt: "2020-01-01" }], window0(), Date.now());
  assert.ok(aged.stale.length > 0, "the gate must notice a measurement older than the window");
  const fresh = staleByAge([{ model: "gemini", class: "ANSWERS", measuredAt: new Date().toISOString() }], window0(), Date.now());
  assert.deepEqual(fresh.stale, [], "and must NOT flag a measurement taken today");

  // (h) the exact legacy row shape: UNMEASURED beside a real measured 502. This
  // is the shape the 2026-09-30 record actually contained for 7 rows, and it is
  // why RULE 9 exists.
  const legacy = records.find((r) => r.class === "WALL-CHALLENGE");
  assert.ok(legacy, "precondition: the re-filed WALL-CHALLENGE row must exist to mutate");
  const reverted = { ...legacy, class: "UNMEASURED" };
  assert.ok(
    unmeasuredAfterMeasured([reverted]).length > 0,
    "the gate must reject an UNMEASURED row whose evidence quotes a measured HTTP 502",
  );

  // (i) a new class that is a free-text escape hatch: WALL-CHALLENGE filed
  // without the server-reported page it is DEFINED by.
  const wallNoPage: ModelRecord = {
    model: "grok",
    measuredAt: "2026-09-30T00:36:43.534Z",
    class: "WALL-CHALLENGE",
    method: "live-v1-chat",
    evidence: "HTTP 502, something went wrong at the wall, trust me",
    poolAtRequest: { busy: 0, total: 3, queued: 0 },
  };
  assert.ok(
    preconditionViolations([wallNoPage]).some((s) => s.includes("missing observedPage")),
    "the gate must reject a WALL-CHALLENGE with no observedPage — a class that can hold anything re-creates the original defect",
  );
  const wallBusy: ModelRecord = {
    ...wallNoPage,
    observedPage: { title: "Just a moment...", url: "https://x.test/" },
    poolAtRequest: { busy: 3, total: 4, queued: 2 },
  };
  assert.ok(
    preconditionViolations([wallBusy]).some((s) => s.includes("BUSY pool")),
    "the gate must reject a model-property class measured at a BUSY pool",
  );

  // (j) the wrong class for the same reported page. The classifier is code, so
  // a hand-filing is caught: a Cloudflare interstitial mis-filed as COMPOSER-DRIFT
  // would license a selector retune, which cannot fix a bot wall.
  const misfiled: ModelRecord = {
    ...legacy,
    class: "COMPOSER-DRIFT",
  };
  assert.ok(
    classDisagreements([misfiled]).length > 0,
    "the gate must reject a Cloudflare-challenge page filed as COMPOSER-DRIFT",
  );
  const misfiled2: ModelRecord = { ...legacy, class: "SIGN-OUT" };
  assert.ok(
    classDisagreements([misfiled2]).length > 0,
    "the gate must reject a Cloudflare-challenge page filed as SIGN-OUT — that asserts a credential problem the evidence does not show",
  );
  // and the classifier's own refusal: a measured response it cannot honestly
  // file is UNCLASSIFIED, not a class.
  assert.equal(
    classifyOutcome({ httpStatus: 503, message: "upstream unavailable", poolAtRequest: { busy: 0, total: 4, queued: 0 } }).cls,
    "UNCLASSIFIED",
    "a measured response matching no named condition must classify as UNCLASSIFIED rather than hide in UNMEASURED",
  );
});
