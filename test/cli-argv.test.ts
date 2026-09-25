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
import { addAllModeArg, declaredAuthorUse, firstNonFlagArg, HELP_LINES, importIdentityArg, promptTextArg, requirementsSiteArg } from "../src/cli.js";

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
// --- GOAL 85: `profile add-all --interactive` was advertised at SIX sites
// (README:432, AGENTS:79, ONBOARDING:94, ONBOARDING:119's quoted "real
// output", the cli.ts scan hint, the cli.ts usage throw) and read NOWHERE —
// cmdProfileAddAll read only dataDir/identity/identityPrefix/known, and the
// selection branch was `if (flags.known) … else …`, so the flag was INERT and
// `--known --interactive` silently took the --known branch, INVERTING the
// documented "checkbox-pick exactly which hosts to import". The flag is now
// real, and the contradiction REFUSES (named, nonzero exit) instead of being
// swallowed. ---

test("GOAL 85: addAllModeArg — bare / --interactive = checkbox pick, --known = bulk import", () => {
  assert.equal(addAllModeArg({} as never), "interactive");
  assert.equal(addAllModeArg({ known: false, interactive: false } as never), "interactive");
  assert.equal(addAllModeArg({ interactive: true } as never), "interactive");
  assert.equal(addAllModeArg({ known: true } as never), "known");
});

test("GOAL 85: THE silent swallow pinned — --known --interactive REFUSES and the message names BOTH flags", () => {
  assert.throws(
    () => addAllModeArg({ known: true, interactive: true } as never),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /cannot combine --known and --interactive/);
      assert.match(msg, /--known/, "the refusal must name --known");
      assert.match(msg, /--interactive/, "the refusal must name --interactive");
      assert.match(msg, /bulk import vs checkbox pick/, "the refusal must name what each flag would have meant");
      return true;
    },
  );
});

test("GOAL 85: cmdProfileAddAll READS the mode (--interactive is no longer inert) and the branch honors it", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  const start = cli.indexOf("async function cmdProfileAddAll");
  const body = cli.slice(start, cli.indexOf("async function cmdProfileCapabilities", start));
  assert.ok(start > 0 && body.length > 0, "cmdProfileAddAll body located");
  // The body consumes the RESOLVED mode, and the branch keys on it (not on a raw
  // `flags.known` read — the old shape is what made --interactive inert).
  assert.match(body, /const mode = addAllModeArg\(flags\);/);
  assert.match(body, /if \(mode === "known"\)/);
  assert.ok(!/if \(flags\.known\)/.test(body), "the raw `if (flags.known)` branch is gone — the mode decides");
  // The decision itself reads BOTH flags — the flag is live, not decorative.
  const hStart = cli.indexOf("export function addAllModeArg");
  const helper = cli.slice(hStart, hStart + 600);
  assert.match(helper, /flags\.known && flags\.interactive/);
  assert.match(helper, /return flags\.known \? "known" : "interactive";/);
  // A contradictory pair refuses BEFORE any OS profile scan — nothing is touched.
  assert.ok(
    body.indexOf("addAllModeArg(flags)") < body.indexOf("findAllChromeProfilesOnOs"),
    "the --known/--interactive refusal must precede the profile scan",
  );
});

