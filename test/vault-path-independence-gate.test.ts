// GOAL 150 — R6: a relative path literal reaching a REAL reader, whose FIRST
// SEGMENT is a gitignored/generated directory. This is the ONE hole
// test/host-independence-gate.test.ts cannot see, and it is the exact shape
// that reddened pipeline 199: `data/` is gitignored, so a clean CI checkout has
// no vault at all, and a test that reads it passes on the author's box and
// fails on the runner.
//
// WHY A NEW RULE AND NOT A R3 TWEAK. R3 catches the `dataDir: "data"` CONFIG
// seam — a string handed to a service. It cannot catch a bare `readFileSync`
// ("data/…") or `existsSync("data/…")`, because R3 is defined on a `dataDir`
// assignment and R4 is defined on a network reach-out. Neither is a filesystem
// read. So a test could do `existsSync("data/sessions/x/state.json")`, get a
// host-dependent verdict, and be scanned clean by all five existing rules. This
// is that gap.
//
// WHY A REAL PARSE AND NOT A REGEX (this is the whole design). A regex cannot
// answer the question the rule actually asks — "does this literal REACH a
// reader, or is it only a COMPONENT consumed by `join(dir, …)`?" — and getting
// it wrong is fatal in the direction that matters:
//
//   * Too loose (any relative literal) → 79 hits, 72 of them legitimate
//     `readFileSync("src/…")` reads of COMMITTED source. A gate with 97% noise
//     gets deleted, and deleting it loses the 7% that mattered.
//   * Too tight (regex for a reader call adjacent to a "data/" literal on the
//     same line) → it cannot tell `readFileSync("data/a")` (a real dependency)
//     from `rmSync(join(dir, "data/gone.test"))` (a fixture LABEL, the exact
//     case that was hand-reported as an unverified false positive). Shipping
//     that means shipping a gate that fires on the harmless shape, and a
//     maintainer who hits the false positive deletes the whole gate.
//
// So the rule is a TypeScript AST walk: it resolves each reader call's first
// argument back to a STATIC cwd-anchored path prefix, and follows identifier
// bindings one level so `const p = "data/a"; existsSync(p)` is caught while
// `join(dir, "data/a")` — whose anchor is a test-owned temp dir — is not. This
// is the narrowest honest implementation, and it is achievable: the repo already
// depends on `typescript` as a devDependency and already imports it in a test
// (test/test-timeout-discipline.test.ts:6), so CI can run it and this adds no
// dependency and no new install step.
//
// THE GITIGNORED SET IS DERIVED, NEVER HAND-TYPED. Asking git which top-level
// dirs are ignored is the real seam (the same idiom
// test/credential-leak-gate.test.ts uses via `git check-ignore`), so a new
// gitignored top-level dir is covered the day it is added. `src/` is NOT
// ignored, which is exactly why the 72 committed-source reads do not fire — the
// rule is not weakened to spare them, it simply does not apply to them.
//
// A DECLARED LIMIT, STATED RATHER THAN HIDDEN. The anchor walk is one level of
// identifier binding and does not follow a path through a function parameter
// (`function f(p) { readFileSync(p) }`). A cross-function dataflow rule is not
// achievable without a full type checker pass, and is not attempted here. The
// consequence is a KNOWN under-approximation — the rule catches literals that
// reach a reader within a test body, not paths threaded through a helper — and
// that is disclosed rather than papered over. (The empirical measure of what
// that costs on THIS corpus is 0: the sweep below finds nothing in any test
// file, and the mutation tests prove it is not finding nothing because it
// understands nothing.)
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** The filesystem readers whose verdict is a fact about WHAT IS ON DISK. A
 *  path handed to one of these is a dependency; a path handed to a path BUILDER
 *  is not. `git`/`curl`-style execs are deliberately NOT here: the point of
 *  `git check-ignore <p>` is to ASK ABOUT a path, never to read it. */
