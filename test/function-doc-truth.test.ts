// GOAL 82 — docs/function-api-ui-map.md must never publish stale headline
// numbers again. The doc prints a measured census at the top; this pin parses
// those DECLARED numbers (never hard-coded here) and asserts them against the
// SAME on-disk measurements the doc's numbers came from
// (scripts/measure-function-map.mjs). A corpus change moves the doc and this
// pin together; a manual doc edit that drifts from disk falls RED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measure } from "../scripts/measure-function-map.mjs";

const DOC = new URL("../docs/function-api-ui-map.md", import.meta.url);
const docSrc = readFileSync(DOC, "utf8");

/** Parse a `KEY: value` census token (optionally **bold**) the doc carries in
 *  its header block — tokens may share a line, so match is unanchored. */
function census(name: string): number {
  const re = new RegExp(`\\*{0,2}${name}\\*{0,2}\\s*:\\s*(\\d+)`, "m");
  // RegExp.prototype.exec takes ONE argument; a second `{ timeout }` arg is
  // silently ignored by V8 and was never a regex API. Removing it is provably
  // behaviour-preserving (measured: /a/.exec("a", {timeout:5}) -> ["a"]).
  const m = re.exec(docSrc);
  assert.ok(m, `docs/function-api-ui-map.md must declare a "${name}: <int>" census token`);
  return Number(m[1]);
}

test("doc census matches the disk measurement (packages, caps, split, routes, chat profiles)", () => {
  const real = measure();
  assert.equal(census("PACKAGES"), real.packageCount);
  assert.equal(census("CAPABILITIES"), real.capabilityTotal);
  assert.equal(census("REAL_RUNNERS"), real.realRunnerCount);
  assert.equal(census("REAL_CAPS"), real.realCaps);
  assert.equal(census("GATED"), real.gatedCount);
  assert.equal(census("GATED_CAPS"), real.gatedCaps);
  assert.equal(census("ROUTES"), real.capabilityRouteCount);
  assert.equal(census("CHAT_PROFILES"), real.chatProfileCount);
});

test("negative: a doc census line that drifts from disk falls RED (scratch fixture, real doc never touched)", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-doc-truth-"));
  try {
    const scratch = join(dir, "function-api-ui-map.md");
    // A plausible-looking but WRONG headline: 2 packages, 3 capabilities.
    writeFileSync(
      scratch,
      [
        "# map",
        "- PACKAGES: 2",
        "- CAPABILITIES: 3",
        "- REAL_RUNNERS: 1",
        "- REAL_CAPS: 1",
        "- GATED: 1",
        "- GATED_CAPS: 2",
        "- ROUTES: 1",
        "- CHAT_PROFILES: 1",
      ].join("\n"),
      "utf8"
    );
    assert.throws(() => {
      // Reuse the same parsing against the scratch fixture: the measurement is
      // the real disk one, so a wrong doc number must assert-fail.
      const scratchSrc = readFileSync(scratch, "utf8");
      const p = (n: string) => Number(new RegExp(`- \\*{0,2}${n}\\*{0,2}: (\\d+)`).exec(scratchSrc)?.[1] ?? -1);
      const real = measure();
      assert.equal(p("PACKAGES"), real.packageCount, "scratch PACKAGES");
      assert.equal(p("CAPABILITIES"), real.capabilityTotal, "scratch CAPABILITIES");
      assert.equal(p("CHAT_PROFILES"), real.chatProfileCount, "scratch CHAT_PROFILES");
    }, /scratch PACKAGES|scratch CAPABILITIES|scratch CHAT_PROFILES/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doc route count is cross-checked by the dispatch seam (HARD drift gate)", () => {
  // GOAL 140 collapsed the 33 per-site dispatchers into ONE table-driven handler
  // driven by CAPABILITY_DISPATCH, so the doc's ROUTES number is now measured
  // from the SEAM (the single `/capability/` prefix route) and the table must
  // still cover every package that declares capabilities — otherwise a site
  // could be advertised and unroutable, which is the defect this replaced.
  const httpSrc = readFileSync(new URL("../src/prompt/http.ts", import.meta.url), "utf8");
  const dispatchers = [...httpSrc.matchAll(/req\.url\?\.startsWith\("\/capability\/"\)/g)].length;
  assert.equal(dispatchers, 1, "there must be exactly ONE /capability handler");
  assert.equal(census("ROUTES"), dispatchers);
  // The table is the real per-site inventory, and it must stay complete.
  const table = readFileSync(new URL("../src/prompt/capability-dispatch.ts", import.meta.url), "utf8");
  const rows = [...table.matchAll(/^  "[a-z0-9-]+": \{ runner:/gm)].length;
  assert.equal(census("SITES_DISPATCHED") ?? rows, rows);
  // And the doc must not claim in-sync dispatch without the hard gate being on.
  const dispatchTest = readFileSync(new URL("../test/capability-dispatch.test.ts", import.meta.url), "utf8");
  assert.match(dispatchTest, /HARD_FAIL_ON_DRIFT\s*=\s*true/, "doc cites a hard drift gate; the gate must actually be hard");
});