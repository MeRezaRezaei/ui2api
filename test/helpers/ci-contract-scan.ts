// Shared derivation for the `test/ci-contract-*.test.ts` gates: the BUILD / DOC /
// CI contract, i.e. the wiring of the wiring.
//
// The failure class these serve: ui2api pins the RUNTIME contract meticulously and
// the BUILD/CI contract not at all. Three times now the gates were fine and the
// WIRING was broken (GOAL 145's six unrun test files; doc-numbers-truth's
// self-referential pin; CI not compiling since pipeline 196). Everything below is
// derived from disk with readdirSync/readFileSync — the idiom at
// test/doc-numbers-truth.test.ts:46-52 — so no list, count, or path is hand-typed
// and cannot rot the way a remembered number does.
//
// SECTION 1 (documents, npm scripts, the CLI surface, the knob table) is the
// derivation the DOC-contract gates consume. SECTION 2 (the CI scanner) is the
// derivation the CI-WIRING gates consume. Every exported function takes an optional
// input override so a test can run the REAL predicate against a synthetic document
// — that is how each gate is proved able to go red without mutating the tree.

import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

/** Extensions that count as "code the project ships and runs". `.sh` is included
 *  deliberately: `scripts/ops/*.sh` READ UI2API_* knobs, and omitting shell is
 *  exactly how an undocumented knob survives — see `UI2API_XVFB_DISPLAY`. */
export const CODE_EXTENSIONS = [".ts", ".mjs", ".js", ".sh"] as const;

// --------------------------------------------------------------- documents ---

/**
 * Every markdown file a human is told to read: README.md, AGENTS.md, and every
 * `docs/*.md`. Derived with readdir, so a new doc is picked up automatically
 * instead of needing a hand-maintained list that silently goes stale.
 */
export function docFiles(root: string = ROOT): string[] {
  const out = ["README.md", "AGENTS.md"].filter((f) => existsSync(join(root, f)));
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) {
    for (const e of readdirSync(docsDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) out.push(`docs/${e.name}`);
    }
  }
  return out.sort();
}

export function readDoc(rel: string, root: string = ROOT): string {
  return readFileSync(join(root, rel), "utf8");
}

/**
 * The COMMAND-SHAPED parts of a document: fenced code blocks and inline backtick
 * spans, each returned as a SEPARATE string.
 *
 * Regions are deliberately NOT joined into one blob. Joining them fabricates
 * adjacency across a line boundary, and any matcher that then allows a newline
 * between a command word and its argument will read tokens out of unrelated
 * sentences — that is how "ui2api drives" became a "command" called `drives`.
 * Keeping them separate makes that class unrepresentable.
 */
export function codeRegions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(m[1]);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!);
  return out;
}

/** `{ docFile -> its code regions }`, for a whole doc set. */
export function docCodeRegions(
  files: string[] = docFiles(),
  root: string = ROOT,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) out.set(f, codeRegions(readDoc(f, root)));
  return out;
}

// ------------------------------------------------------------- npm scripts ---

export interface PackageJson {
  scripts: Record<string, string>;
}

export function packageJson(root: string = ROOT): PackageJson {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
}

/** `npm run <script>` occurrences in doc code regions -> the docs that name each. */
export function npmRunScriptsInDocs(
  regions: Map<string, string[]> = docCodeRegions(),
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      for (const m of r.matchAll(/(?:^|[ \t])npm[ \t]+run[ \t]+([a-zA-Z0-9:_-]+)/g)) {
        if (!out.has(m[1]!)) out.set(m[1]!, new Set());
        out.get(m[1]!)!.add(doc);
      }
    }
  }
  return out;
}

/**
 * Bare `npm test` occurrences. `npm test` is NOT `npm run test`: it resolves to
 * the `test` script key, and with no such key npm exits non-zero with
 * "Missing script: test" (verified against npm on this box). A doc telling a human
 * to run `npm test` is a lie unless the key exists, so it is tracked separately.
 */
export function npmTestInDocs(regions: Map<string, string[]> = docCodeRegions()): Set<string> {
  const out = new Set<string>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      if (/(?:^|[ \t])npm[ \t]+test(?:[ \t]|$)/.test(r)) out.add(doc);
    }
  }
  return out;
}

/**
 * Repo file paths a doc tells a human to run (`npx tsx <path>`, `node <path>`,
 * `tsx <path>`). Only paths carrying a `/` or a real extension are considered, so
 * a bare runner word is not mistaken for a file.
 */
