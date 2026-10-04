/**
 * test/skills-refusal-truth.test.ts — the NEGATIVE-claim gate for `skills/**`.
 *
 * `test/skills-truth.test.ts` has five checks and every one of them is a TOKEN
 * check: frontmatter/name, routes registered, knobs exist, site ids resolve, no
 * bare counts. None of them EXECUTES a described workflow. That is how
 * `skills/ui2api-operate/SKILL.md` passed while claiming "ACP comes via
 * `hub run --acp`" on a path that was provably dead — every NAME in the
 * sentence was real, so token existence could not see the sentence was a lie.
 * Semantic truth is not derivable from token existence.
 *
 * The cheapest class left to pin is the NEGATIVE claims — the REFUSALS — because
 * each has a STABLE LITERAL in `src/`. This gate derives, at run time and from
 * the source only:
 *
 *   1. the refusal MESSAGES — every string/template literal under `src/`
 *      whose text carries a refusal marker (`refus`, `nothing ran`,
 *      `nothing was written`, `re-run with` — morphological, not a per-seam
 *      list);
 *   2. the refusal ANCHOR for each — the leading literal run of its statement,
 *      i.e. the text before the first `${`, cut at the first `:` (inclusive) or
 *      the first sentence/clause break, trimmed;
 *   3. which COMMAND/FLAG/ENV emits it — read out of the guard clause in front
 *      of the literal (`cmd === "hub" && arg === "publish"`), else out of the
 *      enclosing `cmd*` handler name, plus the `--flag` tokens and the
 *      `*_ENV` constants the body itself resolves;
 *
 * and then asserts the falsifiable thing: **a skill that NAMES an emitting
 * command / flag / env must carry that refusal's anchor.** "The skill forgot a
 * refusal" stops being an unfalsifiable omission and becomes a missing token a
 * machine can fail on.
 *
 * DELIBERATELY RED AGAINST `skills/**` TODAY. The gaps this finds ARE the
 * deliverable; a later lane reconciles the skills. This file never edits a skill.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { fileURLToPath } from "node:url";

import { knownFlagsFrom, numericFlagsFrom } from "../src/cli.js";

const REPO = resolve(fileURLToPath(import.meta.url), "../..");
const SRC = join(REPO, "src");
const SKILLS = join(REPO, "skills");

/** Every `.ts` under `src/`, sorted so failures name a stable first file. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Comment stripper that PRESERVES LENGTH and line breaks, so an index into the
 * stripped source is also an index into the raw source — that is what lets a
 * derived seam name a real `file:line` instead of a guess.
 */
function stripJsComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let j = i; j < stop; j++) if (src[j] !== "\n") out[j] = " ";
      i = stop;
      continue;
    }
    if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const q = src[i]!;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * The `[start, end)` index ranges of every TEMPLATE LITERAL, on the
 * length-preserved stripped source so an index is also an index into the raw
 * file.
 *
 * `stripJsComments` deliberately leaves `//` and `/*` INSIDE a string alone —
 * that is correct JavaScript: text in a template literal is text, not a comment.
 * The consequence the derivation then has to respect is that a template literal
 * may contain a whole FOREIGN-SOURCE PROGRAM. `src/generator/lang-php.ts`
 * carries the entire PHP client inside backticks, so `function capability(` there
 * is PHP, and the `//` on the line below it is a PHP comment — code a generator
 * EMITS, not a message the runtime ever prints. Scanning that as if it were
 * JavaScript is how a mangled comment fragment became a "refusal".
 *
 * Deliberately BACKTICK-ONLY, and top-level string-aware, so it introduces no
 * fragility class `stripJsComments` does not already have: a `'` in a regex or a
 * `"` in a comment cannot fabricate a span.
 */
export function templateSpans(src: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    if (c !== "`") continue;
    const start = i;
    i++;
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") { i++; break; }
      if (src[i] === "$" && src[i + 1] === "{") {
        let d = 1;
        i += 2;
        while (i < src.length && d > 0) {
          const e = src[i]!;
          if (e === "{") { d++; i++; continue; }
          if (e === "}") { d--; i++; continue; }
          if (e === '"' || e === "'" || e === "`") {
            const q = e;
            i++;
            while (i < src.length) {
              if (src[i] === "\\") { i += 2; continue; }
              if (src[i] === q) { i++; break; }
              i++;
            }
            continue;
          }
          i++;
        }
        continue;
      }
      i++;
    }
    spans.push({ start, end: i });
  }
  return spans;
}

/** Is `index` inside one of `spans`? */
function insideSpans(spans: Array<{ start: number; end: number }>, index: number): boolean {
  return spans.some((s) => index >= s.start && index < s.end);
}

/** Byte offset of a 1-based `line` in `raw`; `-1` when the line does not exist. */
function offsetOfLine(raw: string, line: number): number {
  let off = 0;
  for (let n = 1; n < line; n++) {
    const i = raw.indexOf("\n", off);
    if (i < 0) return -1;
    off = i + 1;
  }
  return off < raw.length ? off : -1;
}

/**
 * Refusal markers — MORPHOLOGICAL, not a list of this repo's seams. Any literal
 * carrying one of these English shapes is an emitted refusal, wherever it lives.
 * This is the one judgement in the file, and it is stated rather than hidden.
 */
