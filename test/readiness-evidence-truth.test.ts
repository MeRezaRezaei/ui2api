/**
 * ROUND N+98: the readiness file's EVIDENCE column is now machine-checked.
 *
 * WHY THIS FILE EXISTS — the finding is the shape of the gap, not the two cells.
 *
 * `.brain/PRODUCTION_READINESS.md` is what an operator reads to decide whether to
 * ship. `test/production-readiness-gate.test.ts` passes 12/12 because it recomputes
 * the VERDICTS in sections 1-4. It never reads the EVIDENCE column beside them —
 * which is unverified prose, and which had rotted at least twice while the gate
 * stayed green:
 *
 *   - criterion 4.1 cited the hermetic test-file count as `84`; the real derived
 *     figure was 126;
 *   - criterion 4.2 asserted the exact opposite of the world — that the advertised
 *     registry "does NOT exist" and "no registry is published" — while it answers
 *     HTTP 200. The DOCS had been corrected when the registry was published; this
 *     file had not.
 *
 * A gate that checks a column is not a gate on the table. So this one reads the
 * evidence column.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. This file records a LIVE system. A pin that
 * demands a permanently-true fact about the outside world would be a pin that
 * forces a lie, and that mistake has been made and fixed twice in this repository
 * already (the registry doc-truth pin among them). So nothing here hardcodes a
 * world-state: the 4.2 cell must name how to re-derive, not what the answer is
 * forever. The corpus gate (below) is the only structural pin, and it is derived.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = join(ROOT, ".brain", "PRODUCTION_READINESS.md");

function readiness(): string {
  return readFileSync(FILE, "utf8");
}

/** The `| <id> | ... |` rows of the criteria tables, by criterion id. */
function cells(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of src.split("\n")) {
    const m = /^\|\s*(\d+\.\d+)\s*\|/.exec(line);
    if (m) out.set(m[1], line);
  }
  return out;
}

test("GOAL 149: the criteria table was actually parsed (anti-vacuity)", () => {
  const found = cells(readiness());
  // Sections 1-4 are the criteria the READY rule depends on. If this count ever
  // collapses, every assertion below is inspecting nothing and reporting success.
  for (const id of ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7",
    "2.1", "2.2", "2.3", "2.4", "2.5", "2.6",
    "3.1", "3.2", "3.3", "3.4", "3.5",
    "4.1", "4.2", "4.3"]) {
    assert.ok(found.has(id), `criterion ${id} row not found — the parser is broken, not the file`);
  }
  assert.ok(found.size >= 21, `expected >=21 criteria rows, parsed ${found.size}`);
});