export function runPathsInDocs(
  regions: Map<string, string[]> = docCodeRegions(),
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      const re = /(?:^|[ \t])(?:npx[ \t]+)?(?:node|tsx|ts-node)[ \t]+((?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,4})/g;
      for (const m of r.matchAll(re)) {
        const p = m[1]!;
        if (!out.has(p)) out.set(p, new Set());
        out.get(p)!.add(doc);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- CLI surface ---

/** Top-level `case "<cmd>":` labels in the real dispatcher. */
export function dispatchedCommands(src: string = readFileSync(join(ROOT, "src", "cli.ts"), "utf8")): Set<string> {
  const at = src.indexOf("switch (cmd)");
  const body = at >= 0 ? src.slice(at) : src;
  const out = new Set<string>();
  for (const m of body.matchAll(/case[ \t]+"([a-z][a-z0-9-]*)"[ \t]*:/g)) out.add(m[1]!);
  return out;
}

/**
 * Sub-command literals a dispatched command accepts, as they appear in its own
 * `case` body: `arg === "<sub>"` comparisons and `"a" | "b"` string-union types
 * (the `chrome` dispatcher takes its action as a union, not a comparison).
 *
 * Scope is declared, not assumed: this reads the dispatch CASE, so a subcommand
 * handled further up the file is out of scope. Every gate built on it pins the
 * shape it found, so a change to the dispatcher's shape fails loudly instead of
 * quietly shrinking the scanned set.
 */
export function dispatchedSubcommands(
  src: string = readFileSync(join(ROOT, "src", "cli.ts"), "utf8"),
): Map<string, Set<string>> {
  const at = src.indexOf("switch (cmd)");
  const body = at >= 0 ? src.slice(at) : src;
  const cases = [...body.matchAll(/case[ \t]+"([a-z][a-z0-9-]*)"[ \t]*:/g)];
  const out = new Map<string, Set<string>>();
  // Whitespace is absorbed at the START of the repeated group: putting it at the
  // end makes the repetition unable to cross a space, which silently truncated
  // `"start" | "status" | "stop"` to two members.
  const union = /"([a-z][a-z0-9-]*)"(?:[ \t]*\|[ \t]*"([a-z][a-z0-9-]*)")+/g;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const start = c.index! + c[0].length;
    const end = i + 1 < cases.length ? cases[i + 1]!.index! : body.length;
    const seg = body.slice(start, end);
    const subs = new Set<string>();
    for (const m of seg.matchAll(/arg[ \t]*===[ \t]*"([a-z][a-z0-9-]*)"/g)) subs.add(m[1]!);
    for (const m of seg.matchAll(union)) {
      for (const g of m[0].matchAll(/"([a-z][a-z0-9-]*)"/g)) subs.add(g[1]!);
    }
    if (subs.size > 0) out.set(c[1]!, subs);
  }
  return out;
}

/**
 * Shell prefixes allowed between the start of a code region and the command word.
 * Each exists in a real documented line:
 *   - env assignments: `DISPLAY=:99 ui2api chrome start` (AGENTS.md),
 *     `UI2API_PROMPTD_TOKEN=op-secret npx tsx src/cli.ts promptd` (README.md)
 *   - `sudo -u <user> -H`: `sudo -u ui2api -H npx tsx src/cli.ts chrome start` (AGENTS.md)
 *   - `npx`: `npx ui2api hub --port 8787` (README.md)
 * Nothing else is allowed, so prose like "ui2api drives the Chrome" — which has no
 * command word after it at all — cannot enter the set.
 */
const SHELL_PREFIX =
  "(?:[A-Z0-9_]+=[^ \\t]+[ \\t]+)*(?:sudo[ \\t]+-u[ \\t]+\\S+[ \\t]+-H[ \\t]+)?(?:npx[ \\t]+)?";

/** The command word itself: the installed `ui2api` bin, or the dev `src/cli.ts`. */
const COMMAND_WORD = "(?:ui2api|tsx[ \\t]+src\\/cli\\.ts)";

/** A bare token, or a pipe-joined alternation of them (`hub | serve | remap`). */
const TOKEN_GROUP = "([a-z][a-z0-9-]*(?:[ \\t]*\\|[ \\t]*[a-z][a-z0-9-]*)*)";

/** Every top-level command the docs tell a human to RUN -> the docs naming each. */
export function documentedCommands(
  regions: Map<string, string[]> = docCodeRegions(),
): Map<string, Set<string>> {
  const re = new RegExp(`(?:^|[ \\t])${SHELL_PREFIX}${COMMAND_WORD}[ \\t]+${TOKEN_GROUP}`, "g");
  const out = new Map<string, Set<string>>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      for (const m of r.matchAll(re)) {
        for (const tok of m[1]!.split(/[ \t]*\|[ \t]*/)) {
          if (!out.has(tok)) out.set(tok, new Set());
          out.get(tok)!.add(doc);
        }
      }
    }
  }
  return out;
}

