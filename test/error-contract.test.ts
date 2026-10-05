import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measureEmitted, parseDocTable, contractGaps } from "./helpers/error-contract-measure.js";

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
 *
 * THE MEASUREMENT LIVES IN `test/helpers/error-contract-measure.ts`, and
 * `test/production-readiness-gate.test.ts` criterion 3.3 calls the SAME
 * functions. It is a helper rather than an import of this file because importing
 * a `.test.ts` under `node --test` RE-REGISTERS its tests inside the importing
 * run; and it is shared rather than duplicated because the defect being fixed
 * was exactly that the two files could disagree — this one ran a real scan
 * while the readiness gate only asserted the scanner's NAME appeared here, so
 * emptying the scanner left the error contract unmeasured and every gate green.
 */

const README = readFileSync("README.md", "utf8");

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