test("GOAL 85: docs<->code contract — every --interactive advertising site names a flag the add-all path READS", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  // The tokens the sites use are the tokens the parser maps onto the two
  // properties addAllModeArg reads (no doc can drift onto a dead spelling).
  assert.match(cli, /if \(argv\[i\] === "--interactive"\) f\.interactive = true;/);
  assert.match(cli, /if \(argv\[i\] === "--known"\) f\.known = true;/);
  const hStart = cli.indexOf("export function addAllModeArg");
  const helper = cli.slice(hStart, hStart + 600);
  assert.match(helper, /flags\.interactive/);
  assert.match(helper, /flags\.known/);
  // The five documentation surfaces (AGENTS.md is another agent's file, but its
  // wording must stay TRUE — it is asserted, not edited).
  const sites: Array<[string, string]> = [
    ["README.md", "profile add-all --interactive"],
    ["AGENTS.md", "profile add-all [--known|--interactive]"],
    ["docs/ONBOARDING.md", "profile add-all --interactive"],
  ];
  for (const [file, needle] of sites) {
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(needle), `${file} must still show \`${needle}\``);
    assert.ok(
      text.includes("--known"),
      `${file} shows --interactive without the --known it is exclusive with`,
    );
  }
  // The two runtime surfaces a user actually lands on.
  assert.ok(
    cli.includes("ui2api profile add-all [--known|--interactive]"),
    "the scan hint still names both modes",
  );
  assert.ok(
    cli.includes("add-all [--known|--interactive] [--identity-prefix STR]"),
    "the profile usage throw still names both modes",
  );
  // No doc promises the old silent swallow: both copy-paste sites state the refusal.
  assert.match(readFileSync("README.md", "utf8"), /cannot be combined/);
  assert.match(readFileSync("docs/ONBOARDING.md", "utf8"), /mutually exclusive/);
});

test("GOAL 85: docs<->code contract — ONBOARDING's quoted \"real output\" is what the scan hint actually prints", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  const printed = "[ui2api] tip: add ALL known hosts in one step →  ui2api profile add-all [--known|--interactive]";
  assert.ok(
    cli.includes(`console.log("${printed}");`),
    "the scan hint must stay byte-stable — ONBOARDING quotes this exact line",
  );
  assert.ok(
    readFileSync("docs/ONBOARDING.md", "utf8").includes(printed),
    "ONBOARDING's quoted real output must equal the printed hint",
  );
});

test("GOAL 85 (a): --author/--use are WIRED — the package path reads them and the refusal carries the declaration", () => {
  // No declared values ⇒ no extra text on the refusal (unchanged verdict).
  assert.equal(declaredAuthorUse({} as never), "");
  const both = declaredAuthorUse({ author: "alice", use: "My own account" } as never);
  assert.match(both, /author="alice"/);
  assert.match(both, /authorized-use="My own account"/);
  assert.match(both, /capabilities\/<id>\/manifest\.json/, "the verdict names where a real package declares them");
  const cli = readFileSync("src/cli.ts", "utf8");
  // The package path CONSUMES it — the flag is no longer parsed-then-dropped.
  assert.match(cli, /throw new Error\(packageCommandRefusal\(host, root\) \+ declaredAuthorUse\(flags\)\);/);
  // The parser still teaches both flags, and the usage throw still names them
  // — truthfully now, because the package path reads them.
  assert.match(cli, /if \(argv\[i\] === "--author"\) f\.author = argv\[\+\+i\];/);
  assert.match(cli, /if \(argv\[i\] === "--use"\) f\.use = argv\[\+\+i\];/);
  assert.match(cli, /usage: ui2api package <host> \[--author NAME --use 'authorized-use statement'\]/);
  // GOAL 67's honest-help pin still holds: the help block refuses the command
  // and never advertises a working --author invocation.
  const pkgLine = HELP_LINES.find((l) => l.includes("ui2api package"));
  assert.ok(pkgLine && pkgLine.includes("REFUSED"), "help must still mark ui2api package REFUSED");
  assert.ok(!pkgLine!.includes("--author"), "help must not advertise a working --author invocation");
});

test("GOAL 85 (3): --trust is DISCOVERABLE — the serve help line documents the gate cmdServe already enforces", () => {
  const serveLine = HELP_LINES.find((l) => l.includes("ui2api serve"));
  assert.ok(serveLine, "help must still list ui2api serve");
  assert.match(serveLine!, /--trust/, "the only gate flag a user could not find from help is now in the help");
  const cli = readFileSync("src/cli.ts", "utf8");
  assert.match(
    cli,
    /if \(!map\.trusted && !flags\.trust\) throw new Error\("action-map is untrusted — review it and re-run with --trust"\);/,
  );
  assert.match(cli, /if \(argv\[i\] === "--trust"\) f\.trust = true;/);
});