/** `<command> <sub>` pairs the docs tell a human to RUN -> the docs naming each. */
export function documentedSubcommands(
  regions: Map<string, string[]> = docCodeRegions(),
): Map<string, Set<string>> {
  const re = new RegExp(
    `(?:^|[ \\t])${SHELL_PREFIX}${COMMAND_WORD}[ \\t]+([a-z][a-z0-9-]*)[ \\t]+${TOKEN_GROUP}`,
    "g",
  );
  const out = new Map<string, Set<string>>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      for (const m of r.matchAll(re)) {
        for (const sub of m[2]!.split(/[ \t]*\|[ \t]*/)) {
          const key = `${m[1]!} ${sub}`;
          if (!out.has(key)) out.set(key, new Set());
          out.get(key)!.add(doc);
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- knob table ---

export interface KnobRow {
  /** 1-based line of the row in AGENTS.md. */
  docLine: number;
  knob: string;
  /** The `read at` cell, verbatim — `path`, or `path:line`. */
  cite: string;
  /** The file part of `cite`, or "" when the cite is malformed. */
  file: string;
  /** The line part of `cite`, or null when the cite is file-only. */
  line: number | null;
}

/** Matches a `| `UI2API_X` | purpose | default | `read at` |` table row. */
const KNOB_ROW_RE = /^\|[ \t]*`(UI2API_[A-Z0-9_]+)`[ \t]*\|.*\|[ \t]*`([^`]+)`[ \t]*\|[ \t]*$/;

/** Every knob row in AGENTS.md's "full `UI2API_*` surface" table, parsed from disk. */
export function knobTableRows(root: string = ROOT): KnobRow[] {
  const lines = readFileSync(join(root, "AGENTS.md"), "utf8").split("\n");
  const out: KnobRow[] = [];
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

/**
 * Every `UI2API_*` name appearing in shipped code under `src/` and `scripts/`,
 * including `.sh`. AGENTS.md documents `UI2API_OS_USER` as read at
 * `scripts/ops/launch-ui2api-chrome.sh:8` — a shell script — so a scan that stops at
 * `.ts` cannot see half the operator surface.
 */
export function knobsReadInCode(root: string = ROOT): Set<string> {
  const out = new Set<string>();
  for (const dir of ["src", "scripts"]) {
    for (const f of codeFiles(join(root, dir))) {
      for (const m of readFileSync(f, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
    }
  }
  return out;
}

/** The knobs named in AGENTS.md's knob table. */
export function knobsInTable(root: string = ROOT): Set<string> {
  return new Set(knobTableRows(root).map((r) => r.knob));
}

// ------------------------------------------------------- capabilities dirs ---

export interface CapabilityDirCounts {
  /** Every directory under `capabilities/`. */
  dirs: string[];
  /** The ones carrying a `manifest.json` — i.e. real packages. */
  packages: string[];
  /** The ones WITHOUT a manifest — must be exactly the deliberately-skipped set. */
  withoutManifest: string[];
}

export function capabilityDirCounts(root: string = ROOT): CapabilityDirCounts {
  const base = join(root, "capabilities");
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const packages = dirs.filter((d) => existsSync(join(base, d, "manifest.json")));
  const withoutManifest = dirs.filter((d) => !packages.includes(d));
  return { dirs, packages, withoutManifest };
}

/** The `dir/` names AGENTS.md calls out as deliberately skipped (no manifest). */
export function documentedSkippedDirs(agentsMd: string = readFileSync(join(ROOT, "AGENTS.md"), "utf8")): string[] {
  const out: string[] = [];
  for (const m of agentsMd.matchAll(/`([\w.-]+)\/`[ \t]*is a deliberately-skipped/gi)) out.push(m[1]!);
  return out;
}

// ------------------------------------------------------------------ checks ---

export function fileExists(rel: string, root: string = ROOT): boolean {
  try {
    return statSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

export function fileContains(rel: string, needle: string, root: string = ROOT): boolean {
  try {
    return readFileSync(join(root, rel), "utf8").includes(needle);
  } catch {
    return false;
  }
}

export function lineContains(rel: string, line: number, needle: string, root: string = ROOT): boolean {
  try {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    return (lines[line - 1] ?? "").includes(needle);
  } catch {
    return false;
  }
}

// ============================================================================
// SECTION 2 — the CI-WIRING scanner (consumed by test/gate-wiring.test.ts).
//
// WHY A LINE SCANNER AND NOT A YAML PARSER: this project has no YAML dependency
// (deps are @modelcontextprotocol/sdk, classic-level, playwright, zod, @types/node,
// tsx, typescript) and adding one for a two-file gate is not a trade worth making.
// It is safe for THESE two files only because of three properties, the first of
// which is CHECKED (`yamlScannerHazards`) rather than promised:
//   1. neither config uses anchors, aliases, or folded (`>`) block scalars — the
//      three constructs where "what this line means" depends on another line;
//   2. the only block scalar used is a LITERAL block (`run: |`), whose commands
//      already sit one per line, which is exactly what a line scanner reads;
//   3. every rule built on this scanner is a REQUIRED-PRESENCE assertion. A
//      scanner that under-reads a construct can only turn a required step/script/
//      path into a MISSING one, which FAILS. The single way a scanner can lie
//      green is by reading nothing at all, and each config is separately asserted
//      to have yielded real content.
// ============================================================================

/** CI configs, DISCOVERED rather than listed. A hardcoded list of config files is
 *  the same rot these gates exist to catch: a third config added later would
 *  simply not be checked. */
export function discoverCiConfigs(root: string = ROOT): string[] {
  const out: string[] = [];
  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows).sort()) {
      if (/\.ya?ml$/.test(name)) out.push(join(".github", "workflows", name));
    }
  }
  for (const name of [".gitlab-ci.yml", ".gitlab-ci.yaml"]) {
    if (existsSync(join(root, name))) out.push(name);
  }
  return out;
}

/**
 * Drop YAML/shell comments, quote-aware.
 *
 * Needed because both configs talk ABOUT knobs and files inside comments — e.g.
 * `.gitlab-ci.yml` explains `UI2API_GH_LIVE=1` in a comment before assigning it.
 * A naive scan reads the comment as a second assignment, and a comment mentioning
 * a knob nobody sets reads as a phantom parity divergence. `#` only opens a
 * comment when it is outside quotes and preceded by nothing, whitespace, or a
 * YAML indicator, so a `#` inside `"..."` survives.
 */
export function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          continue;
        }
        if (c !== "#") continue;
        const prev = i === 0 ? "" : line[i - 1]!;
        if (i === 0 || prev === " " || prev === "\t" || prev === "," || prev === "-" || prev === "[" || prev === "{") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * YAML constructs a line scanner cannot read honestly. Kept as a CHECKED
 * precondition, not a promise: if a future edit introduces one of these into a CI
 * config, the gate says the scanner is no longer safe there instead of quietly
 * under-reading the file.
 */
