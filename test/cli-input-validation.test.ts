// WHY THIS FILE EXISTS — three refusals the operator's own words forced, each
// pinned so it cannot rot back into a no-op.
//
// Every one of these is A VALUE THE OPERATOR SUPPLIED THAT THE TOOL USED TO
// ACCEPT AND IGNORE. None of them is stylistic input validation:
//
//   1. `--bogus` (unknown flag) — `parseFlags` had no branch matching it and
//      `firstNonFlagArg` skipped it because it starts with `--`. The command
//      therefore RAN and exited as though the operator had not typed it.
//      MEASURED pre-fix: `ui2api prompt "hi" --site duckduckgo --bogus` printed
//      nothing about `--bogus` and went on to a real 45-second browser call.
//   2. `--pool-max abc` (malformed numeric) — became
//      `Number("abc") || undefined` = `undefined` = "auto". The operator asked
//      for a pool; the daemon printed a confident "auto" and started. The run
//      they asked for was not the run they got — a silent coercion to a default.
//   3. `--xhost-all` without `--assist` (needs-companion) — read ONLY inside
//      the `--assist` branch, so `profile capture` opened a browser and
//      reported a capture while the xhost relax-mode was never applied. The
//      operator believes relax-mode ran.
//
// A REFUSAL NOBODY PROVED CAN FIRE IS ONE REFACTOR FROM BEING DECORATIVE. That
// is why `generateTargetRefusal` and `vaultTightenModeArg` are exported and
// tested in test/cli-silent-flag-refusal.test.ts, and why these three are now
// pinned the same way: PURE seams (no I/O, no browser, no network, no exit),
// called directly, with a MUTATION block per assertion class proving each pin
// BITES against a deliberately broken twin.
//
// DO NOT "simplify" these refusals away as unnecessary validation. The
// validation IS the fix. Deleting `unknownFlagRefusal` restores an exit-0 lie;
// deleting `numericFlagRefusal` restores the silent "auto" coercion; deleting
// `needsCompanionRefusal` restores a capture that reports success it did not do.
//
// ONE DELIBERATE NON-REFUSAL, pinned here so nobody "tightens" it:
// `--pool-min 0` / `--port 0` / `--timeout-ms 0` are NOT refused. GOAL 215
// leaves `0` AMBIGUOUS ON PURPOSE — today `Number(0) || undefined` means `0` is
// UNSET — and whether that is "zero" or "auto" is an operator product question,
// not a gate's. These refusals fire ONLY on input that is not a number at all.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  knownFlagsFrom,
  numericFlagsFrom,
  flagTokens,
  unknownFlagRefusal,
  numericFlagRefusal,
  needsCompanionRefusal,
} from "../src/cli.js";

// The same argv the table in the dispatch seam's comment records.
const BOGUS_ARGV = ["prompt", "hi", "--site", "duckduckgo", "--bogus"];
const ABC_ARGV = ["promptd", "--pool-max", "abc"];
/** `--site --weird`: `--weird` is the VALUE of `--site`, consumed as such. */
const VALUE_LOOKS_LIKE_FLAG_ARGV = ["prompt", "hi", "--site", "--weird"];

/** The real signatures, so the MUTATION tests can substitute a broken twin. */
type UnknownRefusal = (argv: string[]) => string;
type NumericRefusal = (argv: string[]) => string;
type Tokener = (argv: string[]) => { flag: string; value?: string; missingValue: boolean }[];
type CompanionRefusal = (cmd: string | undefined, arg: string | undefined, flags: Record<string, unknown>) => string;

/** `parseFlags`' own source, read back — the derivation every set below comes from. */
function parseFlagsSource(): string {
  const cli = readFileSync("src/cli.ts", "utf8");
  const m = /function parseFlags[\s\S]*?\n}\n/.exec(cli);
  assert.ok(m, "parseFlags' source must be readable — these counts are DERIVED from it, never hand-typed");
  return m![0];
}

// ======================================================== SEAM 1: unknown flag ===