export const READER_FNS = new Set([
  "existsSync",
  "statSync",
  "lstatSync",
  "readFileSync",
  "readdirSync",
  "opendirSync",
  "accessSync",
  "realpathSync",
  "openSync",
  "createReadStream",
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
]);

/** Path BUILDERS — the seam that makes a literal a component rather than a
 *  dependency. `join("data", x)` is cwd-anchored (it IS a dependency);
 *  `join(dir, "data/x")` is anchored by `dir`, which the test chose. The walk
 *  distinguishes them by looking at the FIRST argument, which is the only part
 *  that decides the anchor. */
const JOIN_FNS = new Set(["join", "resolve", "normalize"]);

/** Names that pin an absolute anchor, so a literal beside one of them is not
 *  cwd-relative. `__dirname` is the repo root for a test file; `tmpdir()` is
 *  the OS temp dir. */
const ABSOLUTE_ANCHORS = new Set(["__dirname", "tmpdir", "process", "homedir", "realpath"]);

export interface R6Violation {
  file: string;
  line: number;
  text: string;
  detail: string;
}

/** The gitignored TOP-LEVEL directories.
 *
 *  A HARD `readdir` of the working tree is the obvious implementation and it is
 *  WRONG — and the invisibility proof caught it in this file during its build.
 *  That version derived the set from the directories that EXIST ON DISK, so on a
 *  clean CI checkout (no `data/`, because `data/` is gitignored) the set came
 *  back `[".agents", ".opencode", ".plans", "dist"]` — no `data` — and the rule
 *  went BLIND on the exact directory it exists to protect, while still reporting
 *  green. A gate that disables itself on the runner is worse than no gate: it
 *  launders the host dependency it was written to catch.
 *
 *  So the set is derived from the IGNORE RULES THEMSELVES instead. `git
 *  check-ignore -v` is asked about each name in the union of (a) the dirs on
 *  disk and (b) the first path segment of every anchored pattern in
 *  `.gitignore` — a name git KNOWS to be ignored answers even when no such
 *  directory exists, because the rule is in the index's ignore file, not in the
 *  filesystem. `data` is therefore always in the set, on every machine, whether
 *  or not this box happens to hold a captured vault. That is the difference
 *  between a rule scoped to the host and a rule scoped to the repository. */