export function yamlScannerHazards(text: string): string[] {
  const out: string[] = [];
  for (const [i, line] of stripComments(text).split("\n").entries()) {
    if (/:\s*>[-+]?\s*$/.test(line)) out.push(`line ${i + 1}: folded block scalar (" > ") joins lines; a line scanner cannot see inside it`);
    if (/(^|[\s:[{,-])&[A-Za-z0-9_.-]+/.test(line)) out.push(`line ${i + 1}: YAML anchor (&name) — the value may be defined on another line`);
    if (/(^|[\s:[{,-])\*[A-Za-z0-9_.-]+/.test(line)) out.push(`line ${i + 1}: YAML alias (*name) — the value lives on another line`);
  }
  return out;
}

/** Directories this repo owns; a reference outside them is not a repo path. */
const PATH_PREFIXES = ["test", "src", "scripts", "capabilities", ".gitlab", ".github"] as const;

/**
 * Repo-relative paths a CI config references, e.g. `test/wigolo-engine.test.ts` or
 * `.gitlab/fetch-wigolo.sh`.
 *
 * The leading `(?<![\w.\-/])` stops a match from starting mid-token, and the prefix
 * allow-list is what keeps this from firing on `$CI_PROJECT_DIR/wigolo` or
 * `KnockOutEZ/wigolo` noise: only the directories this repo actually owns are
 * scanned. Tokens carrying a glob char are returned separately — `test/*.test.ts`
 * is a legitimate reference to files that cannot be existence-checked one at a time.
 */
export function ciPathRefs(text: string): { paths: string[]; globs: string[] } {
  const stripped = stripComments(text);
  const re = new RegExp(
    `(?<![\\w.\\-/])((?:${PATH_PREFIXES.map((p) => p.replace(/\./g, "\\.")).join("|")})\\/[A-Za-z0-9._@/*-]+)`,
    "g",
  );
  const paths: string[] = [];
  const globs: string[] = [];
  for (const m of stripped.matchAll(re)) {
    const raw = m[1]!.replace(/[.,;:)]+$/, "");
    (raw.includes("*") ? globs : paths).push(raw);
  }
  return { paths: [...new Set(paths)].sort(), globs: [...new Set(globs)].sort() };
}

/** Script names a CI config invokes via `npm run <script>`. */
export function ciNpmRunScripts(text: string): string[] {
  return [
    ...new Set(
      [...stripComments(text).matchAll(/\bnpm run ([A-Za-z0-9:._-]+)/g)].map((m) => m[1]!),
    ),
  ].sort();
}

/**
 * Env assignments a CI config SETS — YAML mappings (`KNOB: "1"`) and shell
 * assignments (`KNOB=1`, `export KNOB=1`) — as `knob -> value`.
 *
 * Assignments only, never mentions: a comment that names a knob must not register
 * as setting it, or the parity rule would "pass" a knob that is only ever talked
 * about. The key pattern is UPPER_SNAKE, which in these two files distinguishes env
 * keys (`UI2API_GH_LIVE`) from YAML's own lower-case structure (`runs-on`,
 * `node-version`, `uses`, `with`).
 */
export function ciEnvKnobs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stripComments(text).split("\n")) {
    const map = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\S.*?)\s*$/);
    if (map) {
      out.set(map[1]!, map[2]!);
      continue;
    }
    for (const sh of line.matchAll(/(?:^|[\s;&|])(?:export\s+)?([A-Z][A-Z0-9_]*)=(\S+)/g)) {
      out.set(sh[1]!, sh[2]!);
    }
  }
  return out;
}

