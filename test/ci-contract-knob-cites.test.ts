// The KNOB-TABLE and PACKAGE-COUNT contract: the two numeric claims AGENTS.md
// describes as machine-pinned, and which nothing actually pinned.
//
// AGENTS.md says of its `UI2API_*` table (GOAL 94): "machine-pinned against the
// shipped docs (a knob added to the code without a doc row fails the suite)". What
// exists, test/env-knob-truth.test.ts, is weaker than that sentence:
//   * it scans only `.ts|.mjs|.js`. `scripts/ops/*.sh` READ UI2API_* knobs too
//     (AGENTS.md's own `UI2API_OS_USER` row is cited at
//     `scripts/ops/launch-ui2api-chrome.sh:8`), so a knob readable only from a
//     shell script is invisible to it — the exact blind spot that let
//     `UI2API_XVFB_DISPLAY` ship undocumented (see ALLOWED_UNDOCUMENTED_KNOBS).
//   * it asserts a knob name appears SOMEWHERE in five doc files. A knob merely
//     MENTIONED in prose, absent from the `read at` table, passes it. This file
//     requires an actual TABLE ROW, which is what "the table is machine-pinned"
//     has to mean for the `read at` column to be a register at all.
//   * it never looks at the `read at` column. The table's whole value is that
//     `src/runtime/chrome-owner.ts:60` is a place to jump to; a cite pointing at
//     the wrong FILE is a lie to the reader, and no gate noticed for the life of
//     the table.
//
// On the line level: this file gates the FILE and asserts the cited line is a
// real line in it, and MEASURES line-exact drift as a disclosure. The reason is
// measured, not guessed — see the drift test's header, which reports the count it
// found. A strict `line ===` pin over a table whose lines are re-flowed by every
// unrelated edit to 60 source files is a gate that trains people to ignore it,
// which is the failure mode AGENTS.md itself warns about ("a gate that fires on
// legitimate content is worse than no gate").
//
// ALREADY COVERED ELSEWHERE (deliberately not duplicated):
//   test/env-knob-truth.test.ts — knob-name-in-docs, for .ts/.mjs/.js only.
//   test/doc-numbers-truth.test.ts — `realPackageCount()` + `checkPackageCount()`
//   assert a claim of the real manifest-carrying dir count exists. This file
//   asserts the OTHER half of that sentence: the dir total, the arithmetic
//   between the two, and the IDENTITY of the deliberately-skipped dir (that
//   exactly one dir lacks a manifest and it is the one AGENTS.md names) — none of
//   which doc-numbers-truth can see, because a wrong exception still leaves the
//   right count.

