// DERIVATION + PREDICATES for the doc-surface gates.
//
// This module holds no `test(...)` call on purpose. `test/gate-wiring.test.ts`
// already imports predicates straight out of `test/doc-numbers-truth.test.ts`
// and pays for it: importing a test file REGISTERS that file's tests in the
// importing process, so they print twice. A helper module keeps the derivation
// reusable without that cost — the same reason `test/helpers/ci-contract-scan.ts`
// exists, and the same precedent gate-wiring's own header sets ("moving the
// helpers to test/helpers/ is an edit to a file this change does not own").
//
// Three things live here, each derived from disk rather than from a list a human
// maintained:
//
//   1. `markdownSurfaces()` — every markdown file the project SHIPS. The
//      forbidden-suite-total rule used to run against `README.md + AGENTS.md`
//      and nothing else, so the same rot that was fixed in AGENTS.md stayed free
//      in docs/AUDIT.md. The file set is a `readdirSync` walk, not a hardcoded
//      array: a hardcoded array is a list that rots on the day a doc is added.
//
//   2. The TWO-TIER unverifiable-count detector (`scanUnverifiableCounts`). The
//      tiers and the dated-vs-current decision are argued in the file that owns
//      the pins; the short form: a count whose SHAPE is unverifiable is refused
//      everywhere, and a count that is merely STALE is allowed only when the
//      document attributes it to a specific dated run and tells the reader where
//      the live number comes from.
//
//   3. `suppressionLists()` + the probe registry — the obsolete-allow-list pin.
//      An allow-list entry that suppresses nothing is debt with a comment on it,
//      and a `pathExists`-shaped staleness check can never clear one. What
//      counts as "still live" is per-list, so the check is REGISTERED per list
//      rather than guessed; a list with no registered probe FAILS, which is the
//      honest outcome (an unreported suppression) instead of a silent pass.

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

// ------------------------------------------------------------- doc surfaces ---

/**
 * Directories that are not project documentation, with the reason each is out.
 * Every exclusion is a judgement, so each one is named rather than folded into a
 * blanket "skip dotfiles".
 */
const NOT_DOCS: Record<string, string> = {
  node_modules: "third-party",
  ".git": "vcs internals",
  dist: "build output, not source",
  data: "captured sessions — real credentials, never a doc surface",
  sites: "generated per-site servers",
  "graphify-out": "generated knowledge-graph artefacts",
  ".brain": "the operator's private IP — never in git, never a doc surface",
  ".agents": "agent scratch",
  ".opencode": "agent scratch",
  ".github": "issue/PR templates, not project documentation",
  ".plans": "superseded design drafts, not shipped documentation",
  raw: "the verbatim archive — the user's own unedited words, never edited to satisfy a gate",
  coverage: "generated coverage output",
};

/**
 * Every markdown file the project ships, as repo-relative POSIX paths, sorted.
 *
 * Derived, never listed. Adding `docs/FOO.md` needs no edit here; the gate picks
 * it up on the next run, which is the whole point of extending coverage past the
 * two files the old rule read.
 */