/**
 * Ordered step tokens of a CI config: `npm ci`, `npm test`, `npm run <script>`.
 * Order is preserved because it is the subject of the chain rule: a pipeline that
 * runs the unit suite BEFORE the build is a different, wrong pipeline, and a
 * set-membership check cannot see that. Sequence is the order the tokens appear in
 * the FILE; for `.gitlab-ci.yml` the job order in the file is also the stage order
 * (`stages: [build, verify]`), so file order is execution order there.
 */
export function ciStepTokens(text: string): string[] {
  const out: string[] = [];
  for (const line of stripComments(text).split("\n")) {
    for (const m of line.matchAll(/\bnpm (?:ci|install|test)\b|\bnpm run ([A-Za-z0-9:._-]+)/g)) {
      out.push(m[1] ? `npm run ${m[1]}` : m[0].replace(/\s+/g, " ").trim());
    }
  }
  return out;
}

// ------------------------------------------------------------- predicates ---

/** Paths a config references that do not exist in the repo. */
export function checkCiPaths(config: string, text: string, root: string = ROOT): string[] {
  return ciPathRefs(text)
    .paths.filter((p) => !fileExists(p, root))
    .map((p) => `${config} references "${p}", which does not exist in the repo`);
}

/** `npm run <script>` invocations with no matching package.json script. */
export function checkCiScripts(config: string, text: string, scripts: Record<string, string>): string[] {
  return ciNpmRunScripts(text)
    .filter((s) => !(s in scripts))
    .map(
      (s) =>
        `${config} runs "npm run ${s}" but package.json scripts has no "${s}" (defined: ${Object.keys(scripts).sort().join(", ")})`,
    );
}

/**
 * The gate chain the project claims it runs, in order.
 *
 * Anchored to AGENTS.md's "Verification before claiming done" (build, `npm test`,
 * `test:unit`, `check:verbatim` + `check:verbatim:goals`), and every entry is
 * asserted against that doc, so the chain is not invented here. `doc: null` marks
 * a step CI runs but AGENTS.md does NOT name — reported as a diagnostic rather
 * than asserted, because "undocumented" is a doc gap and this gate's subject is the
 * pipeline. `builtin` marks npm builtin/lifecycle names, which are not `scripts`
 * entries.
 */
