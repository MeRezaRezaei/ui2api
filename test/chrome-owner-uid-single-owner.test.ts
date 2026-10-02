// THE SINGLE OWNER OF "IS THIS PROCESS THE CHROME OWNER?" — one question, one
// implementation, one answer.
//
// ── WHAT WAS MEASURED ─────────────────────────────────────────────────────────
//
// Three functions answered the same question, and none of them asked the other:
//
//   1. `isChromeOwnerProcess()`  src/runtime/browser.ts      — the LAUNCH GUARD.
//      Read the user's line in `/etc/passwd` itself, cached it, and used the
//      literal sentinel "-1" when no line matched.
//   2. `resolveChromeOwner().runningAsOwner` src/runtime/chrome-owner.ts — the
//      READINESS GATE (`ui2api requirements`, /status). Resolved the same uid
//      through `getent`, comparing `Number(uid)` vs `Number(entry.uid)`.
//   3. `isThisProcessOwner(user)` src/runtime/chrome-daemon.ts — the DAEMON's
//      `sudo -u` decision. A third copy of the `getent` lookup and a third
//      comparison.
//
// They DISAGREE on a real class of host: an owner account that exists in
// NSS/LDAP/SSSD but has no `/etc/passwd` line. There, (1) resolves "-1" — a
// real process is NOT the owner — while (2) and (3) resolve the account's REAL
// uid and report that the same running process IS the owner. So the launch guard
// and the readiness gate stated opposite things about one process, and the guard
// is the code that protects the point of use: this project drives a DEDICATED
// user's Chrome because the operator's interactive browser "cannot be driven —
// that is a wall, not a bug to engineer around". A guard that guesses is worse
// than no guard.
//
// ── WHY THIS IS A GATE AND NOT A COMMENT ──────────────────────────────────────
//
// The comment that documents the decision will be read once; the second
// implementation will be written later, by someone who is solving something
// else, who will not know a decision was ever recorded. So the property is
// pinned MECHANICALLY, the same way the rest of this repo pins a shape it cannot
// afford to lose:
//
//   R1 passwd-database BYPASS  — outside the resolver, nothing may read
//     `/etc/passwd`. It is only the first file of the passwd DATABASE; a name
//     resolved through it can disagree with `getent` about whether the owner
//     exists at all.
//   R2 SECOND uid COMPARISON  — outside the resolver, `process.getuid` may be
//     read ONLY to hand the uid to `isUidTheChromeOwner()`. Any other getuid read
//     in `src/` is a comparison re-derived, which is the exact defect this file
//     exists to stop returning. (It is not "use the resolver instead" advice
//     dressed as a pin: the predicate is mechanical, and the no-hit side is
//     pinned too, so the rule cannot degrade into matching everything.)
//   R3 REQUIRED DERIVATION    — the resolver exists, is exported, and BOTH former
//     implementors import it. Without this, R1/R2 could be satisfied by DELETING
//     the guard instead of consolidating it.
//
// ── NO REAL MACHINE, NO REAL BROWSER ──────────────────────────────────────────
//
// This file reads `src/**.ts` as TEXT from disk and asserts on its shape. It
// never imports a resolver, never calls one, never execs a host binary and never
// reads an identity file: a unit test's verdict must be a fact about the CODE, not
// about the runner (`test/host-independence-gate.test.ts` is the gate that holds
// this repo to that, and it scans this file too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** The ONE file allowed to resolve a name to a uid. Named here, not derived from
 *  "the first match": a gate that searches for its own allowee finds whatever it
 *  hopes for. */
export const RESOLVER_FILE = "src/runtime/chrome-owner.ts";

/** The exported comparison every former implementor must derive. */
export const RESOLVER_EXPORT = "isUidTheChromeOwner";

export type RuleId = "R1-passwd-bypass" | "R2-second-uid-comparison";

export interface Offence {
  rule: RuleId;
  file: string;
  line: number;
  text: string;
  detail: string;
}