const REFUSAL_MARKER = /refus|nothing ran|nothing was written|re-run with/i;

/** Sentence/clause breaks the anchor is cut at, after the `:` rule is tried. */
const ANCHOR_CUTS = [" — ", ". ", ", ", "; ", " (", "!", "?"];

/** Shortest anchor we accept as distinctive. Shorter ⇒ too generic to be a token. */
const ANCHOR_MIN = 8;

/** `--flag` tokens, `UI2API_*` env names, `*_ENV` name constants. */
const FLAG_RE = /--[a-z][a-z0-9-]*/g;
const ENV_LITERAL_RE = /"UI2API_[A-Z0-9_]+"/g;
const ENV_NAME_RE = /\b([A-Z][A-Z0-9_]*_ENV)\b/g;

interface Seam {
  /** `src/cli.ts:447` — where the anchor was derived from. */
  at: string;
  /** the enclosing function's name. */
  fn: string;
  /** the distinctive leading literal of the refusal, e.g. `unknown flag`. */
  anchor: string;
  /** the whole refusal message, used only to fold duplicate literals together. */
  text: string;
  /** every literal of the refusal, joined — the message the operator sees. */
  message: string;
  /** the statement the refusal was read out of. */
  stmt: string;
  /** command paths, e.g. `hub publish`. */
  commands: string[];
  /** every `--flag` in the guard clause or the remedy text. */
  flags: string[];
  /** `--flag`s the guard clause SCOPES the refusal to (required + companion). */
  guardFlags: string[];
  /** the `--flag`s WITHOUT which the refusal does not fire. */
  requiredFlags: string[];
  /** `--flag`s the refusal only NAMES in its remedy. */
  remedyFlags: string[];
  /** resolved `UI2API_*` env names. */
  envs: string[];
  /**
   * The module-level Set whose membership supplied `derivedFlags` (e.g.
   * `NUMERIC_FLAGS`), or `""` when this seam has no derived-set guard. Present
   * so the gate can prove the DERIVED-guard class is gated rather than dropped.
   */
  derivedFrom: string;
  /** the `--flag`s `derivedFrom` holds — derived from the parser, never typed. */
  derivedFlags: string[];
}

/** `cmdHubPublish` → `hub publish`; non-`cmd` names contribute no command path. */
function commandPathFromHandler(fn: string): string {
  const m = /^cmd([A-Z][A-Za-z0-9]*)$/.exec(fn);
  if (!m) return "";
  const words = m[1]!.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/\s+/);
  return words.join(" ");
}

/**
 * The anchor: the leading literal run of the refusal, i.e. its own text before
 * the first `${`, cut at the first `:` (kept, inclusive) else at the first
 * clause break. `publish-refused: hub unreachable at ${base}` → `publish-refused:`;
 * `refusing to bind the ACP server to ${want}` → `refusing to bind the ACP server to`.
 */
function anchorFromLiteral(text: string): string {
  const head = text.split("${")[0] ?? "";
  const colon = head.indexOf(":");
  if (colon >= 0) return head.slice(0, colon + 1).trim();
  let cut = head.length;
  for (const c of ANCHOR_CUTS) {
    const i = head.indexOf(c);
    if (i >= 0) cut = Math.min(cut, i);
  }
  return head.slice(0, cut).trim();
}

/**
 * Locate `fn`'s body by brace matching — LITERAL-AWARE. A plain counter treats
 * every `{` / `}` inside a string or a template as structure, so in a long
 * handler a stray brace in a message closed the body early and the refusal
 * throws near its end (`publish-refused:`, the two `cmdHubPublish` ones) were
 * never reached. Comments are already blanked by the caller.
 */
function functionBody(src: string, name: string): { body: string; offset: number } {
  const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!decl) return { body: "", offset: 0 };
  // Skip the PARAMETER LIST before looking for the body brace: `cmdHubPublish(
  // host: string, flags: Flags = {})` has a `{}` default value, and taking the
  // first `{` after the name opened THAT — so brace matching closed on its own
  // `}` and the handler's real body (both `publish-refused:` throws) was never
  // scanned at all.
  let p = src.indexOf("(", decl.index);
  let pd = 0;
  for (let k = p; k < src.length; k++) {
    if (src[k] === "(") pd++;
    else if (src[k] === ")" && --pd === 0) { p = k; break; }
  }
  let i = src.indexOf("{", p);
  if (i < 0) return { body: "", offset: 0 };
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (c === '"' || c === "'" || c === "`") {
      let k = j + 1;
      while (k < src.length) {
        if (src[k] === "\\") { k += 2; continue; }
        if (c === "`" && src[k] === "$" && src[k + 1] === "{") {
          let d = 1;
          k += 2;
          while (k < src.length && d > 0) {
            if (src[k] === "{") d++;
            else if (src[k] === "}") d--;
            k++;
          }
          continue;
        }
        if (src[k] === c) break;
        k++;
      }
      j = k;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { body: src.slice(i + 1, j), offset: i + 1 };
  }
  return { body: src.slice(i + 1), offset: i + 1 };
}

interface Lit {
  /** the literal's own text. */
  text: string;
  /** index of its opening quote, relative to the function body. */
  at: number;
  /** the whole STATEMENT it sits in — grouping needs the full expression. */
  stmt: string;
  /** every literal in that statement, joined — what the MARKER is tested on. */
  message: string;
}