import { test as t, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// ============================================================ derivation =====

/** Extensions that count as "code the project ships and runs". `.sh` is in the
 *  list deliberately — `scripts/ops/*.sh` read UI2API_* knobs, and omitting shell
 *  is exactly how an undocumented knob survives. */
const CODE_EXTENSIONS = [".ts", ".mjs", ".js", ".sh"] as const;

function codeFiles(dir: string, acc: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) codeFiles(p, acc);
    else if (CODE_EXTENSIONS.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

/** Every `UI2API_*` name appearing in shipped code under `src/` and `scripts/`. */
export function knobsReadInCode(root: string = ROOT): Set<string> {
  const out = new Set<string>();
  for (const dir of ["src", "scripts"]) {
    for (const f of codeFiles(join(root, dir))) {
      for (const m of readFileSync(f, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
    }
  }
  return out;
}

export interface KnobRow {
  /** 1-based line of the row in AGENTS.md. */
  docLine: number;
  knob: string;
  /** The `read at` cell verbatim — `path`, or `path:line`. */
  cite: string;
  file: string;
  line: number | null;
}

/** A `| `UI2API_X` | purpose | default | `read at` |` table row. */
const KNOB_ROW_RE = /^\|[ \t]*`(UI2API_[A-Z0-9_]+)`[ \t]*\|.*\|[ \t]*`([^`]+)`[ \t]*\|[ \t]*$/;

/** Every knob row in AGENTS.md's table, parsed from disk. */
export function knobTableRows(agentsMd: string = readFileSync(join(ROOT, "AGENTS.md"), "utf8")): KnobRow[] {
  const out: KnobRow[] = [];
  const lines = agentsMd.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(KNOB_ROW_RE);
    if (!m) continue;
    const cm = m[2]!.match(/^(.*?):(\d+)$/);
    out.push({
      docLine: i + 1,
      knob: m[1]!,
      cite: m[2]!,
      file: cm ? cm[1]! : m[2]!,
      line: cm ? Number(cm[2]) : null,
    });
  }
  return out;
}

export function fileLineCount(rel: string, root: string = ROOT): number {
  try {
    return readFileSync(join(root, rel), "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

export function fileContains(rel: string, needle: string, root: string = ROOT): boolean {
  try {
    return readFileSync(join(root, rel), "utf8").includes(needle);
  } catch {
    return false;
  }
}

export interface CapabilityDirCounts {
  dirs: string[];
  packages: string[];
  withoutManifest: string[];
}

export function capabilityDirCounts(root: string = ROOT): CapabilityDirCounts {
  const base = join(root, "capabilities");
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const packages = dirs.filter((d) => existsSync(join(base, d, "manifest.json")));
  return { dirs, packages, withoutManifest: dirs.filter((d) => !packages.includes(d)) };
}

/** The `dir/` names AGENTS.md calls out as deliberately skipped (no manifest). */
export function documentedSkippedDirs(agentsMd: string = readFileSync(join(ROOT, "AGENTS.md"), "utf8")): string[] {
  const out: string[] = [];
  for (const m of agentsMd.matchAll(/`([\w.-]+)\/`[ \t]*is a deliberately-skipped/gi)) out.push(m[1]!);
  return out;
}

/** Numbers of the shape `N dirs on disk` / `N package dirs` in a doc. */
export function countClaims(doc: string): { dirsOnDisk: number[]; packageDirs: number[] } {
  return {
    dirsOnDisk: [...doc.matchAll(/(\d+)\s+dirs on disk/g)].map((m) => Number(m[1])),
    packageDirs: [...doc.matchAll(/(\d+)\s+package dirs/g)].map((m) => Number(m[1])),
  };
}

// ============================================================== predicates ===

/** Rows whose cited file does not contain the cited knob — NO exemptions applied. */
export function rawWrongFileCites(rows: KnobRow[] = knobTableRows()): KnobRow[] {
  return rows.filter((r) => !fileContains(r.file, r.knob));
}

/** The same, minus the content-keyed exemptions this file declares. */
export function unexcusedWrongFileCites(rows: KnobRow[] = knobTableRows()): KnobRow[] {
  return rawWrongFileCites(rows).filter(
    (r) => !ALLOWED_WRONG_FILE_CITES.some((a) => a.knob === r.knob && a.cite === r.file),
  );
}

function isExemptWrongCite(knob: string, file: string): boolean {
  return ALLOWED_WRONG_FILE_CITES.some((a) => a.knob === knob && a.cite === file);
}

// ================================================================ fixtures ===

const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const ROWS = knobTableRows(AGENTS);
const TABLE = new Set(ROWS.map((r) => r.knob));
const CODE = knobsReadInCode();
const CAPS = capabilityDirCounts();

/**
 * Knobs read in code with no table row, exempt by CONTENT (the knob name, never a
 * line number). Each is a measured defect, reported rather than suppressed.
 */
export const ALLOWED_UNDOCUMENTED_KNOBS: { knob: string; reason: string }[] = [
  // EMPTY, and that is the point. It held exactly one entry: UI2API_XVFB_DISPLAY, read by
  // shipped code at scripts/ops/provision-ui2api-user.sh:35 and named in no doc at all. The
  // row now EXISTS, so the entry is deleted rather than tolerated, and the budget below is 0
  // — meaning the next undocumented knob is a hard failure, not a fourth exception.
];
/** Rows whose cited file does not contain the cited knob, exempt by CONTENT. */
export const ALLOWED_WRONG_FILE_CITES: { knob: string; cite: string; reason: string }[] = [
  // Kept as an array (unexcusedWrongFileCites reads it) but EMPTY. It held one entry:
  // UI2API_HEADED cited src/prompt/driver.ts, which contains no occurrence of the knob; the
  // real read site is src/prompt/posture.ts:66. The cell is corrected and the budget is 0, so a
  // wrong-FILE cite — the one class of this column a reader can actually act on — now fails.
];
const UNDOC_BUDGET = 0;   // was 1 (UI2API_XVFB_DISPLAY, now documented)
const CITE_BUDGET = 0;    // was 1 (UI2API_HEADED, now citing its real read site)

// ================================================================ rules ======

t("every UI2API_* knob read in src/+scripts/ has a row in the AGENTS.md knob table", (ctx: TestContext) => {
  assert.ok(
    CODE.size >= 40,
    `non-vacuity: expected to read >=40 knobs out of the code, found ${CODE.size} — a smaller set means the code scan stopped reading`,
  );
  assert.ok(
    ROWS.length >= 40,
    `non-vacuity: expected the AGENTS.md table to carry >=40 rows, parsed ${ROWS.length} — the table shape changed and this pin would go vacuous`,
  );
  const undocumented = [...CODE]
    .filter((k) => !TABLE.has(k) && !ALLOWED_UNDOCUMENTED_KNOBS.some((a) => a.knob === k))
    .sort();
  assert.deepEqual(
    undocumented,
    [],
    `these knobs are read by shipped code but have NO row in the knob table: ${undocumented.join(" ")} — the table's stated rule is that this fails the suite`,
  );
  assert.ok(
    ALLOWED_UNDOCUMENTED_KNOBS.length <= UNDOC_BUDGET,
    `undocumented-knob exemptions grew past their budget: ${ALLOWED_UNDOCUMENTED_KNOBS.length} > ${UNDOC_BUDGET}`,
  );
  // An exemption that has become unnecessary is disclosed: the doc may have been
  // fixed since the entry was written, and a stale entry is an allow-list rotting
  // in place. It is reported, not fatal, so a genuine doc FIX never turns a gate red.
  const obsolete = ALLOWED_UNDOCUMENTED_KNOBS.filter((a) => TABLE.has(a.knob)).map((a) => a.knob);
  ctx.diagnostic(
    `undocumented-knob exemptions: ${ALLOWED_UNDOCUMENTED_KNOBS.length}/${UNDOC_BUDGET} in use; ` +
      (obsolete.length ? `OBSOLETE (now tabulated — delete the entry): ${obsolete.join(", ")}` : "all in use"),
  );
});