/**
 * The unknown-flag refusal must be ACTIONABLE, not merely negative. A refusal
 * that only says "no" is one the operator works around by guessing — so this
 * names the offending flag, says it would have been ignored in silence, and
 * points at the command that lists the flags.
 */
function assertUnknownRefusalIsActionable(msg: string, offending: string): void {
  assert.notEqual(msg, "", "an unknown flag MUST produce a refusal — an empty string IS the silent no-op");
  assert.match(msg, /unknown flag/, "it must name the class of failure");
  assert.ok(msg.includes(offending), `it must name the offending flag ${offending} verbatim`);
  assert.match(msg, /would have been ignored/, "it must say what would have happened instead");
  assert.match(msg, /Run `ui2api --help`/, "it must point the operator at the flag list");
  assert.match(msg, /Nothing was written/, "it must say nothing was written");
}

test("seam 1: unknownFlagRefusal REFUSES the measured argv, naming --bogus and --help", () => {
  assertUnknownRefusalIsActionable(unknownFlagRefusal(BOGUS_ARGV), "--bogus");
});

test("seam 1: the refusal reports it runs NOTHING — it is a pre-flight check, not a warning", () => {
  const msg = unknownFlagRefusal(BOGUS_ARGV);
  assert.match(msg, /nothing ran/, "an unknown flag must stop the run, not annotate it");
});

test("seam 1: a NEAR-MISS flag is refused AND gets a 'did you mean' suggestion", () => {
  // `--siet` is one edit from `--site`. A refusal that only says "unknown" makes
  // the operator diff the help output by hand; the suggestion is the difference
  // between a refusal and a next step.
  const msg = unknownFlagRefusal(["prompt", "hi", "--siet", "gemini"]);
  assertUnknownRefusalIsActionable(msg, "--siet");
  assert.match(msg, /Did you mean --site\?/, "a distance-1 typo must be answered with the real flag");
});

test("seam 1: a flag with NO near neighbour is refused WITHOUT inventing a suggestion", () => {
  // Suggesting a wrong flag is worse than suggesting none: the operator would
  // "fix" the typo into a different, valid, wrong flag.
  const msg = unknownFlagRefusal(["prompt", "hi", "--totally-unrelated-nonsense"]);
  assert.doesNotMatch(msg, /Did you mean/, "nothing is within edit distance 3, so nothing may be suggested");
});

test("seam 1: EVERY flag the parser derives is ACCEPTED — the refusal cannot fire on a real flag", () => {
  // Exhaustive, not sampled: a hand-typed allowlist beside the parser is how a
  // real flag ends up refused. `knownFlagsFrom` derives from parseFlags itself.
  const derived = knownFlagsFrom(parseFlagsSource());
  assert.ok(derived.size > 20, `the parser must really have flags (got ${derived.size})`);
  for (const flag of derived) {
    assert.equal(unknownFlagRefusal([flag]), "", `${flag} is derived from parseFlags and must never be refused`);
  }
  // `--help` is the one flag acted on OUTSIDE parseFlags, so it is added to the
  // known set explicitly. If it were refused, the remedy line above would tell
  // the operator to run a command the same refusal then rejects.
  assert.equal(unknownFlagRefusal(["--help"]), "", "--help must never be refused");
});

test("seam 1: the flag COUNT in the message is truthful and DERIVED from parseFlags.toString()", () => {
  // A hand-typed count rots the moment a flag is added. The number must equal
  // what the parser actually derives, plus `--help`.
  const derived = knownFlagsFrom(parseFlagsSource()).size + 1; // +1 = the explicit --help
  const msg = unknownFlagRefusal(BOGUS_ARGV);
  const claimed = /knows exactly (\d+) flags/.exec(msg)?.[1];
  assert.ok(claimed !== undefined, `the message must state a count; got: ${msg}`);
  assert.equal(
    Number(claimed),
    derived,
    `the message claims ${claimed} flags but parseFlags derives ${derived} (${knownFlagsFrom(parseFlagsSource()).size} + --help)`,
  );
});

// ==================================================== SEAM 2: numeric values ===

