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
    const end = endOfStatement(body, j);
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
    for (const fn of new Set([...src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1]!))) {
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
        const flags = new Set([...guardFlags, ...remedyFlags]);
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

test("the derivation is not vacuous: it finds the refusal seams that exist in src/", () => {
  assert.ok(SEAMS.length >= 6, `only ${SEAMS.length} refusal seams derived — derivation is broken`);
  const anchors = SEAMS.map((s) => s.anchor);
  for (const must of ["unknown flag", "publish-refused:", "refusing to bind the ACP server to"]) {
    assert.ok(anchors.includes(must), `expected anchor ${JSON.stringify(must)} among ${JSON.stringify(anchors)}`);
  }
});

test("every derived seam carries at least one command/flag/env trigger", () => {
  const mute = SEAMS.filter((s) => s.commands.length + s.flags.length + s.envs.length === 0);
  assert.deepEqual(mute, [], `seams with no trigger can never fire: ${mute.map((s) => s.anchor).join(", ")}`);
});

test("every derived anchor is distinctive enough to be a token (>= 8 chars, no interpolation)", () => {
  const weak = SEAMS.filter((s) => s.anchor.length < ANCHOR_MIN || s.anchor.includes("${"));
  assert.deepEqual(weak.map((s) => s.anchor), []);
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
