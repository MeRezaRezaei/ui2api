/**
 * Item 4 — the census in scripts/measure-function-map.mjs must be ANCHORED, or
 * it reports a clean zero and calls it success.
 *
 * The failure this kills, stated precisely: `gatedIds()` used to run a
 * whole-file /^\s+"([a-z0-9-]+)",\s*$/gm scan over a 259-line test file. That
 * regex matches ANY bare quoted lowercase string alone on a line, anywhere.
 * So the "login-gated-by-design" census had two silent corruption modes:
 *
 *   F1 ADDITIVE — an unrelated scratch fixture on its own line makes the census
 *                 believe another package is login-gated. Not hypothetical: it
 *                 is exactly how GOAL 147's falsifiability proof broke
 *                 `realRunnerIds()` (it wrote `id: "scratch-stamped"` and the
 *                 census answered 15 real runners instead of 14).
 *   F2 ZERO     — renaming or reindenting the declaration makes the scan match
 *                 NOTHING. `realGatedSplit()` then returns `gatedN: 0`, the
 *                 table prints `gated-by-design 0`, and the doc census loses 76
 *                 capabilities to a measurement that never measured. A gate
 *                 that finds nothing because it understood nothing is not a gate.
 *
 * `gatedIds()` is now anchored to `const LOGIN_GATED_BY_DESIGN = new Set([` ..
 * `]);` and throws a named error if either end is missing — the contract
 * `realRunnerIds()` already had.
 *
 * FALSIFIABILITY METHOD. The 0-arg signature is pinned by
 * scripts/measure-function-map.d.mts (not an editable file for this change), so
 * the proof does not re-implement the scanner — a checker that duplicates the
 * logic is a second source of truth, the exact disease this repo keeps finding.
 * Instead it relocates a BYTE-IDENTICAL copy of the real script into a temp
 * root. `ROOT` is derived from the script's own path, so the copy reads
 * `<tmp>/test/function-api-ui-closure.test.ts` — the mutated file — and the
 * code under test is the shipped code, not a paraphrase of it.
 *
 * Every case is a real top-level `test(...)`, never a bare `describe` body, so
 * a regression is counted in `# tests` instead of passing invisibly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  gatedIds,
  realRunnerIds,
  packageIds,
  capabilityTotal,
  realGatedSplit,
} from "../scripts/measure-function-map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATED_SRC = join(ROOT, "test", "function-api-ui-closure.test.ts");
const SCRIPT = join(ROOT, "scripts", "measure-function-map.mjs");

/**
 * Run the REAL gatedIds() against a mutated copy of its source file.
 *
 * Returns `{ ok, value, error }` from a spawned node process, because the
 * refusal is a THROW and a throw across the test boundary is exactly the signal
 * under test. Uses execFileSync with a hard timeout — no unbounded child.
 */
function gatedIdsAgainst(mutate: (src: string) => string): { ok: boolean; value?: string[]; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-gated-anchor-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    // byte-identical copy of the shipped script — the code under test IS the code shipped
    copyFileSync(SCRIPT, join(dir, "scripts", "measure-function-map.mjs"));
    writeFileSync(join(dir, "test", "function-api-ui-closure.test.ts"), mutate(readFileSync(GATED_SRC, "utf8")));
    const harness =
      'import { gatedIds } from "./scripts/measure-function-map.mjs";' +
      'try { process.stdout.write("OK:" + JSON.stringify(gatedIds())); }' +
      'catch (e) { process.stdout.write("THREW:" + e.message); }';
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", harness], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (out.startsWith("OK:")) return { ok: true, value: JSON.parse(out.slice(3)) };
    return { ok: false, error: out.slice("THREW:".length) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gatedIds() measures the anchored LOGIN_GATED_BY_DESIGN table, not the whole file", () => {
  // The honest value, plus a vacuity guard: a census answering 0, 1, or a
  // number far below the real table would still pass an "is an array" check.
  const gated = gatedIds();
  assert.ok(
    gated.length >= 15,
    `expected the real login-gated table (>=15 ids), got ${gated.length}: ${JSON.stringify(gated)} — ` +
      `if this is 0 the anchor is broken and the census is a silent zero`,
  );
  for (const [id, why] of [
    ["xiaomimimo", "a measured DNS dead-end"],
    ["zenmux", "a measured dormant origin"],
    ["grok", "a measured login-gated-by-design scaffold"],
  ] as const) {
    assert.ok(gated.includes(id), `${id} (${why}) must be in the gated set; got ${gated.join(", ")}`);
  }
  // An id that names nothing on disk is a fabricated row in a census.
  const installed = new Set(packageIds());
  const phantom = gated.filter((id) => !installed.has(id));
  assert.deepEqual(phantom, [], `gatedIds() reported ids that are not installed packages: ${phantom.join(", ")}`);
});