/**
 * End of the statement starting at `from`, LITERAL-AWARE. A plain "next `;`"
 * scan splits a multi-literal refusal in half — the `;` in `"…--headless=new; the
 * real-user posture…"` closes the first literal's statement early, which left the
 * opening piece and the orphan tail looking like two different claims and made
 * the derivation drop the one carrying the real anchor.
 */
function endOfStatement(body: string, from: number): number {
  let i = from;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < body.length) {
        if (body[j] === "\\") { j += 2; continue; }
        if (c === "`" && body[j] === "$" && body[j + 1] === "{") {
          let d = 1;
          j += 2;
          while (j < body.length && d > 0) {
            if (body[j] === "{") d++;
            else if (body[j] === "}") d--;
            j++;
          }
          continue;
        }
        if (body[j] === c) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === ";") return i;
    i++;
  }
  return body.length;
}

/**
 * One forward pass that yields each literal together with the statement around
 * it. The statement matters because a refusal is routinely assembled as
 *
 *     return (`unknown flag ${f} — nothing ran. … ` + (near ? `…` : ``) +
 *             ` Run \`ui2api --help\` … Nothing was written.`)
 *
 * — a ternary in the middle means no two literals are `+`-adjacent, so literal
 * joining alone leaves the marker in an orphan tail. The statement is what makes
 * "does this whole sentence read as a refusal" a decidable question.
 */
function literalsIn(body: string): Lit[] {
  const spans: { text: string; at: number; stmt: string }[] = [];
  let stmtStart = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === ";" || c === "{" || c === "}") { stmtStart = i + 1; continue; }
    if (c !== '"' && c !== "'" && c !== "`") continue;
    let j = i + 1;
    while (j < body.length) {
      if (body[j] === "\\") { j += 2; continue; }
      if (c === "`" && body[j] === "$" && body[j + 1] === "{") {
        let d = 1;
        j += 2;
        while (j < body.length && d > 0) {
          if (body[j] === "{") d++;
          else if (body[j] === "}") d--;
          j++;
        }
        continue;
      }
      if (body[j] === c) break;
      j++;
    }
    // Start the scan AFTER the literal's closing quote, not AT it. `j` indexes
    // the closing quote, so passing it directly made `endOfStatement` treat that
    // quote as an OPENER: it then skipped from just past the close to the NEXT
    // literal's opener, and every character between was scanned as code. That
    // desynchronised the scan badly enough to find a `;` INSIDE the next refusal
    // literal and end the statement there — which is what orphaned
    // `Nothing was written; re-run with a number after ${t.flag}.` away from the
    // `malformed value for` anchor it belongs to. The anchor's own statement then
    // looked marker-free and the seam was DROPPED for a second, undocumented
    // reason, even once its trigger was derivable. Starting one past the close
    // keeps the quote state balanced from a known-synced position, so every
    // literal ahead is skipped whole and the statement ends at real code.
    const end = endOfStatement(body, j + 1);
    spans.push({ text: body.slice(i + 1, j), at: i, stmt: body.slice(stmtStart, end) });
    i = j;
  }
  // The marker is tested on the statement's LITERAL TEXT, never on the raw
  // statement source: raw source carries identifiers, paths and object keys, and
  // testing it there pulled in `ui2api-publish-`, `content-type` and
  // `metadata.json` as "refusals" purely because a neighbouring line of code
  // happened to sit inside the same statement span.
  const byStmt = new Map<string, { text: string; at: number; stmt: string; message: string }[]>();
  for (const sp of spans) {
    const g = byStmt.get(sp.stmt) ?? [];
    g.push({ ...sp, message: "" });
    byStmt.set(sp.stmt, g);
  }
  const out: Lit[] = [];
  for (const [stmt, group] of byStmt) {
    const message = group.map((g) => g.text).join("");
    for (const g of group) out.push({ ...g, stmt, message });
  }
  return out;
}

/**
 * The flags a guard clause SCOPES a refusal to, derived from `flags.<camel>`
 * reads in the guard. `flags.registryRepo && !flags.mirror` yields
 * `--registry-repo` as REQUIRED and `--mirror` as its companion — which is the
 * whole point: `hub publish --data-dir` is a different invocation and must not be
 * asked to carry the `--registry-repo` refusal.
 */