export function markdownSurfaces(root: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (NOT_DOCS[e.name]) continue;
        if (e.name === "fixtures") continue; // test/fixtures holds package DATA
        walk(join(dir, e.name));
      } else if (e.name.endsWith(".md")) {
        out.push(join(dir, e.name).slice(root.length + 1).split("\\").join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

export function readDoc(rel: string, root: string = ROOT): string {
  return readFileSync(join(root, rel), "utf8");
}

/** A doc surface, split into lines with 1-based line numbers. */
export function docLines(rel: string, root: string = ROOT): string[] {
  return readDoc(rel, root).split("\n");
}

// ------------------------------------------------- unverifiable test counts ---

export interface CountRule {
  id: string;
  /** Why this shape is unverifiable, in one line. */
  why: string;
  re: RegExp;
}

export interface CountHit {
  file: string;
  line: number;
  text: string;
  rule: string;
  tier: 1 | 2;
  /** Tier 2 only: the run reference the document used to excuse the count. */
  attributedBy?: string;
}

/**
 * TIER 1 — refused in every doc surface, with no exemption and no date escape.
 *
 * Each of these is a count that CANNOT be re-derived from the repo at all, so
 * there is no reading of it under which it is worth keeping. `N tests / M suites`
 * is the shape node prints and a human retypes; `(N+M) env skip` is its
 * parenthetical twin; `(N+ tests)` is a remembered test count; and a
 * `<file>.test.ts (N/M)` ratio is the loop-generated per-file total GOAL 110
 * found, generalised here from two hardcoded basenames to the SHAPE — a hardcoded
 * basename list is a list that misses the next file.
 */
export const TIER1_COUNT_RULES: CountRule[] = [
  { id: "suite-total", why: "`N tests / M suites` is a retyped run summary", re: /\b\d{3,4}\s+tests?\s*\/\s*\d+\s+suites?\b/ },
  { id: "pass-plus-skip", why: "`(N pass + M env skip)` is the same family, parenthesised", re: /\(\d{3,4}\s+pass\s*\+\s*\d+\s+env skip/ },
  { id: "test-count-plus", why: "`(N+ tests)` counts tests nothing can enumerate", re: /\(\d+\+\s+tests\)/ },
  {
    id: "per-file-ratio",
    why: "a `*.test.ts (N/M)` ratio is loop-generated: the rest of the file's cases come from `for` loops",
    // The `:` guard is what keeps `capability-dispatch.test.ts:16-39` (a line
    // citation) out — that is a pointer, not a count.
    re: /\.test\.ts`?[ \t]*(?!:)\(?\d+\/\d+\)?/,
  },
];

/**
 * A line that is MEASURING something. Tier 2's two rules need this, because a
 * bare `401/404` in a status-code table and a bare `418/418` in a suite summary
 * are the same three glyphs and only the sentence tells them apart. Without it
 * the ratio rule fires on HTTP status pairs (`capabilities/gmail/CAPABILITIES.md`
 * really does say `301/302`) and the gate is noise.
 */
export const MEASUREMENT_CTX =
  /\b(tests|suite|suites|passed|failed|green|assertions)\b|\b(pass|fail)\b|files\s*:|measured|re-?run|fold|records?|counts?/i;

/**
 * A SPECIFIC run reference — a calendar date, a fold, a GOAL number, a CI run id.
 * Deliberately not the words "dated" or "record": those describe the intent, and
 * an intent phrase is exactly what a bypass would type.
 */
export const RUN_REF = /20\d\d-\d\d-\d\d|fold[ -]*#\s*\d+|GOALs?\s+\d+|CI run \d+/i;

/**
 * The sentence a historical-count holder owes its reader: where the LIVE number
 * actually comes from. Without it, a "record" is just a number a reader will
 * quote, and the whole dated/current distinction collapses.
 */
export const LIVE_NUMBER_POINTER =
  /not a current total|not current totals?|never prose|never (to be |ever )?read as today|(get|read) (it|the truth) from (a|the) run/i;

/**
 * A path whose ROLE is to be a record, so it is dated by construction and owes
 * no live-number pointer. Derived from the path, not from the text, because a
 * changelog entry is history by what it is — requiring a changelog to tell you
 * to go read a run would be absurd.
 */
export const RECORD_PATH = /(^|\/)(CHANGELOG\.md)$|(\/handoffs\/)|(\/superpowers\/specs\/)/;

/** Test-file basenames on disk — the stems `foo.test.ts` -> `foo`. */
export function testBasenames(root: string = ROOT): Set<string> {
  return new Set(
    readdirSync(join(root, "test"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => f.replace(/\.test\.ts$/, "")),
  );
}

/**
 * A MARKDOWN PASSAGE boundary. A count belongs to the passage it sits in, so the
 * run reference that excuses it is looked for in that passage and not in a fixed
 * window of lines above it.
 *
 * The shape is deliberate and it is the reason a fixed window was not enough: a
 * bullet that opens `- **FULL-SURFACE VERIFIED (GOAL 15, 2026-09-23, …)**` and
 * then runs for fifteen lines owns every count inside it, including one on line
 * fifteen. A `| table row |` is NOT a boundary — a table is one passage, which
 * is what lets a row that carries no date of its own inherit the table's.
 */
const PASSAGE_BOUNDARY = /^\s*$|^\s{0,3}(?:[-*+]\s|\d+[.)]\s|#{1,6}\s)/;

/** Index (0-based) of the first line of the passage containing `n` (1-based). */
export function passageStart(lines: string[], n: number): number {
  let i = n - 1;
  while (i > 0 && !PASSAGE_BOUNDARY.test(lines[i - 1]!)) i--;
  // The boundary line itself opens the passage, so it is IN it: `- **FULL-SURFACE
  // VERIFIED (GOAL 15, 2026-09-23, …)**` is the run reference for every count in
  // the lines that follow it, and a search that started one line below it would
  // miss the only date the passage has.
  return Math.max(0, i - 1);
}

export interface ScanOptions {
  root?: string;
  files?: string[];
  /** Injectable for the mutation proofs: run the scan over text nobody shipped. */
  overrides?: Record<string, string>;
}

/**
 * Scan a doc surface for unverifiable test/suite counts.
 *
 * TIER 1 hits are returned in `tier1`; TIER 2 hits are split into `tier2Records`
 * (attributed to a dated run) and `tier2Undated` (not). The split is the
 * gate's whole answer to "what about a doc that legitimately cites a historical
 * count" — see the dated-vs-current argument in the owning test file.
 */
export function scanUnverifiableCounts(opts: ScanOptions = {}): {
  tier1: CountHit[];
  tier2Records: CountHit[];
  tier2Undated: CountHit[];
  files: string[];
} {
  const root = opts.root ?? ROOT;
  const files = opts.files ?? markdownSurfaces(root);
  const basenames = testBasenames(root);
  const tier1: CountHit[] = [];
  const tier2Records: CountHit[] = [];
  const tier2Undated: CountHit[] = [];

  for (const file of files) {
    const text = opts.overrides?.[file] ?? readDoc(file, root);
    const lines = text.split("\n");
    const pointer = LIVE_NUMBER_POINTER.test(text);
    const recordByPath = RECORD_PATH.test(file);
    // A dated FILE NAME is a dated record: docs/handoffs/2026-09-20-… says so.
    const pathIsRunRef = RUN_REF.test(file);

    const runRefFor = (n: number): string | null => {
      for (let i = passageStart(lines, n); i < n; i++) {
        const m = lines[i]!.match(RUN_REF);
        if (m) return `passage line ${i + 1}: ${m[0]}`;
      }
      const own = lines[n - 1]!.match(RUN_REF);
      if (own) return `line ${n}: ${own[0]}`;
      if (pathIsRunRef) return `file path: ${file}`;
      // Only the document's OWN TITLE line dates the whole document — a title
      // like "re-verified 2026-09-21, fold #11" is a claim about every line under
      // it. A wider header slice was tried and is wrong: it swallowed the first
      // list item, so a date on the first bullet excused a count on the second.
      const title = lines[0]?.match(RUN_REF);
      return title ? `title: ${title[0]}` : null;
    };

    lines.forEach((line, i) => {
      const n = i + 1;
      for (const rule of TIER1_COUNT_RULES) {
        const m = line.match(rule.re);
        if (m) tier1.push({ file, line: n, text: m[0], rule: rule.id, tier: 1 });
      }
      if (!MEASUREMENT_CTX.test(line)) return;

      const ratio = line.match(/\b\d{3,4}\/\d{3,4}\b/);
      if (ratio) {
        const by = runRefFor(n);
        const hit: CountHit = { file, line: n, text: ratio[0], rule: "suite-ratio", tier: 2 };
        if (by && (pointer || recordByPath)) tier2Records.push({ ...hit, attributedBy: by });
        else tier2Undated.push(hit);
      }

      // A test file's own case count: `<basename> N` / `<basename>: N` / `(N/M)`.
      // The basenames are DERIVED from `test/`, so a new test file is covered the
      // day it lands, and `foo.test.ts:16-39` stays a citation.
      const tokens = line.match(/[A-Za-z0-9_./-]+/g) ?? [];
      for (const tok of tokens) {
        const clean = tok.replace(/[`.:,;)]+$/, "");
        const stem = clean.replace(/\.test\.ts$/, "").split("/").pop() ?? "";
        if (!basenames.has(stem)) continue;
        if (clean.endsWith(".test.ts") && line.slice(line.indexOf(tok) + tok.length).startsWith(":")) continue;
        const cm = line
          .slice(line.indexOf(tok) + tok.length)
          .match(/^`?[ \t]*[:=]?[ \t]*\(?(\d{1,4})(?:\/\d{1,4})?\)?/);
        if (!cm) continue;
        const by = runRefFor(n);
        const hit: CountHit = {
          file,
          line: n,
          text: `${clean} ${cm[1]}`,
          rule: "per-file-count",
          tier: 2,
        };
        if (by && (pointer || recordByPath)) tier2Records.push({ ...hit, attributedBy: by });
        else tier2Undated.push(hit);
        break;
      }
    });
  }
  return { tier1, tier2Records, tier2Undated, files };
}

/**
 * The non-vacuity guard, as a value a test can assert on.
 *
 * A rule that finds nothing because its derivation read NOTHING is
 * indistinguishable, from the outside, from a rule that found nothing because
 * there is nothing to find. That is how an allow-list gate reported "4/4 entries
 * in use" while one entry was dead, and it is why the empty-derivation case is a
 * returned FAILURE rather than an empty result set.
 *
 * It checks the corpus size and nothing else on purpose: a healthy corpus with
 * zero violations is the normal state and must pass. The detector's SENSITIVITY
 * is proved by mutation instead, where a synthetic violation must be reported.
 */
export function nonVacuityProblems(scan: { files: string[] }): string[] {
  if (scan.files.length === 0) {
    return [
      "non-vacuity: the doc-surface derivation returned 0 markdown files, so every count rule in this file would pass without reading a single doc",
    ];
  }
  return [];
}

// ------------------------------------------- allow-list / suppression liveness ---

/**
 * Names that mean "this entry SUPPRESSES a violation". An allow-list that is
 * not named like one is not found by this scan — which is why the completeness
 * test below scans a deliberately BROADER family and requires every member to be
 * either a registered suppression or a declared non-suppression.
 */
const SUPPRESSION_NAME = /ALLOW|EXEMPT|WAIV|SKIP/;
const SUPPRESSION_FAMILY = /ALLOW|EXEMPT|WAIV|SKIP|IGNOR|MUST_|REQUIRE/;

export interface SuppressionEntry {
  /** Every `key: "value"` pair in the object entry, verbatim. */
  fields: Record<string, string>;
  raw: string;
}

export interface SuppressionList {
  /** `test/foo.test.ts` — repo-relative. */
  file: string;
  name: string;
  entries: SuppressionEntry[];
  /** True for `= [ ... ]`; false for `= { ... }` (a Record-shaped allow-list). */
  arrayForm: boolean;
}

/** A balanced `[...]` or `{...}` literal starting at `from` (the bracket index). */
function balancedLiteral(src: string, from: number): string | null {
  const open = src[from]!;
  const close = open === "[" ? "]" : open === "{" ? "}" : null;
  if (!close) return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(from + 1, i);
    }
  }
  return null;
}

/**
 * Every `export const <NAME> = [...] | {...}` in a TypeScript file whose NAME is
 * in the given family, with its entries parsed.
 *
 * Parsing is textual and therefore bounded: an entry it cannot read is reported
 * as a zero-field entry rather than skipped, so "I could not read this allow-list"
 * surfaces as a failure of the completeness test instead of a silent pass.
 */
export function parseSuppressionLists(
  src: string,
  file: string,
  family: RegExp = SUPPRESSION_NAME,
): SuppressionList[] {
  const out: SuppressionList[] = [];
  const decl =
    /export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]*?)?=\s*([\[{])/g;
  for (const m of src.matchAll(decl)) {
    const name = m[1]!;
    if (!family.test(name)) continue;
    const body = balancedLiteral(src, m.index + m[0].length - 1);
    if (body === null) continue;
    const entries: SuppressionEntry[] = [];
    if (m[2] === "[") {
      // Object entries `{ file: "x", match: "y" }`, and bare string entries.
      const objs = body.match(/\{[^{}]*\}/g) ?? [];
      for (const o of objs) {
        const fields: Record<string, string> = {};
        for (const f of o.matchAll(/([A-Za-z0-9_]+)\s*:\s*"([^"]*)"/g)) fields[f[1]!] = f[2]!;
        entries.push({ fields, raw: o.replace(/\s+/g, " ").trim() });
      }
      if (objs.length === 0) {
        for (const s of body.matchAll(/"([^"]*)"/g)) entries.push({ fields: {}, raw: s[0]! });
      }
    } else {
      for (const f of body.matchAll(/([A-Za-z0-9_]+)\s*:\s*"([^"]*)"/g)) {
        entries.push({ fields: { key: f[1]!, reason: f[2]! }, raw: `${f[1]}: "${f[2]}"` });
      }
    }
    out.push({ file, name, entries, arrayForm: m[2] === "[" });
  }
  return out;
}

/** Every suppression-shaped `export const` in `test/**` (helpers included). */
export function suppressionLists(root: string = ROOT, family: RegExp = SUPPRESSION_NAME): SuppressionList[] {
  const out: SuppressionList[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "fixtures") continue;
        walk(p);
      } else if (e.name.endsWith(".ts")) {
        const rel = p.slice(root.length + 1).split("\\").join("/");
        out.push(...parseSuppressionLists(readFileSync(p, "utf8"), rel, family));
      }
    }
  };
  walk(join(root, "test"));
  return out.sort((a, b) => `${a.file}::${a.name}`.localeCompare(`${b.file}::${b.name}`));
}