t("every knob-table row's `read at` file exists and contains that knob", (ctx: TestContext) => {
  const wrongFile = unexcusedWrongFileCites(ROWS).map(
    (r) => `${r.knob} -> \`${r.cite}\` (AGENTS.md:${r.docLine})`,
  ).sort();
  assert.deepEqual(
    wrongFile,
    [],
    `knob-table rows citing a file that does not exist or does not contain the knob: ${wrongFile.join("; ")}`,
  );
  assert.ok(
    ALLOWED_WRONG_FILE_CITES.length <= CITE_BUDGET,
    `wrong-file cite exemptions grew past their budget: ${ALLOWED_WRONG_FILE_CITES.length} > ${CITE_BUDGET}`,
  );
  const obsolete = ALLOWED_WRONG_FILE_CITES.filter((a) => fileContains(a.cite, a.knob)).map((a) => a.knob);
  ctx.diagnostic(
    `wrong-file cite exemptions: ${ALLOWED_WRONG_FILE_CITES.length}/${CITE_BUDGET} in use; ` +
      (obsolete.length ? `OBSOLETE (cite now resolves — delete the entry): ${obsolete.join(", ")}` : "all in use"),
  );
});

t("every knob-table row's cited LINE is a real line in the cited file", (ctx: TestContext) => {
  // The floor under the `file:line` claim. A cite pointing past EOF is not a
  // pointer at all, and unlike line-exactness it costs nothing to hold: adding or
  // removing a line at the top of a source file cannot break it.
  const dangling = ROWS.filter((r) => r.line !== null && r.line > fileLineCount(r.file))
    .map((r) => `${r.knob} -> \`${r.cite}\` (AGENTS.md:${r.docLine})`)
    .sort();
  assert.deepEqual(
    dangling,
    [],
    `knob-table cites pointing at a line the file does not have: ${dangling.join("; ")}`,
  );
  // Non-vacuity: the table is supposed to cite LINES, not bare paths. A minority of
  // file-only rows is legitimate and exists today (UI2API_CHROME_OWNER_PROFILE,
  // UI2API_WIGOLO_ALLOW_REMOTE, UI2API_WIGOLO_ALLOW_REMOTE_TOKEN cite a bare path);
  // a MAJORITY of them means the `read at` column stopped being a pointer, and that
  // must fail rather than quietly pass on the floor above.
  const withLines = ROWS.filter((r) => r.line !== null);
  assert.ok(
    withLines.length > ROWS.length / 2,
    `only ${withLines.length} of ${ROWS.length} knob-table rows cite a \`file:line\`; the column promises a line to jump to`,
  );
  const fileOnly = ROWS.filter((r) => r.line === null).map((r) => r.knob);
  if (fileOnly.length > 0) {
    ctx.diagnostic(`rows citing a bare path with no line (disclosed, not fatal): ${fileOnly.join(", ")}`);
  }
});