function guardFlagNames(guard: string): { required: string[]; companion: string[] } {
  const required: string[] = [];
  const companion: string[] = [];
  for (const m of guard.matchAll(/(!?)\s*flags\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
    const kebab = "--" + m[2]!.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    (m[1] === "!" ? companion : required).push(kebab);
  }
  return { required: [...new Set(required)].sort(), companion: [...new Set(companion)].sort() };
}

/**
 * A guard that filters an ITERATION by a Set instead of by a literal flag:
 * `if (!NUMERIC_FLAGS.has(t.flag)) continue;` — the shape that made
 * `numericFlagRefusal` UNGATEABLE, because `guardFlagNames` above only reads
 * `flags.<camel>` and this guard reads no flag at all. The set is the whole
 * trigger, and the set is DERIVED, so it can be derived here too.
 *
 * Two requirements, and the second is what makes this safe:
 *
 *   1. the `continue;` — proof the test is an ITERATION FILTER rather than a
 *      condition, and proof a loop encloses it (`continue` outside one is a
 *      syntax error), so the set really does gate the iteration the seam's
 *      message belongs to;
 *   2. the SAME iteration variable the seam's message interpolates. This is what
 *      a positional window could not do: in `numericFlagRefusal` the set test is
 *      one guard FURTHER BACK than the `if (t.missingValue) {` that `guardBefore`
 *      returns, so reading "the last guard before the literal" never saw it — and
 *      that is precisely why the seam was dropped in the first place. Matching
 *      `${t.flag}` in the message against `has(t.flag)` in the guard associates
 *      the seam with the decision that actually governs its own variable.
 *
 * The `!` is REQUIRED. `unknownFlagRefusal` guards
 * `if (KNOWN_FLAGS.has(t.flag)) continue;` — the same shape without the negation
 * — and admitting it would attach ~41 derived flags to that seam, so every skill
 * naming ANY flag would owe `unknown flag`. The negation is what says "this
 * refusal is scoped TO the set's members", which is the class that needs gating.
 */
function derivedSetGuardIn(
  body: string,
  at: number,
  stmtFlagVar: string,
): { ident: string } | null {
  if (!stmtFlagVar) return null;
  const head = body.slice(0, at);
  const re = new RegExp(
    `!\\s*([A-Z][A-Z0-9_]*)\\.has\\(\\s*${stmtFlagVar}\\.flag\\s*\\)\\s*\\)\\s*continue\\s*;`,
    "g",
  );
  let last: RegExpExecArray | null = null;
  let m = re.exec(head);
  while (m !== null) {
    last = m;
    m = re.exec(head);
  }
  return last ? { ident: last[1]! } : null;
}

/**
 * The iteration variable whose `.flag` a statement interpolates — `${t.flag}` in
 * `` `malformed value for ${t.flag}: …` ``. That interpolation is what the set
 * guard filters, so it is the join between the message and its trigger.
 */
const INTERPOLATED_FLAG_VAR = /\$\{\s*([A-Za-z_]\w*)\.flag\s*\}/;

/**
 * `<IDENT> = <helper>(parseFlags.toString())` — a module-level Set whose
 * membership is read out of the PARSER rather than typed beside it. Matching the
 * declaration shape (rather than the identifier) is what keeps this honest: a
 * hand-typed `const BAD = new Set(["--x"])` does not match, so it is not treated
 * as a derived set — which is correct, because a hand-typed list is exactly the
 * defect `src/cli.ts`'s own GOAL 215 comment warns about.
 */
const PARSER_DERIVED_DECL =
  /(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:new Set\(\s*\.\.\.\s*)?([A-Za-z]\w*)\(\s*parseFlags\.toString\(\)\s*\)/g;

/**
 * The published parser-derivation helpers, keyed by their own names, read off
 * the declaration above — so the FLAG LIST is never restated here. It is taken
 * from the same exported derivation `src/cli.ts` itself uses and that
 * `test/cli-input-validation.test.ts` mutation-proves against a synthetic
 * parser, so this gate and the source cannot disagree about which flags are
 * numeric.
 *
 * A new parser helper that is not wired in here does not fall back to anything:
 * when a GUARD names such a Set it lands in {@link UNRESOLVED_DERIVED_SETS} and
 * fails a named test. That is the honest failure mode — a NEW gate failing
 * loudly, never a stale list passing quietly. A declared Set that no guard names
 * is simply unused (`VALUE_TAKING_FLAGS` today) and is NOT reported, because
 * reporting it would be a false alarm about a seam that does not exist.
 */
const PARSER_DERIVED_HELPERS: Record<string, (parserSource: string) => Set<string>> = {
  knownFlagsFrom,
  numericFlagsFrom,
};

/** Guard-named Sets that could not be resolved. Reported by a named test, not dropped. */
const UNRESOLVED_DERIVED_SETS = new Set<string>();

/**
 * `parseFlags`' own source, read back out of `src/`. `functionBody` returns the
 * body plus the index of its opening brace, so the declaration is reconstructable
 * exactly — the same reconstruction `test/cli-input-validation.test.ts` performs
 * with its own `parseFlagsSource()`.
 */
function parserSourceOf(src: string): string {
  const declStart = src.indexOf("function parseFlags");
  const { body, offset } = functionBody(src, "parseFlags");
  if (declStart < 0 || !body || offset <= 0) return "";
  return src.slice(declStart, offset + 1 + body.length + 1);
}

/**
 * Every parser-derived flag Set a module declares, mapped IDENT → its members,
 * sorted. Empty for a file with no `parseFlags`.
 */
function derivedFlagSetsIn(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const parserSource = parserSourceOf(src);
  if (!parserSource) return out;
  for (const m of src.matchAll(PARSER_DERIVED_DECL)) {
    const helper = PARSER_DERIVED_HELPERS[m[2]!];
    if (helper) out.set(m[1]!, [...helper(parserSource)].sort());
  }
  return out;
}

/**
 * The guard clause in front of a literal: the last `if (` / `for (` / `while (`
 * / `case ` / `catch ` before it. That window is where `cmd === "hub" &&
 * arg === "publish"` and the flags a refusal is scoped to actually live, so it
 * is what associates a COMMAND with a LITERAL without a hand-written table.
 */
function guardBefore(body: string, at: number): string {
  const cuts: number[] = [];
  for (const re of [/\bif\s*\(/g, /\bfor\s*\(/g, /\bwhile\s*\(/g, /\bcase\b/g, /\bcatch\b/g]) {
    let m = re.exec(body);
    while (m !== null) {
      if (m.index >= at) break;
      cuts.push(m.index);
      m = re.exec(body);
    }
  }
  if (!cuts.length) return "";
  return body.slice(Math.max(...cuts), at);
}


/**
 * THE DERIVATION. Walk every function in `src/`, find its refusal literals, and
 * attach the command / flag / env that emits each — all read out of the source.
 * No seam name, no command and no literal is hand-listed anywhere in this file.
 */
export function deriveSeams(): Seam[] {
  const seams: Seam[] = [];
  // Re-derive from scratch, so a second `deriveSeams()` cannot report a stale
  // unresolved set from a previous pass.
  UNRESOLVED_DERIVED_SETS.clear();
  for (const file of tsFilesUnder(SRC)) {
    const raw = readFileSync(file, "utf8");
    const src = stripJsComments(raw);
    const rel = file.slice(REPO.length + 1);
    // `matchAll`, not `.exec`: a /g regex keeps `lastIndex` between files, so the
    // second file's scan silently started mid-string and every `*_ENV` const in
    // it resolved to nothing — which is how the ACP bind refusal lost its only
    // trigger and vanished from the derived set.
    const fileEnvs = new Set([...src.matchAll(ENV_LITERAL_RE)].map((m) => m[0].slice(1, -1)));
    const envConsts = new Map<string, string>();
    for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*_ENV)\s*=\s*"([A-Z0-9_]+)"/g)) {
      if (fileEnvs.has(m[2]!)) envConsts.set(m[1]!, m[2]!);
    }
    // Flag Sets this module derives FROM THE PARSER. Empty for every file that
    // has no `parseFlags`, so nothing outside the parser-owning module is
    // affected by this at all.
    const derivedSets = derivedFlagSetsIn(src);
    // A `function <name>(` inside a TEMPLATE LITERAL is FOREIGN SOURCE — the PHP
    // client `src/generator/lang-php.ts` emits, whose `//` lines are PHP comments
    // — and none of it is a message the runtime prints. Left in, the PHP body was
    // brace-matched and then scanned as JavaScript, the apostrophe in
    // `the runner's own honest refusal` opened a JS string, and the seam
    // `anchor "s own honest\n            // refusal"` was born with `--tag` (read
    // out of the same PHP body) as its trigger. The exclusion is at the
    // DECLARATION, not at the literal: every such body is foreign source, so
    // filtering per-literal would only remove today's symptom while the next
    // foreign body kept producing the next mangled anchor.
    const templates = templateSpans(src);
    const fnDecls = [...src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)].filter(
      (m) => !insideSpans(templates, m.index),
    );
    for (const fn of new Set(fnDecls.map((m) => m[1]!))) {
      const { body, offset } = functionBody(src, fn);
      if (!body) continue;
      const cmdPath = commandPathFromHandler(fn);
      // One refusal = one statement. Group the literals by their statement and
      // keep the FIRST literal of each, which is where the anchor lives.
      const byStmt = new Map<string, Lit>();
      for (const lit of literalsIn(body)) {
        if (!REFUSAL_MARKER.test(lit.message)) continue;
        if (lit.text.length < 3) continue;
        if (!byStmt.has(lit.stmt)) byStmt.set(lit.stmt, lit);
      }
      // A refusal is EITHER thrown, or it is what a `*Refusal` / `*ModeArg`
      // function exists to return. Without this the English marker alone swept
      // in every `console.log` summary, every HTTP `jsonError(...)` body and
      // every `attach_*` error code — 61 seams, most of them not refusals at all.
      const refusalSite = /Refusal$|ModeArg$/.test(fn);
      for (const lit of byStmt.values()) {
        // `throw new …` ANYWHERE in the statement, not just at its head: the
        // common shape is `if (cond) throw new Error(...)`, whose statement
        // begins with the guard, and a head-anchored test dropped every
        // conditional refusal in the CLI (including `action-map is untrusted`).
        if (!refusalSite && !/\bthrow\s+new\b/.test(lit.stmt)) continue;
        // A literal whose preceding non-space character is `+` is a CONTINUATION
        // of the message before it, not a claim of its own. `unknownFlagRefusal`
        // ends with ``+ ` Run \`ui2api --help\` … Nothing was written.`)`` and
        // that tail would otherwise demand its own literal from any skill naming
        // `--help` — pedantry, not a missing refusal. A genuinely separate branch
        // (`needsCompanionRefusal`'s three `if (cmd === …)` arms) is preceded by
        // `return (` and survives this test.
        let back = lit.at - 1;
        while (back >= 0 && /\s/.test(body[back]!)) back--;
        if (body[back] === "+") continue;
        const anchor = anchorFromLiteral(lit.text);
        if (anchor.length < ANCHOR_MIN) continue;

        // The guard clause names the command pair directly; the enclosing
        // `cmd*` handler is the fallback. Flags and envs come from the guard
        // window plus the refusal's OWN text — which is where the remedy names
        // them (`Run \`ui2api --help\``, `--xhost-all only means …`).
        const guard = guardBefore(body, lit.at);
        const commands = new Set<string>();
        const cmds = [...guard.matchAll(/\bcmd === "([^"]+)"/g)].map((m) => m[1]!);
        const args = [...guard.matchAll(/\barg === "([^"]+)"/g)].map((m) => m[1]!);
        if (cmds.length && args.length) commands.add(cmds[0] + " " + args[0]);
        else if (cmds.length) commands.add(cmds[0]!);
        if (commands.size === 0 && cmdPath) commands.add(cmdPath);

        // Guard flags scope the refusal (`--registry-repo` is only refused WITHOUT
        // `--mirror`), so they are kept apart from flags merely named in the
        // remedy text — conflating the two is what made `hub publish --data-dir`
        // look like it had to carry the `--registry-repo` refusal.
        const guardFlags = new Set([
          ...guardFlagNames(guard).required,
          ...guardFlagNames(guard).companion,
        ]);
        const requiredFlags = new Set(guardFlagNames(guard).required);
        // Flags/envs are read from the WHOLE statement, not just the anchor
        // literal: `--help` lives in the remedy tail of `unknownFlagRefusal`,
        // and `--acp` in the remedy of `generateTargetRefusal`, so reading only
        // the anchor left those seams with no trigger at all and dropped them.
        const remedyFlags = new Set(
          [...lit.stmt.matchAll(FLAG_RE)].map((m) => m[0]).filter((f) => !guardFlags.has(f)),
        );
        // Env triggers come from the whole statement, resolved through the
        // file's own `*_ENV` name constants — the ACP bind refusal names
        // `${ACP_BIND_ENV}` only in its LAST remedy clause, so an anchor-literal
        // scan lost its one and only trigger.
        const envs = new Set<string>();
        for (const m of lit.stmt.matchAll(ENV_NAME_RE)) {
          const v = envConsts.get(m[1]!);
          if (v) envs.add(v);
        }
        for (const m of lit.stmt.matchAll(/"(UI2API_[A-Z0-9_]+)"/g)) envs.add(m[1]!);

        // A guard filtering an iteration by a PARSER-DERIVED flag Set is a valid
        // trigger set, on the same terms a literal flag list is one. It is joined
        // to this seam through the `${t.flag}` the MESSAGE interpolates, not
        // through position, because in `numericFlagRefusal` the set test sits one
        // guard behind the `if (t.missingValue)` that `guard` ends at. Before this
        // the seam had no trigger at all and was DROPPED — which is why a skill
        // could name `--port` and owe nothing about the refusal it prints for
        // `--port abc`. The membership comes from the parser through the source's
        // own exported derivation, so it is the same set the refusal actually
        // judges and cannot drift from it.
        //
        // These go into `flags` (NOT `guardFlags`): the seam is not command-scoped
        // and has no `flags.<camel>` scoping read, so folding them into
        // `requiredFlags` would make the companion-pairing logic in
        // `triggersNamed` demand a companion that does not exist.
        const stmtFlagVar = INTERPOLATED_FLAG_VAR.exec(lit.stmt)?.[1] ?? "";
        const derivedGuard = derivedSetGuardIn(body, lit.at, stmtFlagVar);
        const derivedIdent = derivedGuard?.ident ?? "";
        // A guard naming a Set this gate cannot resolve is REPORTED, never
        // dropped in silence — that is the defect this class was added to fix.
        if (derivedIdent && !derivedSets.has(derivedIdent)) UNRESOLVED_DERIVED_SETS.add(derivedIdent);
        const derivedFlags = new Set<string>(derivedIdent ? derivedSets.get(derivedIdent) ?? [] : []);

        const flags = new Set([...guardFlags, ...remedyFlags, ...derivedFlags]);
        if (commands.size === 0 && flags.size === 0 && envs.size === 0) continue;

        // stripJsComments preserves length, so this offset is a real index in
        // the RAW file and the reported line is real, not a guess.
        const line = raw.slice(0, offset + lit.at).split("\n").length;
        seams.push({
          at: `${rel}:${line}`,
          fn,
          anchor,
          text: lit.text,
          message: lit.message,
          stmt: lit.stmt,
          commands: [...commands].sort(),
          flags: [...flags].sort(),
          guardFlags: [...guardFlags].sort(),
          requiredFlags: [...requiredFlags].sort(),
          remedyFlags: [...remedyFlags].sort(),
          envs: [...envs].sort(),
          derivedFrom: derivedIdent,
          derivedFlags: [...derivedFlags].sort(),
        });
      }
    }
  }
  // Two seams with the same opening are one claim (a refusal re-thrown on a
  // second code path). The `+`-continuation filter above already removed the
  // orphan-tail case; this collapses what is left.
  const folded = seams.filter(
    (s) => !seams.some((o) => o !== s && o.fn === s.fn && o.anchor === s.anchor && o.message.length > s.message.length),
  );
  const bySignature = new Map<string, Seam>();
  for (const s of folded) {
    const key = [s.fn, s.anchor, s.commands.join("|"), [...s.flags].sort().join("|"), s.envs.join("|")].join("\u0000");
    if (!bySignature.has(key)) bySignature.set(key, s);
  }
  return [...bySignature.values()].sort((a, b) => a.anchor.localeCompare(b.anchor));
}

/** The two spellings of the same CLI, collapsed so a path match is spelling-free. */
function normalize(text: string): string {
  return text
    .replace(/npx\s+tsx\s+src\/cli\.ts/g, "ui2api")
    .replace(/sudo\s+ui2api/g, "ui2api");
}

function skillFiles(): string[] {
  return readdirSync(SKILLS)
    .sort()
    .map((d) => join(SKILLS, d, "SKILL.md"))
    .filter((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });
}

/**
 * A command path counts as NAMED only in COMMAND POSITION — `ui2api hub publish`
 * or `cli.ts hub publish` — never as the bare English word. Without this the
 * seam derived from `cmdServe` fired on every skill containing the word "serve",
 * which is a false positive on a rule, not a finding about a skill.
 */
function namesCommand(text: string, path: string): boolean {
  const words = path.split(/\s+/).join("\\s+");
  return new RegExp(`(?:ui2api|cli\\.ts)\\s+${words}\\b`).test(text);
}

/**
 * Which triggers of `seam` this skill names — empty means the skill is silent.
 *
 * An env name alone is decisive (`UI2API_ACP_BIND` names exactly one refusal).
 * A COMMAND alone is not: a guard-scoped refusal such as
 * `hub publish --registry-repo` without `--mirror` is only reached when the skill
 * also names `--registry-repo`, so the command and its guard flag are required
 * TOGETHER. Requiring both is what kept `hub publish --data-dir` — a genuinely
 * different invocation — from being asked to carry the `--registry-repo` refusal.
 */
function triggersNamed(seam: Seam, text: string): string[] {
  const named: string[] = [];
  for (const e of seam.envs) if (text.includes(e)) named.push(e);
  if (seam.envs.some((e) => text.includes(e))) return named;

  const cmds = seam.commands.filter((c) => namesCommand(text, c));
  const flags = seam.flags.filter((f) => text.includes(f));
  if (seam.commands.length > 0) {
    if (cmds.length === 0) return [];
    const scoped = seam.requiredFlags.filter((f) => text.includes(f));
    if (seam.requiredFlags.length > 0 && scoped.length === 0) return [];
    named.push(...cmds, ...(scoped.length ? scoped : flags));
    return named;
  }
  named.push(...flags);
  return named;
}

const SEAMS = deriveSeams();

/**
 * Guard-named Sets the association step could NOT resolve to a trigger list. An
 * empty set is the healthy state; a name here means a seam was dropped for a
 * reason nobody reads, which is the defect this file was fixed for.
 */
function unresolvedDerivedSets(): Set<string> {
  return UNRESOLVED_DERIVED_SETS;
}

test("the derivation is not vacuous: it finds the refusal seams that exist in src/", () => {
  assert.ok(SEAMS.length >= 6, `only ${SEAMS.length} refusal seams derived — derivation is broken`);
  const anchors = SEAMS.map((s) => s.anchor);
  for (const must of ["unknown flag", "publish-refused:", "refusing to bind the ACP server to"]) {
    assert.ok(anchors.includes(must), `expected anchor ${JSON.stringify(must)} among ${JSON.stringify(anchors)}`);
  }
});

/**
 * The seams whose guard names a PARSER-DERIVED flag SET instead of a literal
 * flag list — `if (!NUMERIC_FLAGS.has(t.flag)) continue;` — are the class this
 * gate used to DROP. Its reason was recorded as structural ("no trigger is
 * derivable, so the seam is dropped rather than gated on nothing"), and the
 * anchor was derivable all along: the literal run before the first `${`, which
 * is `malformed value for`. So a skill could name `--port` and owe nothing about
 * the refusal it prints on `--port abc`.
 *
 * `derivedFrom` is the identifier whose membership supplied the trigger set (or
 * `""` when the seam has no such guard), so this reads the SAME `SEAMS` the gap
 * test reads rather than a parallel derivation that could drift from it.
 */
test("a seam whose guard names a PARSER-DERIVED flag set is gated, not dropped", () => {
  const derived = SEAMS.filter((s) => s.derivedFrom !== "");
  assert.ok(
    derived.length > 0,
    "no seam guarded by a parser-derived flag set was derived — the association step DROPS them, " +
      "which is how `malformed value for` became ungated",
  );
  for (const s of derived) {
    assert.ok(
      s.derivedFlags.length > 0,
      `seam ${s.fn} (${s.at}) claims trigger set ${s.derivedFrom} but resolved no flag out of it`,
    );
    assert.ok(
      s.anchor.length >= ANCHOR_MIN && !s.anchor.includes("${"),
      `parser-derived seam ${s.fn} produced a non-token anchor ${JSON.stringify(s.anchor)}`,
    );
  }
});

/**
 * A derived-set guard whose set cannot be resolved must NOT be dropped in
 * silence — that is the very defect this file was fixed for, one layer down. A
 * new parser helper that is not wired in here lands here, loudly, instead of
 * becoming a seam nobody gates.
 */
test("every parser-derived flag set a guard names is RESOLVED, not silently skipped", () => {
  assert.deepEqual(
    [...unresolvedDerivedSets()],
    [],
    `a guard names a derived set this gate cannot resolve, so its seam is dropped for a reason ` +
      `nobody reads: ${[...unresolvedDerivedSets()].join(", ")}`,
  );
});

test("every derived seam carries at least one command/flag/env trigger", () => {
  const mute = SEAMS.filter((s) => s.commands.length + s.flags.length + s.envs.length === 0);
  assert.deepEqual(mute, [], `seams with no trigger can never fire: ${mute.map((s) => s.anchor).join(", ")}`);
});

test("every derived anchor is distinctive enough to be a token (>= 8 chars, no interpolation)", () => {
  const weak = SEAMS.filter((s) => s.anchor.length < ANCHOR_MIN || s.anchor.includes("${"));
  assert.deepEqual(weak.map((s) => s.anchor), []);
});

/**
 * A seam is only a REFUSAL if a human-facing message the runtime actually prints
 * carries it. `src/generator/lang-php.ts` holds the entire PHP client inside one
 * template literal, so `function capability(` there is PHP SOURCE and the `//`
 * under it is a PHP comment. `deriveSeams` matched the declaration, brace-matched
 * the PHP body, and then scanned it as JavaScript: the apostrophe in
 * `the runner's own honest refusal` opened a JS "string" whose contents ran on
 * into `$data['error']`, and that mangled fragment became the seam
 *
 *     anchor `s own honest\n            // refusal`   flags [`--tag`]
 *
 * `--tag` came out of the same PHP body. Nothing about that seam is a refusal any
 * caller can be asked to carry — and a gate satisfiable by pasting a comment
 * fragment into a skill is not a gate.
 *
 * The test is deliberately not "the anchor is not this exact string": it
 * recomputes the template spans per file and fails for ANY seam whose literal
 * lands inside one, and separately asserts the exclusion is LOAD-BEARING — there
 * really is at least one function declaration inside a template literal in
 * `src/`, so the check cannot pass by having nothing to exclude.
 */
test("no refusal seam is derived from FOREIGN SOURCE inside a template literal", () => {
  const offenders: string[] = [];
  const embedded: string[] = [];
  for (const file of tsFilesUnder(SRC)) {
    const raw = readFileSync(file, "utf8");
    const spans = templateSpans(stripJsComments(raw));
    if (spans.length === 0) continue;
    const rel = file.slice(REPO.length + 1);
    const stripped = stripJsComments(raw);
    for (const m of stripped.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)) {
      if (insideSpans(spans, m.index)) embedded.push(`${rel}: ${m[1]}()`);
    }
    for (const s of SEAMS) {
      if (!s.at.startsWith(`${rel}:`)) continue;
      const off = offsetOfLine(raw, Number(s.at.slice(rel.length + 1)));
      if (off < 0 || !insideSpans(spans, off)) continue;
      offenders.push(
        `  ${s.at} fn ${s.fn} anchor ${JSON.stringify(s.anchor)} flags ${JSON.stringify(s.flags)}`,
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `refusal seams derived from code a generator EMITS rather than from a message the runtime prints:\n${offenders.join("\n")}`,
  );
  assert.ok(
    embedded.length > 0,
    "no function declaration inside a template literal was found in src/ — the template-literal " +
      "exclusion in deriveSeams() is vacuous, so this test would pass for the wrong reason",
  );
  assert.ok(
    embedded.includes("src/generator/lang-php.ts: capability()"),
    `expected the embedded PHP client's own capability() to be among ${embedded.length} template-declared ` +
      `functions; got: ${embedded.join(", ") || "(none)"}`,
  );
});

/**
 * The signature of the defect itself, independent of where it came from: an
 * anchor carrying a line-comment marker, or spanning lines, is not a sentence a
 * daemon prints — it is source text. This is the property that makes the gate
 * non-satisfiable-by-comment-paste, and it holds whatever the extraction does.
 */
test("no derived anchor is a comment fragment or a multi-line blob", () => {
  const bad = SEAMS.filter((s) => /(^|\s)\/\/|\/\*/.test(s.anchor) || /[\r\n]/.test(s.anchor));
  assert.deepEqual(
    bad.map((s) => `${s.at} fn ${s.fn} anchor ${JSON.stringify(s.anchor)}`),
    [],
    "a comment fragment is pasteable into any skill, so an anchor shaped like one cannot gate anything",
  );
});

test("a skill that NAMES a refusal-emitting command/flag/env CARRIES that refusal's literal", () => {
  const gaps: string[] = [];
  for (const file of skillFiles()) {
    const text = normalize(readFileSync(file, "utf8"));
    for (const seam of SEAMS) {
      const named = triggersNamed(seam, text);
      if (named.length === 0) continue;
      if (text.includes(seam.anchor)) continue;
      gaps.push(
        `  ${file.slice(REPO.length + 1)}\n` +
          `    names: ${named.join(", ")}\n` +
          `    missing literal: ${JSON.stringify(seam.anchor)}   (derived from ${seam.at}, fn ${seam.fn})`,
      );
    }
  }
  assert.deepEqual(gaps, [], `\nSKILLS MISSING A REFUSAL LITERAL:\n${gaps.join("\n")}\n`);
});
