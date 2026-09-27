// The COMMAND contract: what a human is TOLD to type must actually work.
//
// ui2api pins the RUNTIME contract meticulously (a wrong answer shows up at
// runtime) and the BUILD/DOCS/CI contract hardly at all. The documented history
// of this repo prices that gap:
//   * GOAL 145 — six `test/*.test.ts` files existed that NO npm script ran, so
//     six real gates never executed. A gate nobody runs is not a gate.
//   * `doc-numbers-truth`'s self-referential pin — it counted test files by
//     regexing the `package.json` script string instead of `readdir`-ing the
//     directory, so it was invisible on exactly the axis it guarded.
//   * CI stopped compiling the project for three pipelines: a `build` job died
//     and `verify` was SKIPPED. Every gate was fine; the WIRING was broken.
//
// This file is that discipline moved onto the commands a person is told to run. A
// doc saying `npm run verify` when no such script exists is worse than no doc: it
// costs a stranger an afternoon and then reads as a broken tool.
//
// EVERY list here is derived from disk (readdirSync / readFileSync) — the idiom
// at test/doc-numbers-truth.test.ts:46-52. No command, script name, or path is
// hand-typed, so nothing here can rot the way a remembered number does.
//
// WHY THE HELPERS ARE LOCAL. test/helpers/ci-contract-scan.ts exists, but it is
// owned by the CI-config gate (test/gate-wiring.test.ts) and its doc-scanning
// half was replaced under me mid-flight. A shared helper three agents are editing
// concurrently is a coupling this file must not carry: the derivation is ~40 lines
// and is the part that must be trusted, so it lives with the assertions that
// consume it and is re-proven by the mutation tests at the bottom of this file.
//
// WHAT IS ALREADY COVERED ELSEWHERE (deliberately not duplicated):
//   test/cli-command-coverage.test.ts asserts the FORWARD direction — every
//   command the dispatcher registers appears in HELP_LINES and in the docs. It
//   does NOT cover (a) the REVERSE direction (a doc naming a command the CLI
//   does not dispatch), (b) SUBcommands at all (`chrome start` vs `chrome stop`
//   — it reads only top-level `case` labels), or (c) the region-scoped AGENTS.md
//   `## Commands` block, which is the list an agent is expected to trust as the
//   CLI's surface. Those three gaps are this file.
//   test/doc-numbers-truth.test.ts covers the test-file counts and the
//   capability package COUNT; the deliberately-skipped-dir EXCEPTION and the
//   `read at` cite column of the knob table are ./ci-contract-knob-cites.test.ts.

import { test as t, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docsMentionPath } from "./helpers/doc-scan.js";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

// ============================================================ derivation =====

/**
 * Every markdown file a human is told to read: README.md, AGENTS.md and each
 * `docs/*.md`. readdir-derived, so a new doc joins the audit automatically
 * instead of needing a hand-maintained list that goes stale silently.
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

export function pathExists(p: string, root: string = ROOT): boolean {
  try {
    return existsSync(join(root, p));
  } catch {
    return false;
  }
}

export function fileExists(rel: string, root: string = ROOT): boolean {
  try {
    return statSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * The COMMAND-SHAPED parts of a document: fenced code blocks and inline backtick
 * spans, each returned SEPARATELY.
 *
 * Regions are deliberately not joined into one blob. Joining fabricates adjacency
 * across a line boundary, and a matcher that then allows a newline between a
 * command word and its argument reads tokens out of unrelated sentences — that is
 * how "ui2api drives" became a command called `drives`.
 */
export function codeRegions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(m[1]!);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!);
  return out;
}

export function docCodeRegions(
  files: string[] = docFiles(),
  root: string = ROOT,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) out.set(f, codeRegions(readDoc(f, root)));
  return out;
}

export function packageJson(root: string = ROOT): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
}