/** The malformed-value refusal must name flag + received value + accepted form. */
function assertNumericRefusalIsActionable(msg: string, flag: string, value: string): void {
  assert.notEqual(msg, "", "a malformed value MUST produce a refusal — silence IS the silent coercion");
  assert.match(msg, /malformed value/, "it must name the class of failure");
  assert.ok(msg.includes(flag), `it must name the offending flag ${flag}`);
  assert.ok(msg.includes(JSON.stringify(value)), `it must quote the value received: ${JSON.stringify(value)}`);
  assert.match(msg, /accepted form: a number/, "it must state the accepted form");
  assert.match(msg, /Nothing was written/, "it must say nothing was written");
}

test("seam 2: numericFlagRefusal REFUSES --pool-max abc, naming flag, received value and accepted form", () => {
  assertNumericRefusalIsActionable(numericFlagRefusal(ABC_ARGV), "--pool-max", "abc");
});

test("seam 2: a numeric flag given NO value at all refuses, naming the missing value", () => {
  // `--pool-max` with nothing after it is the same defect as `--pool-max abc`:
  // the value was dropped in silence and the default was used.
  const msg = numericFlagRefusal(["promptd", "--pool-max"]);
  assert.notEqual(msg, "", "a valueless numeric flag must refuse");
  assert.match(msg, /malformed value for --pool-max/, "it must name the flag");
  assert.match(msg, /NO value/, "it must say the value was absent, not malformed");
  assert.match(msg, /accepted form/, "it must still state the accepted form");
});

test("seam 2: a BLANK numeric value refuses (it is not a number)", () => {
  const msg = numericFlagRefusal(["promptd", "--pool-max", "   "]);
  assertNumericRefusalIsActionable(msg, "--pool-max", "   ");
});

test("seam 2: EVERY numeric flag the parser derives REFUSES a malformed value (exhaustive)", () => {
  // A hand-typed numeric list beside the parser is how `--max-tasks abc` slips
  // through while `--pool-max abc` is caught.
  const numeric = numericFlagsFrom(parseFlagsSource());
  assert.ok(numeric.size >= 3, `the parser must really have numeric flags (got ${numeric.size})`);
  for (const flag of numeric) {
    const msg = numericFlagRefusal([flag, "not-a-number"]);
    assert.notEqual(msg, "", `${flag} takes a Number(...) value, so ${flag} not-a-number must refuse`);
    assert.ok(msg.includes(flag), `the refusal for ${flag} must name ${flag}`);
    assert.match(msg, /accepted form/, `the refusal for ${flag} must state the accepted form`);
  }
});

test("seam 2: a WELL-FORMED numeric value is accepted (the seam must not block real work)", () => {
  assert.equal(numericFlagRefusal(["promptd", "--pool-max", "8"]), "");
  assert.equal(numericFlagRefusal(["promptd", "--pool-min", "2"]), "");
  assert.equal(numericFlagRefusal(["--port", "9222"]), "");
  assert.equal(numericFlagRefusal(["--timeout-ms", "60000"]), "");
});

/**
 * THE deliberate non-refusal. Today `Number(0) || undefined` means `0` IS
 * UNSET. Whether that is "zero" or "auto" is a product question the gate does
 * not settle, so narrowing this refusal to non-NaN input is deliberate. A future
 * reader who "fixes" this to refuse `0` is changing a documented product
 * decision, not fixing a bug — so it lives in a named helper the MUTATION test
 * can point a broken twin at.
 */
function assertZeroStaysLegal(fn: NumericRefusal): void {
  for (const flag of ["--pool-min", "--port", "--timeout-ms", "--pool-max"]) {
    assert.equal(fn([flag, "0"]), "", `${flag} 0 must stay legal — GOAL 215 leaves 0 AMBIGUOUS`);
  }
  // Negative and fractional values parse, were accepted before, and narrowing
  // the rule to NaN is the whole of the mandate.
  assert.equal(fn(["--port", "-1"]), "", "-1 parses; it was accepted before and stays accepted");
  assert.equal(fn(["--pool-max", "2.5"]), "", "2.5 parses; it was accepted before and stays accepted");
}