/** Every `export const` in the broader family, for the completeness check. */
export function suppressionFamilyLists(root: string = ROOT): SuppressionList[] {
  return suppressionLists(root, SUPPRESSION_FAMILY);
}

export const listId = (l: SuppressionList): string => `${l.file}::${l.name}`;

/**
 * "Is this entry still suppressing a real violation?" — the check the sibling
 * gate got wrong. `pathExists` answers "does the thing exist?", which for a
 * doc-path allow-list is the OPPOSITE polarity: the entry exists precisely
 * BECAUSE the path does not, so the entry can never self-clear and a fixed
 * violation stays allowed forever. Every probe below answers the actual
 * question instead: does a real violation still match this entry?
 */
export type LivenessProbe = (entry: SuppressionEntry) => boolean;

/** The knob table of AGENTS.md, as a `| `UI2API_X` | … | `cite` |` row. */
export function knobTableKnobs(agentsMd: string): Set<string> {
  return new Set(
    [...agentsMd.matchAll(/^\|[ \t]*`(UI2API_[A-Z0-9_]+)`[ \t]*\|/gm)].map((m) => m[1]!),
  );
}

/** Every `UI2API_*` name read in shipped code under `src/` and `scripts/`. */
export function knobsReadInShippedCode(root: string = ROOT): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs|js|sh)$/.test(e.name)) {
        for (const m of readFileSync(p, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
      }
    }
  };
  for (const d of ["src", "scripts"]) walk(join(root, d));
  return out;
}