test("GOAL 149: 4.1's cited test-file count equals the live package.json list", () => {
  const live = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    .scripts["test:unit"] as string)
    .split(/\s+/)
    .filter((t) => t.endsWith(".test.ts")).length;
  const cell = cells(readiness()).get("4.1") ?? "";
  // Every `(<n>)` in the cell must be the live number, so the count cannot rot
  // silently again. This is the cell that said 84 while the truth was 126.
  const cited = [...cell.matchAll(/\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(cited.length > 0, "4.1 cites no parenthesised count any more — re-pin it");
  for (const n of cited) {
    assert.equal(n, live,
      `4.1 cites (${n}) but package.json lists ${live} test files`);
  }
});

test("GOAL 149: 4.2 names how to re-derive the registry, never a frozen world-state", () => {
  const cell = cells(readiness()).get("4.2") ?? "";
  assert.ok(cell.length > 0, "4.2 row missing");
  // The cell used to assert the registry "does NOT exist" — a permanently-false
  // claim about a third party. It may quote that as history, but it must not be
  // stated as current fact, and it must carry a re-derivation.
  const asCurrentFact = /the advertised `[^`]*` does NOT exist(?! \()/i.test(cell);
  assert.ok(!asCurrentFact,
    "4.2 states as current fact that the registry does not exist; it is reachable (HTTP 200)");
  assert.match(cell, /curl|re-derive|Re-derive/i,
    "4.2 makes a claim about a third party without saying how to re-derive it");
  // And the current state must be recorded, not just the method.
  assert.match(cell, /HTTP 200|reachable|EXISTS/i,
    "4.2 does not record the registry's measured current state");
});

test("GOAL 149: the vault-exposure claim is the measured scope, not one file", () => {
  const src = readiness();
  assert.match(src, /142 of 143/,
    "the vault exposure must be stated as the measured scope (142 of 143), " +
    "not as the single 0644 file it was previously recorded as");
  // The number must be traceable to the sensor that derives it, so a future
  // change to the vault is visible rather than silently contradicting this file.
  assert.match(src, /vault-permission-census\.test\.ts/,
    "the vault claim must name the census that measures it");
});

test("GOAL 149: no criterion row still cites the retired (84) file count", () => {
  const src = readiness();
  for (const [id, cell] of cells(src)) {
    assert.ok(!/\(84\)/.test(cell),
      `criterion ${id} still cites (84); the live count is derived from package.json`);
  }
});

test("GOAL 149: operator_ack is the operator's alone and this gate cannot satisfy it", () => {
  const src = readiness();
  // Sanity: the file still HAS the field (so this test can never pass vacuously by
  // the field being gone), and this test asserts nothing about its value.
  assert.match(src, /operator_ack/,
    "the operator_ack field is gone from the readiness file — investigate before continuing");
  // The gate must never be satisfiable by an agent: the READY condition is
  // verdict-gate + operator_ack, and only the verdicts are machine-derived here.
  const gate = readFileSync(join(ROOT, "test", "production-readiness-gate.test.ts"), "utf8");
  assert.ok(!/operator_ack[^\n]*=\s*["']?yes/i.test(gate),
    "production-readiness-gate.test.ts appears to SET operator_ack — that is the operator's line");
});

// ===========================================================================
// GOAL 185: no committed markdown file may contain a RAW ESC BYTE (0x1b).
//
// THE MEASURED INCIDENT, which is the only reason this gate exists. A previous
// agent captured COLOURED terminal output straight into
// `.brain/PRODUCTION_READINESS.md`, and two raw ANSI escape sequences landed
// inside a table cell — in criterion 4.1, the very row this file gates.
//
// The corruption was worse than ugly, it was MISLEADING. The 4.1 gate below
// (`/\((\d+)\)/` vs the live package.json count) stopped matching through the
// invisible bytes and therefore reported:
//
//     "4.1 cites no parenthesised count any more — re-pin it"
//
// …when the number was PRESENT AND CORRECT. A correct number presented as a
// missing one. The diagnostic reads like a logic error in the gate, so the next
// maintainer would re-pin something already right — and because the repo's own
// doctrine warns that hand-maintained doc numbers must have exactly ONE owner,
// "fixing" it by hand-duplicating the fact manufactures the second copy. The
// failure mode was not "a document is corrupt"; it was "a document is corrupt
// AND the gate is confidently wrong about it".
//
// It is fixed. A follow-up lane then scanned all 102 committed `.md` files and
// found ZERO raw ESC bytes and zero textual escape notations anywhere else.
//
// -----------------------------------------------------------------------
// MEASURED INSTANCE COUNT IS ZERO. Say that plainly and never let this file be
// read as a gate guarding a live problem: nothing is currently corrupted. This
// is insurance against the SECOND instance, which nothing else prevents.
// -----------------------------------------------------------------------
//
// WHY THIS GATE ANYWAY, and why that is NOT the GOAL 184 situation. GOAL 184
// (the document-citation gate) was DECIDED: DO NOT BUILD, because every scoping
// that made it green also made a real finding invisible — false positives were
// unavoidable, and an unavoidable false positive trains people to ignore the
// gate. Here the false-positive cost is ZERO:
//
//   * A RAW ESC byte (0x1b) inside a committed `.md` file is corruption, full
//     stop. There is no legitimate case for one. Not in prose, not in a code
//     fence, not in a table — an escape byte renders as nothing and breaks
//     every regex and every reader downstream.
//   * The LEGITIMATE case — DOCUMENTING an escape sequence — is written as
//     TEXT (`\x1b`, `\033`, `\u001b`, "ANSI escape sequences"), which is what
//     this repository's own goal index does when it describes this very fix
//     (`.brain/verbatim-goals.md`, GOAL 185). A raw-byte rule does not touch
//     that, and the negative direction is asserted as its own test below.
//
// So: a gate with no false-positive surface, over a corruption class with a
// DEMONSTRATED failure mode that produced a misleading diagnostic. Cheap
// insurance, not a gate that cries wolf. If you are about to argue this should
// not exist, the argument to have is not "it is noisy" — it is not — but "a raw
// ESC byte in committed markdown is fine, and here is the case", and there isn't
// one. THAT is the bar this gate sets, and it is deliberately high.
//
// ---------------------------------------------------------------------------
// DESIGN NOTE — WHY THIS FILE, AND WHY RAW BYTES.
//
// WHICH FILE. `.brain/PRODUCTION_READINESS.md` is this file's SUBJECT, and the
// bytes broke this file's OWN assertion (the 4.1 `assert.ok(cited.length > 0)`
// above, whose message is the misleading diagnostic quoted in this header). The
// escape landed in the one document whose evidence column this gate exists to
// read, so the corruption and its symptom live in the same file as the sensor.
// `test/doc-numbers-truth.test.ts` was the other candidate and was NOT chosen:
// its own header reserves an attribution boundary ("pointing them at every
// derived surface would change which file a failure is attributed to"), so
// dropping a 102-file corpus rule there would contradict the design its header
// documents. Extending THIS file also needs zero `package.json` edits, because
// this file is already named by `scripts["test:unit"]`.
//
// WHY RAW BYTES, AND WHY "SIMPLIFYING" IT IS A REGRESSION. This is the
// non-obvious part. The gate reads each file as a BUFFER and tests
// `buf.includes(0x1b)`; it never decodes to a string. That is not fussiness —
// decoding is precisely what let the corruption hide in the first place:
//
//   * The incident was invisible because it passed through a TEXT pipeline. The
//     fooled gate read the cell as a decoded string and ran a regex over it. A
//     byte-identity test has no decode, no regex, no normalisation and no
//     line-splitting step that could drop, reorder or reassemble the sequence.
//   * UTF-8 DECODING IS LOSSY. A decoder maps invalid byte sequences to U+FFFD
//     and is free to normalise. If the bytes ever formed a sequence the decoder
//     considered invalid, a decoded-string gate could in principle MASK them. A
//     test on the buffer cannot be fooled that way at all.
//   * Line numbers must be exact for the finding to be actionable, and counting
//     0x0a in a buffer is exact where a decode-then-split is only as exact as
//     the decoder.
//
// `scanEscBytes` therefore REFUSES a string reader (see the `Buffer.isBuffer`
// throw below). That refusal is deliberate: it converts "read it as text" from
// a comment a future maintainer may quietly undo into a change that fails the
// suite. If you are tempted to swap the Buffer for a string to make something
// simpler, that is the bug this whole file is about.
// ===========================================================================

/** The byte this gate exists to forbid: ESC. */
const ESC = 0x1b;

/**
 * Every COMMITTED markdown file, as repo-relative POSIX paths.
 *
 * The corpus is the GIT INDEX, not the working tree and not a `readdirSync`
 * walk, and the distinction is the point: a scratch or in-flight untracked file
 * is not a shipped artefact and must not be able to redden this gate, while a
 * file that has been `git add`ed and is about to be committed MUST be able to.
 * `test/helpers/doc-scan.ts`'s `markdownSurfaces()` is a filesystem walk with a
 * deliberate skip-list; using it here would inherit that skip-list and quietly
 * narrow the corpus, and it would include untracked files.
 */
function committedMarkdown(): string[] {
  // `-z` so a path containing a space or a quote cannot split the list. Never
  // `.split("\n")` a git path listing.
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 120000,
  });
  return out.split("\0").filter(Boolean);
}

/** The 1-based line of every ESC byte in `buf`, counted over the raw bytes. */
export function escByteLines(buf: Buffer): number[] {
  const lines: number[] = [];
  let line = 1;
  for (const b of buf) {
    if (b === ESC) lines.push(line);
    if (b === 0x0a) line++;
  }
  return lines;
}

/**
 * Every committed-markdown ESC finding, one string per offending line.
 *
 * `read` is injected so the negative direction (textual notation must NOT fire)
 * can be proven against synthetic buffers without touching the working tree.
 */
export function scanEscBytes(
  files: readonly string[],
  read: (rel: string) => Buffer = (rel) => readFileSync(join(ROOT, rel)),
): string[] {
  const findings: string[] = [];
  for (const rel of files) {
    const buf = read(rel);
    // The decoder-proofing refusal. See the design note: a string here means
    // somebody decoded the file, and decoding is the incident.
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError(
        `scanEscBytes("${rel}") must be read as raw bytes; a decoded string can mask ESC (0x1b)`,
      );
    }
    for (const line of escByteLines(buf)) {
      findings.push(`${rel}:${line} — raw ESC byte (0x1b) in committed markdown`);
    }
  }
  return findings;
}

test("GOAL 185: no committed markdown file contains a raw ESC byte (0x1b)", () => {
  const files = committedMarkdown();
  // ANTI-VACUITY, and it is not decorative. If `git ls-files` ever failed, or ran
  // outside a checkout, or matched nothing, the corpus would be empty and the
  // gate would report a clean pass while scanning NOTHING — which is the exact
  // shape of the incident it exists to prevent (a green gate over a corpus it
  // did not read). A collapsed corpus must be a LOUD failure.
  assert.ok(files.length > 0,
    "committedMarkdown() returned nothing — the corpus is empty, so this gate is reading nothing " +
    "and passing vacuously. Run from inside the repo checkout.");
  assert.ok(files.includes(".brain/PRODUCTION_READINESS.md"),
    "the file the incident happened in is no longer in the corpus; the corpus derivation has rotted");
  assert.ok(files.some((f) => f.startsWith("docs/")),
    "no docs/ surface in the corpus — the walk is not seeing what it is meant to see");

  const findings = scanEscBytes(files);
  assert.deepEqual(findings, [],
    "committed markdown contains raw ESC bytes. These render as NOTHING, so every regex gate and " +
    `every reader over the file silently misbehaves: ${findings.join("; ")}. Strip the escapes ` +
    "(re-capture without colour) and commit the clean text — do NOT suppress this.");
});

test("GOAL 185: the ESC scan reads RAW BYTES, and that is load-bearing", () => {
  // The negative direction, part 1: this repository's own index describes the
  // escape-sequence class IN PROSE and proposes this gate. It must stay green —
  // a raw-byte rule must not touch documentation that mentions escapes as text.
  const index = ".brain/verbatim-goals.md";
  const prose = committedMarkdown();
  assert.ok(prose.includes(index), `precondition: ${index} is not in the committed corpus`);
  const buf = readFileSync(join(ROOT, index));
  assert.ok(Buffer.isBuffer(buf), "precondition: the reader must hand back a Buffer, not a string");
  assert.equal(escByteLines(buf).length, 0,
    `${index} carries a raw ESC byte; it describes escapes as TEXT and must stay textual`);
  // The prose really does mention the class, so the negative case is not vacuous.
  assert.match(buf.toString("utf8"), /ANSI escape sequences/,
    "precondition: the index no longer describes the escape class in prose, so the negative " +
    "direction below is no longer proven against a real document");

  // The negative direction, part 2: every accepted TEXTUAL notation is clean.
  // NB these are the ASCII spellings a human writes, NOT template
  // interpolations of a byte — `${ESC}` would stringify the NUMBER 27 to "27"
  // and plant nothing at all, which is precisely the mistake this file exists
  // to prevent. A raw byte is always built here as `Buffer.from([...])`.
  for (const notation of [
    "the raw byte is \\x1b",
    "the raw byte is \\033",
    "the raw byte is \\u001b",
    "the raw byte is 0x1b",
    "written as ESC inside a fence: `\\x1b`",
    "no committed markdown file may contain ANSI escape sequences.",
  ]) {
    const clean = Buffer.from(notation, "utf8");
    assert.equal(clean.includes(ESC), false,
      `precondition: the textual notation ${JSON.stringify(notation)} must NOT contain a raw ESC byte`);
    assert.deepEqual(scanEscBytes(["synthetic.md"], () => clean), [],
      `the scan must not fire on the textual notation ${JSON.stringify(notation)}`);
  }
});

test("GOAL 185 MUTATION: a planted raw ESC byte in a real committed file is reported, with path and line", () => {
  // THE BITE. The planted defect is a REAL ESC byte in a REAL file, injected via
  // an injected `read` — not by weakening the gate's own predicate. The real
  // corpus and the real predicate are exercised; only the file CONTENT is
  // substituted, which is precisely the variable the gate is about.
  const real = committedMarkdown();
  const target = ".brain/PRODUCTION_READINESS.md";
  assert.ok(real.includes(target), `precondition: ${target} is not committed`);

  const clean = readFileSync(join(ROOT, target));
  const baseline = scanEscBytes([target], () => clean);
  assert.deepEqual(baseline, [], "precondition: the target file is already clean on the real disk");

  // Plant the byte inside a table cell, which is where the incident happened.
  // `Buffer.from([...])` of EXPLICIT BYTES, never a template interpolation:
  // `ESC` is the NUMBER 0x1b, so `${ESC}` yields the two characters "27" and
  // plants nothing — a mutation that silently plants nothing looks exactly like
  // a gate that does not bite.
  //
  // NOTE the byte-offset discipline, which cost this test one honest failure:
  // the anchor must be located IN THE BUFFER, not in the decoded string. A
  // character index fed to `subarray` is a byte index, and this file carries
  // multi-byte UTF-8 (`—`, `⚠`) before line 76, so the two diverge and the
  // computed line number comes out wrong — which is the same byte-vs-text
  // confusion that made the original incident invisible, one level up.
  const needle = Buffer.from("| 4.1 |", "utf8");
  const anchor = clean.indexOf(needle);
  assert.ok(anchor > 0, "precondition: could not find the 4.1 criteria row to plant into");

  // Plant BETWEEN the `(` and its digits, because that is where the incident's
  // escapes sat and it is the only position that actually breaks the gate: an
  // ESC earlier in the line leaves the `(166)` intact and the regex still
  // matches, which would make this "reproduction" prove nothing.
  const paren = clean.indexOf(Buffer.from("(", "utf8"), anchor);
  assert.ok(paren > anchor, "precondition: the 4.1 row cites no parenthesised count to split");
  const at = paren + 1; // immediately after the `(`: `(` ESC [ 3 1 m `166)`
  const COLOURED_RED = Buffer.from([ESC, 0x5b, 0x33, 0x31, 0x6d]); // ESC [ 3 1 m
  assert.equal(COLOURED_RED[0], ESC, "precondition: the planted sequence really starts with ESC");
  const planted = Buffer.concat([
    clean.subarray(0, at),
    COLOURED_RED,
    clean.subarray(at),
  ]);

  const findings = scanEscBytes([target], () => planted);
  assert.equal(findings.length, 1, `the gate must report exactly the planted byte; got ${JSON.stringify(findings)}`);
  assert.ok(findings[0].startsWith(`${target}:`),
    `the finding must name the offending path; got ${findings[0]}`);
  // And it must name the line the byte is actually on, so the finding is
  // actionable rather than merely red.
  const reported = Number(/^[^:]+:(\d+)/.exec(findings[0])![1]);
  const expected = clean.subarray(0, anchor).toString("utf8").split("\n").length;
  assert.equal(reported, expected,
    `the finding must name the offending line (expected ${expected}, got ${reported})`);

  // And the planted byte MUST reproduce the incident's exact misleading
  // diagnostic, measured against the REAL 4.1 predicate in THIS file rather than
  // a restatement of it. On the clean row the predicate extracts a count; on the
  // planted row it extracts NOTHING and `cited.length === 0` — which is exactly
  // the condition that made the gate say "re-pin it" about a correct number.
  const rowOf = (s: string): string => s.split("\n")[expected - 1] ?? "";
  const PARENTHESISED = /\((\d+)\)/g;
  const citedIn = (s: string): number[] =>
    [...rowOf(s).matchAll(PARENTHESISED)].map((m) => Number(m[1]));
  assert.ok(citedIn(clean.toString("utf8")).length > 0,
    "precondition: the clean 4.1 row does cite a parenthesised count");
  assert.deepEqual(citedIn(planted.toString("utf8")), [],
    "precondition: the planted byte does not reproduce the incident's misleading-diagnostic shape");
  // Stated as the assertion that misled a maintainer, so the point survives:
  assert.equal(citedIn(planted.toString("utf8")).length, 0,
    "a correct number is present but unreported — this is the incident, not a synthetic case");
});