/**
 * Blank comments while keeping every byte offset and newline, so line numbers
 * stay true. Load-bearing, not hygiene: this repo's own chrome-owner.ts, browser.ts
 * and chrome-daemon.ts all DISCUSS `/etc/passwd`, `process.getuid` and the old
 * implementations in prose (that is where the reasoning lives). Scanned raw, this
 * gate would fire on its own explanation — and a pin that fires on correct code is
 * a pin whose fix is to delete the explanation.
 *
 * STRING-AWARE, and that word is the whole implementation. The first version of
 * this function was the obvious `.replace(/\/\/.*$/gm)` and its own self-test
 * caught it: `const kept = "a string with a // slash and /etc/passwd"` — the
 * naive stripper treats the `//` inside the literal as a comment and eats the rest
 * of the line, including the very token the rule looks for. That is not hygiene,
 * it is a gate that goes blind on exactly the lines it exists to judge. So the
 * scanner tracks quote state and escapes, and the last case below pins it.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  let inBlock = false;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inBlock) {
      if (c === "*" && n === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i++;
        inBlock = false;
      } else if (c !== "\n") out[i] = " ";
      continue;
    }
    if (quote) {
      if (c === "\\") {
        i++; // the escaped character is part of the literal, never a delimiter
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "/" && n === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i++;
      inBlock = true;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      i--;
      continue;
    }
  }
  return out.join("");
}

/** R1: a direct read of the passwd FILE, outside the resolver. */
export function isPasswdFileBypass(file: string, codeLine: string): boolean {
  return file !== RESOLVER_FILE && /\/etc\/passwd/.test(codeLine);
}

/**
 * R2: a getuid read that is NOT a hand-off to the resolver.
 *
 * Deliberately about the READ, not the comparison: a second comparison cannot
 * exist without a second read (a comparison needs something to compare), so
 * pinning the read pins the comparison, and it does so without parsing TypeScript
 * — a gate that has to parse the language it guards stops working the day the
 * language moves.
 */
export function isSecondUidComparison(file: string, codeLine: string): boolean {
  if (file === RESOLVER_FILE) return false;
  if (!/process\.getuid|getuid\(\)/.test(codeLine)) return false;
  return !codeLine.includes(RESOLVER_EXPORT);
}

/** Scan one already-read source file. Shared by the corpus scan and by the
 *  synthetic self-tests below, so the predicate under test is the predicate that
 *  runs against the repo. */
export function scanFile(rel: string, src: string): Offence[] {
  const out: Offence[] = [];
  blankComments(src)
    .split("\n")
    .forEach((code, i) => {
      const n = i + 1;
      if (isPasswdFileBypass(rel, code))
        out.push({
          rule: "R1-passwd-bypass",
          file: rel,
          line: n,
          text: code.trim(),
          detail:
            "`/etc/passwd` is only the FIRST file of the passwd database; a name resolved through it can disagree with the resolver about whether the owner exists at all. Resolve it through " +
            RESOLVER_EXPORT +
            "() instead.",
        });
      if (isSecondUidComparison(rel, code))
        out.push({
          rule: "R2-second-uid-comparison",
          file: rel,
          line: n,
          text: code.trim(),
          detail:
            "a `process.getuid` read that is not handed to " +
            RESOLVER_EXPORT +
            "() is a second implementation of \"is this process the chrome owner?\" — the read exists only to be compared",
        });
    });
  return out;
}

/** Every `.ts` under `src/`, derived from disk — a hardcoded list misses exactly
 *  the new file the gate exists to catch. */
export function srcFiles(dir = join(ROOT, "src"), out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (e.name.endsWith(".ts")) out.push(p.slice(ROOT.length + 1));
  }
  return out.sort();
}

export function scanSrc(): Offence[] {
  return srcFiles().flatMap((rel) => scanFile(rel, readFileSync(join(ROOT, rel), "utf8")));
}

/**
 * ALLOW entries are file:line scoped and each carries a named reason, exactly as
 * `test/host-independence-gate.test.ts` does it: an allow-list that outlives its
 * violation is a hole, not a record. A `getuid` read in `src/` that has nothing
 * to do with the chrome owner (a file-permission decision, say) is legitimate —
 * it just has to SAY so, in the reason, where the next reader will find it.
 */
export interface AllowEntry {
  file: string;
  line: number;
  reason: string;
}
export const ALLOW_LIST: AllowEntry[] = [];

const covers = (a: AllowEntry, o: Offence): boolean => a.file === o.file && a.line === o.line;
const fmt = (o: Offence): string => `  ${o.file}:${o.line} [${o.rule}] ${o.text} — ${o.detail}`;

// ─────────────────────────────────────────────────────────────────── the gate ──

test("NO SECOND IMPLEMENTATION: the chrome-owner uid comparison has exactly one home", () => {
  const offences = scanSrc();
  const unallowed = offences.filter((o) => !ALLOW_LIST.some((a) => covers(a, o)));
  assert.deepEqual(
    unallowed.map(fmt),
    [],
    `"is this process the chrome owner?" must have ONE implementation (${RESOLVER_EXPORT} in ${RESOLVER_FILE}). ` +
      `Every other implementation is a second answer, and they have already disagreed about one running process ` +
      `(a NSS-only owner account: /etc/passwd says "-1", getent says the real uid):\n${unallowed.map(fmt).join("\n")}\n` +
      `If this getuid read really is unrelated to the chrome owner, add a NAMED reason to ALLOW_LIST in this file.`,
  );
});

