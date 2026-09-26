import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

// GOAL 108 class: a test file whose assertions sit directly in a bare
// `describe(...)` body. node:test counts a `describe` as a SUITE, so the
// assertion runs once as suite setup and is never counted as a test — the
// file prints a green tick and reports `tests 0`, and a break in the code it
// covers can never surface as a test failure.
//
// This pin works by SOURCE SCAN (it does not run the suite). For each
// test/*.test.ts: if the file makes `assert.` calls, it must ALSO declare at
// least one real, counted test declaration.
//
// A real test declaration is a call to the node:test `test`/`it` export under
// ANY local name it was imported/bound as (`test(`, `it(`, `test as t` ->
// `t(`, `it as tt` -> `tt(`), or an `await t.test(` sub-test on a TestContext.
// Aliases are resolved from the file's own import/require of node:test, so a
// member call like `harness.test(1)` is NOT mistaken for a test declaration.

const TEST_DIR = join(process.cwd(), "test");

/** Local names bound to node:test's `test`/`it` export in this source. */
export function testLocalNames(src: string): string[] {
  const names = new Set<string>();
  // import { test as t, it as tt, describe as d } from "node:test";
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["']node:test["']/g;
  for (const m of src.matchAll(importRe)) {
    for (const raw of m[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
      if (imported === "test" || imported === "it") names.add(local ?? imported);
    }
  }
  // import test from "node:test";  /  const test = require("node:test").test
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s*["']node:test["']/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']node:test["']\s*\)\s*(?:\.\s*(test|it)\b)?/g)) {
    names.add(m[1]);
  }
  if (/\bnode:test\b/.test(src) && names.size === 0) {
    // A bare `import "node:test"` or a destructure we did not parse: fall back
    // to the conventional unaliased names so we never under-report.
    names.add("test");
    names.add("it");
  }
  return [...names];
}

/** True when the source declares at least one real, counted test. */
export function hasRealTestDeclaration(src: string): boolean {
  if (/\bawait\s+\w+\s*\.\s*test\s*\(/.test(src)) return true; // await t.test(...)
  for (const name of testLocalNames(src)) {
    if (new RegExp(`(?:^|[^.\\w$])${name}\\s*\\(`).test(src)) return true;
  }
  return false;
}

/** Any assertion call: assert.equal / ok / deepEqual / ..., incl. renamed imports. */
export function hasAssertionCall(src: string): boolean {
  return /\b(?:assert|nodeAssert|strictAssert)\s*\.\s*[A-Za-z]+/.test(src);
}

/** The GOAL 108 predicate: assertions exist, but none of them is in a counted test. */
export function fileHasAssertionButNoTest(src: string): boolean {
  if (!hasAssertionCall(src)) return false; // no assertions -> nothing to count
  return !hasRealTestDeclaration(src);
}

function testFiles(): string[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
}

/**
 * Pre-existing instances of the class that this goal's file-scope does NOT
 * permit fixing (GOAL 108 authorises editing test/agent, test/trust,
 * test/session and new files only). They are NAMED here rather than hidden:
 * if this list ever needs to grow, that is a signal, not a convenience.
 */
// Every offender found by this scan has been FIXED. The list is deliberately
// EMPTY: it may not be used to silence a violation, and if a file is ever
// allowlisted here the companion test below fails, because it requires each
// allowlisted file to STILL be an offender.
const KNOWN_UNFIXED: string[] = [];

describe("assertions must live in counted tests", () => {
  test("the predicate reports a describe-only file that holds an assertion (mutation)", () => {
    // A scratch source string in the exact broken shape must be flagged, so
    // this pin cannot pass vacuously.
    const broken = [
      'import { strict as assert } from "node:assert";',
      'import { describe as d } from "node:test";',
      'd("vacuous", () => {',
      "  assert.equal(1, 1);",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(broken), true);
  });

  test("the predicate does NOT report a file that uses an unaliased test(...)", () => {
    const fixed = [
      'import { strict as assert } from "node:assert";',
      'import { describe, test } from "node:test";',
      'describe("ok", () => {',
      '  test("real", () => {',
      "    assert.equal(1, 1);",
      "  });",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(fixed), false);
  });

  test("the predicate does NOT report a file that uses an ALIASED test as t(...)", () => {
    // The `import { test as t, describe as d }` shape used across this repo.
    const fixed = [
      'import { strict as assert } from "node:assert";',
      'import { test as t, describe as d } from "node:test";',
      'd("ok", () => {',
      '  t("real", () => {',
      "    assert.equal(1, 1);",
      "  });",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(fixed), false);
  });

  test("the predicate does NOT report a file with no assertions at all", () => {
    assert.equal(
      fileHasAssertionButNoTest('import { describe as d } from "node:test";\nd("x", () => {});'),
      false,
    );
  });

  test("the predicate accepts a top-level await t.test(...) sub-test", () => {
    const src = [
      'import { strict as assert } from "node:assert";',
      'import test from "node:test";',
      'await t.test("sub", () => {',
      "  assert.equal(1, 1);",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(src), false);
  });

  test("the predicate does not mistake a member call for a test declaration", () => {
    // `harness.test(1)` is not a test declaration: a file whose only "test(" is
    // a member call is still describe-only and must be flagged.
    const src = [
      'import { strict as assert } from "node:assert";',
      'import { describe as d } from "node:test";',
      'd("vacuous", () => {',
      "  assert.equal(harness.test(1), 1);",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(src), true);
  });

  test("the alias resolver finds every local name node:test was imported as", () => {
    const names = testLocalNames(
      'import { test as t, it as tt, describe as d } from "node:test";',
    );
    assert.deepEqual(names.sort(), ["t", "tt"]);
  });

  test("no NEW test/*.test.ts has assertions outside a counted test", () => {
    const offenders = testFiles().filter((f) =>
      fileHasAssertionButNoTest(readFileSync(join(TEST_DIR, f), "utf8")),
    );
    const newOffenders = offenders.filter((f) => !KNOWN_UNFIXED.includes(f));
    assert.deepEqual(
      newOffenders,
      [],
      `assertions with no counted test() — a pin nobody counts is a pin nobody reads: ${newOffenders.join(", ")}`,
    );
  });

  test("the known-unfixed list is still a real list of offenders (no stale allowlisting)", () => {
    for (const f of KNOWN_UNFIXED) {
      const src = readFileSync(join(TEST_DIR, f), "utf8");
      assert.equal(
        fileHasAssertionButNoTest(src),
        true,
        `${f} is allowlisted as a GOAL 108 offender but no longer is — remove it from KNOWN_UNFIXED`,
      );
    }
  });
});
