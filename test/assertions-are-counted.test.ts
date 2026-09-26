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
// least one real test declaration — `test(`, `it(`, or `await t.test(`.

const TEST_DIR = join(process.cwd(), "test");

/** A real, counted test declaration in the source. */
const REAL_TEST_DECL =
  /(^|[^.\w$])(?:it|test)\s*\(|await\s+t\.test\s*\(/;

/** Any assertion call (assert.equal / ok / deepEqual / ... , or strictAssert). */
const ASSERT_CALL = /\b(?:assert|nodeAssert|strictAssert)\s*\.\s*[A-Za-z]+/;

export function fileHasAssertionButNoTest(src: string): boolean {
  if (!ASSERT_CALL.test(src)) return false; // no assertions -> nothing to count
  return !REAL_TEST_DECL.test(src);
}

function testFiles(): string[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
}

describe("assertions must live in counted tests", () => {
  test("the predicate reports a describe-only file that holds an assertion", () => {
    // MUTATION: a scratch source string in the exact broken shape must be
    // flagged, so this pin cannot pass vacuously.
    const broken = [
      'import { strict as assert } from "node:assert";',
      'import { describe as d } from "node:test";',
      'd("vacuous", () => {',
      "  assert.equal(1, 1);",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(broken), true);
  });

  test("the predicate does NOT report a file that uses a real test(...)", () => {
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

  test("the predicate does NOT report a file with no assertions at all", () => {
    assert.equal(fileHasAssertionButNoTest('import { describe } from "node:test";\nd("x", () => {});'), false);
  });

  test("the predicate accepts top-level await t.test(...) as a real test", () => {
    const src = [
      'import { strict as assert } from "node:assert";',
      'import test from "node:test";',
      'await t.test("sub", () => {',
      "  assert.equal(1, 1);",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(src), false);
  });

  test("the predicate does not mistake a method call for a test declaration", () => {
    // `obj.test(` is not a test declaration; a file whose only "test(" is a
    // member call is still a describe-only file and must be flagged.
    const src = [
      'import { strict as assert } from "node:assert";',
      'import { describe as d } from "node:test";',
      'd("vacuous", () => {',
      "  assert.equal(harness.test(1), 1);",
      "});",
    ].join("\n");
    assert.equal(fileHasAssertionButNoTest(src), true);
  });

  test("no test/*.test.ts has assertions outside a counted test", () => {
    const offenders: string[] = [];
    for (const f of testFiles()) {
      const src = readFileSync(join(TEST_DIR, f), "utf8");
      if (fileHasAssertionButNoTest(src)) offenders.push(f);
    }
    assert.deepEqual(
      offenders,
      [],
      `assertions with no counted test() — a pin nobody counts is a pin nobody reads: ${offenders.join(", ")}`,
    );
  });
});