test("seam 2: DELIBERATE NON-REFUSAL — 0 is NOT refused, because GOAL 215 leaves it AMBIGUOUS", () => {
  assertZeroStaysLegal(numericFlagRefusal);
});

// ============================================ THE SHARED "flag-shaped" WALKER ===

test("flagTokens: a value that LOOKS like a flag is consumed as the flag's VALUE, never scanned", () => {
  // THE crux of GOAL 215: `--site --weird-dir` is a site NAMED `--weird-dir`, a
  // legal input. Refusing it would make the tool hostile to a directory- or
  // URL-shaped value, which is exactly what `--site` is for.
  const tokens = flagTokens(VALUE_LOOKS_LIKE_FLAG_ARGV);
  assert.deepEqual(tokens, [{ flag: "--site", value: "--weird", missingValue: false }]);
  assert.equal(
    unknownFlagRefusal(VALUE_LOOKS_LIKE_FLAG_ARGV),
    "",
    "a flag-valued-looking token is NOT an unknown-flag refusal",
  );
  assert.equal(numericFlagRefusal(VALUE_LOOKS_LIKE_FLAG_ARGV), "", "…nor a malformed numeric value");
});

test("flagTokens: an UNKNOWN flag consumes nothing, so the token after it is still scanned", () => {
  // The mirror of the case above, and the reason the walker agrees with
  // firstNonFlagArg BY CONSTRUCTION rather than by promise.
  const tokens = flagTokens(["prompt", "--bogus", "--also-bogus"]);
  assert.deepEqual(
    tokens.map((t) => t.flag),
    ["--bogus", "--also-bogus"],
    "an unknown flag must not swallow the token after it, or a second bad flag would go unseen",
  );
});

test("flagTokens: a positional (command, subcommand, host, URL, prompt text) is NEVER a flag", () => {
  for (const argv of [
    ["prompt", "hi"],
    ["profile", "capture", "https://example.invalid/x"],
    ["requirements", "gemini"],
    ["hub", "publish", "example.invalid"],
    ["prompt", "-"], // a bare dash is not a flag
    ["prompt", "-x"], // a single-dash token is not a flag either
  ]) {
    assert.deepEqual(flagTokens(argv), [], `${JSON.stringify(argv)} contains no --x token and yields no flag tokens`);
    assert.equal(unknownFlagRefusal(argv), "", `${JSON.stringify(argv)} must not be refused`);
  }
});

test("flagTokens: missingValue is true ONLY for a value-taking flag with no token after it", () => {
  assert.equal(flagTokens(["--pool-max"])[0]?.missingValue, true, "a valueless value-taking flag is missing its value");
  assert.equal(flagTokens(["--sites"])[0]?.missingValue, false, "a boolean flag takes no value and is never missing one");
  assert.equal(flagTokens(["--pool-max", "8"])[0]?.missingValue, false, "a supplied value is not missing");
});

// ================================================ SEAM 3: needs-companion flag ===

test("seam 3: --xhost-all WITHOUT --assist refuses, naming --assist as the flag it needs", () => {
  const msg = needsCompanionRefusal("profile", "capture", { xhostAll: true });
  assert.notEqual(msg, "", "--xhost-all alone must refuse — nothing reads it");
  assert.match(msg, /--xhost-all/, "it must name the offending flag");
  assert.match(msg, /--assist/, "it must name the flag it needs");
  assert.match(msg, /read only inside that branch/, "it must say why the flag was inert");
  assert.match(msg, /ui2api profile capture <url> --assist --xhost-all/, "it must give the re-run command");
  assert.match(msg, /Nothing was written/, "it must say nothing was written");
});

test("seam 3: --xhost-all WITH --assist is ACCEPTED (the legal pairing must stay legal)", () => {
  assert.equal(needsCompanionRefusal("profile", "capture", { xhostAll: true, assist: true }), "");
  assert.equal(needsCompanionRefusal("profile", "capture", { assist: true }), "");
  assert.equal(needsCompanionRefusal("profile", "capture", {}), "");
});

