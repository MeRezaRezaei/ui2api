// THE ALLOW-LIST THAT COULD GROW WITHOUT LIMIT: two budgets, one per suppression
// in `scripts/verify-verbatim-index.mjs`.
//
// An independent audit of this repo found the same defect twice in two different
// gates, and the shape is worth naming. A gate reported "4/4 entries in use; all
// entries still live" while one of its entries was OBSOLETE, because its staleness
// check was `pathExists` — the wrong POLARITY, since a doc-path allow-list exists
// precisely because the path is absent. `test/doc-allow-list-liveness.test.ts` closed
// that one, and it closed it INSIDE `test/**`.
//
// The second one was in `scripts/`, which that gate cannot see: its discovery is a
// readdir over `test/`. So the sibling class of defect was still open, one directory
// over, with nothing watching it.
//
// ---------------------------------------------------------------- the subject --
//
// `COMPRESSED` (scripts/verify-verbatim-index.mjs) is a Set of 4 timestamps. It is a
// data-quality EXEMPTION over the P3 check — "every Index row's one-line is its
// block's OWN words" — for rows where a hand-compressed one-liner legitimately is
// not the block's first words. Every entry in it weakens exactly that proof, and
// nothing stopped a fifth, a tenth, a twentieth. The measured cost of that is not
// theoretical: P3 is the check that makes the completeness claim honest.
//
// This file gives it two bounds:
//
//   BUDGET     the set may not exceed its own measured size. Set on the MEASURED
//              value, not a round number above it, so it cannot grow by one entry
//              that "looks harmless". Shrinking stays legal — a fixed violation
//              SHOULD lose its exemption — so the rule is `<=`, never `===`.
//
//   NEEDEDNESS each entry must still suppress a REAL P3 violation. If it suppresses
//              nothing it FAILS LOUD, naming the entry, because a suppression that
//              suppresses nothing is debt with a comment on it.
//
// ------------------------------------------------------- how neededness is run --
//
// The predicate is END-TO-END, not a re-implementation. For each entry it writes a
// copy of the REAL verifier with that one entry neutralised, runs it against the REAL
// archive, and diffs the problems against the unmodified run. This matters: P3's
// ratio depends on which block a row pairs with, and that pairing is an `in`-order
// walk with a `used` set. A second derivation of the ratio could disagree with the
// gate about which rows an entry covers and be wrong in a way nothing notices. The
// copy is driven, not paraphrased.
//
// The copy runs from a temp dir with `.brain` SYMLINKED at the real one, so the
// verifier's own `join(here, "..")` root resolution finds the real archive and the
// repo tree is never written to.
//
// -------------------------------------------------------- the limits, stated --
//
// Because a pin that overstates what it checks is the same defect in a new coat:
//   * It reads the WORKING TREE, not the git index, so it can see another agent's
//     in-flight edit to the verifier. Right trade for a staleness check.
//   * It judges entries by NEUTRALISING them, which is equivalent to removal
//     (a key matching no row date exempts nothing) but not textually identical to
//     deleting the line. Both forms are asserted to agree, so the two readings
//     cannot diverge silently.
//   * A date-only entry covers EVERY row at that date, so it is judged needed if ANY
//     of them would fail. That is correct — it is suppressing something real — and it
//     means a date-only entry can outlive the specific row that motivated it. Prefer
//     the `date:who` form for that reason.
//   * It cannot see a suppression that is not a named `Set`/`const` in that file: a
//     hardcoded `.filter(v => v !== "x")` inside a predicate is invisible. Nothing
//     mechanical can see that; the only defence is not writing one.
import { strict as assert } from "node:assert";
import { test as t, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIER_REL = join("scripts", "verify-verbatim-index.mjs");
const VERIFIER = join(ROOT, VERIFIER_REL);
const REAL_SOURCE = readFileSync(VERIFIER, "utf8");
const REAL_ARCHIVE = readFileSync(join(ROOT, ".brain", "verbatim.md"), "utf8");

/** A budget of 1 would be a real budget; a budget of 40 is a comment. */
const MIN_USEFUL_BUDGET = 1;

// ------------------------------------------------------------------ parsing --

const TIMESTAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}`;
/** `const COMPRESSED = new Set([ ... ]);` — the allow-list as it is written. */
const COMPRESSED_SET_RE = /const\s+COMPRESSED\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/;
const BUDGET_DECL_RE = /const\s+COMPRESSED_BUDGET\s*=\s*(\d+)\s*;/;
/** The gate's own message puts the ellipsis INSIDE the quotes: `P3 row D "one-line…" is not…`. */
const P3_PROBLEM_RE = /^P3 row (\S+) "(.*)…" is not its block's own words/;

/** The entries of the allow-list, read out of the real source. */
export function compressedEntries(source: string): string[] {
  const m = COMPRESSED_SET_RE.exec(source);
  if (!m) {
    // Unreadable is NOT "empty". Returning [] here would make every rule below
    // pass vacuously, which is the exact false green this file exists to kill.
    throw new Error(
      "could not read the COMPRESSED allow-list out of scripts/verify-verbatim-index.mjs — " +
        "if its shape changed, this gate is measuring nothing. Update COMPRESSED_SET_RE deliberately.",
    );
  }
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? "");
}

/** The budget the gate itself declares, so the test cannot drift from the gate. */
export function declaredBudget(source: string): number {
  const m = BUDGET_DECL_RE.exec(source);
  if (!m) {
    throw new Error(
      "scripts/verify-verbatim-index.mjs declares no COMPRESSED_BUDGET — the allow-list is unbounded again",
    );
  }
  return Number(m[1]);
}

/** An entry is either a bare timestamp or `timestamp:who` — the two shapes P3 consults. */
const ENTRY_SHAPE_RE = new RegExp(String.raw`^${TIMESTAMP}(?::[A-Za-z0-9_.-]+)?$`);

/** `YYYY-MM-DDTHH:MM` — exactly 16 characters, and it CONTAINS a colon of its own. */
const TIMESTAMP_LEN = 16;

/**
 * Split an entry into its date and optional `who`.
 *
 * Splitting on the first colon is WRONG and silently so: every timestamp contains a
 * colon at index 14, so `2026-09-24T00:00` would parse as date `2026-09-24T00` with
 * who `00` and would then cover no real row — which is exactly how a needed entry
 * gets reported obsolete. The qualifier colon is the one AFTER the timestamp.
 */
export function splitEntry(entry: string): { date: string; who?: string } {
  if (entry.length === TIMESTAMP_LEN) return { date: entry };
  return { date: entry.slice(0, TIMESTAMP_LEN), who: entry.slice(TIMESTAMP_LEN + 1) };
}

/** Does `entry` cover the index row (`date`, `who`)? Mirrors the P3 `has(r.date) || has(key)`. */
export function entryCovers(entry: string, date: string, who: string): boolean {
  const { date: d, who: w } = splitEntry(entry);
  return d === date && (w === undefined || w === who);
}

// ----------------------------------------------------------------- the runner --

type Verdict = { status: number; problems: string[]; raw: string };

/**
 * Run a copy of the verifier and collect its verdict.
 *
 * `corpus === undefined` symlinks the REAL `.brain` in, so the verifier's own
 * root resolution finds the real archive. Passing a string writes that instead,
 * which is how the synthetic neededness corpus is built.
 */
function runVerifier(source: string, corpus?: string): Verdict {
  const dir = mkdtempSync(join(tmpdir(), "verbatim-compressed-"));
  try {
    mkdirSync(join(dir, "scripts"));
    if (corpus === undefined) {
      symlinkSync(join(ROOT, ".brain"), join(dir, ".brain"), "dir");
    } else {
      mkdirSync(join(dir, ".brain"));
      writeFileSync(join(dir, ".brain", "verbatim.md"), corpus);
    }
    writeFileSync(join(dir, VERIFIER_REL), source);
    // ABSOLUTE path, and deliberately no `cwd`: a relative path here would resolve
    // against the test process's cwd and silently execute the REAL, unmutated
    // verifier in the repo — which turns every mutation below into a false green.
    const r = spawnSync(process.execPath, [join(dir, VERIFIER_REL)], { encoding: "utf8", timeout: 60000 });
    const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return {
      status: r.status ?? -1,
      raw,
      problems: raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2).trim()),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Rename one entry to a key that can match no row date — equivalent to removing it. */
function neutralise(source: string, entry: string): string {
  const needle = `"${entry}"`;
  if (!source.includes(needle)) {
    throw new Error(`COMPRESSED entry ${entry} is not present as a literal in the source — refusing to guess`);
  }
  return source.replace(needle, `"__neutralised__${entry}"`);
}

/** Delete one entry's line outright — the other half of the equivalence check. */
function removeEntry(source: string, entry: string): string {
  const re = new RegExp(String.raw`^\s*"${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\n`, "m");
  if (!re.test(source)) {
    throw new Error(`COMPRESSED entry ${entry} has no own line to remove — refusing to guess`);
  }
  return source.replace(re, "");
}