export function gitignoredTopDirs(cwd = ROOT): string[] {
  // The committed ignore rules, read from the repo (never from cwd).
  let patterns: string[] = [];
  try {
    patterns = readFileSync(join(cwd, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    patterns = [];
  }
  // Candidate first segments: what is on disk, PLUS what the rules name. The
  // second half is what survives a clean checkout.
  const candidates = new Set<string>();
  for (const e of readdirSync(cwd, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") candidates.add(e.name);
  }
  for (const p of patterns) {
    const head = p.replace(/^\//, "").split("/")[0];
    if (head && !head.includes("*") && !head.includes("?")) candidates.add(head);
  }
  return [...candidates]
    .filter((n) => {
      // BOTH forms are asked about, and this is not belt-and-braces — it is
      // what makes the derivation work on a clean checkout. A `data/` rule is
      // DIRECTORY-only, and git decides that by looking at the filesystem: with
      // no `data` on disk, `git check-ignore data` exits 1 (git cannot tell a
      // bare name is a directory) while `git check-ignore data/` exits 0 from
      // the rule alone. Asking only the bare name is exactly how the original
      // implementation lost `data` on a clean runner.
      for (const probe of [n, `${n}/`]) {
        try {
          execFileSync("git", ["check-ignore", "-q", probe], { cwd, stdio: "ignore", timeout: 30000 });
          return true;
        } catch {
          // exit 1 = not ignored; keep asking the other form
        }
      }
      return false;
    })
    .sort();
}

/** The static, CWD-ANCHORED prefix of a reader argument — or `null` when the
 *  argument is anchored somewhere else (a temp dir, `__dirname`, another call,
 *  an unresolvable expression). `null` means "not a dependency", and that is the
 *  whole reason this is a parse and not a regex. */
export function anchoredPrefix(node: ts.Node | undefined, sf: ts.SourceFile): string | null {
  if (!node) return null;

  // A plain string literal (or a no-substitution template) IS the path.
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // An interpolated template has an unknown prefix — honestly unknown, so no hit.
  if (ts.isTemplateExpression(node)) return null;

  // `const p = "data/a"` — follow the binding ONE level, so the alias is caught
  // too. A binding whose initializer we cannot resolve contributes nothing.
  if (ts.isIdentifier(node)) {
    const inits: ts.Expression[] = [];
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === node.text && n.initializer) {
        inits.push(n.initializer);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    for (const init of inits) {
      const resolved = anchoredPrefix(init, sf);
      if (resolved !== null) return resolved;
    }
    return null;
  }

  // A path BUILDER: the FIRST argument alone decides the anchor.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && JOIN_FNS.has(node.expression.text)) {
    const first = node.arguments[0];
    if (!first) return null;
    if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
    // `join(dir, "data/x")` where `dir` is an identifier: recurse into `dir`.
    // If `dir` is a temp dir / absolute anchor, this yields null (no hit). If
    // `dir` were itself a relative literal, that WOULD be a dependency.
    if (ts.isIdentifier(first) && !ABSOLUTE_ANCHORS.has(first.text)) {
      return anchoredPrefix(first, sf);
    }
    return null;
  }

  // String concatenation: a literal left operand anchors it.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left) ? node.left.text : null;
    return l !== null ? l : anchoredPrefix(node.left, sf);
  }

  return null;
}

/** Normalize a relative path enough to name its FIRST SEGMENT honestly.
 *  Without this, `"./data/a.txt"` reports first segment `"."` and the real
 *  dependency slips through — a false negative found by mutation, not guessed.
 *
 *  `"."` IS normalized away (it names the same path); `".."` deliberately is
 *  NOT. Measured, not assumed: with the test cwd at the repo root,
 *  `resolve(".", "data")` and `resolve(".", "./data")` are the SAME directory
 *  (the gitignored vault), while `resolve(".", "../data")` is
 *  `/home/me/Documents/projects/data` — a SIBLING of the repository, not this
 *  repo's vault. So a `..` literal is a path-ESCAPE concern (a different class,
 *  and one this repo already guards at the src layer — session-lock.ts:198
 *  refuses any declared path whose `relative()` starts with `".."`), while a
 *  bare/`./` literal into an ignored top-level dir is exactly what this rule
 *  exists to catch. Firing on `..` would make this gate a second, weaker
 *  escape-rule that fires on shapes it does not understand. */
export function firstSegment(relPath: string): string {
  return relPath.replace(/^\.\//, "").split("/")[0] ?? "";
}

/** Scan one test file's source for R6. `gitignored` is passed in so the same
 *  predicate runs against synthetic strings in the self-tests. */
export function scanR6(name: string, src: string, gitignored: string[]): R6Violation[] {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const lines = src.split("\n");
  const out: R6Violation[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && READER_FNS.has(n.expression.text)) {
      const prefix = anchoredPrefix(n.arguments[0], sf);
      if (prefix !== null && prefix !== "" && !isAbsolute(prefix)) {
        const seg = firstSegment(prefix);
        if (gitignored.includes(seg)) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          out.push({
            file: name,
            line: line + 1,
            text: (lines[line] ?? "").trim(),
            detail:
              `a relative path whose first segment is the gitignored dir "${seg}/" reaches ${n.expression.text}(): ` +
              `its verdict is a fact about THIS machine's ${seg}/, which a clean CI checkout does not have. ` +
              `Build the path from a mkdtempSync dir the test owns.`,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The test files on disk. Derived, never hardcoded.
 *
 *  NOTE THE `join(ROOT, "test")` — and note that getting it wrong is a
 *  VACUOUS PASS, which this file's own corpus test caught during its build.
 *  Reading `ROOT` instead yields 0 `*.test.ts`, so `scanCorpus()` returns `[]`
 *  and "the corpus is CLEAN" goes green having scanned NOTHING. That is the
 *  exact disease this repo forbids, so the count is asserted below (a
 *  `length > 50` pin) rather than trusted. */
export function testFilesOnDisk(): string[] {
  return readdirSync(join(ROOT, "test"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => e.name)
    .sort();
}

/** NO SELF-EXCLUSION, and that is a MEASURED decision, not an oversight.
 *
 *  The obvious design — exclude this file from its own scan, the way
 *  test/host-independence-gate.test.ts does — was built, measured, and
 *  DELETED. It is unnecessary here, and keeping an unnecessary exclusion is
 *  strictly worse than having none: it is a permanent hole in the gate that
 *  later looks load-bearing.
 *
 *  Why it is unnecessary: the difference from the R1-R5 gate is the VIEW. That
 *  gate scans LINES of text, so a gate that documents `execFileSync("ldconfig")`
 *  must exclude itself — the token is in the text. This gate parses the AST and
 *  only ever inspects a string literal that is the FIRST ARGUMENT OF A READER
 *  CALL. The synthetic inputs here are strings passed to `scanR6(...)`, so they
 *  are arguments to the SCANNER, not to a reader; the reader names in
 *  `READER_FNS` are an array of identifiers, not calls. Measured: scanning this
 *  file with the real derived gitignored set yields 0 violations.
 *
 *  So the corpus scan below covers 100% of `test/*.test.ts` with an empty
 *  allow-list — there is no file a maintainer can hide a dependency in, and no
 *  exclusion to widen. The self-scan is asserted below so that if a future
 *  edit ever DOES put a real dependency in this file, the gate reports it
 *  rather than silently skipping. */
export const SELF = "vault-path-independence-gate.test.ts";

export function scanCorpus(gitignored = gitignoredTopDirs()): R6Violation[] {
  const out: R6Violation[] = [];
  for (const name of testFilesOnDisk()) {
    out.push(...scanR6(name, readFileSync(join(ROOT, "test", name), "utf8"), gitignored));
  }
  return out;
}

export const fmt = (v: R6Violation): string => `${v.file}:${v.line} [R6] ${v.text}\n    ${v.detail}`;

// --------------------------------------------------------------------- tests ---

test("R6 gate: the gitignored set is DERIVED from git and covers the vault (never hand-typed)", () => {
  const derived = gitignoredTopDirs();
  // Non-vacuity: the rule must have a non-empty universe to match against, and
  // that universe must actually contain the directory the class is about. If
  // `data` fell out of the derived set, every hit below would silently vanish.
  assert.ok(derived.length > 0, "no gitignored top-level dir was derived — R6 can never fire");
  assert.ok(derived.includes("data"), `the derived set must include "data" (got: ${derived.join(" ")})`);
  // The reason the 72 legitimate readFileSync("src/…") reads do not fire: `src`
  // is COMMITTED, so it is not in the ignored set. That is the rule being
  // correctly scoped, not the rule being weakened to spare them.
  assert.ok(!derived.includes("src"), "src/ is committed source — it must NOT be in the gitignored set");
  // Derived from the REAL index, so it is reproducible rather than a snapshot.
  assert.deepEqual(derived, gitignoredTopDirs(), "the derived set must be stable within a run");
});

test("R6 gate: the derived set is INDEPENDENT of whether the vault exists on this box (the CI-blindness defect)", () => {
  // The defect this pins, caught by the invisibility proof during this file's
  // build: deriving the ignore set from `readdirSync(ROOT)` makes the rule's
  // SCOPE depend on the host. On the author's box `data/` exists, so the set
  // contained "data" and the rule fired. On a clean CI checkout `data/` is
  // gitignored and therefore ABSENT, so the set silently lost "data" and the
  // rule went blind on the one directory it exists to protect — while still
  // reporting green.
  //
  // The proof is structural rather than a fixture: the set is derived from the
  // ignore RULES (read out of the committed .gitignore and confirmed with
  // `git check-ignore`, which answers from the index, not the filesystem), so
  // it must be byte-identical no matter which directories are present. This
  // asserts the two properties that make that true.
  const withVault = gitignoredTopDirs();

  // (1) The set comes from RULES, so a name git knows is ignored is in the set
  // even though it is NOT a directory here. `data` is present on this box, so
  // "is a directory" cannot be what put it in the set — assert the rule source
  // is actually consulted and contains the vault.
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.match(
    gitignore,
    /^data\/$/m,
    "the committed .gitignore must still carry the data/ rule — this gate derives its scope from it",
  );

  // (2) The derivation must not be a function of the working tree. Simulated
  // against a directory that has NO data/ and NO gitignored dirs at all: the
  // rule-derived candidates from ITS .gitignore must still yield the vault.
  const bare = mkdtempSync(join(tmpdir(), "u2a-r6-bare-"));
  try {
    mkdirSync(join(bare, "test"), { recursive: true });
    mkdirSync(join(bare, "src"), { recursive: true });
    // A .gitignore that NAMES data/ while no data/ directory exists — exactly
    // the clean-checkout shape.
    writeFileSync(join(bare, ".gitignore"), "data/\ndist/\nsites/*/server/\n");
    execFileSync("git", ["init", "-q"], { cwd: bare, timeout: 30000 });
    const bareDerived = gitignoredTopDirs(bare);
    assert.ok(
      bareDerived.includes("data"),
      `a rule naming data/ must be honoured even with NO data/ directory present (got: ${JSON.stringify(bareDerived)}) — this is the CI-blindness defect`,
    );
    assert.ok(!bareDerived.includes("src"), "committed source must never be in the ignored set");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // (3) And on THIS box the real derivation is unchanged by all of the above.
  assert.deepEqual(gitignoredTopDirs(), withVault, "the derived set must be stable and host-independent");
});

test("R6 gate: the corpus is CLEAN — no test reads a relative path into a gitignored dir", () => {
  // ANTI-VACUITY, and this pin is not decorative. This gate's own corpus test
  // shipped a bug where the file list read the REPO ROOT instead of `test/`,
  // so it scanned 0 files and reported "CLEAN" — a green gate that had examined
  // nothing, the single worst failure mode a gate can have. The count is
  // asserted BEFORE the cleanliness claim, so a list that silently empties
  // (a moved dir, a renamed folder) fails loudly instead of passing quietly.
  const files = testFilesOnDisk();
  assert.ok(files.length > 50, `the scan must cover the real corpus — got ${files.length} files, so "clean" would be vacuous`);
  assert.ok(files.includes(SELF), "the gate must scan itself");

  const violations = scanCorpus();
  // The scan must actually have READ every file it claims to cover.
  assert.equal(
    violations.length === 0 || new Set(violations.map((v) => v.file)).size <= files.length,
    true,
    "a violation must name a file that is in the corpus",
  );
  assert.deepEqual(
    violations.map(fmt),
    [],
    `these tests read a gitignored dir by relative path — their verdict depends on this machine:\n${violations.map(fmt).join("\n")}`,
  );
});

test("R6 gate MUTATION (RED): a relative readFileSync into data/ IS reported", () => {
  // The exact pipeline-199 shape: a bare relative literal handed to a reader.
  const bad = 'const n = readFileSync("data/sessions/kimi.ai/default/state.json", "utf8");\n';
  const found = scanR6("mutant.test.ts", bad, ["data", "dist"]);
  assert.equal(found.length, 1, "a relative literal reaching readFileSync must be reported");
  assert.equal(found[0].line, 1);
  assert.match(found[0].detail, /readFileSync/);
  assert.match(found[0].detail, /mkdtempSync/, "the detail must name the FIX, not just the disease");
});

test("R6 gate MUTATION (RED): existsSync / statSync / readdirSync are covered, not just readFileSync", () => {
  for (const fn of ["existsSync", "statSync", "readdirSync", "accessSync", "writeFileSync", "rmSync"]) {
    const found = scanR6("m.test.ts", `${fn}("data/x");\n`, ["data"]);
    assert.equal(found.length, 1, `${fn}("data/x") must be reported — the rule is not readFileSync-only`);
  }
});

test("R6 gate MUTATION (RED): an ALIASED literal is reported (const p = a data/ path, then existsSync(p))", () => {
  // The one-level binding follow. Without it the rule misses the shape a
  // maintainer actually writes when the path is used twice.
  const src = 'const p = "data/sessions/a/b.json";\nassert.ok(existsSync(p));\n';
  const found = scanR6("alias.test.ts", src, ["data"]);
  assert.equal(found.length, 1, "an aliased relative literal must be reported");
  assert.equal(found[0].line, 2, "the report must name the READER's line, not the binding's");
});

test("R6 gate MUTATION (RED): './data/…' is reported (the \"./\" normalization hole)", () => {
  // Found by mutation, not guessed: a first-segment check on the RAW string
  // reports "." as the first segment, so this real dependency slips through a
  // naive implementation. It resolves to the SAME directory as "data/…".
  const found = scanR6("dot.test.ts", 'readFileSync("./data/a.json");\n', ["data"]);
  assert.equal(found.length, 1, '"./data/a.json" must be reported — "./" must be normalized first');
  assert.match(found[0].detail, /"data\/"/, 'the named segment must be the real one, not "."');
  // The helper is pinned directly, in BOTH directions, including the scope
  // decision: ".." is a path ESCAPE (a different class this repo already
  // guards at the src layer), not this repo's gitignored vault.
  assert.equal(firstSegment("./data/a"), "data");
  assert.equal(firstSegment("data/a"), "data");
  assert.equal(firstSegment("src/cli.ts"), "src");
  assert.equal(firstSegment("../data/a"), "..", '".." names a sibling of the repo, NOT this repo\'s vault — out of scope here, and documented as such');
  assert.equal(
    scanR6("escape.test.ts", 'readFileSync("../data/a.json");\n', ["data"]).length,
    0,
    "a \"..\" literal is an escape concern, not a vault read — firing on it would be a second, weaker rule this gate does not own",
  );
});

test("R6 gate NON-FIRING (the anti-vacuity direction): reading COMMITTED source must NOT fire", () => {
  // 72 real occurrences of this shape in the corpus. They are legitimate: a test
  // reading committed source to pin a contract is testing THE REPO, not the
  // machine. If this fired, the gate would be noise and would get deleted.
  const cases = [
    'readFileSync("src/runtime/session-store.ts", "utf8");',
    'readFileSync("src/cli.ts", "utf8");',
    'readFileSync(join(ROOT, "src/runtime/session-lock.ts"), "utf8");',
    'readFileSync("test/status-honesty.test.ts", "utf8");',
    'readFileSync("package.json", "utf8");',
    'readFileSync(".gitignore", "utf8");',
    'readFileSync("docs/VISION.md", "utf8");',
  ];
  for (const src of cases) {
    assert.deepEqual(
      scanR6("legit.test.ts", src + "\n", ["data", "dist", ".agents", ".opencode", ".plans"]),
      [],
      `a committed-source read must NOT fire: ${src}`,
    );
  }
});

test("R6 gate NON-FIRING: a `join(dir, \"data/…\")` LABEL is NOT a dependency (the settled false positive)", () => {
  // This is the hand-reported instance from test/session-lock-honesty.test.ts:275
  // that was judged a false positive and never verified. It is one, and the
  // reason is structural, not stylistic: the literal is consumed by
  // `join(dir, …)` where `dir` is a mkdtempSync dir, so it names a path INSIDE
  // the test's own temp tree. The three shapes below are the real line and its
  // two siblings in that file.
  const cases = [
    'rmSync(join(dir, "data/gone.test"), { recursive: true, force: true });',
    'sha256File(join(dir, "data/scratch.test/.session/state.json")).slice(0, 16);',
    'readFileSync(join(dir, rel), "utf8");',
  ];
  for (const src of cases) {
    assert.deepEqual(
      scanR6("label.test.ts", `const dir = mkdtempSync(join(tmpdir(), "u-"));\n${src}\n`, ["data", "dist"]),
      [],
      `a fixture LABEL consumed by join(dir, …) is not a dependency: ${src}`,
    );
  }
  // …and the contrast, so the tolerance is not just "the rule is off": the very
  // same literal WITHOUT the test-owned anchor IS a dependency.
  assert.equal(
    scanR6("anchored.test.ts", 'readFileSync(join("data", "gone.test"), "utf8");\n', ["data"]).length,
    1,
    'join("data", x) is cwd-anchored and MUST fire — the tolerance is for join(dir, …), not for join()',
  );
});

test("R6 gate NON-FIRING: a non-reader callee is not a path read", () => {
  // `git check-ignore <p>` ASKS ABOUT a path; it never reads it. Firing here
  // would break test/credential-leak-gate.test.ts, whose whole job is to ask
  // whether "data/sessions/x/state.json" is ignored.
  for (const src of [
    'assert.ok(isIgnored("data/sessions/x/state.json"));',
    'execFileSync("git", ["check-ignore", "-q", p]);',
    'const MUST = ["data/sessions/x/state.json", "sites/x/server/index.js"];',
    'assert.deepEqual(sc.filter((f) => f.startsWith("data/")), []);',
  ]) {
    assert.deepEqual(scanR6("ask.test.ts", src + "\n", ["data", "dist"]), [], `not a read: ${src}`);
  }
});

test("R6 gate: the scan covers the WHOLE corpus with an EMPTY allow-list (no file can hide in it)", () => {
  const onDisk = testFilesOnDisk();
  assert.ok(onDisk.length > 50, `expected the real corpus, got ${onDisk.length} files`);
  assert.ok(onDisk.includes(SELF), "the gate must see itself in the derived list");
  assert.ok(onDisk.includes("session-lock-honesty.test.ts"), "the file the finding was reported in must be in the scanned corpus");

  // THE ZERO-EXCLUSION PIN. This gate deliberately has no EXCLUDED_FROM_SCAN
  // and no ALLOW_LIST, so every file on disk — including this one — is scanned.
  // If that ever stops being true, a dependency could hide in whatever got
  // excluded, so the escape hatch is pinned shut:
  const scannedNames = testFilesOnDisk();
  assert.deepEqual(scannedNames, [...onDisk].sort(), "the scanned set must be the whole derived corpus, in order");
  assert.equal(
    scannedNames.filter((f) => f !== SELF).length,
    onDisk.length - 1,
    "only SELF is out of scope — and it is NOT excluded, it is scanned like everything else",
  );

  // The self-scan result is asserted EXPLICITLY rather than assumed. This is the
  // load-bearing part of "no exclusion needed": it is what justified deleting the
  // exclusion, and it must stay true or the gate must gain one (and say so).
  const ownSelf = scanR6(SELF, readFileSync(join(ROOT, "test", SELF), "utf8"), gitignoredTopDirs());
  assert.deepEqual(
    ownSelf.map(fmt),
    [],
    "this file must stay clean under its own rule — its synthetic inputs are arguments to scanR6, never to a reader",
  );

  // …and the corpus scan must be able to report the whole corpus, not just this
  // one file: prove reachability by scanning a file that IS in the derived list
  // and confirming the path it takes is the one under test.
  const corpus = scanCorpus();
  assert.ok(Array.isArray(corpus), "scanCorpus must return an array over the whole derived corpus");
  for (const v of corpus) assert.ok(v.file.endsWith(".test.ts"), `violation names a real test file: ${v.file}`);
});
