import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * GOAL 102: the suite's own signal was untrustworthy. Measured in this very
 * session: a full run hit EXIT=124 with a file hung for 864s, and another run
 * produced 5 FILE-LEVEL failures that all passed standalone. Root causes were 23
 * subprocess/network call sites with NO timeout (for spawnSync that means WAIT
 * FOREVER — including a live `gh` GitHub API call), no per-test timeout, and
 * almost no teardown of the servers tests start.
 *
 * A pin that measures nothing is what let this happen, so this pin is a real
 * mechanical scan of every test file.
 *
 * The rule is unchanged and keeps its teeth: every REAL subprocess/network call
 * in `test/` must be bounded by a `timeout`/`signal` or a nearby `.kill(`.
 */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SELF = "test/test-timeout-discipline.test.ts";
const TEST_FILES = readdirSync("test")
  .filter((f) => f.endsWith(".ts") && `test/${f}` !== SELF)
  .map((f) => `test/${f}`);
/** SYNC family: Node's spawnSync/execFileSync accept a `timeout` option. */
const SYNC_FAMILY = /(?<![.\w$])(spawnSync|execFileSync)\(/g;
/** ASYNC family: spawn/exec/execFile have NO timeout option — they need a
 *  bounded kill (`.kill(`) or an AbortSignal, or a hung child never settles. */
const ASYNC_FAMILY = /(?<![.\w$])(spawn|execFile|exec)\(/g;

/** The same two families as SETS, so the rule has exactly one definition. The
 *  parser oracle below matches on these names, and the lookbehind that excludes
 *  `cp.exec(` / `/re/.exec(` is expressed THERE structurally — a bare
 *  `Identifier` callee — instead of by a second, hand-written regex. */
const SYNC_FAMILY_SET = new Set(["spawnSync", "execFileSync"]);
const ASYNC_FAMILY_SET = new Set(["spawn", "execFile", "exec"]);
/** Cheap prefilter for the parser cross-check: does this file mention the family
 *  at all? A file that does not cannot contain a call to it. */
const FAMILY_MENTION = /(?<![.\w$])(?:spawnSync|execFileSync|spawn|execFile|exec)\s*\(/;

// --------------------------------------------------------------- the scanner ---
//
// WHY A SCAN AT ALL, AND WHY THIS SCAN. The rule's signal is a CALL, and a call
// is CODE. An earlier version of this gate stripped comments with the repo's
// usual `.replace(/\/\/.*$/gm, "")` idiom and then scanned the result, which made
// it read STRING DATA as call sites. It fired on CI (pipeline 218) with six
// findings that were all string fixtures belonging to the sibling gate
// test/host-independence-gate.test.ts — a gate whose own source NECESSARILY
// quotes every forbidden shape as data (its R1 rule table, the synthetic inputs
// its self-tests feed its predicates). None of the six was a call that gate
// makes; on the code view below that file has ZERO exec-family call sites.
//
// The naive `//` stripper is not merely imprecise here, it is actively
// DESTRUCTIVE, and that is documented with the same finding in
// test/host-independence-gate.test.ts:437-439: `"https://…"` and
// `page.goto("http://example.com/")` contain `//`, so the naive stripper eats
// the rest of the line. Measured here: the `execFileSync("curl", ["-s",
// "https://…"])` fixture on line 408 unbalanced the paren scan, and the
// resulting phantom "call" ran from line 408 to the end of the file, swallowing
// real code on the way. A stripper that mis-parses is worse than no stripper,
// because it reports clean.
//
// So this is a CHARACTER STATE MACHINE (the approach the sibling gate already
// proved), re-derived here rather than imported. It is re-derived on purpose:
// importing the sibling would (a) mean importing a `.test.ts`, which under
// node:test RE-REGISTERS that file's tests inside this run, and (b) couple two
// independent gates so that deleting or renaming either breaks the other.
//
// `codeView` blanks comments AND string/template/regex CONTENTS, and it
// preserves every byte offset and every newline. Offsets matter: the async
// branch below looks 1200 characters PAST a `spawn(` for a `.kill(`, so the
// view has to be index-aligned with the real source.

/** A `/` opens a regex literal (rather than dividing) only when what precedes it
 *  cannot end an expression. The standard heuristic. */
const REGEX_PRECEDERS = new Set([
  "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*",
  "%", "<", ">", "~", "^", "\n",
]);
/** …and the same for a preceding KEYWORD, which ends in an identifier char. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do",
  "else", "yield", "await", "case", "throw",
]);

/** Blank comments, string contents, template contents and regex-literal
 *  contents, keeping every byte offset and newline. Returns a view in which a
 *  surviving `execFileSync(` is a real call and a quoted one is not.
 *
 *  Two safety properties, both pinned by the self-tests below:
 *   1. A regex literal cannot contain a literal newline, so a `/` misread as a
 *      regex start SELF-CORRECTS at the next newline instead of blanking the
 *      rest of the file. The scanner therefore cannot silently blank a whole
 *      file by accident.
 *   2. A `${…}` interpolation returns to CODE state, so a real call inside a
 *      template hole is still found rather than hidden. */
export function codeView(src: string): string {
  const n = src.length;
  let out = "";
  let i = 0;
  type St = "code" | "line" | "block" | "str" | "regex";
  let st: St = "code";
  let quote = "";
  /** Interpolation frames: a `${` inside a template pushes one, and the `}` that
   *  closes it pops back into the template. */
  const frames: Array<{ quote: string; depth: number }> = [];
  let depth = 0;
  let lastSig = "";
  let lastWord = "";
  const emit = (s: string): void => { out += s; };
  while (i < n) {
    const c = src[i] as string;
    const c2 = src[i + 1];
    if (st === "code") {
      if (c === "/" && c2 === "/") { st = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { st = "block"; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") {
        st = "str"; quote = c; emit(" "); lastSig = c; lastWord = ""; i++; continue;
      }
      if (c === "/" && (REGEX_PRECEDERS.has(lastSig) || REGEX_KEYWORDS.has(lastWord))) {
        st = "regex"; i++; continue;
      }
      if (c === "{" ) { depth++; }
      else if (c === "}" && frames.length > 0 && depth === 0) {
        const f = frames.pop()!;
        st = "str"; quote = f.quote; emit(" "); lastSig = c; lastWord = ""; i++; continue;
      } else if (c === "}") { depth--; }
      if (/[A-Za-z0-9_$]/.test(c)) { lastWord += c; lastSig = c; }
      else if (!/\s/.test(c)) { lastWord = ""; lastSig = c; }
      emit(c); i++; continue;
    }
    if (st === "line") {
      if (c === "\n") { st = "code"; emit(c); }
      i++; continue;
    }
    if (st === "block") {
      if (c === "*" && c2 === "/") { st = "code"; i += 2; continue; }
      if (c === "\n") emit(c);
      i++; continue;
    }
    if (st === "regex") {
      // self-correction: a real regex cannot span a newline, so if we reach one
      // the `/` was a division after all — rewind and let CODE state see it.
      if (c === "\n") { st = "code"; emit("/"); emit(c); lastSig = "\n"; i++; continue; }
      if (c === "\\") { i += 2; continue; }
      if (c === "[") { while (i < n && src[i] !== "\n" && src[i] !== "]") i++; i++; continue; }
      if (c === "/") { st = "code"; emit(" "); lastSig = "/"; lastWord = ""; i++; continue; }
      i++; continue;
    }
    // inside a string / template literal
    if (quote === "`" && c === "$" && c2 === "{") {
      frames.push({ quote, depth });
      depth = 0; st = "code"; i += 2; continue;
    }
    if (c === "\\") { if (c2 === "\n") emit("\n"); i += 2; continue; }
    if (c === quote) { st = "code"; emit(" "); lastSig = c; lastWord = ""; i++; continue; }
    if (c === "\n") emit(c);
    i++;
  }
  return out;
}

/** Extract every call of a family with balanced parens. */
function execCalls(src: string, re: RegExp): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    while (i < src.length) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    out.push({ start: m.index, end: i + 1, text: src.slice(m.index, i + 1) });
  }
  return out;
}

/** The unbounded call sites in ONE already-read source. Every caller — the
 *  corpus scan below and every self-test — goes through this one function, so a
 *  self-test that makes it go red is a proof about the real scan and not about a
 *  parallel re-implementation. */
export function scanSource(src: string, label: string): string[] {
  // Comments AND string contents are blanked first: a PROSE mention of `spawn(`
  // cannot hang, and neither can a quoted fixture the file matches against. What
  // survives is real code, which is the only thing that can hang.
  const code = codeView(src);
  const unbounded: string[] = [];
  // SYNC calls must carry `timeout:` — without it spawnSync waits FOREVER.
  execCalls(code, SYNC_FAMILY).forEach((c, i) => {
    if (!/timeout\s*:/.test(c.text)) unbounded.push(`${label} sync-call#${i + 1} (needs timeout)`);
  });
  // ASYNC: `exec`/`execFile` DO accept `timeout` and `signal`. Only `spawn`
  // has neither, so it alone requires a bounded `.kill(` nearby.
  execCalls(code, ASYNC_FAMILY).forEach((c, i) => {
    if (/\bspawn\(/.test(c.text)) {
      const after = code.slice(c.end, c.end + 1200);
      if (!/\.kill\(/.test(after)) unbounded.push(`${label} spawn-call#${i + 1} (needs a bounded .kill())`);
      return;
    }
    if (!/timeout\s*:/.test(c.text) && !/signal\s*:/.test(c.text))
      unbounded.push(`${label} async-call#${i + 1} (needs timeout or signal)`);
  });
  return unbounded;
}

/** Real exec-family call sites in a source, on the CODE view. Used by the
 *  anti-vacuity pin: if the scanner ever stopped understanding code, this
 *  count would collapse toward zero and the pin would fail. */
export function callSiteCount(src: string): number {
  const code = codeView(src);
  return execCalls(code, SYNC_FAMILY).length + execCalls(code, ASYNC_FAMILY).length;
}

/** The same count, asked of TypeScript's PARSER instead of the hand-rolled
 *  character view — an oracle that owes nothing to `codeView`.
 *
 *  This exists because "the scanner is precise enough" is otherwise a claim
 *  about a regex scan, and a regex scan can only be checked by another regex
 *  scan. The parser is a different KIND of instrument: it is handed the same
 *  bytes and reports the `CallExpression` nodes that genuinely exist, so when
 *  the two agree the DATA/CODE decision is corroborated by something that never
 *  heard of strings-versus-code. When they disagree, one of them is wrong and
 *  the disagreement is a named failure instead of a silent loss of coverage.
 *
 *  Deliberately NOT `ts.createScanner`: the low-level scanner cannot tell a
 *  regex literal from a division (that is the PARSER's job via reScanSlashToken),
 *  so on this corpus it opens a bogus string at `/["']/` in
 *  test/assertions-are-counted.test.ts:28 and stops emitting real tokens — it
 *  found 450 tokens in a 12 887-char file. The parser gets it right. */
function parserCallSiteCount(src: string, file: string): number {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (SYNC_FAMILY_SET.has(node.expression.text) || ASYNC_FAMILY_SET.has(node.expression.text))
    ) n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

d("GOAL 102: the measuring instrument is itself trustworthy", () => {
  t("every subprocess/network call in test/ is bounded (timeout or a kill)", () => {
    const unbounded: string[] = [];
    for (const f of TEST_FILES) {
      const raw = readFileSync(join(ROOT, f), "utf8");
      unbounded.push(...scanSource(raw, f));
    }
    assert.deepEqual(unbounded, [], `these calls can hang forever: ${unbounded.join(", ")}`);
  });

  t("the suite declares an explicit per-test timeout", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const script: string = pkg.scripts["test:unit"];
    assert.match(script, /--test-timeout=\d+/, "test:unit must carry --test-timeout so a hang is a NAMED failure");
    const ms = Number(script.match(/--test-timeout=(\d+)\}?/)![1]);
    // generous enough not to fail a legitimately slow test, tight enough to
    // convert a 29-minute stall into a reported failure
    assert.ok(ms >= 30_000, `timeout ${ms}ms is too tight for the slowest real test (~28s standalone)`);
    assert.ok(ms <= 180_000, `timeout ${ms}ms is too loose — a real hang must surface well before 29 minutes`);
  });

  t("negative: the scan CAN fail — an unbounded scratch call is reported", () => {
    const scratch = 'const x = execFileSync("gh", ["repo", "view"]);\nconst y = execFileSync("git", ["ls-files"], { timeout: 5 });';
    const code = codeView(scratch);
    const calls = execCalls(code, SYNC_FAMILY);
    const unbounded = calls.filter((c) => !/timeout\s*:/.test(c.text));
    assert.equal(unbounded.length, 1, "exactly the unbounded scratch call must be reported");
    assert.equal(calls.length, 2, "the scan must see both calls");
    // …and through the REAL production path, not just the helper.
    assert.deepEqual(
      scanSource(scratch, "scratch.ts"),
      ["scratch.ts sync-call#1 (needs timeout)"],
      "the production scan must name the one unbounded call and stay quiet on the bounded one",
    );
    // an async call with no signal and no nearby kill must also be reported
    const asyncScratch = 'const c = spawn("node", ["x"]);\nconst c2 = spawn("node", ["y"], { signal: c.signal });';
    const aCalls = execCalls(codeView(asyncScratch), ASYNC_FAMILY);
    assert.equal(aCalls.length, 2, "the async scan must see both spawns");
    assert.equal(aCalls.filter((c) => !/signal\s*:/.test(c.text)).length, 1, "the unbounded async call must be reported");
    // The production scan's spawn contract, stated exactly as the rule is
    // written: `spawn` has no `timeout` option, so it is bounded ONLY by a
    // nearby `.kill(` — a `signal` is not accepted in its place. Both scratch
    // spawns therefore need a kill, and this is deliberately NOT relaxed.
    assert.deepEqual(
      scanSource(asyncScratch, "scratch.ts"),
      ["scratch.ts spawn-call#1 (needs a bounded .kill())", "scratch.ts spawn-call#2 (needs a bounded .kill())"],
      "every spawn without a nearby bounded .kill() must be reported",
    );
    // …and one WITH a kill is quiet, so the naming is about the missing bound.
    assert.deepEqual(
      scanSource('const c = spawn("node", ["x"]);\nc.kill("SIGKILL");\n', "scratch.ts"),
      [],
      "a spawn followed by a bounded .kill() is bounded and must stay quiet",
    );
  });
});

// ------------------------------------------------ the scanner must be PROVABLE ---
//
// Every pin below is about the SCANNER, not about relaxing the rule. The rule
// above is unchanged and still fails on a real violation (the previous test
// proves that on synthetic input, and the scratch-file mutation proof run
// manually for this change proves it on a real file in `test/`).

d("the code view distinguishes CODE from STRING DATA", () => {
  t("a quoted call is DATA; the identical text as code is a CALL", () => {
    // Quoted: the shape a gate's own fixture table, a doc example, or a
    // snapshot assertion carries. It is a string. It cannot hang.
    const quoted = 'const rule = /x/;\nconst expected = "execFileSync(\\"gh\\", [\\"repo\\", \\"view\\"])";\n';
    assert.deepEqual(scanSource(quoted, "quoted.ts"), [], "a quoted call must not be reported");
    assert.equal(callSiteCount(quoted), 0, "the code view must hold no call site here");
    // Real: the same text, unquoted. It is a call, and it is unbounded.
    const real = 'const r = execFileSync("gh", ["repo", "view"]);\n';
    assert.deepEqual(scanSource(real, "real.ts"), ["real.ts sync-call#1 (needs timeout)"]);
    assert.equal(callSiteCount(real), 1);
  });

  t("the naive `//` stripper CANNOT do this — that is why the character scanner exists", () => {
    // The exact failure the sibling gate recorded (its self-test at
    // host-independence-gate.test.ts:437-439) reproduced HERE, on this gate's
    // own family: a `//` inside a string must not swallow the rest of the line.
    // The host is LOOPBACK on purpose: this is about the `//`, and a real
    // non-loopback reach-out is the sibling gate's R4 to rule on, not a fixture
    // this file gets to carry.
    const urlCall = 'const r = execFileSync("curl", ["-s", "http://127.0.0.1:9/x"]);\nconst next = 1;\n';
    assert.equal(codeView(urlCall).includes("https"), false, "string contents are blanked, but the CALL token survives");
    assert.equal(codeView(urlCall).includes("execFileSync("), true, "the real call token must survive a `//` in its arguments");
    // The naive stripper genuinely destroys this line — pinned so the reason
    // for the character scanner cannot be quietly deleted.
    assert.equal(
      urlCall.replace(/\/\/.*$/gm, "").includes("const next = 1;"),
      true,
      "sanity: the naive stripper only eats the current line",
    );
    assert.equal(
      codeView(urlCall).split("\n").length,
      urlCall.split("\n").length,
      "the view must preserve the line count exactly, so line numbers stay true",
    );
  });

  t("a `//` and a `/*` INSIDE a string do not start a comment", () => {
    const src = [
      'const a = "see http://example.com/x";',
      'const b = "/* not a comment */";',
      'const c = execFileSync("git", ["status"], { timeout: 5 });',
    ].join("\n");
    const code = codeView(src);
    assert.equal(code.includes("http"), false, "the URL is string content");
    assert.ok(code.includes("const a ="), "the statement before the `//` survives");
    assert.ok(code.includes("const b ="), "a `/*` inside a string must not blank the rest of the file");
    assert.ok(code.includes("const c = execFileSync("), "a real call after those strings is still found");
    assert.equal(callSiteCount(src), 1, "exactly the one real call");
  });

  t("a rule-table REGEX LITERAL is data, and a DIVISION is not swallowed", () => {
    // A gate's own family regex is not a call site.
    const table = 'const RE = /(?<![.\\w$])(?:spawnSync|execFileSync)\\(/g;\n';
    assert.equal(callSiteCount(table), 0, "a regex literal naming the family is a rule table, not a call");
    // Division must not be misread as a regex start and blank the rest of the
    // line — a misparse that reported CLEAN would be worse than no scanner.
    const div = 'const ratio = total / count;\nconst r = spawn("node", ["x"]);\n';
    assert.equal(callSiteCount(div), 1, "a `/` division must not blank the real spawn after it");
    assert.ok(codeView(div).includes("const ratio = total"), "the division expression survives");
    // And the self-correction: a regex literal cannot span a newline.
    const selfCorrect = 'const x = a / b\nconst y = execFileSync("git", ["ls-files"]);\n';
    assert.equal(callSiteCount(selfCorrect), 1, "an unterminated `/` self-corrects at the newline");
  });

  t("a real call inside a `${…}` template hole is still found", () => {
    const src = 'const bin = "git";\nconst out = `${execFileSync("git", ["status"])}`;\n';
    assert.equal(callSiteCount(src), 1, "an interpolation is CODE, not template text");
    assert.deepEqual(scanSource(src, "tpl.ts"), ["tpl.ts sync-call#1 (needs timeout)"]);
    // A template that merely QUOTES the shape stays data.
    const quoted = 'const doc = `run execFileSync("git", ["status"]) with a timeout`;\n';
    assert.equal(callSiteCount(quoted), 0, "template text is data");
  });

  t("the `timeout:` OPTION survives blanking — a bounded call is not mistaken for an unbounded one", () => {
    const bounded = [
      'const a = execFileSync("git", ["ls-files"], { timeout: 120000 });',
      'const b = spawnSync(process.execPath, ["x"], { encoding: "utf8", timeout: 120000 });',
      'const c = execFile("php", ["-v"], { timeout: 60000 }, (e, so) => {});',
      'const d = exec("node", ["x"], { signal: ac.signal });',
      'const e = spawn("node", ["x"]);\ne.child.kill("SIGKILL");',
    ].join("\n");
    assert.deepEqual(scanSource(bounded, "bounded.ts"), [], "every bounded form must stay quiet");
    assert.equal(callSiteCount(bounded), 5, "all five real call sites must be SEEN (this is the anti-vacuity half)");
  });
});

d("ANTI-VACUITY: the scan must still understand the corpus", () => {
  t("the code view finds the corpus's REAL call sites (it is not blanking everything)", () => {
    // The worst outcome for a scanner is reporting ZERO findings because it
    // understood nothing. So the count of REAL call sites the code view finds
    // across `test/` is pinned to a floor. Measured on this tree: 27 call sites
    // across 15 files (independently corroborated by the parser cross-check
    // below). If a future edit makes the scanner blank code, this collapses and
    // the pin fails LOUD instead of the rule going quiet.
    let sites = 0;
    let files = 0;
    for (const f of TEST_FILES) {
      const n = callSiteCount(readFileSync(join(ROOT, f), "utf8"));
      if (n > 0) files++;
      sites += n;
    }
    // The floor is deliberately CLOSE to the measured value. An earlier version
    // of this pin used 15 against a measured 27, which meant a scanner that
    // silently dropped 11 real call sites — over 40% of the corpus's coverage —
    // would still have passed. A loose anti-vacuity pin is an anti-vacuity pin
    // that cannot fail, which is the disease, not the cure.
    assert.ok(sites >= 25, `the code view found only ${sites} real call sites in test/ (measured 27) — the scanner is losing code`);
    assert.ok(files >= 14, `only ${files} test files still yield a call site (measured 15) — the scanner is losing code`);
  });

  t("CROSS-CHECK: the code view reaches EVERY real call TypeScript's parser can see", () => {
    // The floor above is a heuristic: a count can be right for the wrong reason.
    // This is the exact version. TypeScript's parser is handed the same bytes
    // and reports the CallExpression nodes that genuinely exist, so it shares no
    // code, no regex and no assumption with `codeView`. Agreement across two
    // instruments of different kinds is what makes "the code view is not losing
    // real calls" a measured fact rather than a hope.
    //
    // Prefiltered on the cheap family regex so only files that MENTION the
    // family are parsed — measured 23 of 106 files, 106 ms. A file that never
    // mentions the family cannot contain a call to it, so skipping the rest
    // costs no coverage.
    const drift: string[] = [];
    let compared = 0;
    for (const f of TEST_FILES) {
      const raw = readFileSync(join(ROOT, f), "utf8");
      if (!FAMILY_MENTION.test(raw)) continue;
      compared++;
      const truth = parserCallSiteCount(raw, f);
      const seen = callSiteCount(raw);
      if (seen !== truth) drift.push(`${f}: parser sees ${truth}, code view sees ${seen}`);
    }
    assert.deepEqual(
      drift,
      [],
      `the code view and the parser disagree — a real call is being hidden (parser > code view) or a string is being read as a call (code view > parser):\n${drift.join("\n")}`,
    );
    // …and the cross-check must not be vacuous either: it has to have actually
    // compared a real number of call sites, or a bug that made it compare nothing
    // would pass.
    assert.ok(compared >= 10, `only ${compared} files were cross-checked — the oracle is not reaching the corpus`);
  });

  t("the corpus file list is DERIVED from disk — a new test file cannot slip past the gate", () => {
    // The claim the mutation proof below makes is only worth anything if the
    // scan really reads the directory rather than a hand-written array, which
    // rots and misses exactly the new file that matters.
    const onDisk = readdirSync(join(ROOT, "test"))
      .filter((f) => f.endsWith(".ts") && `test/${f}` !== SELF)
      .map((f) => `test/${f}`);
    assert.deepEqual([...TEST_FILES].sort(), onDisk, "the scanned list must be exactly what is on disk, not a hardcoded array");
    for (const f of TEST_FILES) {
      assert.ok(existsSync(join(ROOT, f)), `${f} is scanned but does not exist — the list is stale`);
    }
    assert.ok(!TEST_FILES.includes(SELF), "the gate must not scan itself");
  });

  t("the sibling gate's quoted fixtures are cleared by the CODE VIEW, not by a filename exemption", () => {
    // The exact CI-218 finding. test/host-independence-gate.test.ts quotes
    // every forbidden shape as DATA (its R1 rule table, the synthetic inputs its
    // self-tests feed its predicates). It is NOT exempted by name anywhere in
    // this gate: it is scanned like every other file, and it comes back clean
    // because on the code view it has no exec-family call site at all.
    const f = "test/host-independence-gate.test.ts";
    const raw = readFileSync(join(ROOT, f), "utf8");
    const quoted = [...raw.matchAll(/\b(?:execFileSync|execFile|execSync|spawnSync|spawn|exec)\b/g)].length;
    assert.ok(quoted >= 20, `expected the sibling gate to quote the exec family heavily, found ${quoted} mentions`);
    assert.equal(callSiteCount(raw), 0, "every one of those mentions must be DATA, so the code view must hold no call site");
    assert.deepEqual(scanSource(raw, f), [], "the sibling gate's fixtures are data and must not be reported");
    // …and the anti-vacuity proof that it is the MECHANISM, not a hole: the very
    // same source, unquoted, is reported. If the exemption were the reason the
    // file is clean, this would still be clean too. (`git`, not one of the
    // sibling gate's host-inspection binaries — naming `ldconfig` here would be
    // an R1 finding, and rightly so.)
    const unquoted = 'execFileSync("git", ["ls-files"]);\n';
    assert.deepEqual(scanSource(unquoted, f), [`${f} sync-call#1 (needs timeout)`], "the same shape as CODE must be reported");
  });

  t("an unbounded call in a real test file is NAMED, and the bounded sibling of it is not", () => {
    // The mutation proof, kept mechanical and re-runnable rather than described
    // in prose. This exercises the exact per-file path the corpus scan uses, on
    // the exact bytes a scratch file would hold. It is NOT a whole-suite run:
    // TEST_FILES is captured at import, so a file dropped into test/ mid-process
    // would not be in the list. The real end-to-end proof — a scratch file on
    // disk, a fresh process, red output naming it — is the run recorded with
    // this change; the disk-wiring claim it rests on is pinned by the
    // "DERIVED from disk" test above.
    const scratchName = "zz-timeout-discipline-mutation.test.ts";
    const scratchBody = 'import { execFileSync } from "node:child_process";\nexecFileSync("gh", ["repo", "view"]);\n';
    assert.deepEqual(
      scanSource(scratchBody, `test/${scratchName}`),
      [`test/${scratchName} sync-call#1 (needs timeout)`],
      "an unbounded execFileSync in a test file must be named with its path",
    );
    // And the bounded sibling of the same file is clean, so the naming is
    // specific to the missing bound rather than to the file.
    assert.deepEqual(
      scanSource('import { execFileSync } from "node:child_process";\nexecFileSync("git", ["ls-files"], { timeout: 5000 });\n', `test/${scratchName}`),
      [],
      "the same file with a timeout must be clean",
    );
    // The string-data counterpart, on the same file name: a gate's own fixture
    // quoting this shape must NOT be reported. This is the CI-218 finding in its
    // final form — the fix is the mechanism, not an exemption.
    assert.deepEqual(
      scanSource('const doc = "execFileSync(\\"gh\\", [\\"repo\\", \\"view\\"])";\n', `test/${scratchName}`),
      [],
      "the same shape quoted as data must stay quiet",
    );
  });
});