/**
 * Does ANY doc surface still NAME this exact path?
 *
 * Deliberately a raw substring over every markdown surface rather than a
 * grammar-based path-token scan. A token grammar has to decide what counts as a
 * path, and every rule it adds is a rule that can wrongly clear a dead entry —
 * which is the whole failure being pinned. A raw substring cannot be too narrow:
 * it fails only if the literal string is gone from every doc, which is exactly
 * the condition "no document names this any more".
 */
export function docsMentionPath(rel: string, root: string = ROOT): boolean {
  for (const f of markdownSurfaces(root)) {
    if (readFileSync(join(root, f), "utf8").includes(rel)) return true;
  }
  return false;
}

/**
 * The registered liveness probe per discovered list.
 *
 * A list with no entry here FAILS the completeness test. That is deliberate and
 * is the honest outcome: an allow-list whose semantics this gate cannot read is
 * REPORTED, not assumed live. The alternative — a default `() => true` — is
 * precisely the vacuous pass this pin exists to kill.
 */
export const LIVENESS_PROBES: Record<string, LivenessProbe> = {
  // The single-owner gate's exemption list is EMPTY today, so this probe is
  // dormant until the first entry is added -- and that is the point: an
  // allow-list nobody can check is a suppression list that grows silently. An
  // entry is live only while the file it excuses still exists, that line is
  // still in it, and the entry carries a NAMED reason. An entry that outlives
  // its violation, loses its file, or goes anonymous is dead and must fail.
  "test/chrome-owner-uid-single-owner.test.ts::ALLOW_LIST": (e) => {
    const rel = `test/${e.fields.file ?? ""}`;
    if (!e.fields.file || !existsSync(join(ROOT, rel))) return false;
    const reason = (e.fields.reason ?? "").trim();
    if (!reason) return false;
    const line = Number(e.fields.line);
    if (!Number.isInteger(line) || line < 1) return false;
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    return line <= lines.length && lines[line - 1]!.trim().length > 0;
  },
  // An entry excuses ONE line of ONE test file: the file must still exist and
  // that line must still be the offending one.
  "test/host-independence-gate.test.ts::ALLOW_LIST": (e) => {
    const rel = `test/${e.fields.file ?? ""}`;
    if (!e.fields.file || !existsSync(join(ROOT, rel))) return false;
    const fragment = e.fields.match ?? "";
    if (!fragment) return false;
    return readFileSync(join(ROOT, rel), "utf8").split("\n").some((l) => l.includes(fragment));
  },
  // The polarity trap, stated as code. Live == "a doc STILL NAMES this path AND
  // the path still does not exist". Testing only `pathExists` (as the owning
  // gate does at test/ci-contract-doc-commands.test.ts:403) can never clear an
  // entry: the entry is there BECAUSE the path is absent, so it stays "live"
  // forever even after every doc stops naming it.
  "test/ci-contract-doc-commands.test.ts::ALLOWED_DOC_PATHS": (e) => {
    const p = e.fields.path ?? "";
    if (!p) return false;
    if (existsSync(join(ROOT, p))) return false; // the defect it excuses is gone
    return docsMentionPath(p);                 // …but is any doc still naming it?
  },
  // Live == "shipped code still reads this knob AND the doc table still has no row".
  "test/ci-contract-knob-cites.test.ts::ALLOWED_UNDOCUMENTED_KNOBS": (e) => {
    const knob = e.fields.knob ?? "";
    if (!knob) return false;
    return knobsReadInShippedCode().has(knob) && !knobTableKnobs(readDoc("AGENTS.md")).has(knob);
  },
  // Live == "the row still exists AND its cited file still does NOT hold the knob".
  "test/ci-contract-knob-cites.test.ts::ALLOWED_WRONG_FILE_CITES": (e) => {
    const knob = e.fields.knob ?? "";
    const cite = e.fields.cite ?? "";
    if (!knob || !cite) return false;
    if (!knobTableKnobs(readDoc("AGENTS.md")).has(knob)) return false;
    const file = cite.split(":")[0]!;
    if (!existsSync(join(ROOT, file))) return true; // a cite to a file that is gone
    return !readFileSync(join(ROOT, file), "utf8").includes(knob);
  },
  // Live == "a real CI-config knob divergence exists for this knob".
  "test/helpers/ci-contract-scan.ts::KNOB_PARITY_ALLOW": (e) => {
    const knob = e.fields.key ?? "";
    if (!knob) return false;
    for (const cfg of [".gitlab-ci.yml", ".github/workflows/ci.yml"]) {
      const p = join(ROOT, cfg);
      if (!existsSync(p)) continue;
      const mine = new Set([...readFileSync(p, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)].map((m) => m[0]));
      if (mine.has(knob)) {
        const other = cfg === ".gitlab-ci.yml" ? ".github/workflows/ci.yml" : ".gitlab-ci.yml";
        const op = join(ROOT, other);
        if (existsSync(op)) {
          const theirs = new Set([...readFileSync(op, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)].map((m) => m[0]));
          if (!theirs.has(knob)) return true;
        }
      }
    }
    return false;
  },
};

/**
 * Lists in the broader family that are NOT suppressions, each with the reason.
 * A requirement list (`MUST_BE_IGNORED`) asserts; an allow-list excuses. Listing
 * it here is what lets the completeness test say "I saw it and know what it is"
 * instead of leaving a reader to assume the scan missed it.
 */
export const NOT_SUPPRESSIONS: { id: string; reason: string }[] = [
  {
    id: "test/credential-leak-gate.test.ts::MUST_BE_IGNORED",
    reason:
      "a REQUIREMENT list, not a suppression: each entry must still be git-ignored, and the test asserts exactly that. Its failure mode is the opposite of debt — the list cannot rot into silence.",
  },
];
