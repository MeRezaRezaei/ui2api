// WHY THIS FILE EXISTS — the SILENT NO-OP FLAG defect class, pinned.
//
// A flag that is PARSED and ACCEPTED but read NOWHERE, on a command that then
// exits 0, is worse than an unknown flag. An unknown flag is ignored by every
// CLI tool on earth and nobody builds against it. A silently-accepted flag
// tells the user IT WORKED — and they go on to build against an `acp.ts` that
// was never written, or, far worse, against a vault they believe was only
// REPORTED while it was actually CHMOD-ed. The failure surfaces somewhere else,
// much later, and the flag is the reason it is hard to see.
//
// Two refusals were added for exactly this class, in src/cli.ts:
//
//   1. `generateTargetRefusal(flags)` — `ui2api generate --acp` and
//      `ui2api generate --skill` were parsed and never read. `generate` emits
//      the MCP server and nothing else, and it exited 0. So the fix is NOT to
//      wire the flags: it is to NAME the real ACP path (`ui2api hub publish
//      <host>` then `ui2api hub run <host> --acp`, which DOES read `--acp`
//      today), say `--skill` has no CLI surface at all, exit nonzero, and write
//      nothing.
//
//   2. `vaultTightenModeArg(flags)` — `--dry-run` was parsed at the flag table
//      and read NOWHERE. The handler computed `apply` from `flags.apply`
//      ALONE (`{ dryRun: !apply }`), so the pair `--apply --dry-run` — an
//      operator asking for BOTH, which is precisely the confused sentence a
//      credential-permission tool gets — silently APPLIED. `vault tighten`
//      rewrites 0600/0700 on files holding REAL cookies and Bearer tokens. A
//      silent apply there is a security event, not a papercut. The refusal now
//      names both flags and refuses; the dry-run DEFAULT is unchanged and is
//      pinned here separately, because a fix that "resolved" the contradiction
//      by defaulting to apply would be strictly worse than the bug.
//
// DO NOT "simplify" either refusal away as unnecessary validation. The
// validation IS the fix. Deleting the throw in `vaultTightenModeArg` restores
// the security regression below; deleting the refusal in `generateTargetRefusal`
// restores a flag that lies. The MUTATION tests at the bottom exist to prove
// each assertion BITES, because a pin that cannot fail is not a pin.
//
// Both functions are PURE (no I/O, no browser, no vault), so the whole contract
// is testable by direct call — same pattern as the GOAL 85 `addAllModeArg` pins
// in test/cli-argv.test.ts. The wiring assertions read src/cli.ts back so a
// refactor cannot leave a correct helper behind an UNUSED call site, which is
// how the original defect survived in the first place.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { generateTargetRefusal, vaultTightenModeArg } from "../src/cli.js";

type GenerateFlags = { acp?: boolean; skill?: boolean };
type VaultFlags = { apply?: boolean; dryRun?: boolean };

/** The real signatures, so the MUTATION tests can substitute a broken twin. */
type GenerateRefusal = (flags: GenerateFlags) => string;
type VaultMode = (flags: VaultFlags) => "apply" | "dry-run";

// ==================================================== generateTargetRefusal ===

/**
 * The ACP refusal must be ACTIONABLE, not merely negative. A refusal that only
 * says "no" is a refusal the operator works around by guessing — so this asserts
 * the REAL, WORKING path by name: `hub publish` then `hub run <host> --acp`.
 */
function assertAcpRefusalIsActionable(msg: string): void {
  assert.notEqual(msg, "", "an --acp refusal must not be empty — an empty string IS the silent no-op");
  assert.match(msg, /--acp/, "the refusal must name the offending flag");
  assert.match(msg, /MCP server only/, "it must say what the command actually emits");
  assert.match(msg, /ui2api hub publish <host>/, "it must name the real path: publish the package");
  assert.match(msg, /ui2api hub run <host> --acp/, "it must name the real path: hub run --acp");
  assert.match(msg, /Nothing was written/, "it must say nothing was written");
}