export const GATE_CHAIN: readonly { step: string; doc: string | null; builtin?: boolean }[] = [
  { step: "npm ci", doc: null, builtin: true },
  { step: "npm run build", doc: "npm run build" },
  // FINDING: wired in BOTH configs by GOAL 147, but AGENTS.md names only
  // `npx tsc --noEmit` — `npm run typecheck` is documented nowhere in the repo.
  { step: "npm run typecheck", doc: null },
  { step: "npm run check:verbatim", doc: "npm run check:verbatim" },
  { step: "npm run check:verbatim:goals", doc: "npm run check:verbatim:goals" },
  { step: "npm test", doc: "npm test", builtin: true },
  { step: "npm run test:unit", doc: "npm run test:unit" },
];

/**
 * Chain steps missing from a config, or present in the WRONG ORDER.
 *
 * The corpus gates are the reason this is not optional: both configs call
 * `check:verbatim` part of the "human-free chain" — a change that leaves the corpus
 * inconsistent must fail the pipeline, not a person — and that sentence becomes
 * false, silently, the moment one config drops the step.
 */
export function checkChain(config: string, text: string): string[] {
  const steps = ciStepTokens(text);
  const problems: string[] = [];
  let cursor = -1;
  for (const { step } of GATE_CHAIN) {
    const at = steps.indexOf(step, cursor + 1);
    if (at === -1) problems.push(`${config} never runs "${step}" in the documented gate-chain order`);
    else cursor = at;
  }
  return problems;
}

export interface KnobDivergence {
  knob: string;
  /** The config that SETS the knob. */
  config: string;
  /** The config that does NOT. */
  other: string;
}

/**
 * `UI2API_*` knobs set in one config but not the other.
 *
 * This is the knob that gets set in one file and silently left out of the other,
 * so the two pipelines stop running the same gates. Only `UI2API_*` is compared:
 * it is the namespace this repo owns end to end.
 */
export function knobDivergences(
  a: string,
  aText: string,
  b: string,
  bText: string,
): KnobDivergence[] {
  const mine = ui2apiKnobs(aText);
  const theirs = ui2apiKnobs(bText);
  return [
    ...[...mine].filter((k) => !theirs.has(k)).map((knob) => ({ knob, config: a, other: b })),
    ...[...theirs].filter((k) => !mine.has(k)).map((knob) => ({ knob, config: b, other: a })),
  ];
}

export function ui2apiKnobs(text: string): Set<string> {
  return new Set([...ciEnvKnobs(text).keys()].filter((k) => k.startsWith("UI2API_")));
}

export function fmtDivergence(d: KnobDivergence): string {
  return `${d.config} sets ${d.knob} but ${d.other} does not`;
}

/**
 * Justified knob asymmetries, keyed by the knob NAME — a CONTENT key, never a line
 * number (a line-scoped allow-list entry in this repo went stale within minutes
 * under a concurrent edit). Each entry must carry a reason; an entry with an empty
 * reason fails its own test, and an entry naming a knob no config sets is stale and
 * also fails, so an unjustified exception cannot rot in quietly.
 */
export const KNOB_PARITY_ALLOW: Record<string, string> = {};

/**
 * The `test/*.test.ts` files in the git INDEX — i.e. the files the repository
 * actually ships.
 *
 * Why the index and not just `readdirSync("test")`: CI checks out a COMMIT, so the
 * shipped set is the index. A file that is on disk but untracked is not yet part of
 * the repo's contract and no pipeline could run it; several agents edit this tree
 * at once, and a gate that fired on their in-flight files would be a false positive
 * on correct wiring (the class that teaches people to ignore a gate). Scoping to
 * the index expires by itself: the moment the file is committed, the requirement
 * lands on it without any edit here.
 *
 * A tracked file missing from the working tree is a different matter and is
 * reported, not asserted — a concurrent `git rm`/move during a test run is
 * indistinguishable from a real deletion.
 */
export function trackedTestFiles(root: string = ROOT): Set<string> {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "test/"], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
  } catch (err) {
    throw new Error(
      `the CI-wiring gate needs the git index (git ls-files test/) and could not read it in ${root}: ${(err as Error).message}. Run the suite from a checkout — a gate that silently sees zero tracked files is a gate that proves nothing.`,
    );
  }
  return new Set(
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("test/") && l.endsWith(".test.ts"))
      .map((l) => l.slice("test/".length)),
  );
}
