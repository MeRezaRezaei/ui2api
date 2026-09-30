import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  MODEL_ANSWER_CLASS,
  MODEL_VERIFICATION_SCHEMA,
  answerableChatSurface,
  buildRegistryPackages,
  defaultChatSurface,
  modelAdvertisementSummary,
  readModelVerification,
  withheldChatModels,
  type ModelVerification,
} from "../src/prompt/registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE ADVERTISEMENT GATE — "the promise matches the measurement" (GOAL 159)
//
// The defect this kills is not a missing feature, it is a promise no code kept.
// capabilities/model-verification.json is a dated, checked-in record of which
// models were MEASURED to return a real answer, and until this gate nothing in
// src/ read it: `grep -rn 'model-verification' src/` returned 0 hits, so
// /v1/models advertised 22 models and /health reported counts.chatModels = 22
// on a service where the record says a handful of them answer at all. A record
// that exists but is never read is documentation wearing a contract's clothes.
//
// It fails on ANY drift, in either direction:
//   - a model advertised that the record does not call ANSWERS (the old lie),
//   - a model the record calls ANSWERS that is not advertised (a promise the
//     consumer never learns about),
//   - a model advertised with no record at all.
// It is HERMETIC and it is MUTATION-PROVEN: the predicates below are fed
// fabricated records and MUST notice, so a green run means the gate can fail.
// ─────────────────────────────────────────────────────────────────────────────