test("seam 3: the pairing is COMMAND-SCOPED — the same flag elsewhere is merely inert, which stays LEGAL", () => {
  // Refusing `--xhost-all` on `prompt`, or `--port` on `profile list`, would be
  // hostile strictness rather than honesty: the operator typed a flag that does
  // not apply to that command, and saying so is not worth a refusal.
  assert.equal(needsCompanionRefusal("prompt", "hi", { xhostAll: true }), "");
  assert.equal(needsCompanionRefusal("profile", "list", { xhostAll: true }), "");
  assert.equal(needsCompanionRefusal("profile", "import", { xhostAll: true }), "");
  assert.equal(needsCompanionRefusal("promptd", undefined, { port: 9222 }), "");
});

test("seam 3: EVERY needs-companion pairing in the seam fires (exhaustive over the three)", () => {
  // Three pairings exist. A silent one is a contradiction the operator typed and
  // the tool reported as work it did not do.
  const xhost = needsCompanionRefusal("profile", "capture", { xhostAll: true });
  const repo = needsCompanionRefusal("hub", "publish", { registryRepo: "https://example.invalid/r.git" });
  const port = needsCompanionRefusal("hub", "run", { port: 9222 });
  assert.notEqual(xhost, "", "pairing 1 (--xhost-all without --assist) must fire");
  assert.notEqual(repo, "", "pairing 2 (--registry-repo without --mirror) must fire");
  assert.notEqual(port, "", "pairing 3 (hub run --port without --acp) must fire");
  assert.match(repo, /--registry-repo/, "pairing 2 must name its flag");
  assert.match(repo, /--mirror/, "pairing 2 must name the flag it needs");
  assert.match(port, /--port/, "pairing 3 must name its flag");
  assert.match(port, /--acp/, "pairing 3 must name the flag it needs");
  // And each pairing is silent when its companion IS present.
  assert.equal(needsCompanionRefusal("hub", "publish", { registryRepo: "https://example.invalid/r.git", mirror: true }), "");
  assert.equal(needsCompanionRefusal("hub", "run", { port: 9222, acp: true }), "");
});

// ================================================ INERT-BUT-WELL-FORMED IS OK ===

test("seam 1+2 together: an inert-but-WELL-FORMED flag on a command that ignores it is legal", () => {
  // `prompt --sites --port 9222`: `--port` means nothing to `--sites`, but it is
  // a KNOWN flag with a WELL-FORMED value. Refusing that would be refusing the
  // operator's own guesswork at a flag the tool documents. Only UNKNOWN or
  // MALFORMED input refuses.
  const argv = ["prompt", "--sites", "--port", "9222"];
  assert.equal(unknownFlagRefusal(argv), "");
  assert.equal(numericFlagRefusal(argv), "");
  assert.equal(flagTokens(argv).length, 2, "both flags are recognised tokens");
});

// ================================================================= WIRING =====
// A correct helper behind an UNUSED call site is the original defect class, so
// the call sites are read back from src/cli.ts: each refusal is consulted AT THE
// DISPATCH SEAM, and it THROWS (nonzero exit) before the switch — never logs.

test("WIRING: all three refusals are consulted in main(), before the command switch", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  const start = cli.indexOf("function main(");
  assert.ok(start > 0, "main() located");
  const body = cli.slice(start, cli.indexOf("\nasync function ", start + 10) > 0 ? cli.indexOf("\nasync function ", start + 10) : cli.length);
  const switchAt = body.indexOf("switch (cmd)");
  assert.ok(switchAt > 0, "the command switch located inside main()");
  for (const [name, guard] of [
    ["unknownFlagRefusal", "unknownFlag"],
    ["numericFlagRefusal", "badNumeric"],
    ["needsCompanionRefusal", "needsCompanion"],
  ] as const) {
    const callAt = body.indexOf(`${name}(`);
    assert.ok(callAt > 0, `${name} must be consulted in main() — an unused helper is the original defect`);
    assert.match(body, new RegExp(`const ${guard} = `), `${guard} must capture the refusal`);
    assert.ok(body.indexOf(`if (${guard})`) < switchAt, `${name} must refuse BEFORE the switch, i.e. before every command`);
  }
});

