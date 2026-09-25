// GOAL 44: the prompt-command argv seam — the flag-before-text silent drop at
// the flagship command. `prompt --json "hello"` used to send the literal
// string "--json" to the live default site (text "hello" dropped in rest,
// never read; resolveProfile(undefined) falls back to default; --json truthy
// so the usage guard never fires → real ChatDriver browser run answering a
// plausible JSON to the WRONG question, no error, no hint). The pure
// flag-aware `promptTextArg` now reads <text> from the whole argv so BOTH
// orders ask the SAME text, and a flag (or its value) is never sent as text.
// Pure argv math — no browser, no network, no env (same pattern as the
// GOAL-43 pins in test/requirements.test.ts).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { firstNonFlagArg, promptTextArg, requirementsSiteArg } from "../src/cli.js";

test("GOAL 44: prompt positional-first works — text before a flag is the text", () => {
  assert.equal(promptTextArg(["prompt", "hello", "--json"]), "hello");
});

test("GOAL 44: THE silent drop pinned — a flag BEFORE the text is skipped, never sent as text", () => {
  assert.equal(promptTextArg(["prompt", "--json", "hello"]), "hello");
});

test("GOAL 44: a value-taking flag AND its value are both skipped (--site gemini)", () => {
  assert.equal(promptTextArg(["prompt", "--site", "gemini", "hello"]), "hello");
});

test("GOAL 44: a boolean flag (no value) is skipped, the next token is the text", () => {
  assert.equal(promptTextArg(["prompt", "--new", "hello"]), "hello");
});

test("GOAL 44: a value-taking flag's VALUE is never misread as the text", () => {
  assert.equal(promptTextArg(["prompt", "--data-dir", "/tmp/d", "--json", "hello"]), "hello");
  assert.equal(promptTextArg(["prompt", "--site", "gemini", "--new", "hello"]), "hello");
});

test("GOAL 44: no text token ⇒ \"\" — the existing usage throw fires, never a flag as text", () => {
  assert.equal(promptTextArg(["prompt", "--json"]), "");
  assert.equal(promptTextArg(["prompt"]), "");
  // And the command-level guard for text-only leftovers of other commands:
  assert.equal(firstNonFlagArg([]), "");
  assert.equal(firstNonFlagArg(["--json"]), "");
  assert.equal(firstNonFlagArg(["--data-dir", "/tmp/d"]), "");
});

test("GOAL 44: both orders ask the SAME text across flag shapes (∧ wiring anchor)", () => {
  const shapes: Array<[string[], string[]]> = [
    [["prompt", "--json", "hello"], ["prompt", "hello", "--json"]],
    [["prompt", "--site", "gemini", "hello"], ["prompt", "hello", "--site", "gemini"]],
    [["prompt", "--new", "hello"], ["prompt", "hello", "--new"]],
    [["prompt", "--data-dir", "/tmp/d", "--json", "hello"], ["prompt", "hello", "--data-dir", "/tmp/d", "--json"]],
    [["prompt", "--timeout-ms", "30000", "hello"], ["prompt", "hello", "--timeout-ms", "30000"]],
  ];
  for (const [flagFirst, textFirst] of shapes) {
    assert.equal(promptTextArg(flagFirst), promptTextArg(textFirst));
    assert.equal(promptTextArg(flagFirst), "hello");
  }
  // Wiring anchor: the prompt case consumes promptTextArg from the whole argv,
  // and requirementsSiteArg DELEGATES to the shared firstNonFlagArg (the 8
  // GOAL-43 pins in test/requirements.test.ts stay green on the delegation).
  const cli = readFileSync("src/cli.ts", "utf8");
  assert.match(cli, /case "prompt":/);
  assert.match(cli, /return cmdPrompt\(promptTextArg\(process\.argv\.slice\(2\)\), flags\);/);
  assert.match(cli, /export function firstNonFlagArg\(argv: string\[\]\): string/);
  assert.match(cli, /export function promptTextArg\(argv: string\[\]\): string/);
  assert.match(cli, /export function requirementsSiteArg\(argv: string\[\]\): string[\s\S]*?return firstNonFlagArg\(argv\.slice\(1\)\);/);
  // The shared VALUE_TAKING_FLAGS set is the source of truth for both.
  assert.match(cli, /VALUE_TAKING_FLAGS\.has\(tok\)/);
  // Sanity: the pure requirement seam still scopes identically via delegation.
  assert.equal(requirementsSiteArg(["requirements", "--json", "gemini"]), "gemini");
  assert.equal(requirementsSiteArg(["requirements", "gemini", "--json"]), "gemini");
  assert.equal(requirementsSiteArg(["requirements", "--json"]), "");
});