test("gatedIds() IGNORES a stray bare string outside the table (the GOAL 147 shape)", () => {
  // F1, the additive failure mode. `id: "scratch-stamped"` is a key:value pair
  // so it would not match; a scratch ARRAY on its own lines does. This is the
  // exact edit that broke realRunnerIds once. The anchored scan must not see
  // it, and must still answer the real 19.
  const r = gatedIdsAgainst(
    (src) =>
      src +
      '\n// scratch falsifiability probe — must be invisible to the census\n' +
      'const SCRATCH = [\n  "scratch-stamped",\n  "another-ghost",\n];\n',
  );
  assert.ok(r.ok, `a scratch fixture after the table must not break the census; got: ${r.error}`);
  assert.deepEqual(
    r.value,
    gatedIds(),
    "a scratch fixture appended after the table changed the census — the anchor is not holding",
  );
  assert.ok(
    !r.value!.includes("scratch-stamped"),
    "a scratch id leaked into the login-gated census — the anchor is not holding",
  );
});

test("gatedIds() REFUSES when the declaration is renamed (no silent zero)", () => {
  // F2, the clean-zero failure mode. Rename the table and the old unanchored
  // scan matched nothing at all, so realGatedSplit() reported `gatedN: 0` —
  // a clean zero presented as SUCCESS.
  const r = gatedIdsAgainst((src) => src.replace("const LOGIN_GATED_BY_DESIGN", "const RENAMED_ELSEWHERE"));
  assert.equal(r.ok, false, "a renamed declaration must be a NAMED refusal, not a silent empty set");
  assert.match(
    r.error ?? "",
    /gatedIds: no `const LOGIN_GATED_BY_DESIGN = new Set\(\[/,
    "the refusal must name the anchor it could not find, so the reader knows what moved",
  );
});

test("gatedIds() REFUSES when the table literal is broken", () => {
  // A half-edited set (someone added an id and broke the literal) must not
  // degrade into a partial census that still looks like an answer.
  const r = gatedIdsAgainst((src) =>
    src.replace("const LOGIN_GATED_BY_DESIGN = new Set([", "const LOGIN_GATED_BY_DESIGN = ["),
  );
  assert.equal(r.ok, false, "a broken literal must refuse, not answer with whatever it could still match");
  assert.match(r.error ?? "", /gatedIds: no `const LOGIN_GATED_BY_DESIGN = new Set\(\[/);
});

test("the real/gated split is a CLOSED PARTITION of the installed packages", () => {
  // The property that makes a clean zero DETECTABLE at all. Today all 33
  // installed packages sit in exactly one set and the capability split sums to
  // the total — so if either census degrades to 0, or a package falls out of
  // both, THIS is the test that goes red. Without it, 85 + 76 quietly becoming
  // 161 + 0 is indistinguishable from a healthy run.
  const ids = packageIds();
  assert.ok(ids.length > 0, "the census must not be empty — if this passes, every gate below is vacuous");

  const real = new Set(realRunnerIds());
  const gated = new Set(gatedIds());
  const neither = ids.filter((s) => !real.has(s) && !gated.has(s));
  const both = ids.filter((s) => real.has(s) && gated.has(s));
  assert.deepEqual(neither, [], `packages in NEITHER the real-runner nor the gated table: ${neither.join(", ")}`);
  assert.deepEqual(both, [], `packages in BOTH tables (double-counted caps): ${both.join(", ")}`);

  const { realN, gatedN } = realGatedSplit();
  const total = capabilityTotal();
  assert.ok(total > 100, `expected the whole installed surface, saw ${total} capabilities`);
  assert.equal(
    realN + gatedN,
    total,
    `the split must cover every capability: ${realN} real + ${gatedN} gated != ${total} total`,
  );
  assert.ok(
    gatedN > 0,
    "gatedN is 0 — a census that measured nothing is reporting SUCCESS. This is the exact failure the anchor exists to prevent.",
  );
});