test("WIRING: each refusal THROWS (a nonzero exit a script can test), never logs", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  const start = cli.indexOf("function main(");
  const body = cli.slice(start);
  for (const guard of ["unknownFlag", "badNumeric", "needsCompanion"]) {
    assert.match(
      body,
      new RegExp(`if \\(${guard}\\) throw new Error\\(${guard}\\);`),
      `${guard} must THROW — an exit 0 that reads as success is the defect itself`,
    );
  }
});

// ============================================================== MUTATION =====
// The SAME predicates the tests above used, run against deliberately BROKEN
// twins. If a mutant survives, the corresponding real assertion is vacuous.

/** (a) The pre-fix shape: every flag is fine, so the refusal returns "". */
const unknownRefusalPreFix: UnknownRefusal = () => "";

/** (a') Refuses, but stops naming the flag or the remedy — not actionable. */
const unknownRefusalBare: UnknownRefusal = (argv) =>
  argv.some((a) => a.startsWith("--bogus")) ? "unknown flag" : "";

/** (a'') Refuses with a HAND-TYPED count that has nothing to do with the parser. */
const unknownRefusalHardcodedCount: UnknownRefusal = () =>
  "unknown flag --bogus — nothing ran. This CLI knows exactly 7 flags and --bogus is not one.";

/** (b) The pre-fix shape: `Number("abc") || undefined` never notices. */
const numericRefusalPreFix: NumericRefusal = () => "";

/** (b') "Tightened" past the mandate: refuses `0` too, overriding GOAL 215. */
const numericRefusalRefusesZero: NumericRefusal = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pool-min" || argv[i] === "--port" || argv[i] === "--timeout-ms") {
      return `malformed value for ${argv[i]}: got ${JSON.stringify(argv[i + 1] ?? "")}`;
    }
  }
  return "";
};

/** (c) A walker that scans every `--x` token, so a flag's VALUE gets flagged. */
const tokensNoValueSkip: Tokener = (argv) =>
  argv.filter((t) => t.startsWith("--")).map((flag) => ({ flag, missingValue: false }));

/** (d) The pre-fix shape: no contradiction is ever detected. */
const companionRefusalPreFix: CompanionRefusal = () => "";

/** (d') Detects the contradiction but names neither flag nor remedy. */
const companionRefusalBare: CompanionRefusal = (cmd, arg, flags) =>
  cmd === "profile" && arg === "capture" && flags.xhostAll && !flags.assist
    ? "this flag cannot be used alone"
    : "";

test("MUTATION (a): if unknownFlagRefusal returned \"\" for an unknown flag, the pin fails", () => {
  assert.notEqual(unknownFlagRefusal(BOGUS_ARGV), "", "precondition: the real seam refuses");
  assert.equal(unknownRefusalPreFix(BOGUS_ARGV), "", "the pre-fix twin returns \"\" — the silent no-op itself");
  assert.throws(
    () => assertUnknownRefusalIsActionable(unknownRefusalPreFix(BOGUS_ARGV), "--bogus"),
    "the SAME assertion the real test uses must reject the silent twin",
  );
});

test("MUTATION (a'): if the unknown-flag refusal stopped naming the flag and the remedy, the pin fails", () => {
  assert.throws(
    () => assertUnknownRefusalIsActionable(unknownRefusalBare(BOGUS_ARGV), "--bogus"),
    "a refusal that names neither the offending flag nor --help is not actionable",
  );
  assert.doesNotThrow(() => assertUnknownRefusalIsActionable(unknownFlagRefusal(BOGUS_ARGV), "--bogus"));
});

test("MUTATION (a''): if the flag COUNT were hand-typed instead of derived, the pin fails", () => {
  const derived = knownFlagsFrom(parseFlagsSource()).size + 1;
  const claimedOf = (msg: string): number => Number(/knows exactly (\d+) flags/.exec(msg)?.[1] ?? -1);
  assert.equal(claimedOf(unknownFlagRefusal(BOGUS_ARGV)), derived, "precondition: the real count is derived");
  assert.notEqual(
    claimedOf(unknownRefusalHardcodedCount(BOGUS_ARGV)),
    derived,
    "a hardcoded count that disagrees with the parser must be rejected",
  );
});