/** The `--skill` refusal must say there is NO CLI surface, not imply one exists. */
function assertSkillRefusalIsActionable(msg: string): void {
  assert.notEqual(msg, "", "a --skill refusal must not be empty — an empty string IS the silent no-op");
  assert.match(msg, /--skill/, "the refusal must name the offending flag");
  assert.match(msg, /no CLI surface at all/, "--skill must be refused as having no CLI surface");
  assert.match(msg, /generate\(map, dir, "mcp", \{ skill: true \}\)/, "it must name the only real surface: the generator API");
  assert.match(msg, /Nothing was written/, "it must say nothing was written");
}

test("generateTargetRefusal: no flag set returns \"\" — the normal generate path is untouched", () => {
  assert.equal(generateTargetRefusal({}), "");
  assert.equal(generateTargetRefusal({ acp: false, skill: false }), "");
  assert.equal(generateTargetRefusal({ acp: false }), "");
  assert.equal(generateTargetRefusal({ skill: false }), "");
});

test("generateTargetRefusal: --acp REFUSES and names the real working ACP path", () => {
  const msg = generateTargetRefusal({ acp: true });
  assertAcpRefusalIsActionable(msg);
  assert.doesNotMatch(msg, /--skill/, "the header names ONLY the flags actually passed");
  assert.doesNotMatch(msg, /no CLI surface at all/, "the --skill advice must not appear when --skill was not passed");
});

test("generateTargetRefusal: --skill REFUSES as having no CLI surface at all", () => {
  const msg = generateTargetRefusal({ skill: true });
  assertSkillRefusalIsActionable(msg);
  assert.doesNotMatch(msg, /ui2api hub run <host> --acp/, "the ACP advice must not appear when --acp was not passed");
});

test("generateTargetRefusal: BOTH flags refuse, naming both and giving both remedies", () => {
  const msg = generateTargetRefusal({ acp: true, skill: true });
  assertAcpRefusalIsActionable(msg);
  assertSkillRefusalIsActionable(msg);
  assert.match(msg, /--acp and --skill/, "both offending flags are named together");
  assert.match(msg, /never read --acp nor --skill/, "the message says the flags were read by neither branch");
});

test("generateTargetRefusal: EVERY set flag produces a NON-EMPTY refusal (no combination escapes)", () => {
  // Exhaustive over the four combinations: a silent no-op is exactly one of them
  // returning "". This is the assertion that would have caught the original bug.
  const combos: GenerateFlags[] = [{}, { acp: true }, { skill: true }, { acp: true, skill: true }];
  for (const flags of combos) {
    const expected = flags.acp || flags.skill ? "refuse" : "no refusal";
    assert.equal(
      generateTargetRefusal(flags) === "" ? "no refusal" : "refuse",
      expected,
      `combo ${JSON.stringify(flags)} must ${expected}`,
    );
  }
});

// ====================================================== vaultTightenModeArg ===

test("vaultTightenModeArg: DEFAULT is \"dry-run\" — no flag must never tighten the vault", () => {
  // THE SECURITY PIN. `vault tighten` rewrites 0600/0700 on files holding real
  // cookies and Bearer tokens; a default of `apply` would chmod a user's whole
  // session vault the moment they mistyped a flag. This is the single assertion
  // below that would catch a silent re-introduction of the regression.
  assert.equal(vaultTightenModeArg({}), "dry-run");
  assert.equal(vaultTightenModeArg({ apply: false }), "dry-run");
  assert.equal(vaultTightenModeArg({ dryRun: false }), "dry-run");
  assert.equal(vaultTightenModeArg({ apply: false, dryRun: false }), "dry-run");
});

test("vaultTightenModeArg: --apply means \"apply\" and --dry-run means \"dry-run\" (both flags are LIVE)", () => {
  assert.equal(vaultTightenModeArg({ apply: true }), "apply");
  assert.equal(vaultTightenModeArg({ dryRun: true }), "dry-run");
  assert.equal(vaultTightenModeArg({ apply: false, dryRun: true }), "dry-run");
  assert.equal(vaultTightenModeArg({ apply: true, dryRun: false }), "apply");
});