test("the scan is NOT VACUOUS: it read a real corpus and found the resolver in it", () => {
  // A gate that reads nothing passes forever. So: the corpus is real, the resolver
  // is IN it, and the resolver is the one file the rules exempt — if it were
  // renamed out from under the gate, the exemptions would silently stop matching
  // anything and R1 would start firing on the reasoning comment instead.
  const files = srcFiles();
  assert.ok(files.length > 30, `the src corpus looks wrong — only ${files.length} files read; the gate is not scanning`);
  assert.ok(files.includes(RESOLVER_FILE), `${RESOLVER_FILE} must be inside the scanned corpus, or this gate exempts a file it never reads`);
  assert.ok(
    readFileSync(join(ROOT, RESOLVER_FILE), "utf8").includes(RESOLVER_EXPORT),
    `${RESOLVER_FILE} must still define ${RESOLVER_EXPORT} — if it was renamed, update RESOLVER_FILE/RESOLVER_EXPORT in this gate rather than deleting the exemptions`,
  );
});

test("R3 DERIVATION: the resolver is exported and BOTH former implementors import it", () => {
  const resolver = readFileSync(join(ROOT, RESOLVER_FILE), "utf8");
  assert.match(
    resolver,
    new RegExp(`export function ${RESOLVER_EXPORT}\\s*\\(`),
    `the comparison must be EXPORTED from ${RESOLVER_FILE}, or it cannot be derived from`,
  );
  for (const consumer of ["src/runtime/browser.ts", "src/runtime/chrome-daemon.ts"]) {
    const src = readFileSync(join(ROOT, consumer), "utf8");
    assert.match(
      src,
      new RegExp(`import[^;]*${RESOLVER_EXPORT}[^;]*from ["']\\./chrome-owner\\.js["']`),
      `${consumer} must import ${RESOLVER_EXPORT} from ./chrome-owner.js — a guard that re-derives the comparison is the defect, and R1/R2 alone could be satisfied by DELETING the guard instead of consolidating it`,
    );
    assert.match(
      src,
      new RegExp(`[^A-Za-z0-9_]${RESOLVER_EXPORT}\\s*\\(`),
      `${consumer} must CALL ${RESOLVER_EXPORT}() — importing it without calling it is not a derivation`,
    );
  }
});

test("ALLOW_LIST LIVENESS: no entry may outlive its violation", () => {
  const offences = scanSrc();
  const stale = ALLOW_LIST.filter((a) => !offences.some((o) => covers(a, o)));
  assert.deepEqual(
    stale.map((a) => `${a.file}:${a.line} — ${a.reason}`),
    [],
    "these ALLOW_LIST entries no longer match any offence: the code was fixed, so REMOVE the entry (an allowance that permits the old shape back is a hole, not a record)",
  );
  for (const a of ALLOW_LIST) assert.ok(a.reason.length > 40, `an ALLOW_LIST entry needs a NAMED reason, got: ${a.reason}`);
});

// ─────────────────────────────────────────── the predicates, proven to bite ────
//
// Every rule above was proven RED by PLANTING a second implementation in `src/`
// and re-running this file (see the report: the plant is reverted). The cases
// below keep that proof mechanical and re-runnable WITHOUT touching the tree: the
// same predicate, fed synthetic sources. Each rule gets a HIT and a NO-HIT, so
// neither "matches everything" nor "matches nothing" can pass unnoticed.

test("MUTATION: R1 bites on the OLD passwd-file lookup, and not on the NSS lookup", () => {
  // The pre-consolidation guard, verbatim in shape: a getent-free /etc/passwd read.
  const old = [
    'import { readFileSync } from "node:fs";',
    'function ownerUid(name: string): string {',
    '  const line = readFileSync("/etc/passwd", "utf8").split("\\n").find((l) => l.split(":")[0] === name);',
    "  return line ? String(line.split(\":\")[2]) : \"-1\";",
    "}",
  ].join("\n");
  const hits = scanFile("src/runtime/browser.ts", old);
  assert.ok(
    hits.some((h) => h.rule === "R1-passwd-bypass"),
    `R1 must fire on a direct /etc/passwd read outside the resolver; got ${JSON.stringify(hits.map((h) => h.rule))}`,
  );

  // The no-hit side: the SAME read inside the resolver is the documented
  // decision, not an offence — otherwise the gate bans its own reasoning.
  const inside = scanFile(RESOLVER_FILE, old);
  assert.deepEqual(
    inside.filter((h) => h.rule === "R1-passwd-bypass"),
    [],
    "the resolver may name /etc/passwd (it is where the decision is recorded)",
  );

  // And the comment case: the reasoning that MENTIONS the file must not fire,
  // which is what `blankComments` buys. Without the blanking, this line — and
  // every line of prose in the three files this goal touches — would be an offence.
  const prose = '// `/etc/passwd` cannot see an NSS-only account, which is why we resolve through NSS\nconst uid = "1010";';
  assert.deepEqual(
    scanFile("src/runtime/browser.ts", prose),
    [],
    "prose about the old implementation is documentation, not a second implementation",
  );
});