test("MUTATION (b): if numericFlagRefusal accepted \"abc\", the pin fails", () => {
  assert.notEqual(numericFlagRefusal(ABC_ARGV), "", "precondition: the real seam refuses a non-number");
  assert.equal(numericRefusalPreFix(ABC_ARGV), "", "the pre-fix twin returns \"\" — the silent 'auto' coercion");
  assert.throws(
    () => assertNumericRefusalIsActionable(numericRefusalPreFix(ABC_ARGV), "--pool-max", "abc"),
    "the SAME assertion the real test uses must reject the coercing twin",
  );
});

test("MUTATION (b'): if numericFlagRefusal started refusing 0, the pin fails", () => {
  // Overriding GOAL 215's deliberate AMBIGUITY is a product change, so it must
  // not happen by accident.
  const zeroRefused = (fn: NumericRefusal): boolean => fn(["--pool-min", "0"]) !== "";
  assert.equal(zeroRefused(numericFlagRefusal), false, "precondition: 0 stays legal");
  assert.equal(zeroRefused(numericRefusalRefusesZero), true, "the tightened twin refuses 0 and must be rejected");
  assert.doesNotThrow(
    () => assertZeroStaysLegal(numericFlagRefusal),
    "the SAME helper the real test uses must accept the real seam",
  );
  assert.throws(
    () => assertZeroStaysLegal(numericRefusalRefusesZero),
    "the SAME helper the real test uses must reject the 0-refusing twin",
  );
});

test("MUTATION (c): if flagTokens stopped skipping a value-taking flag's value, the pin fails", () => {
  const realTokens = flagTokens(VALUE_LOOKS_LIKE_FLAG_ARGV);
  assert.deepEqual(realTokens, [{ flag: "--site", value: "--weird", missingValue: false }], "precondition");
  const mutantTokens = tokensNoValueSkip(VALUE_LOOKS_LIKE_FLAG_ARGV);
  assert.deepEqual(
    mutantTokens.map((t) => t.flag),
    ["--site", "--weird"],
    "the mutant scans the VALUE too, so it would flag a legal site named --weird",
  );
  assert.throws(
    () => assert.deepEqual(mutantTokens, realTokens),
    "the SAME assertion the real test uses must reject the value-scanning twin",
  );
  // And the consequence the seam exists to prevent: with that walker, the legal
  // input `prompt "hi" --site --weird` would be refused as an unknown flag.
  const mutantUnknown = (argv: string[]): string =>
    tokensNoValueSkip(argv).find((t) => !knownFlagsFrom(parseFlagsSource()).has(t.flag)) ? "unknown flag" : "";
  assert.equal(mutantUnknown(VALUE_LOOKS_LIKE_FLAG_ARGV) !== "", true, "the mutant refuses legal input — the regression");
  assert.equal(unknownFlagRefusal(VALUE_LOOKS_LIKE_FLAG_ARGV), "", "…and the real seam does not");
});

test("MUTATION (d): if needsCompanionRefusal returned \"\", the pin fails", () => {
  assert.notEqual(
    needsCompanionRefusal("profile", "capture", { xhostAll: true }),
    "",
    "precondition: the real seam refuses the contradiction",
  );
  assert.equal(
    companionRefusalPreFix("profile", "capture", { xhostAll: true }),
    "",
    "the pre-fix twin returns \"\" — a capture that reports work it did not do",
  );
  assert.throws(() => assert.match(companionRefusalBare("profile", "capture", { xhostAll: true }), /--assist/));
});

test("MUTATION (d'): if the companion refusal stopped naming the flag it needs, the pin fails", () => {
  const namesRemedy = (msg: string): boolean => msg.includes("--assist");
  assert.equal(namesRemedy(needsCompanionRefusal("profile", "capture", { xhostAll: true })), true, "precondition");
  assert.equal(namesRemedy(companionRefusalBare("profile", "capture", { xhostAll: true })), false, "must be rejected");
});