/** `npm run <name>` occurrences in doc code regions -> the docs naming each. */
export function npmRunScriptsInDocs(regions: Map<string, string[]>): Map<string, Set<string>> {
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
 * Bare `npm test` occurrences, tracked SEPARATELY from `npm run test`: bare
 * `npm test` resolves to the `test` script KEY, and with no such key npm exits
 * non-zero with "Missing script: test" (verified against npm on this box). A doc
 * telling a human `npm test` is lying unless that key exists.
 */
export function npmTestInDocs(regions: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  for (const [doc, rs] of regions) {
    for (const r of rs) if (/(?:^|[ \t])npm[ \t]+test(?:[ \t]|$)/.test(r)) out.add(doc);
  }
  return out;
}

/** Repo paths a doc tells a human to RUN (`npx tsx <path>`, `node <path>`, `tsx <path>`). */
export function runPathsInDocs(regions: Map<string, string[]>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      const re = /(?:^|[ \t])(?:npx[ \t]+)?(?:node|tsx|ts-node)[ \t]+((?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,4})/g;
      for (const m of r.matchAll(re)) {
        if (!out.has(m[1]!)) out.set(m[1]!, new Set());
        out.get(m[1]!)!.add(doc);
      }
    }
  }
  return out;
}

/**
 * A repo-relative path token a doc NAMES inside a command-shaped region.
 *
 * `data/`, `dist/` and `sites/` are deliberately NOT in this set. All three are
 * gitignored runtime/build state — README:652 tells the reader that
 * `data/registry.json` + `data/pkgs/<name>/<version>.json` IS the filesystem the
 * hub creates on demand ("backup = copy the folder"), and docs/AUDIT.md:66 names a
 * per-account vault path (`data/sessions/<host>/<slug>/state.json`) whose slug
 * differs per machine. Requiring those to exist would be a false positive by
 * construction: the contract under audit is "a path a MAINTAINER edits", i.e. the
 * source and test tree.
 */