/**
 * The neededness predicate: does `entry` suppress a REAL P3 violation today?
 *
 * Answered end-to-end. `base` is the unmodified verdict and `without` the verdict
 * with the entry neutralised; an entry is needed when neutralising it introduces at
 * least one P3 problem, every such problem is a P3 problem (never a P1/P2/P4/P5/P6
 * side-effect), and each names a row the entry actually covers.
 */
export function neededness(entry: string, base: Verdict, without: Verdict): { needed: boolean; why: string } {
  const introduced = without.problems.filter((p) => !base.problems.includes(p));
  if (introduced.length === 0) {
    return {
      needed: false,
      why: "neutralising it changed nothing — the gate's verdict is identical with and without it, so it suppresses no violation",
    };
  }
  const offTarget: string[] = [];
  for (const p of introduced) {
    const m = P3_PROBLEM_RE.exec(p);
    if (!m) {
      offTarget.push(`${p}  (not a P3 own-words problem)`);
      continue;
    }
    // A date-only entry covers every row at that date; a qualified entry covers one.
    // The problem line carries the date, so a date-only entry can be checked exactly
    // and a qualified one is checked by date + the one-line it quoted.
    const { date: entryDate } = splitEntry(entry);
    const date = m[1] ?? "";
    const quoted = m[2] ?? "";
    const covered = entryDate === date || entryQuotedRowMatches(entry, date, quoted);
    if (!covered) offTarget.push(`${p}  (not a row this entry covers)`);
  }
  if (offTarget.length > 0) {
    return { needed: false, why: `it changed the verdict, but not for a row it covers:\n    ${offTarget.join("\n    ")}` };
  }
  return { needed: true, why: `${introduced.length} P3 problem(s) reappear without it` };
}

