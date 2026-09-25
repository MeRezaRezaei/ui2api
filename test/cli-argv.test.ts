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
import { firstNonFlagArg, importIdentityArg, promptTextArg, requirementsSiteArg } from "../src/cli.js";

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

// --- GOAL 80: `profile import --account email` is a real knob, not a dead
// flag. ONBOARDING §4b's copy-paste command named --account while
// cmdProfileImport only read --identity (the flag was parsed and silently
// dropped — the import landed under the auto-detected identity instead). ---

test("GOAL 80: importIdentityArg resolves --identity first, then --account, empty when neither", () => {
  assert.equal(importIdentityArg({ identity: undefined, account: undefined } as never), undefined);
  assert.equal(importIdentityArg({ account: "me@example.com" } as never), "me@example.com");
  assert.equal(importIdentityArg({ identity: "me@example.com" } as never), "me@example.com");
  assert.equal(importIdentityArg({ identity: "a@b.c", account: "d@e.f" } as never), "a@b.c");
});

test("GOAL 80: cmdProfileImport consumes the resolved identity AND the scan hint + usage name a flag the import path reads", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  // The wiring: the import call passes importIdentityArg(flags) as the identity.
  assert.match(cli, /const requestedIdentity = importIdentityArg\(flags\);/);
  assert.match(cli, /identity: requestedIdentity/);
  // The divergence echo exists so a requested-vs-detected mismatch is never silent.
  assert.match(cli, /requested identity .* but the import resolved to/);
  // The runtime hint + usage document BOTH names (the copy-paste --account is
  // now real because the import path reads flags.account via importIdentityArg).
  assert.match(cli, /profile import <host> \[--identity\|--account email\]/);
});

test("GOAL 80: docs<->code contract — the ONBOARDING copy-paste command's flag is a flag the import path reads", () => {
  const onboarding = readFileSync("docs/ONBOARDING.md", "utf8");
  assert.ok(
    onboarding.includes("profile import www.kimi.ai --account me@example.com"),
    "ONBOARDING §4b keeps the --account copy-paste command",
  );
  const cli = readFileSync("src/cli.ts", "utf8");
  assert.ok(
    cli.includes("flags.identity ?? flags.account"),
    "the import path reads --account (via importIdentityArg) — the documented flag is real",
  );
  // The quoted "real output" block matches what the CLI actually prints now.
  assert.ok(
    onboarding.includes("profile import <host> [--identity|--account email]"),
    "the ONBOARDING quoted scan output matches the corrected runtime hint",
  );
});