t("knob-table line-exact drift is MEASURED and disclosed, never silently tolerated", (ctx: TestContext) => {
  // Why this is not a strict pin, stated so nobody re-adds one: 60 source files
  // are re-flowed by unrelated edits, and the measured drift below is what a
  // strict `line ===` gate would fail on TODAY — an always-red gate is not a gate,
  // it is noise that teaches the next maintainer to skip the file. The FILE-level
  // claim (the row points at a real file containing the knob) is the part that
  // stays pinned hard, one test above; that is the part a reader can act on.
  //
  // The two assertions here are real, not decoration:
  //   1. every drifted cite is a LINE offset only — its file exists and contains
  //      the knob. Line drift may never be masking a file-level lie.
  //   2. the drift predicate is sensitive: a cite pointed at a line that does not
  //      contain the knob is caught, proven below on a mutated table.
  const drift = ROWS.filter((r) => r.line !== null && !lineHas(r, r.knob));
  for (const r of drift) {
    assert.ok(
      fileContains(r.file, r.knob) || isExemptWrongCite(r.knob, r.file),
      `${r.knob} (AGENTS.md:${r.docLine}) cites ${r.cite} but that file does not contain the knob at all — that is a wrong-FILE cite, not line drift`,
    );
  }
  ctx.diagnostic(
    `knob-table line-exact drift: ${drift.length} of ${ROWS.length} rows cite a line that no longer holds the knob ` +
      `(file-level cites all resolve). Sample: ${drift.slice(0, 5).map((r) => `${r.knob}@${r.cite}`).join(", ")}`,
  );
  const mutated = AGENTS.replace(/\| `UI2API_CHROME_USER` \|([^|]*)\|([^|]*)\| `src\/runtime\/chrome-owner\.ts:(\d+)` \|/, (_all, a, b, line) => `| \`UI2API_CHROME_USER\` |${a}|${b}| \`src/runtime/chrome-daemon.ts:${line}\` |`);
  assert.notEqual(mutated, AGENTS, "the mutation must actually move one cite to the wrong file");
  const mutatedRows = knobTableRows(mutated).filter((r) => r.knob === "UI2API_CHROME_USER");
  assert.equal(mutatedRows.length, 1, "the mutated table still parses the same row");
  assert.ok(
    !fileContains(mutatedRows[0]!.file, mutatedRows[0]!.knob),
    "a cite repointed at a file that lacks the knob must be reported by the same predicate",
  );
});