test("vaultTightenModeArg: THE silent swallow pinned — --apply AND --dry-run REFUSES, naming BOTH flags", () => {
  // Before the fix this combination APPLIED silently: the handler keyed off
  // `flags.apply` alone, so the ignored `--dry-run` cost nothing.
  assert.throws(
    () => vaultTightenModeArg({ apply: true, dryRun: true }),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /cannot combine --apply and --dry-run/, "the refusal must name the contradiction");
      assert.match(msg, /--apply/, "the refusal must name --apply");
      assert.match(msg, /--dry-run/, "the refusal must name --dry-run");
      assert.match(msg, /tighten the vault vs report only/, "it must say what each flag would have meant");
      assert.match(msg, /exactly one/, "it must tell the operator how to proceed");
      return true;
    },
  );
});

// ============================================================== MUTATION =====
// The SAME predicates the tests above used, run against deliberately BROKEN
// twins of the two functions. If a mutant survives, the corresponding real
// assertion is vacuous and does not pin anything.

/** (a) The pre-fix shape: `--dry-run` ignored, contradiction swallowed. */
const vaultModePreFix: VaultMode = (flags) => (flags.apply ? "apply" : "dry-run");

/** (c) A "fix" that resolved the contradiction by defaulting to APPLY. */
const vaultModeDefaultApply: VaultMode = (flags) =>
  flags.apply && flags.dryRun
    ? (() => {
        throw new Error("cannot combine --apply and --dry-run");
      })()
    : "apply";

/** (a') Still throws, but stops naming the flags — a refusal nobody can act on. */
const vaultModeSilentThrow: VaultMode = (flags) => {
  if (flags.apply && flags.dryRun) throw new Error("invalid flag combination");
  return flags.apply ? "apply" : "dry-run";
};

/** (b) The pre-fix shape: a set flag produces the empty string ⇒ silent no-op. */
const generateRefusalPreFix: GenerateRefusal = () => "";

/** (b') Refuses, but only says "no" — no real path to run instead. */
const generateRefusalWithoutPath: GenerateRefusal = (flags) =>
  flags.acp || flags.skill ? `ui2api generate: unsupported flag (a silent no-op, exit 0).` : "";

test("MUTATION (a): if the vault refusal STOPPED THROWING on --apply --dry-run, a test fails", () => {
  // Same predicate the real contradiction test uses.
  const throwsOnPair = (fn: VaultMode): boolean => {
    try {
      fn({ apply: true, dryRun: true });
      return false;
    } catch {
      return true;
    }
  };
  assert.equal(throwsOnPair(vaultTightenModeArg), true, "precondition: the real function refuses the pair");
  assert.equal(
    throwsOnPair(vaultModePreFix),
    false,
    "the pre-fix twin swallows the contradiction and returns \"apply\" — the security regression itself",
  );
  // And the exact form used above:
  assert.throws(() => vaultTightenModeArg({ apply: true, dryRun: true }));
  assert.doesNotThrow(
    () => vaultModePreFix({ apply: true, dryRun: true }),
    "the pre-fix twin silently returns \"apply\" for --apply --dry-run — the regression this file exists to keep dead",
  );
});

test("MUTATION (a'): if the throw stopped NAMING the flags, a test fails", () => {
  const namesBothFlags = (fn: VaultMode): boolean => {
    try {
      fn({ apply: true, dryRun: true });
    } catch (e) {
      const msg = (e as Error).message;
      return msg.includes("--apply") && msg.includes("--dry-run");
    }
    return false;
  };
  assert.equal(namesBothFlags(vaultTightenModeArg), true, "precondition: the real refusal names both flags");
  assert.equal(
    namesBothFlags(vaultModeSilentThrow),
    false,
    "a refusal that names neither flag is not actionable — the pin must reject it",
  );
});

test("MUTATION (b): if generateTargetRefusal returned \"\" for a SET flag, a test fails", () => {
  const refusesAcp: GenerateRefusal = generateTargetRefusal;
  assert.notEqual(refusesAcp({ acp: true }), "", "precondition: a set flag produces a refusal");
  assert.equal(generateRefusalPreFix({ acp: true }), "", "the pre-fix twin returns the empty string — the silent no-op");
  assert.equal(generateRefusalPreFix({ skill: true }), "", "…for --skill as well");
  assertAcpRefusalIsActionable(refusesAcp({ acp: true }));
  assert.throws(
    () => assertAcpRefusalIsActionable(generateRefusalPreFix({ acp: true })),
    "the same assertion the real test uses must reject the silent twin",
  );
});