const SRC_DIR = resolve(process.cwd(), "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const verification = readModelVerification();
const addressable = defaultChatSurface();
const addressableIds = addressable.map((e) => e.id);
const offered = answerableChatSurface(verification);
const offeredIds = offered.map((e) => e.id);
const withheld = withheldChatModels(verification);

test("GATE 1: the record is READ BY src/, not only by a test — a record no code reads is documentation", () => {
  const readers = sourceFiles(SRC_DIR).filter((f) => readFileSync(f, "utf8").includes("model-verification"));
  assert.ok(
    readers.length > 0,
    "no file under src/ mentions model-verification — the record exists but nothing reads it, so /v1/models cannot be gated on a measurement",
  );
  // The reader must be wired into the PROMISE surfaces, not merely present as
  // an unused export: a reader nothing calls is the same defect one layer down.
  const openai = readFileSync(resolve(SRC_DIR, "prompt", "openai.ts"), "utf8");
  assert.ok(
    openai.includes("answerableChatSurface"),
    "src/prompt/openai.ts does not gate /v1/models on the measured surface — the reader exists but the promise is still unfiltered",
  );
});

test("GATE 2: the record itself is readable and well-formed enough to gate on", () => {
  assert.equal(verification.refusal, null, `the record could not be read: ${verification.refusal}`);
  assert.equal(verification.schema, MODEL_VERIFICATION_SCHEMA);
  assert.ok(verification.answers.length > 0, "the record names no ANSWERS model — the gate would serve an empty promise");
  assert.ok(
    verification.generatedAt !== null && verification.ageDays !== null,
    "the record carries no parseable generatedAt, so its age cannot be reported to a consumer",
  );
});

test("GATE 3: every advertised model has an ANSWERS record — the direction the old code got wrong", () => {
  const answering = new Set(verification.answers);
  const offenders = offeredIds.filter((id) => !answering.has(id));
  assert.deepEqual(
    offenders,
    [],
    `advertised on /v1/models without a measured ANSWERS record: ${offenders.join(" ")} — a consumer materialises a provider per advertised id and 18 of 22 could not keep the promise`,
  );
  // And no advertised id may be riding on a record that does not exist at all.
  const recorded = new Set([...verification.answers, ...withheld.map((w) => w.model)]);
  const unrecorded = offeredIds.filter((id) => !recorded.has(id));
  assert.deepEqual(unrecorded, [], `advertised with NO record of any kind: ${unrecorded.join(" ")}`);
});

test("GATE 4: every ANSWERS record that is addressable IS advertised — the other direction", () => {
  const addressableSet = new Set(addressableIds);
  const silentlyDropped = verification.answers.filter((id) => addressableSet.has(id) && !offeredIds.includes(id));
  assert.deepEqual(
    silentlyDropped,
    [],
    `measured as answering, addressable, and not advertised: ${silentlyDropped.join(" ")} — the consumer never learns about a promise the service can keep`,
  );
});

test("GATE 5: the two gates are SEPARATE booleans — addressable is not the same question as answering", () => {
  assert.ok(offeredIds.length <= addressableIds.length, "the answering set must be a subset of the addressable set");
  const addressableSet = new Set(addressableIds);
  assert.ok(
    offeredIds.every((id) => addressableSet.has(id)),
    "a model was advertised that the addressable gate does not carry — the answering gate must never ADD an id",
  );
  // Anti-vacuity: if the two sets were equal this goal would be a no-op, and if
  // the answering set were empty this gate would pass on every future mistake.
  assert.ok(offeredIds.length > 0, "no model is advertised — the promise is empty");
  assert.ok(
    offeredIds.length < addressableIds.length,
    `the answering set (${offeredIds.length}) equals the addressable set (${addressableIds.length}) — either the measurement was not read, or this gate proves nothing`,
  );
  const addressableNotAnswering = addressableIds.filter((id) => !offeredIds.includes(id));
  assert.ok(
    addressableNotAnswering.length > 0,
    "anti-vacuity: expected at least one addressable id the record does not call ANSWERS",
  );
});

test("GATE 6: every withheld id carries a NAMED class and reason — a silent omission is the defect again", () => {
  for (const w of withheld) {
    assert.ok(w.class.trim() !== "", `${w.model}: withheld with no class`);
    assert.ok(w.reason.trim().length > 20, `${w.model}: withheld with no readable reason`);
  }
  const withNoRecord = withheld.filter((w) => w.class === "NO-RECORD");
  for (const w of withNoRecord) {
    assert.ok(
      w.reason.includes("no entry"),
      `${w.model}: an unrecorded model must say that nothing was measured about it, not that it failed`,
    );
  }
});

test("GATE 7: THE FULL CATALOGUE STAYS REACHABLE — restriction is on the promise surface only", () => {
  const packages = buildRegistryPackages();
  const byId = new Map(packages.map((p) => [p.id, p]));
  for (const id of addressableIds) {
    assert.ok(byId.has(id), `${id} left /registry entirely — a withheld model must stay discoverable, just not advertised`);
  }
  for (const id of withheld.map((w) => w.model)) {
    const pkg = byId.get(id);
    if (!pkg) continue; // url-less packages were never listed; not a new loss
    assert.equal(pkg.chat, undefined, `${id}: /registry still stamps a chat claim on a withheld model`);
    assert.ok(
      pkg.chatWithheld !== undefined,
      `${id}: /registry omits the chat key with no named reason — the catalogue cannot explain its own omission`,
    );
    assert.ok(
      (pkg.chatWithheld?.reason.length ?? 0) > 20,
      `${id}: /registry names no reason for withholding the chat claim`,
    );
  }
  // Every advertised id still carries the registry chat claim /v1/models serves.
  for (const id of offeredIds) {
    const pkg = byId.get(id);
    if (pkg) assert.equal(pkg.chat?.model, id, `${id}: advertised on /v1/models but carries no registry chat claim`);
  }
});

test("GATE 8: the honest count is REPORTED — offered + withheld == addressable, and the classes add up", () => {
  const s = modelAdvertisementSummary(verification);
  assert.equal(s.refusal, null);
  assert.equal(s.offered, offeredIds.length);
  assert.equal(s.addressable, addressableIds.length);
  assert.equal(s.withheld, withheld.length);
  assert.equal(
    s.offered + s.withheld,
    s.addressable,
    `offered(${s.offered}) + withheld(${s.withheld}) != addressable(${s.addressable}) — a consumer cannot reconcile the count, so one number is being hidden`,
  );
  const classSum = Object.values(s.withheldByClass).reduce((a, b) => a + b, 0);
  assert.equal(classSum, s.withheld, "withheldByClass does not sum to withheld");
  assert.equal(s.record, "capabilities/model-verification.json");
  assert.ok(s.catalogueEndpoints.includes("/registry"), "the summary must name where the withheld models remain reachable");
  assert.ok(s.recordAgeDays !== null, "the summary must report the record's age, not hide it");
});

// ── MUTATION PROOF: the gate must be provably capable of failing ─────────────

/** A fabricated record, so the predicates are exercised without touching the
 *  shipped one — and so a green run is evidence about the LOGIC, not about
 *  today's file contents. */
function fabricated(records: { model: string; class: string }[], answers?: string[]): ModelVerification {
  return {
    recordPath: "capabilities/model-verification.json",
    schema: MODEL_VERIFICATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    ageDays: 0,
    answers: answers ?? records.filter((r) => r.class === MODEL_ANSWER_CLASS).map((r) => r.model).sort(),
    withheld: records
      .filter((r) => r.class !== MODEL_ANSWER_CLASS)
      .map((r) => ({ model: r.model, class: r.class, reason: `fabricated class ${r.class} for the mutation proof` }))
      .sort((a, b) => (a.model < b.model ? -1 : 1)),
    refusal: null,
  };
}

test("MUTATION: a model advertised without an ANSWERS record is caught, in both directions", (t) => {
  const surfaceIds = defaultChatSurface().map((e) => e.id);
  const target = surfaceIds[0];
  assert.ok(target, "no addressable id to mutate");

  // The record as loaded, flattened back into the shape `fabricated` consumes,
  // so each mutation is a real edit to TODAY'S record rather than a new file.
  const rows = (answers: string[]) => [
    ...answers.map((model) => ({ model, class: MODEL_ANSWER_CLASS })),
    ...verification.withheld.map((w) => ({ model: w.model, class: w.class })),
  ];
  assert.ok(
    verification.answers.includes(target),
    `${target} is not an ANSWERS model in the shipped record, so nothing was proven by mutating it`,
  );

  // (a) withholding a model the record calls ANSWERS must REMOVE it from the
  //     promise — if it did not, the record would be decorative.
  const withoutTarget = verification.answers.filter((id) => id !== target);
  assert.ok(
    !answerableChatSurface(fabricated(rows(withoutTarget))).some((e) => e.id === target),
    `dropping ${target} from the ANSWERS set did not remove it from the advertised set`,
  );

  // (b) promoting a model the record does NOT call ANSWERS must ADD it — if it
  //     did not, a signature change to the record would never widen the promise.
  const withTarget = [...verification.answers, target];
  assert.ok(
    answerableChatSurface(fabricated(rows(withTarget))).some((e) => e.id === target),
    `promoting ${target} to ANSWERS did not add it to the advertised set`,
  );
  t.diagnostic(`mutated ${target} in both directions; the gate moved with the record`);

  // (c) a record that claims nothing at all advertises nothing, and names why.
  const empty = answerableChatSurface(fabricated([{ model: target, class: "SIGN-OUT" }]));
  assert.equal(empty.length, 0, "a record with no ANSWERS row must advertise no model");

  // (d) a MISSING record is a named refusal, not a silent "serve everything"
  //     and not a silent "serve nothing".
  const missing = { ...verification, refusal: "fabricated: the record file is gone" };
  assert.equal(missing.refusal !== null, true);
  assert.equal(answerableChatSurface(missing).length, 0, "an unreadable record must not yield an advertised model");
  assert.equal(modelAdvertisementSummary(missing).refusal, missing.refusal, "the refusal must reach the consumer, not be swallowed");
});