/**
 * For a `date:who` entry, confirm the P3 problem really is about THAT row by
 * matching the truncated one-line the problem quotes against the index rows.
 */
function entryQuotedRowMatches(entry: string, date: string, quoted: string): boolean {
  const { who } = splitEntry(entry);
  if (!who) return false;
  return indexRows().some((r) => r.date === date && r.who === who && r.one.slice(0, 60) === quoted);
}

/** The archive's Index rows, in the shape the verifier parses them. */
function indexRows(source: string = REAL_ARCHIVE): { date: string; who: string; one: string }[] {
  const bodyStart = source.indexOf("\n## 2026-08-29");
  if (bodyStart < 0) throw new Error("no `## 2026-08-29` body marker in .brain/verbatim.md");
  const rows: { date: string; who: string; one: string }[] = [];
  const re = new RegExp(String.raw`^\| (${TIMESTAMP}) \| ([^|]+?) \| (.*) \|$`);
  for (const line of source.slice(0, bodyStart).split("\n")) {
    const m = re.exec(line);
    if (m) rows.push({ date: m[1] ?? "", who: (m[2] ?? "").trim(), one: (m[3] ?? "").trim() });
  }
  return rows;
}

/**
 * A copy of the verifier carrying exactly `entries` as its COMPRESSED allow-list,
 * with the budget moved to match.
 *
 * The budget is moved too, and that is not a convenience: the synthetic corpora below
 * each need an entry that does not exist in the real archive, so pinning the budget at
 * 4 would make every one of them fail on P6 for a reason unrelated to what they are
 * testing. (That is the budget check working — it caught exactly this while this file
 * was being written.)
 */