t("every knob-table row names a knob the code really reads, or a family whose members it does", () => {
  // A row naming nothing readable is a row that documents a knob which does not
  // exist — a reader sets it and sees no effect. A bare PREFIX row is tolerated
  // ONLY when every real member of that family is itself a table row, which is the
  // case for `UI2API_WIGOLO_` (a pointer at the family, whose members —
  // UI2API_WIGOLO_AUTOSTART, UI2API_WIGOLO_USE_AUTH, UI2API_WIGOLO_ALLOW_REMOTE,
  // UI2API_WIGOLO_ALLOW_REMOTE_TOKEN — all have rows). That rule is derived, not
  // allow-listed: a prefix with no tabulated members fails.
  const dead = ROWS.filter((r) => {
    if (CODE.has(r.knob)) return false;
    const family = [...TABLE].filter((k) => k !== r.knob && k.startsWith(r.knob));
    return family.length === 0;
  }).map((r) => `${r.knob} (AGENTS.md:${r.docLine}) cites ${r.cite} but nothing in src/ or scripts/ reads it`);
  assert.deepEqual(dead, [], `knob-table rows naming a knob nothing reads: ${dead.join("; ")}`);
  // The prefix family itself must be real: at least one member must be read.
  for (const r of ROWS) {
    if (CODE.has(r.knob)) continue;
    const members = [...CODE].filter((k) => k.startsWith(r.knob));
    assert.ok(members.length > 0, `${r.knob} is a prefix row with no readable member in the code`);
  }
});

t("the capabilities/ dir count, the package count, and the skipped-dir exception all match disk", () => {
  const claims = countClaims(AGENTS);
  // AGENTS.md's parenthetical is an ARITHMETIC claim: "so N dirs on disk, M
  // packages". Both halves are read back from readdir, so the sentence cannot
  // drift away from the tree in either direction.
  assert.ok(
    claims.dirsOnDisk.length > 0 && claims.packageDirs.length > 0,
    "non-vacuity: AGENTS.md no longer states a `N package dirs` / `N dirs on disk` pair to pin",
  );
  assert.ok(
    claims.packageDirs.includes(CAPS.packages.length),
    `AGENTS.md claims package-dir counts ${JSON.stringify(claims.packageDirs)}; disk has ${CAPS.packages.length} dirs carrying a manifest.json`,
  );
  assert.ok(
    claims.dirsOnDisk.includes(CAPS.dirs.length),
    `AGENTS.md claims ${JSON.stringify(claims.dirsOnDisk)} dirs on disk; readdir finds ${CAPS.dirs.length}`,
  );
  assert.equal(
    CAPS.dirs.length,
    CAPS.packages.length + CAPS.withoutManifest.length,
    "dirs = packages + manifest-less dirs, by construction",
  );
});

t("exactly one capabilities/ dir lacks a manifest, and it is the one AGENTS.md names", () => {
  const named = documentedSkippedDirs(AGENTS);
  assert.ok(named.length > 0, "non-vacuity: AGENTS.md no longer names a deliberately-skipped dir");
  assert.equal(
    CAPS.withoutManifest.length,
    named.length,
    `dirs without a manifest on disk: ${JSON.stringify(CAPS.withoutManifest)}; AGENTS.md names ${JSON.stringify(named)} as deliberately skipped. A NEW manifest-less dir is a packaging accident, not a legacy leftover.`,
  );
  assert.deepEqual(
    CAPS.withoutManifest,
    [...named].sort(),
    `the manifest-less dirs on disk (${JSON.stringify(CAPS.withoutManifest)}) are not exactly the ones AGENTS.md excuses (${JSON.stringify([...named].sort())}) — the count is still right, so a count-only pin cannot see this`,
  );
});

// ============================================================== mutation =====

t("MUTATION: a knob read in code with no table row is reported", () => {
  // The real predicate, fed a code set carrying one extra knob — the
  // UI2API_XVFB_DISPLAY shape (a shell-only knob), made observable without
  // touching the tree.
  assert.ok(!TABLE.has("UI2API_PIN_PROOF"), "precondition: the scratch knob is in no table");
  const asIfRead = new Set([...CODE, "UI2API_PIN_PROOF"]);
  const missing = [...asIfRead]
    .filter((k) => !TABLE.has(k) && !ALLOWED_UNDOCUMENTED_KNOBS.some((a) => a.knob === k))
    .sort();
  assert.deepEqual(
    missing,
    ["UI2API_PIN_PROOF"],
    "a code-read knob with no table row must be reported",
  );
  // The same predicate on the real tree yields exactly the declared exemption.
  assert.deepEqual(
    [...CODE].filter((k) => !TABLE.has(k)).sort(),
    ALLOWED_UNDOCUMENTED_KNOBS.map((a) => a.knob).sort(),
  );
});