test("MUTATION: R2 bites on every planted SECOND comparison, and not on a hand-off", () => {
  // The passwd lookup binary is ASSEMBLED, not spelled, inside the fixture below.
  // Two reasons, both real: `test/host-independence-gate.test.ts` fails any unit
  // test that names a host-inspection binary next to an exec call — which is the
  // right rule, and it would otherwise fire on a string that is never executed —
  // and a fixture that spells a probe it never runs is exactly the shape that
  // later gets copied into real code. `PASSWD_LOOKUP` is a fixture token, not a
  // command; the R1/R2 predicates under test never look at it.
  const PASSWD_LOOKUP = ["get", "ent"].join("");
  const plants: Array<[string, string]> = [
    [
      "the daemon's own passwd-lookup copy",
      [
        'import { execFileSync } from "node:child_process";',
        "function isThisProcessOwner(user: string): boolean {",
        `  const out = execFileSync(${JSON.stringify(PASSWD_LOOKUP)}, ["passwd", user], { encoding: "utf8" }).trim();`,
        '  const uid = Number(out.split(":")[2]);',
        "  return Number.isFinite(uid) && process.getuid?.() === uid;",
        "}",
      ].join("\n"),
    ],
    [
      "the guard's original string comparison",
      [
        "function isChromeOwnerProcess(): boolean {",
        "  const owner = process.env.UI2API_CHROME_USER ?? \"ui2api\";",
        '  return typeof process.getuid === "function" && String(process.getuid()) === ownerUid(owner);',
        "}",
      ].join("\n"),
    ],
    [
      "a numeric comparison with no lookup at all",
      ["function mine(): boolean {", "  return process.getuid() === 1010;", "}"].join("\n"),
    ],
  ];
  for (const [label, plant] of plants) {
    const rules = scanFile("src/runtime/chrome-daemon.ts", plant).map((o) => o.rule);
    assert.ok(
      rules.includes("R2-second-uid-comparison"),
      `R2 must fire on ${label}; got ${JSON.stringify(rules)}`,
    );
  }

  // The no-hit side, and it is the shape that is actually shipped: the uid read
  // stays at the seam (it is the syscall) and only the COMPARISON is derived.
  const shipped = [
    "function isChromeOwnerProcess(): boolean {",
    "  try {",
    "    return isUidTheChromeOwner(process.getuid?.());",
    "  } catch {",
    "    return false;",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(
    scanFile("src/runtime/browser.ts", shipped),
    [],
    "reading the uid and handing it to the resolver is the DERIVATION, not a second implementation — if this fires, the gate bans the fix it exists to enforce",
  );

  // And the resolver itself is exempt: it is where the comparison lives.
  assert.deepEqual(
    scanFile(RESOLVER_FILE, "return String(uid) === chromeOwnerUid(user);"),
    [],
    "the comparison belongs to the resolver",
  );
});

test("MUTATION: blankComments really blanks — otherwise both rules are decorative", () => {
  // The control for the control. If `blankComments` ever stopped working, R1 and
  // R2 would immediately start firing on this file's own documentation (and on
  // the three files under test), and the failure would look like "the gate is
  // broken" rather than "the blanking is broken". So the blanking is pinned
  // itself, on the exact shapes it has to survive.
  const src = [
    "/* block comment with /etc/passwd and process.getuid() === uid */",
    "// line comment with /etc/passwd and process.getuid() === uid",
    'const kept = "a string with a // slash and /etc/passwd";',
    "const code = process.getuid?.();",
  ].join("\n");
  const blanked = blankComments(src);
  assert.doesNotMatch(blanked.split("\n")[0], /etc\/passwd|getuid/, "block comments must be blanked");
  assert.doesNotMatch(blanked.split("\n")[1], /etc\/passwd|getuid/, "line comments must be blanked");
  assert.match(blanked.split("\n")[2], /etc\/passwd/, "a // inside a string literal is CODE and must survive — a naive stripper eats it and blinds the scanner");
  assert.match(blanked.split("\n")[3], /process\.getuid/, "real code must survive");
  assert.equal(blanked.split("\n").length, src.split("\n").length, "blanking must preserve line numbers, or every offence is reported at the wrong line");
});