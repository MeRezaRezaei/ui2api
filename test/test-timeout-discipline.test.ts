import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * GOAL 102: the suite's own signal was untrustworthy. Measured in this very
 * session: a full run hit EXIT=124 with a file hung for 864s, and another run
 * produced 5 FILE-LEVEL failures that all passed standalone. Root causes were 23
 * subprocess/network call sites with NO timeout (for spawnSync that means WAIT
 * FOREVER — including a live `gh` GitHub API call), no per-test timeout, and
 * almost no teardown of the servers tests start.
 *
 * A pin that measures nothing is what let this happen, so this pin is a real
 * mechanical scan of every test file.
 */

const SELF = "test/test-timeout-discipline.test.ts";
const TEST_FILES = readdirSync("test")
  .filter((f) => f.endsWith(".ts") && `test/${f}` !== SELF)
  .map((f) => `test/${f}`);
/** SYNC family: Node's spawnSync/execFileSync accept a `timeout` option. */
const SYNC_FAMILY = /(?<![.\w$])(spawnSync|execFileSync)\(/g;
/** ASYNC family: spawn/exec/execFile have NO timeout option — they need a
 *  bounded kill (`.kill(`) or an AbortSignal, or a hung child never settles. */
const ASYNC_FAMILY = /(?<![.\w$])(spawn|execFile|exec)\(/g;

/** Extract every call of a family with balanced parens. */
function execCalls(src: string, re: RegExp): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    while (i < src.length) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    out.push({ start: m.index, end: i + 1, text: src.slice(m.index, i + 1) });
  }
  return out;
}

d("GOAL 102: the measuring instrument is itself trustworthy", () => {
  t("every subprocess/network call in test/ is bounded (timeout or a kill)", () => {
    const unbounded: string[] = [];
    for (const f of TEST_FILES) {
      const src = readFileSync(f, "utf8");
      // SYNC calls must carry `timeout:` — without it spawnSync waits FOREVER.
      execCalls(src, SYNC_FAMILY).forEach((c, i) => {
        if (!/timeout\s*:/.test(c.text)) unbounded.push(`${f} sync-call#${i + 1} (needs timeout)`);
      });
      // ASYNC: `exec`/`execFile` DO accept `timeout` and `signal`. Only `spawn`
      // has neither, so it alone requires a bounded `.kill(` nearby.
      execCalls(src, ASYNC_FAMILY).forEach((c, i) => {
        if (/\bspawn\(/.test(c.text)) {
          const after = src.slice(c.end, c.end + 1200);
          if (!/\.kill\(/.test(after)) unbounded.push(`${f} spawn-call#${i + 1} (needs a bounded .kill())`);
          return;
        }
        if (!/timeout\s*:/.test(c.text) && !/signal\s*:/.test(c.text))
          unbounded.push(`${f} async-call#${i + 1} (needs timeout or signal)`);
      });
    }
    assert.deepEqual(unbounded, [], `these calls can hang forever: ${unbounded.join(", ")}`);
  });

  t("the suite declares an explicit per-test timeout", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const script: string = pkg.scripts["test:unit"];
    assert.match(script, /--test-timeout=\d+/, "test:unit must carry --test-timeout so a hang is a NAMED failure");
    const ms = Number(script.match(/--test-timeout=(\d+)/)![1]);
    // generous enough not to fail a legitimately slow test, tight enough to
    // convert a 29-minute stall into a reported failure
    assert.ok(ms >= 30_000, `timeout ${ms}ms is too tight for the slowest real test (~28s standalone)`);
    assert.ok(ms <= 180_000, `timeout ${ms}ms is too loose — a real hang must surface well before 29 minutes`);
  });

  t("negative: the scan CAN fail — an unbounded scratch call is reported", () => {
    const scratch = 'const x = execFileSync("gh", ["repo", "view"]);\nconst y = execFileSync("git", ["ls-files"], { timeout: 5 });';
    const calls = execCalls(scratch, SYNC_FAMILY);
    const unbounded = calls.filter((c) => !/timeout\s*:/.test(c.text));
    assert.equal(unbounded.length, 1, "exactly the unbounded scratch call must be reported");
    assert.equal(calls.length, 2, "the scan must see both calls");
    // an async call with no signal and no nearby kill must also be reported
    const asyncScratch = 'const c = spawn("node", ["x"]);\nconst c2 = spawn("node", ["y"], { signal: c.signal });';
    const aCalls = execCalls(asyncScratch, ASYNC_FAMILY);
    assert.equal(aCalls.length, 2, "the async scan must see both spawns");
    assert.equal(aCalls.filter((c) => !/signal\s*:/.test(c.text)).length, 1, "the unbounded async call must be reported");
  });
});
