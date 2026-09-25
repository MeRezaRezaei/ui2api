import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * GOAL 91: the daemon's NAMED error codes are a consumer contract, so the
 * shipped doc and the source must agree — in BOTH directions, with the status.
 *
 * This pin MEASURES the emitted set from the source (it is never a hardcoded
 * list of its own) and fails when a code ships undocumented, when the doc
 * names a code the daemon does not emit, or when a status drifts.
 *
 * Proven able to fail: the last block below runs the same checker against a
 * scratch doc that DROPS a code, and asserts it goes red.
 */

const HTTP = readFileSync("src/prompt/http.ts", "utf8");
const OPENAI = readFileSync("src/prompt/openai.ts", "utf8");
const README = readFileSync("README.md", "utf8");

type Emitted = Map<string, number>;

/** Codes carried inside an `{ error: { ... code: "x" } }` envelope, with the status of its send(). */
function envelopeCodes(src: string, into: Emitted): void {
  const re = /error:\s*\{[\s\S]{0,400}?code:\s*"([a-z_]+)"/g;
  for (const m of src.matchAll(re)) {
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    // the status literal of the enclosing send(res, NNN, {...}) / sendJson(res, NNN, ...)
    const statuses = [...before.matchAll(/(?:send|sendJson)\(\s*(?:res|w)\s*,\s*(\d{3})/g)];
    const status = statuses.length ? Number(statuses[statuses.length - 1]![1]) : 0;
    if (status) into.set(m[1]!, status);
  }
}

/** poolRefusal answers one code per pool refusal, all under the status its own doc comment states. */
function poolRefusalCodes(src: string, into: Emitted): void {
  const start = src.indexOf("function poolRefusal");
  if (start < 0) return;
  const body = src.slice(start, src.indexOf("\n}", start));
  const status = Number(/Answer (\d{3})/.exec(src.slice(Math.max(0, start - 500), start))?.[1] ?? 0);
  for (const m of body.matchAll(/return \{ code: "([a-z_]+)" \}/g)) into.set(m[1]!, status);
}

/** Everything the daemon actually emits, measured. */
export function measureEmitted(): Emitted {
  const out: Emitted = new Map();
  envelopeCodes(HTTP, out);
  envelopeCodes(OPENAI, out);
  poolRefusalCodes(HTTP, out);
  return out;
}

/** The doc's table rows: status + code, as shipped. */
export function parseDocTable(doc: string): Emitted {
  const out: Emitted = new Map();
  for (const m of doc.matchAll(/^\|\s*(\d{3})\s*\|\s*`([a-z_]+)`\s*\|/gm)) out.set(m[2]!, Number(m[1]));
  return out;
}

/** The single source of truth for "doc and code agree", shared by the pin and its negative. */
export function contractGaps(emitted: Emitted, documented: Emitted): string[] {
  const gaps: string[] = [];
  for (const [code, status] of emitted) {
    if (!documented.has(code)) gaps.push(`${code} (${status}) is emitted by the daemon but documented nowhere`);
    else if (documented.get(code) !== status) gaps.push(`${code}: code emits ${status}, doc says ${documented.get(code)}`);
  }
  for (const [code, status] of documented) {
    if (!emitted.has(code)) gaps.push(`${code} (${status}) is documented but the daemon never emits it`);
  }
  return gaps;
}

d("GOAL 91: the daemon's named error contract is documented and machine-pinned", () => {
  t("the emitted set is measured from source and the shipped doc agrees both ways", () => {
  const emitted = measureEmitted();
  const documented = parseDocTable(README);

  // (1) non-vacuity: the measurement must actually FIND codes, or this pin is a green lie.
  assert.ok(emitted.size >= 5, `expected the source measurement to find >=5 named codes, found ${emitted.size}: ${[...emitted.keys()]}`);
  assert.ok(documented.size >= 5, `expected the doc table to carry >=5 codes, found ${documented.size}`);

  // (2) the three pool refusals really are measured, with their 503.
  for (const code of ["pool_saturated", "pool_queue_timeout", "pool_closed"]) {
    assert.equal(emitted.get(code), 503, `${code} must be measured from poolRefusal as a 503`);
  }
  assert.equal(emitted.get("request_timeout"), 504, "request_timeout is the 504 aggregate-deadline refusal");
  assert.equal(emitted.get("not_found"), 404, "not_found is the 404 unknown-endpoint/refused-model refusal");

  // (3) THE CONTRACT: both directions, statuses included.
  assert.deepEqual(contractGaps(emitted, documented), [], "the shipped error contract and the source must agree");
  });
});

d("negative: a doc that drops a code falls RED (the pin CAN fail)", () => {
  t("a doc that drops a code, or invents one, is reported (the pin CAN fail)", () => {
    const emitted = measureEmitted();
    const full = parseDocTable(README);
    assert.deepEqual(contractGaps(emitted, full), [], "precondition: the real doc is green");

    // Drop one row from a scratch copy of the shipped table.
    const scratch = README.replace(/^\|\s*503\s*\|\s*`pool_closed`\s*\|.*$/m, "");
    const dropped = parseDocTable(scratch);
    assert.equal(dropped.has("pool_closed"), false, "the scratch fixture really dropped the row");

    const gaps = contractGaps(emitted, dropped);
    assert.ok(gaps.some((g) => g.includes("pool_closed") && g.includes("documented nowhere")), `dropping a code must be reported, got ${JSON.stringify(gaps)}`);

    // And a doc entry with no code behind it must fall RED too (the other direction).
    const invented = parseDocTable(`${README}\n| 418 | \`teapot\` | nothing emits this | retry forever |\n`);
    assert.ok(
      contractGaps(emitted, invented).some((g) => g.includes("teapot") && g.includes("never emits")),
      "an invented doc entry must be reported",
    );
  });
});