function withAllowList(entries: string[]): string {
  return REAL_SOURCE.replace(/const\s+COMPRESSED\s*=\s*new\s+Set\(\s*\[[\s\S]*?\]\s*\);/, [
    `const COMPRESSED = new Set([`,
    ...entries.map((e) => `  "${e}",`),
    `]);`,
  ].join("\n")).replace(/const COMPRESSED_BUDGET = \d+;/, `const COMPRESSED_BUDGET = ${entries.length};`);
}

// ------------------------------------------------------------------- rules ---

// -------------------------------------------------- the harness proves itself ---

t("GUARD: the harness runs the MUTATED COPY, not the verifier in the repo", () => {
  // This file's whole argument is "the gate was run with the entry removed". If the
  // harness ever resolves to the repo's own verifier instead of the temp copy, every
  // neededness verdict becomes a verdict on the UNMODIFIED gate — which is green for
  // every entry, so the rule would pass for the wrong reason and the mutation tests
  // would be measuring the harness instead of the allow-list. That regression already
  // happened once while writing this file, so it is pinned rather than trusted.
  const booby = 'throw new Error("HARNESS-RAN-THE-COPY");';
  // Inserted after line 1 rather than matched against the shebang text, so the guard
  // does not rot when the interpreter line changes.
  const boobyed = REAL_SOURCE.replace(/^(#![^\n]*)\n/, `$1\n${booby}\n`);
  assert.notEqual(boobyed, REAL_SOURCE, "precondition: the booby-trap was actually inserted");
  const v = runVerifier(boobyed);
  assert.notEqual(v.status, 0, "a copy that throws on line 1 must fail the run");
  assert.match(
    v.raw,
    /HARNESS-RAN-THE-COPY/,
    `the harness must execute the temp copy; this run's output shows it did not:\n${v.raw}`,
  );
});

t("the COMPRESSED allow-list is inside its budget, and the budget is the measured size", (ctx: TestContext) => {
  const entries = compressedEntries(REAL_SOURCE);
  const budget = declaredBudget(REAL_SOURCE);

  // Non-vacuity, in both directions. An empty set would make the neededness rule
  // pass over nothing — the sibling's exact false green — and a budget of 0 would
  // be a prohibition, not a bound.
  assert.ok(entries.length > 0, "the COMPRESSED allow-list is EMPTY, so every rule here is vacuous");
  assert.ok(
    budget >= MIN_USEFUL_BUDGET,
    `COMPRESSED_BUDGET is ${budget}; a budget below ${MIN_USEFUL_BUDGET} is not a bound, it is a ban`,
  );
  assert.ok(
    entries.length <= budget,
    `the COMPRESSED allow-list has ${entries.length} entries, over its budget of ${budget}. ` +
      `Every entry is an exemption from the P3 own-words check, so each one is a hole. ` +
      `Prefer fixing the row's one-line to be its block's own words; if a row genuinely cannot be, ` +
      `raise COMPRESSED_BUDGET in scripts/verify-verbatim-index.mjs deliberately and say why in the commit.`,
  );

  // Every entry must be a shape P3 can actually consult. A malformed key can never
  // match, so it is an exemption that exempts nothing — the neededness rule would
  // catch it, but with a much worse message than "this key is not a key".
  const malformed = entries.filter((e) => !ENTRY_SHAPE_RE.test(e));
  assert.deepEqual(
    malformed,
    [],
    `these COMPRESSED entries are not a shape the P3 check can consult (timestamp or timestamp:who):\n  ${malformed.join("\n  ")}`,
  );

  ctx.diagnostic(
    `COMPRESSED: ${entries.length} entries, budget ${budget} (headroom ${budget - entries.length}); all entries well-shaped`,
  );
});

t("the budget is enforced BY THE GATE ITSELF, not only by this test", () => {
  // `npm run check:verbatim` runs in CI on its own, without the unit suite, so a
  // budget that only this test enforces would be enforced nowhere on a CI run that
  // skips tests. Prove the gate refuses a fifth entry, on the real script.
  // The extra entry is added to the COMPRESSED set specifically — `NOISE`'s `];`
  // appears earlier in the file, so a bare `/\n\];\n/` would inject into the wrong list.
  const budget = declaredBudget(REAL_SOURCE);
  const real4 = compressedEntries(REAL_SOURCE);
  const grown = REAL_SOURCE.replace(
    /const\s+COMPRESSED\s*=\s*new\s+Set\(\s*\[[\s\S]*?\]\s*\);/,
    `const COMPRESSED = new Set([\n${[...real4, "1999-01-01T00:00"].map((e) => `  "${e}",`).join("\n")}\n]);`,
  );
  assert.notEqual(grown, REAL_SOURCE, "precondition: the mutation actually changed the allow-list");
  assert.equal(
    compressedEntries(grown).length,
    real4.length + 1,
    "precondition: the mutation added exactly one entry to COMPRESSED",
  );
  // DERIVED, never typed: the budget shrinks when obsolete exemptions are removed (it went
  // 4 -> 1 the day 3 of the 4 entries were proved obsolete), so a hardcoded 4 here would
  // make this precondition fail for a correct change — which is number-rot wearing a
  // test's clothes, the exact class this gate exists to catch.
  assert.equal(declaredBudget(grown), budget, "precondition: the mutation left the budget where it was");

  const v = runVerifier(grown);
  assert.notEqual(v.status, 0, "a COMPRESSED list over its budget MUST fail the gate");
  assert.ok(
    v.problems.some((p) => p.startsWith("P6 COMPRESSED allow-list has grown past its budget")),
    `the gate must name the P6 budget breach, got:\n${v.raw}`,
  );
});

t("every COMPRESSED entry is still NEEDED — it suppresses a real P3 violation today", (ctx: TestContext) => {
  const entries = compressedEntries(REAL_SOURCE);
  const base = runVerifier(REAL_SOURCE);
  assert.equal(
    base.status,
    0,
    `precondition: the unmodified verifier must be green, or a diff against it means nothing:\n${base.raw}`,
  );

  const obsolete: string[] = [];
  for (const entry of entries) {
    const { needed, why } = neededness(entry, base, runVerifier(neutralise(REAL_SOURCE, entry)));
    if (!needed) obsolete.push(`${entry}  — ${why}`);
  }
  assert.deepEqual(
    obsolete,
    [],
    `these COMPRESSED entries suppress NOTHING: neutralising each one leaves the gate's verdict byte-identical.\n` +
      `  ${obsolete.join("\n  ")}\n` +
      `A suppression that suppresses nothing is debt with a comment on it. Remove the entry — the measured ` +
      `evidence is that the P3 own-words check PASSES without it, so removing it weakens nothing. ` +
      `Do NOT relax the ratio threshold to keep an entry justified, and do NOT widen the entry to a bare date ` +
      `to cover a neighbouring row: that hides the same hole more quietly.`,
  );
  ctx.diagnostic(`COMPRESSED: ${entries.length}/${entries.length} entries still suppress a real P3 violation`);
});

t("MUTATION: neutralising an entry and deleting its line are the same read", () => {
  // The predicate is driven by a rename; the natural fix is a deletion. If the two
  // could ever disagree, "needed" would depend on which mutation the gate happened to
  // apply, and the two readings would rot apart. Assert they cannot.
  for (const entry of compressedEntries(REAL_SOURCE)) {
    const base = runVerifier(REAL_SOURCE);
    const byRename = neededness(entry, base, runVerifier(neutralise(REAL_SOURCE, entry)));
    const byDeletion = neededness(entry, base, runVerifier(removeEntry(REAL_SOURCE, entry)));
    assert.equal(
      byRename.needed,
      byDeletion.needed,
      `entry ${entry}: renaming it to a dead key says needed=${byRename.needed} but deleting the line says ` +
        `needed=${byDeletion.needed}. The two mutations must be equivalent or this gate is measuring the ` +
        `mutation instead of the entry.`,
    );
  }
});

t("MUTATION: the neededness predicate can say NO — a suppression that suppresses nothing is reported", (ctx: TestContext) => {
  // Proved on a synthetic corpus so the negative direction is exercised by
  // construction, not hoped for. One block, one row, and a row whose one-line shares
  // NO words with its block: it is not its block's own words, so P3 must fail on it
  // unless an allow-list entry covers it.
  const corpus = [
    "# scratch",
    "",
    "## Index (all verbatim blocks — date · who · one line)",
    "",
    "| 2026-09-25T10:00 | user | zzz unrelated words entirely |",
    "",
    "## 2026-08-29",
    "<!-- 2026-09-25T10:00 -->",
    "[user] alpha beta gamma delta",
    "",
  ].join("\n");

  // (a) the entry that genuinely covers the row -> needed.
  const withReal = withAllowList(["2026-09-25T10:00"]);
  assert.equal(runVerifier(withReal, corpus).status, 0, "precondition: the covering entry makes the row pass");
  const realVerdict = neededness("2026-09-25T10:00", runVerifier(withReal, corpus), runVerifier(neutralise(withReal, "2026-09-25T10:00"), corpus));
  assert.equal(realVerdict.needed, true, "an entry covering a row that fails P3 without it IS needed");
  ctx.diagnostic(`covered entry reported needed: ${realVerdict.why}`);

  // (b) an entry covering a row that does not exist -> suppresses nothing -> obsolete.
  const withBogus = withAllowList(["1999-01-01T00:00"]);
  const base = runVerifier(withBogus, corpus);
  assert.equal(base.status, 1, "precondition: with only a bogus entry, the row fails P3");
  const bogusVerdict = neededness("1999-01-01T00:00", base, runVerifier(neutralise(withBogus, "1999-01-01T00:00"), corpus));
  assert.equal(
    bogusVerdict.needed,
    false,
    "an entry whose row does not exist suppresses nothing and MUST be reported obsolete",
  );
  ctx.diagnostic(`bogus entry reported obsolete: ${bogusVerdict.why}`);
});

t("MUTATION: an entry that suppresses a DIFFERENT row's violation is reported, not credited", (ctx: TestContext) => {
  // The neededness rule must not be satisfiable by "the gate went red, therefore the
  // entry is needed". An entry whose removal changes the verdict only for a row it
  // does NOT cover is suppressing nothing of its own.
  const corpus = [
    "# scratch",
    "",
    "## Index (all verbatim blocks — date · who · one line)",
    "",
    "| 2026-09-25T10:00 | user | zzz unrelated words entirely |",
    "",
    "## 2026-08-29",
    "<!-- 2026-09-25T10:00 -->",
    "[user] alpha beta gamma delta",
    "",
  ].join("\n");
  // The entry names the right date but the wrong `who`, so it covers no real row.
  const wrongWho = withAllowList(["2026-09-25T10:00:ses_nobody"]);
  const base = runVerifier(wrongWho, corpus);
  assert.equal(base.status, 1, "precondition: a wrong-`who` entry covers no row, so the row still fails");
  const v = neededness("2026-09-25T10:00:ses_nobody", base, runVerifier(neutralise(wrongWho, "2026-09-25T10:00:ses_nobody"), corpus));
  assert.equal(v.needed, false, "an entry that covers no row must be reported obsolete even if the corpus is red");
  ctx.diagnostic(`wrong-who entry reported obsolete: ${v.why}`);
});

// -------------------------------------------------- the NOISE blast radius ---

/**
 * The machine classes the noise filter is allowed to catch. This is a CLASS rule,
 * not a per-entry one: adding another string to an existing class is fine, and a
 * human sentence caught by the filter is not.
 */
const NOISE_CLASSES: { cls: string; re: RegExp }[] = [
  { cls: "tool tag (<pty_exited> / <SUBAGENT-STOP>)", re: /^</ },
  { cls: "goal-plugin echo (New active goal:)", re: /^New active goal:/ },
  { cls: "goal-plugin echo (Replacing active goal)", re: /^⚠️ Replacing active goal/ },
  { cls: "continuation auto-echo", re: /^Continue if you have next steps/ },
];

t("the NOISE filter only ever excludes MACHINE-shaped blocks — a real user block caught by it fails loud", (ctx: TestContext) => {
  // `isNoise` is PREFIX-based, so a real user block that happened to BEGIN with one
  // of those strings would be dropped from the completeness count: no row, no
  // problem, no signal, and a total that is understated by one forever. The
  // residual risk this CANNOT remove — a user who literally opens a block with the
  // words "New active goal:" — is machine-shaped by construction and is stated here
  // rather than papered over.
  const anchor = "const userBlocks = blocks.filter((b) => !isNoise(b));";
  if (!REAL_SOURCE.includes(anchor)) {
    throw new Error(
      "the noise-probe anchor moved in scripts/verify-verbatim-index.mjs — this probe is blind, not passing. " +
        "Re-point it deliberately; do not skip it.",
    );
  }
  // Derive the excluded set through the verifier's OWN `isNoise`, not a second copy.
  const instrumented = REAL_SOURCE.replace(
    anchor,
    [
      anchor,
      "for (const b of blocks) {",
      "  if (!isNoise(b)) continue;",
      "  const f = b.text.trim().split('\\n')[0].trim();",
      "  console.log('EXCLUDED\\t' + JSON.stringify(f));",
      "}",
    ].join("\n"),
  );
  const v = runVerifier(instrumented);
  assert.equal(v.status, 0, `precondition: instrumenting the verifier must change no verdict:\n${v.raw}`);
  const excluded = v.raw
    .split("\n")
    .filter((l) => l.startsWith("EXCLUDED\t"))
    .map((l) => {
      const raw = l.slice("EXCLUDED\t".length);
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw;
      }
    });

  // Non-vacuity: the probe must be looking at a real exclusion set. An empty one
  // would make the class rule below pass for the wrong reason.
  const reported = /blocks: (\d+) dated markers \((\d+) noise excluded/.exec(v.raw);
  assert.ok(reported, `precondition: the report discloses the excluded count:\n${v.raw}`);
  assert.equal(
    excluded.length,
    Number(reported[2]),
    `the probe saw ${excluded.length} excluded blocks but the gate reports ${reported[2]} — the anchor ` +
      `is measuring a different set than the gate excludes, so the rule below is meaningless`,
  );
  assert.ok(excluded.length > 0, "precondition: the archive excludes no machine noise at all — the rule below is vacuous");

  const human = excluded.filter((first) => !NOISE_CLASSES.some((c) => c.re.test(first)));
  assert.deepEqual(
    human.map((f) => f.slice(0, 90)),
    [],
    `the NOISE filter excluded ${human.length} block(s) that are not machine-shaped. isNoise is PREFIX-based, so ` +
      `a real user block that starts with a noise string is dropped from the completeness count with no row, no ` +
      `problem, and no signal. Either the block is machine output of a class not listed in NOISE_CLASSES above ` +
      `(add the class — do NOT weaken the filter), or the filter is eating a real user block (which is a data bug ` +
      `in .brain/verbatim.md, not a rule to relax).`,
  );
  ctx.diagnostic(
    `NOISE: ${excluded.length} excluded blocks, all machine-shaped across ${NOISE_CLASSES.length} declared classes`,
  );
});