test("MUTATION (b'): if the refusal dropped the REAL ACP path, a test fails", () => {
  assertAcpRefusalIsActionable(generateTargetRefusal({ acp: true }));
  assert.throws(
    () => assertAcpRefusalIsActionable(generateRefusalWithoutPath({ acp: true })),
    "a refusal that does not tell the operator what to run instead is a refusal that gets worked around",
  );
});

test("MUTATION (c): SECURITY — if the DEFAULT mode flipped from \"dry-run\" to \"apply\", a test fails", () => {
  // The one that would silently re-introduce the security regression: the
  // contradiction is still refused, but a bare `vault tighten` would now CHMOD
  // real cookies and Bearer tokens. Nothing else in the suite names the default.
  const isDryRunByDefault = (fn: VaultMode): boolean =>
    fn({}) === "dry-run" && fn({ apply: false }) === "dry-run" && fn({ dryRun: false }) === "dry-run";
  assert.equal(isDryRunByDefault(vaultTightenModeArg), true, "precondition: the real default is a dry run");
  assert.equal(
    isDryRunByDefault(vaultModeDefaultApply),
    false,
    'the mutated twin defaults to "apply" — a bare `vault tighten` would rewrite the vault',
  );
  // The exact assertion used by the default test above:
  assert.equal(vaultTightenModeArg({}), "dry-run");
  assert.throws(() => assert.equal(vaultModeDefaultApply({}), "dry-run"));
  // …and the twin still refuses the pair, proving (c) is caught by the DEFAULT
  // pin and not merely by the contradiction pin.
  assert.equal(throwsOnPair(vaultModeDefaultApply), true);
});

function throwsOnPair(fn: VaultMode): boolean {
  try {
    fn({ apply: true, dryRun: true });
    return false;
  } catch {
    return true;
  }
}

// ============================================================== WIRING =======
// A correct helper behind an UNUSED call site is the original defect, so the
// call sites are read back from src/cli.ts.

test("WIRING: cmdGenerate consults generateTargetRefusal and throws BEFORE it writes anything", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  const start = cli.indexOf("async function cmdGenerate");
  const body = cli.slice(start, cli.indexOf("async function cmdServe", start));
  assert.ok(start > 0 && body.length > 0, "cmdGenerate body located");
  assert.match(body, /const refusal = generateTargetRefusal\(flags\);/);
  assert.match(body, /if \(refusal\) throw new Error\(refusal\);/, "a refusal must THROW (nonzero exit), not be logged");
  assert.ok(
    body.indexOf("generateTargetRefusal(flags)") < body.indexOf("generate(map, root)"),
    "the refusal must precede the generate() call — nothing may be written for a refused flag",
  );
  // The parser must still map BOTH tokens, or the refusal can never name them.
  assert.match(cli, /if \(argv\[i\] === "--acp"\) f\.acp = true;/);
  assert.match(cli, /if \(argv\[i\] === "--skill"\) f\.skill = true;/);
});

test("WIRING: cmdVault takes its mode from vaultTightenModeArg, NOT from a raw flags.apply read", () => {
  // The pre-fix shape was `const apply = flags.apply === true;` — which is
  // exactly how `--dry-run` became inert. Pinning the RESOLVED mode keeps the
  // flag live and the contradiction reachable.
  const cli = readFileSync("src/cli.ts", "utf8");
  const start = cli.indexOf("async function cmdVault");
  const body = cli.slice(start, cli.indexOf("async function cmd", start + 20));
  assert.ok(start > 0 && body.length > 0, "cmdVault body located");
  assert.match(body, /const mode = vaultTightenModeArg\(flags\);/);
  assert.match(body, /const apply = mode === "apply";/);
  assert.ok(
    !/flags\.apply\s*===\s*true/.test(body),
    "the raw `flags.apply === true` read is gone — the resolved mode decides (that read is what made --dry-run inert)",
  );
  assert.ok(
    body.indexOf("vaultTightenModeArg(flags)") < body.indexOf("tightenVaultModes("),
    "the contradiction must refuse BEFORE the vault is touched",
  );
  // `--dry-run` and `--apply` are both still parsed, so the refusal can name them.
  assert.match(cli, /if \(argv\[i\] === "--dry-run"\) f\.dryRun = true;/);
  assert.match(cli, /if \(argv\[i\] === "--apply"\) f\.apply = true;/);
});