const DOC_PATH_RE =
  /(?:^|[ `("'])((?:src|test|scripts|capabilities|docs|fixture|fixtures)\/[A-Za-z0-9_./-]+)/g;

/**
 * Every repo path a doc NAMES, keyed by path, valued by the docs naming it.
 * A DIRECTORY token (`src/prompt/`, `capabilities/`) resolves when the directory
 * exists — the layout blocks in AGENTS.md legitimately name directories.
 */
export function docPathTokens(
  regions: Map<string, string[]> = REGIONS,
  root: string = ROOT,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      for (const m of r.matchAll(DOC_PATH_RE)) {
        const p = m[1]!.replace(/[.,;:)\]/]+$/, "");
        if (!out.has(p)) out.set(p, new Set());
        out.get(p)!.add(doc);
      }
    }
  }
  return out;
}

export function unresolvableDocPaths(
  tokens: Map<string, Set<string>>,
  allowed: string[] = [],
  root: string = ROOT,
): string[] {
  return [...tokens]
    .filter(([p]) => !pathExists(p, root) && !allowed.includes(p))
    .map(([p, docs]) => `${p}  (${[...docs].sort().join(", ")})`)
    .sort();
}

/** Top-level `case "<cmd>":` labels in the real dispatcher. */
export function dispatchedCommands(
  src: string = readFileSync(join(ROOT, "src", "cli.ts"), "utf8"),
): Set<string> {
  const at = src.indexOf("switch (cmd)");
  const body = at >= 0 ? src.slice(at) : src;
  const out = new Set<string>();
  for (const m of body.matchAll(/case[ \t]+"([a-z][a-z0-9-]*)"[ \t]*:/g)) out.add(m[1]!);
  return out;
}

/**
 * Sub-command literals a dispatched command accepts, read from its OWN `case`
 * body: `arg === "<sub>"` comparisons and `"a" | "b"` string-union types (the
 * `chrome` dispatcher takes its action as a union, not a comparison).
 *
 * Whitespace is absorbed at the START of the repeated group: putting it at the
 * end makes the repetition unable to cross a space, which silently truncated
 * `"start" | "status" | "stop"` to two members.
 */
export function dispatchedSubcommands(
  src: string = readFileSync(join(ROOT, "src", "cli.ts"), "utf8"),
): Map<string, Set<string>> {
  const at = src.indexOf("switch (cmd)");
  const body = at >= 0 ? src.slice(at) : src;
  const cases = [...body.matchAll(/case[ \t]+"([a-z][a-z0-9-]*)"[ \t]*:/g)];
  const out = new Map<string, Set<string>>();
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
 * Each exists in a real documented line: env assignments
 * (`DISPLAY=:99 ui2api chrome start`, `UI2API_PROMPTD_TOKEN=… npx tsx src/cli.ts promptd`),
 * `sudo -u <user> -H`, and `npx`. Nothing else, so prose like "ui2api drives the
 * Chrome" — which has no command word after it — cannot enter the set.
 */
const SHELL_PREFIX =
  "(?:[A-Z0-9_]+=[^ \\t]+[ \\t]+)*(?:sudo[ \\t]+-u[ \\t]+\\S+[ \\t]+-H[ \\t]+)?(?:npx[ \\t]+)?";

/** The command word itself: the installed `ui2api` bin, or the dev `src/cli.ts`. */
const COMMAND_WORD = "(?:ui2api|tsx[ \\t]+src\\/cli\\.ts)";

/** A bare token, or a pipe-joined alternation of them (`hub | serve | remap`). */
const TOKEN_GROUP = "([a-z][a-z0-9-]*(?:[ \\t]*\\|[ \\t]*[a-z][a-z0-9-]*)*)";

/** Every top-level command the docs tell a human to RUN -> the docs naming each. */
export function documentedCommands(regions: Map<string, string[]>): Map<string, Set<string>> {
  const re = new RegExp(`(?:^|[ \\t])${SHELL_PREFIX}${COMMAND_WORD}[ \\t]+${TOKEN_GROUP}`, "g");
  return collectTokens(regions, re, (m) => m[1]!);
}

/** `<command> <sub>` pairs the docs tell a human to RUN -> the docs naming each. */
export function documentedSubcommands(regions: Map<string, string[]>): Map<string, Set<string>> {
  const re = new RegExp(
    `(?:^|[ \\t])${SHELL_PREFIX}${COMMAND_WORD}[ \\t]+([a-z][a-z0-9-]*)[ \\t]+${TOKEN_GROUP}`,
    "g",
  );
  return collectTokens(regions, re, (m) => `${m[1]!} ${m[2]!}`);
}

function collectTokens(
  regions: Map<string, string[]>,
  re: RegExp,
  key: (m: RegExpExecArray) => string,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [doc, rs] of regions) {
    for (const r of rs) {
      for (const m of r.matchAll(re)) {
        for (const tok of key(m).split(/[ \t]*\|[ \t]*/)) {
          if (!out.has(tok)) out.set(tok, new Set());
          out.get(tok)!.add(doc);
        }
      }
    }
  }
  return out;
}

// ================================================================ fixtures ===

const PKG = packageJson();
const REGIONS = docCodeRegions();
const DISPATCHED = dispatchedCommands();
const DOC_CMDS = documentedCommands(REGIONS);
const DOC_SUBS = documentedSubcommands(REGIONS);
const DISPATCHED_SUBS = dispatchedSubcommands();
const ALL_DOC_TEXT = docFiles().map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");

/**
 * Measured doc defects, exempt by CONTENT (the path token, never a line number —
 * a line-scoped entry in this repo went stale within minutes under a concurrent
 * edit). Each is a real, verified finding, not a suppression of a noisy pattern.
 */
export const ALLOWED_DOC_PATHS: { path: string; reason: string }[] = [
  // EMPTY, deliberately, and the budget below is 0. All four entries are DEAD: the docs that
  // named them no longer do — `src/generator/generate.js` (docs now say dist/generator/generate.js),
  // `src/hub/serve.js` and `src/registry/package.js` (named nowhere), and `src/prompt/trust.ts`
  // (CHANGELOG.md:134 records the phantom reference as removed). A suppression that suppresses
  // nothing is not coverage, it is debt with a comment on it.
];
/**
 * The hole this file tolerates, bounded. A growing allow-list is a gate being
 * switched off one entry at a time, so exceeding the budget fails rather than
 * passing quietly. Raise it only together with a named reason above.
 */
export const DOC_PATH_ALLOW_BUDGET = 0;

// ================================================================ rules ======

t("every `npm run <script>` the docs tell a human to run exists in package.json", () => {
  const named = npmRunScriptsInDocs(REGIONS);
  assert.ok(
    named.size >= 3,
    `non-vacuity: expected the docs to name >=3 npm scripts, found ${named.size} — a smaller set means the scan stopped reading`,
  );
  const missing = [...named]
    .filter(([s]) => !Object.prototype.hasOwnProperty.call(PKG.scripts, s))
    .map(([s, docs]) => `npm run ${s}  (${[...docs].sort().join(", ")})`)
    .sort();
  assert.deepEqual(
    missing,
    [],
    `these docs tell a human to run a script package.json does not define: ${missing.join("; ")}`,
  );
  // The other direction is NOT drift: a script nothing documents is a maintainer's
  // business, not a doc lie. Assert the scan really saw the script table, though —
  // a renamed package.json must not turn this gate vacuous.
  assert.ok(Object.keys(PKG.scripts).length >= 10, "package.json still carries a real script table");
});

t("every bare `npm test` in the docs resolves to a real `test` script", () => {
  const docs = [...npmTestInDocs(REGIONS)].sort();
  assert.ok(docs.length > 0, "non-vacuity: the docs do instruct `npm test` somewhere");
  assert.ok(
    Object.prototype.hasOwnProperty.call(PKG.scripts, "test"),
    `docs instruct \`npm test\` (${docs.join(", ")}) but package.json defines no "test" script; npm would answer "Missing script: test"`,
  );
});