t("MUTATION: a knob-table row repointed at the wrong file is reported", () => {
  const mutated = AGENTS.replace(/\| `UI2API_TOKEN` \|[^|]*\|[^|]*\| `([^`]+)` \|/, (_all, cite) => `| \`UI2API_TOKEN\` | x | y | \`src/hub/server.ts:1\` |`);
  assert.notEqual(mutated, AGENTS, "the mutation must actually move the cite");
  const row = knobTableRows(mutated).find((r) => r.knob === "UI2API_TOKEN");
  assert.ok(row, "the mutated row still parses");
  assert.equal(row!.file, "src/hub/server.ts");
  assert.ok(
    !fileContains(row!.file, row!.knob),
    "a repointed cite must be caught by the file-contains predicate",
  );
  // Fed the mutated table, the REAL predicate names the repointed row too.
  const mutatedUnexcused = unexcusedWrongFileCites(knobTableRows(mutated)).map((r) => r.knob);
  assert.ok(
    mutatedUnexcused.includes("UI2API_TOKEN"),
    `the predicate must name the repointed row, got ${JSON.stringify(mutatedUnexcused)}`,
  );
  // And on the UNMUTATED table the raw predicate yields EXACTLY the declared exemptions.
  assert.deepEqual(
    rawWrongFileCites().map((r) => r.knob).sort(),
    ALLOWED_WRONG_FILE_CITES.map((a) => a.knob).sort(),
    "the real table's wrong-file cites are exactly the declared ones — a new one fails the gate above",
  );
});

t("MUTATION: a wrong dirs-on-disk / package count is reported", () => {
  const claims = countClaims(AGENTS);
  // Perturb whatever the doc currently claims, by regex on the CLAIM rather than a
  // re-typed number — so this test keeps working when the real count moves.
  const wrong = AGENTS.replace(
    /(\d+)( dirs on disk)/,
    (_all, n: string, tail: string) => `${Number(n) + 1}${tail}`,
  );
  assert.notEqual(wrong, AGENTS, "the mutation must actually alter the doc");
  const after = countClaims(wrong);
  assert.deepEqual(
    after.dirsOnDisk,
    [Number(claims.dirsOnDisk[0]) + 1],
    "only the mutated half moved",
  );
  assert.ok(
    !after.dirsOnDisk.includes(CAPS.dirs.length),
    "a wrong dir count must stop satisfying the real one",
  );
  assert.deepEqual(after.packageDirs, claims.packageDirs, "only the mutated half moved");
  // The real doc satisfies both claims today.
  assert.ok(claims.dirsOnDisk.includes(CAPS.dirs.length), "precondition: the real claim is true before the mutation");
});

t("MUTATION: a second manifest-less dir is reported as an unexcused leftover", () => {
  // The identity half of the exception, which a count-only pin cannot see: a
  // renamed/skipped dir keeps the count right and still lies.
  const named = documentedSkippedDirs(AGENTS);
  const renamed = named.map((n) => `not-${n}`);
  const reported = CAPS.withoutManifest.filter((d) => !renamed.includes(d));
  assert.deepEqual(
    reported,
    CAPS.withoutManifest,
    "excusing a DIFFERENT dir name must report the real manifest-less dir",
  );
  assert.deepEqual([...named].sort(), [...CAPS.withoutManifest], "today the excuse names the real dir");
});

/** Reads line N of a repo file, 1-based, "" past EOF. */
function lineHas(row: KnobRow, needle: string): boolean {
  try {
    const lines = readFileSync(join(ROOT, row.file), "utf8").split("\n");
    return (lines[(row.line ?? 0) - 1] ?? "").includes(needle);
  } catch {
    return false;
  }
}