t("every repo path a doc tells a human to RUN exists on disk", () => {
  const paths = runPathsInDocs(REGIONS);
  assert.ok(paths.size >= 2, `non-vacuity: expected >=2 runnable repo paths in the docs, found ${paths.size}`);
  const missing = [...paths]
    .filter(([p]) => !fileExists(p))
    .map(([p, docs]) => `${p}  (${[...docs].sort().join(", ")})`)
    .sort();
  assert.deepEqual(
    missing,
    [],
    `docs tell a human to run paths that do not exist: ${missing.join("; ")}`,
  );
});

t("every repo path a doc NAMES in a command-shaped region exists on disk", (ctx: TestContext) => {
  const tokens = docPathTokens(REGIONS);
  assert.ok(
    tokens.size >= 40,
    `non-vacuity: expected >=40 distinct path tokens across the docs, found ${tokens.size} — a smaller set means the region scan stopped reading`,
  );
  const problems = unresolvableDocPaths(tokens, ALLOWED_DOC_PATHS.map((a) => a.path));
  assert.deepEqual(problems, [], `docs name repo paths that do not exist: ${problems.join("; ")}`);
  // Each exemption must still be a live defect. An entry that no longer matches
  // anything is an allow-list entry rotting in place, so it is named; and the
  // budget is enforced, so the hole cannot quietly grow.
  const obsolete = ALLOWED_DOC_PATHS.filter((a) => !docsMentionPath(a.path)).map((a) => a.path);
  assert.ok(
    ALLOWED_DOC_PATHS.length <= DOC_PATH_ALLOW_BUDGET,
    `allow-list grew past its budget: ${ALLOWED_DOC_PATHS.length} > ${DOC_PATH_ALLOW_BUDGET}`,
  );
  ctx.diagnostic(
    `path allow-list: ${ALLOWED_DOC_PATHS.length}/${DOC_PATH_ALLOW_BUDGET} entries in use; ` +
      (obsolete.length
        ? `OBSOLETE (the path now exists — delete the entry): ${obsolete.join(", ")}`
        : "all entries still live"),
  );
});

t("every top-level command the docs tell a human to RUN is dispatched by src/cli.ts", () => {
  // The REVERSE of test/cli-command-coverage.test.ts, which walks dispatched ->
  // documented. That direction cannot catch a doc inventing a command: a reader
  // who types it gets an unknown-command error and blames the tool.
  assert.ok(DOC_CMDS.size >= 10, `non-vacuity: expected >=10 documented commands, found ${DOC_CMDS.size}`);
  assert.ok(DISPATCHED.size >= 15, `non-vacuity: expected >=15 dispatched commands, found ${DISPATCHED.size}`);
  const invented = [...DOC_CMDS]
    .filter(([c]) => !DISPATCHED.has(c))
    .map(([c, docs]) => `${c}  (${[...docs].sort().join(", ")})`)
    .sort();
  assert.deepEqual(
    invented,
    [],
    `docs tell a human to run commands src/cli.ts does not dispatch: ${invented.join("; ")}`,
  );
});

t("every command in the AGENTS.md `## Commands` block is dispatched", () => {
  // The one block an agent is expected to read as "the CLI's surface". Region
  // scoped on purpose: a hit anywhere else in the 52 KB file proves nothing about
  // the block an operator copies commands out of.
  const agents = readDoc("AGENTS.md");
  const start = agents.indexOf("\n## Commands");
  assert.ok(start >= 0, "AGENTS.md still carries a `## Commands` block");
  const rest = agents.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const block = end > 0 ? rest.slice(0, end) : rest;
  const blockRegions = new Map<string, string[]>([["AGENTS.md##Commands", codeRegions(block)]]);
  const cmds = documentedCommands(blockRegions);
  assert.ok(
    cmds.size >= 8,
    `non-vacuity: the ## Commands block should name >=8 commands, found ${cmds.size}: ${[...cmds.keys()].join(" ")}`,
  );
  const invented = [...cmds].filter(([c]) => !DISPATCHED.has(c)).map(([c]) => c).sort();
  assert.deepEqual(
    invented,
    [],
    `AGENTS.md's ## Commands block lists commands the dispatcher does not route: ${invented.join(" ")}`,
  );
  // The block's own npm lines are the same lie class, re-asserted here so the
  // block cannot be "fixed" by deleting the offending command's script.
  for (const s of npmRunScriptsInDocs(blockRegions).keys()) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(PKG.scripts, s),
      `AGENTS.md ## Commands block tells a human to run \`npm run ${s}\`, which package.json does not define`,
    );
  }
});

t("every dispatched SUBcommand is documented in the shipped docs", () => {
  // test/cli-command-coverage.test.ts reads only top-level `case` labels, so a
  // subcommand added to a case body (`chrome explode`) reaches the dispatcher with
  // no gate and no doc. This is the subcommand axis it does not have.
  assert.ok(
    DISPATCHED_SUBS.size >= 4,
    `non-vacuity: expected >=4 commands with subcommands, found ${DISPATCHED_SUBS.size}: ${[...DISPATCHED_SUBS.keys()].join(" ")}`,
  );
  const undocumented: string[] = [];
  for (const [cmd, subs] of [...DISPATCHED_SUBS].sort()) {
    for (const sub of [...subs].sort()) {
      // A same-line mention counts: AGENTS.md's `profile scan|import|capture|…`
      // documents five subcommands on one line, and that is legitimate.
      const documented =
        DOC_SUBS.has(`${cmd} ${sub}`) ||
        new RegExp(`${cmd}[ \\t]+[^\\n]*\\b${sub}\\b`).test(ALL_DOC_TEXT);
      if (!documented) undocumented.push(`${cmd} ${sub}`);
    }
  }
  assert.deepEqual(undocumented, [], `dispatched subcommands no doc mentions: ${undocumented.join(" ")}`);
});

// ============================================================== mutation =====

t("MUTATION: a doc naming a script package.json does not define is reported", () => {
  // The REAL predicate fed a synthetic doc region — the GOAL 145 shape (a
  // command that cannot run), made observable without touching the tree.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(PKG.scripts, "verify"),
    "precondition: no `verify` script exists today",
  );
  const fake = new Map<string, string[]>([["SYNTH.md", ["npm run build", "npm run verify"]]]);
  const missing = [...npmRunScriptsInDocs(fake)]
    .filter(([s]) => !Object.prototype.hasOwnProperty.call(PKG.scripts, s))
    .map(([s]) => s)
    .sort();
  assert.deepEqual(missing, ["verify"], "a doc naming a non-existent npm script must be reported");
  assert.deepEqual(
    [...npmRunScriptsInDocs(REGIONS)].filter(([s]) => !PKG.scripts[s]).map(([s]) => s),
    [],
    "the shipped docs are clean on this predicate today",
  );
});

t("MUTATION: a doc naming a command the CLI does not dispatch is reported", () => {
  const fake = new Map<string, string[]>([["SYNTH.md", ["ui2api promptd", "ui2api hyperspace"]]]);
  const cmds = documentedCommands(fake);
  assert.ok(cmds.has("hyperspace"), "precondition: the synthetic doc names a command");
  assert.deepEqual([...cmds].filter(([c]) => !DISPATCHED.has(c)).map(([c]) => c), ["hyperspace"]);
  assert.deepEqual(
    [...DOC_CMDS].filter(([c]) => !DISPATCHED.has(c)).map(([c]) => c),
    [],
    "the shipped docs are clean on this predicate today",
  );
});

t("MUTATION: a doc path that does not exist on disk is reported", () => {
  const fake = new Map<string, Set<string>>([["src/ghost/module.ts", new Set(["SYNTH.md"])]]);
  assert.deepEqual(unresolvableDocPaths(fake, []), ["src/ghost/module.ts  (SYNTH.md)"]);
  assert.deepEqual(unresolvableDocPaths(docPathTokens(REGIONS), ALLOWED_DOC_PATHS.map((a) => a.path)), []);
});

t("MUTATION: an undocumented dispatched subcommand is reported", () => {
  // Feed the real subcommand extractor a dispatcher carrying one extra
  // subcommand and confirm the doc side names it — the axis cli-command-coverage
  // cannot see, because it never looks inside a case body.
  const cli = readFileSync(join(ROOT, "src", "cli.ts"), "utf8");
  assert.deepEqual(
    [...(dispatchedSubcommands(cli).get("chrome") ?? [])].sort(),
    ["start", "status", "stop"],
    "precondition: the real chrome subcommands are these three",
  );
  const doctored = cli.replace('"start" | "status" | "stop"', '"start" | "status" | "stop" | "explode"');
  assert.notEqual(doctored, cli, "the mutation must actually alter the dispatcher text");
  const after = [...(dispatchedSubcommands(doctored).get("chrome") ?? [])].sort();
  assert.deepEqual(after, ["explode", "start", "status", "stop"], "the new subcommand must be extracted");
  const undocumented = after.filter(
    (sub) => !DOC_SUBS.has(`chrome ${sub}`) && !new RegExp(`chrome[ \\t]+[^\\n]*\\b${sub}\\b`).test(ALL_DOC_TEXT),
  );
  assert.deepEqual(undocumented, ["explode"], "an undocumented dispatched subcommand must be reported");
});
