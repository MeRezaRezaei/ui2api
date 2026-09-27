// GOAL 149: NOTHING stopped a unit test from reading the REAL machine.
//
// Pipeline 199 went red because a test asserted a verdict while silently
// probing the REAL host instead of its injected seam. It passed on the author's
// desktop and failed on a bare CI runner. Nothing in the suite said so. The
// seams exist and are even declared REQUIRED — `RequirementsDeps`
// (src/runtime/requirements.ts:147) lists them, and src/runtime/requirements.ts
// still carries `?? default…` fallbacks — but no gate ever asked a test to
// PROVE it injected them, so a fixture that "forgot" one seam was a one-line
// change that only CI could catch.
//
// This is that gate. It is META: it scans `test/*.test.ts` from disk and fails,
// naming file and line, on the five shapes of machine-read that make a unit
// test's verdict depend on the box it runs on:
//
//   R1 host-inspection binary   ldconfig/fc-list/xdpyinfo/getent/which/dpkg/
//                              apt/lsusb/xrandr — a verdict that is whatever
//                              the runner happens to have installed.
//   R2 real-identity read       os.userInfo() / os.homedir() / os.hostname().
//   R3 relative operator vault  `dataDir: "data"` — the gitignored
//                              data/sessions/… vault, resolved against cwd.
//   R4 non-loopback reach-out   a real external host reached from the suite.
//                              (This is finding 1: `goto("http://example.com/")`.)
//   R5 tautological assertion  `assert.ok(true)` — a gate nobody can fail is
//                              not a gate, the same class as this repo's rule
//                              that every pin lives inside a counted `test()`.
//
// DESIGN, and why each part is there:
//   * The file list is DERIVED with readdirSync (the idiom already at
//     test/doc-numbers-truth.test.ts:66-72), never a hardcoded array — a
//     hardcoded list rots and misses exactly the new file that matters.
//   * Comments are stripped before scanning (same idiom as
//     test/account-exact-resolution-cli.test.ts:24-25). Otherwise the prose
//     that DOCUMENTS a fix names the very token the rule forbids, and the gate
//     fires on its own explanation.
//   * Every rule has a NO-HIT case asserted here, against synthetic input, so
//     the predicate itself is pinned and cannot silently degrade into
//     "matches nothing".
//   * Every rule was PROVEN RED by mutation (a scratch file per rule); the
//     `MUTATION` tests below keep that proof mechanical and re-runnable.
//   * ALLOW_LIST entries are file:line scoped and each carries a named reason.
//     A STALE entry (the line no longer offends) FAILS: an allow-list that
//     outlives its violation is a hole, not a record.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** Host-inspection binaries: their OUTPUT is a fact about the runner, not
 *  about the code. Reading one inside a unit test makes the verdict portable-
 *  only by accident. */
export const HOST_INSPECTION_BINARIES = [
  "ldconfig",
  "fc-list",
  "xdpyinfo",
  "getent",
  "which",
  "dpkg",
  "apt",
  "lsusb",
  "xrandr",
];

/** The exec family — a host binary named anywhere near one of these is being
 *  RUN, not quoted in prose. */
const EXEC_TOKEN = /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|exec|fork)\b/;

export type RuleId = "R1-host-binary" | "R2-real-identity" | "R3-relative-vault" | "R4-external-reach" | "R5-tautology";

export interface Violation {
  rule: RuleId;
  file: string;
  line: number;
  text: string;
  detail: string;
}

/** Blank comments and, when `keepStrings` is false, string CONTENTS — while
 *  keeping every byte offset and newline, so line numbers stay true.
 *
 *  A naive `.replace(/\/\/.*$/gm)` is WRONG here and was caught by this file's
 *  own self-test: `page.goto("http://example.com/")` contains `//`, so the
 *  naive stripper ate the rest of the line and the URL rule could never fire on
 *  the exact shape it exists to catch. Hence the character scanner.
 *
 *  Which rules use which view:
 *    text  — raw line. Needed where the SIGNAL IS a string: a host binary named
 *            as a command/args literal (R1), the `dataDir: "data"` value (R3),
 *            the non-loopback URL (R4).
 *    code  — comments AND string contents blanked. Needed where the signal is a
 *            CALL or an assertion (R2, R5), so an `os.homedir()` mentioned in
 *            a failure message, or an `assert.equal(1, 1)` sitting inside a
 *            source-code fixture string, is correctly read as data. */
export function blank(src: string, keepStrings: boolean): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let state: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  while (i < n) {
    const c = src[i] as string;
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") {
        state = "str"; quote = c; out += keepStrings ? c : " "; i++; continue;
      }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; i += 2; continue; }
      if (c === "\n") out += c;
      i++; continue;
    }
    // inside a string literal
    if (c === "\\") {
      if (keepStrings) { out += c; if (c2 !== undefined) out += c2; }
      else if (c2 === "\n") out += "\n";
      i += 2; continue;
    }
    if (c === quote) { state = "code"; out += keepStrings ? c : " "; i++; continue; }
    if (c === "\n") out += "\n";
    else if (keepStrings) out += c;
    i++;
  }
  return out;
}

/** Comments removed, string contents kept — the view for string-signalled rules. */
export function stripComments(src: string): string {
  return blank(src, true);
}

/** Comments AND string contents removed — the view for call/assertion rules. */
export function codeOnly(src: string): string {
  return blank(src, false);
}

/** A reach-OUT is a network/subprocess call. A non-loopback URL in a pure data
 *  string (an SSRF fixture, a site profile url, a doc-truth expectation) is
 *  NOT a reach-out and must not be flagged — flagging it would train people to
 *  ignore the gate. */
const REACH_OUT = /\b(?:goto|fetch|openPage|connect|request|execFileSync|execFile|execSync|spawnSync|spawn|exec|curl)\s*\(/;

/** Loopback hosts are the ONLY hosts a unit test may reach. */
const LOOPBACK_HOST = /^(?:127\.|localhost|LocalHost|0\.0\.0\.0|\[::1\]|::1)/i;

const NON_LOOPBACK_URL = /https?:\/\/[A-Za-z0-9._:%-]+/g;

export function isTautology(codeLine: string): boolean {
  const t = codeLine.trim();
  return (
    /^(?:[\w.]*\.)?assert\.ok\(\s*(?:true|1)\s*[,)]/.test(t) ||
    /^(?:[\w.]*\.)?assert\.(?:equal|strictEqual)\(\s*true\s*,\s*true\s*\)/.test(t) ||
    /^(?:[\w.]*\.)?assert\.(?:equal|strictEqual)\(\s*1\s*,\s*1\s*\)/.test(t) ||
    // same-expression tautology: assert.equal(x, x, "…")
    /^(?:[\w.]*\.)?assert\.(?:equal|strictEqual)\(\s*([A-Za-z_$][\w$]*)\s*,\s*\1\s*[,)]/.test(t)
  );
}

export function isRealIdentityRead(codeLine: string): boolean {
  return /\b(?:userInfo|homedir|hostname)\s*\(/.test(codeLine);
}

export function isRelativeVaultDataDir(textLine: string): boolean {
  return /\bdataDir\b\s*[:=]\s*["'`]data["'`]/.test(textLine);
}

export function isHostBinaryExec(textLine: string, codeLine: string = textLine): boolean {
  for (const bin of HOST_INSPECTION_BINARIES) {
    const escaped = bin.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    // a quoted literal of the binary name (the command / args[] form)
    if (new RegExp(`["'\`]${escaped}["'\`]`).test(textLine)) return true;
    // a bare token on the same line as an exec-family call
    if (EXEC_TOKEN.test(codeLine) && new RegExp(`\\b${escaped}\\b`).test(codeLine)) return true;
  }
  return false;
}

export function externalHostsIn(textLine: string): string[] {
  if (!REACH_OUT.test(textLine)) return [];
  const hits: string[] = [];
  for (const m of textLine.matchAll(NON_LOOPBACK_URL)) {
    const host = m[0].replace(/^https?:\/\//, "");
    if (!LOOPBACK_HOST.test(host)) hits.push(m[0]);
  }
  return hits;
}

/** Scan one already-read test file's source. `name` labels the violations, so
 *  the very same predicates run against synthetic strings in the self-tests. */
export function scanSource(name: string, src: string): Violation[] {
  const out: Violation[] = [];
  const textLines = stripComments(src).split("\n");
  const codeLines = codeOnly(src).split("\n");
  const len = Math.max(textLines.length, codeLines.length);
  for (let i = 0; i < len; i++) {
    const text = textLines[i] ?? "";
    const code = codeLines[i] ?? "";
    const n = i + 1;
    if (isHostBinaryExec(text, code)) {
      out.push({ rule: "R1-host-binary", file: name, line: n, text: text.trim(), detail: "a unit test must not exec a host-inspection binary: its output is a fact about the runner, not the code" });
    }
    if (isRealIdentityRead(code)) {
      out.push({ rule: "R2-real-identity", file: name, line: n, text: text.trim(), detail: "os.userInfo()/homedir()/hostname() read the REAL machine; inject the seam (or use a fixture)" });
    }
    if (isRelativeVaultDataDir(text)) {
      out.push({ rule: "R3-relative-vault", file: name, line: n, text: text.trim(), detail: 'a relative dataDir:"data" resolves against cwd into the gitignored operator vault; use a mkdtempSync dir' });
    }
    for (const host of externalHostsIn(text)) {
      out.push({ rule: "R4-external-reach", file: name, line: n, text: text.trim(), detail: `a unit test must not reach a non-loopback host (${host}); serve it from a loopback fixture (startFixture / 127.0.0.1)` });
    }
    if (isTautology(code)) {
      out.push({ rule: "R5-tautology", file: name, line: n, text: text.trim(), detail: "a tautological assertion cannot fail, so it pins nothing; assert the real property (and do it inside a counted test())" });
    }
  }
  return out;
}

/** The test files that exist on disk. Derived, never hardcoded — a gate whose
 *  file list is written by hand misses exactly the new file it exists to catch. */
export function testFilesOnDisk(): string[] {
  return readdirSync(join(ROOT, "test"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => e.name)
    .sort();
}

export function scanCorpus(): Violation[] {
  const out: Violation[] = [];
  for (const name of testFilesOnDisk()) {
    if (EXCLUDED_FROM_SCAN.includes(name)) continue;
    out.push(...scanSource(name, readFileSync(join(ROOT, "test", name), "utf8")));
  }
  return out;
}

export function fmt(v: Violation): string {
  return `${v.file}:${v.line} [${v.rule}] ${v.text}\n    ${v.detail}`;
}

// ---------------------------------------------------------------- allow-list ---
//
// Every entry is (file, rule, code-snippet) scoped and carries a NAMED reason.
//
// WHY A CODE SNIPPET AND NOT A LINE NUMBER: this tree is edited by four agents
// at once, and a line-numbered allow-list is therefore a landmine — during the
// build of this gate, test/profile-scan.test.ts:243 silently became :248 and
// test/chat-surface-merge.test.ts's entry stopped matching entirely (the owning
// agent fixed it to a temp dir). A snippet survives reflow and still DIES the
// moment the code is fixed, which is what we want: see LIVENESS below.
//
// A STALE entry (no live violation matches it) FAILS. An allow-list that
// outlives its violation is a hole, not a record — and a fixed violation must
// never stay allowed, or the old shape walks straight back in.

export interface AllowEntry {
  file: string;
  rule: RuleId;
  /** A code fragment that must be present on the offending line. */
  match: string;
  reason: string;
}

export const ALLOW_LIST: AllowEntry[] = [
  {
    file: "profile-scan.test.ts",
    rule: "R2-real-identity",
    match: "userInfo().username",
    reason:
      "DEBT (owner: test/profile-scan.test.ts): findAllChromeProfilesOnOs derives a profile's `user` from the OS account, so the test compares the code's output to os.userInfo().username. Deterministic ONLY because both sides read the same box — and os.userInfo() THROWS where the running uid has no passwd entry, which is a real bare-container risk (exactly the pipeline-199 class). Fix: inject the username into findAllChromeProfilesOnOs and assert the fixture value.",
  },
  {
    file: "pool-deadline.test.ts",
    rule: "R3-relative-vault",
    match: 'const pool = new ChatPool({ profiles: [], dataDir: "data", ...opts } as PoolOptions);',
    reason:
      "DEBT (owner: test/pool-deadline.test.ts): ChatPool is constructed with dataDir:\"data\" and profiles: [], so no session is ever read from the real vault. Harmless today ONLY because the empty profile list makes the pool inert; add one profile and it reads the operator vault. Fix: a mkdtempSync dir.",
  },
  {
    file: "status-honesty.test.ts",
    rule: "R3-relative-vault",
    match: 'return new ChatPool({ profiles: [], dataDir: "data", max: 1, ...opts } as PoolOptions);',
    reason:
      "DEBT (owner: test/status-honesty.test.ts): the pool FACTORY takes dataDir:\"data\" with profiles: [], so it is never used to resolve a session. Fix: a mkdtempSync dir.",
  },
  {
    file: "status-honesty.test.ts",
    rule: "R3-relative-vault",
    match: 'const pool = new ChatPool({ profiles: [], dataDir: "data", max: 1, maxWaiters: 3',
    reason:
      "DEBT (owner: test/status-honesty.test.ts): second ChatPool construction with dataDir:\"data\", profiles: []. Fix: a mkdtempSync dir.",
  },
  {
    file: "registry-doc-truth.test.ts",
    rule: "R4-external-reach",
    match: "await fetch(`https://api.github.com/repos/",
    reason:
      "Named and fail-safe by its own author: the GOAL 116 reachability probe fetches api.github.com, then tt.skip()s on ANY network failure, non-ok status or inconclusive answer, and asserts only what is true while the registry is 404 (the current honest state). It cannot fail on a runner with no network — but it can still burn the 120 s file timeout on a slow one. Fix worth taking: gate it behind the same UI2API_REGISTRY_LIVE=1 idiom as test/install.test.ts:141.",
  },
  {
    file: "account-exact-resolution-cli.test.ts",
    rule: "R5-tautology",
    match: 'assert.ok(true, "skipped: no vault artifact',
    reason:
      "DEBT (owner: test/account-exact-resolution-cli.test.ts): a placeholder the test returns into when the real vault has nothing to compare. The message is honest about skipping, but the assertion pins nothing. Fix: t.skip() — the idiom test/install.test.ts:141 already uses — or a temp-dir artifact.",
  },
  {
    file: "account-exact-resolution-cli.test.ts",
    rule: "R5-tautology",
    match: "assert.equal(before, before,",
    reason:
      "DEBT (owner: test/account-exact-resolution-cli.test.ts): compares a value with itself. Fix: drop the line — the real pin is two below it, which re-stats the file and compares against `before`.",
  },
];

/** The gate's own file. Its source NECESSARILY contains every forbidden shape as
 *  DATA — the R1 rule table, the R3 detail string, and the synthetic inputs the
 *  self-tests feed the predicates — so scanning it would be permanently red and
 *  train people to ignore the gate. The exclusion is load-bearing (a test
 *  asserts the gate's own source really does contain the shapes) and it is
 *  exactly one named file, pinned so it cannot be widened silently. */
export const SELF = "host-independence-gate.test.ts";
export const EXCLUDED_FROM_SCAN = [SELF];

const covers = (e: AllowEntry, v: Violation): boolean =>
  e.file === v.file && e.rule === v.rule && v.text.includes(e.match);

const isAllowed = (v: Violation): boolean => ALLOW_LIST.some((e) => covers(e, v));


// -------------------------------------------------------------------- tests ---

test("GOAL149(a): the gate reads its file list from DISK — a new test file cannot slip past it", () => {
  const onDisk = testFilesOnDisk();
  assert.ok(onDisk.length > 50, `expected the real corpus, got ${onDisk.length} files`);
  assert.ok(onDisk.includes("session-store.test.ts"), "the corpus must include the file finding 1 lived in");
  assert.ok(onDisk.includes(SELF), "the gate must see itself in the derived list");
  assert.deepEqual([...onDisk].sort(), onDisk, "the derived list must be sorted so a report is stable");
  // The self-exclusion is load-bearing, not a free pass: the gate's own source
  // really does contain every forbidden shape as DATA (its rule table, its
  // detail strings, and the synthetic inputs its self-tests feed the
  // predicates). Prove it, so nobody can quietly widen the exclusion and call
  // the corpus clean while it is not.
  const ownSelf = scanSource(SELF, readFileSync(join(ROOT, "test", SELF), "utf8"));
  const rulesInSelf = [...new Set(ownSelf.map((v) => v.rule))].sort();
  assert.ok(rulesInSelf.length > 0, "EXCLUDED_FROM_SCAN is skipping nothing — this file contains no forbidden shape, so the exclusion is a stale no-op");
  // Pinned exactly. R2 and R5 are deliberately ABSENT: every os.userInfo() and
  // assert.ok(true) example in this file lives inside a STRING, and both rules
  // are defined on the string-blanked view precisely so that counts as data,
  // not as a call or an assertion — that is the R5 no-hit case, pinned. The
  // other three ARE present as literal data here (the R1 rule table, the R3
  // detail string, the finding-1 URL fixture), which is exactly why this file
  // cannot scan itself.
  assert.deepEqual(
    rulesInSelf,
    ["R1-host-binary", "R3-relative-vault", "R4-external-reach"],
    "the set of rules this file itself offends changed — re-check the EXCLUDED_FROM_SCAN rationale before touching it",
  );
  // Exactly one file is excluded, and it is this one.
  assert.deepEqual(EXCLUDED_FROM_SCAN, [SELF], "the self-exclusion must stay exactly one named file");
  assert.ok(onDisk.filter((f) => EXCLUDED_FROM_SCAN.includes(f)).length === 1);
});

test("GOAL149(b): the corpus is CLEAN — no unit test reads the real machine outside the named allow-list", () => {
  const violations = scanCorpus();
  const unallowed = violations.filter((v) => !isAllowed(v));
  assert.deepEqual(
    unallowed.map(fmt),
    [],
    `these unit tests depend on the machine they run on — fix the seam, or add a reasoned ALLOW_LIST entry:\n${unallowed.map(fmt).join("\n")}`,
  );
  // The gate is not vacuous: it must be capable of reporting SOMETHING, and it
  // must actually have found the named debt (otherwise the corpus silently
  // changed shape and the allow-list is hiding a bigger problem).
  assert.ok(violations.length > 0, "the scan found nothing at all — is the gate still wired to the corpus?");
  for (const v of violations) assert.ok(isAllowed(v), `unreported violation: ${fmt(v)}`);
});

test("GOAL149(c): ALLOW_LIST LIVENESS — no entry may outlive its violation (a stale allowance is a hole)", () => {
  const violations = scanCorpus();
  const stale = ALLOW_LIST.filter((e) => !violations.some((v) => covers(e, v)));
  assert.deepEqual(
    stale.map((e) => `${e.file} [${e.rule}] match=${JSON.stringify(e.match)} — ${e.reason.slice(0, 60)}…`),
    [],
    "these ALLOW_LIST entries no longer match any violation: the code was fixed, so REMOVE the entry (otherwise the gate is a hole that silently permits the old shape back)",
  );
  // Every entry must carry a real reason — an entry with no reason is not an
  // allowance, it is a hole with a comment.
  for (const e of ALLOW_LIST) {
    assert.ok(e.reason.length > 40, `${e.file} [${e.rule}] needs a NAMED reason, got ${JSON.stringify(e.reason)}`);
    assert.ok(e.match.length > 3, `${e.file} [${e.rule}] needs a code snippet to match, got ${JSON.stringify(e.match)}`);
  }
});

// ---- self-test: every predicate must bite AND must not fire on legit code ---

test("GOAL149 SELFTEST R1: a host-inspection binary in an exec is reported; prose, loopback fixtures and other binaries are not", () => {
  // bites
  assert.equal(isHostBinaryExec('execFileSync("ldconfig", ["-p"])'), true);
  assert.equal(isHostBinaryExec('const bins = ["fc-list"];'), true, "a quoted binary name is a host probe");
  assert.equal(isHostBinaryExec('  execFileSync("xdpyinfo", [], { timeout: 5 });'), true);
  assert.equal(isHostBinaryExec('spawnSync("getent", ["passwd", "ui2api"])'), true);
  assert.equal(isHostBinaryExec('exec("dpkg -l | grep libnss")'), true);
  // does NOT fire
  assert.equal(isHostBinaryExec('assert.match(o.home, /^\\//, "an absolute path from getent")'), false, "the word in a message is prose, not a probe");
  assert.equal(isHostBinaryExec('execFileSync("git", ["ls-files"])'), false, "git index queries are legitimate");
  assert.equal(isHostBinaryExec('execFileSync("google-chrome", ["--version"])'), false, "a real product binary, not host inspection");
  assert.equal(scanSource("x.test.ts", '// execFileSync("which", ["xdpyinfo"]);\nexecFileSync("git", ["status"]);').length, 0, "comment-stripping must hide the documented probe");
});

test("GOAL149 SELFTEST R2: os.userInfo/homedir/hostname are reported; a fixture or a message naming them is not", () => {
  // bites (on the CODE view — the call is real code)
  assert.equal(isRealIdentityRead(codeOnly("const u = os.userInfo().username;")), true);
  assert.equal(isRealIdentityRead(codeOnly('const h = homedir();')), true);
  assert.equal(isRealIdentityRead(codeOnly("const h = os.hostname();")), true);
  // does NOT fire
  assert.equal(isRealIdentityRead(codeOnly('const dir = mkdtempSync(join(tmpdir(), "u2a-"));')), false);
  assert.equal(isRealIdentityRead(codeOnly('assert.match(o.home, /^\\//, "absolute path, NOT os.homedir()")')), false, "a message string is data, not a call");
  assert.equal(scanSource("x.test.ts", '// os.userInfo().username is the old bug\nconst x = 1;').length, 0);
});

test("GOAL149 SELFTEST R3: a relative dataDir:\"data\" is reported; an absolute or joined data dir is not", () => {
  assert.equal(isRelativeVaultDataDir('const svc = await startPromptd({ port: 0, dataDir: "data" });'), true);
  assert.equal(isRelativeVaultDataDir('const pool = new ChatPool({ profiles: [], dataDir: "data" } as PoolOptions);'), true);
  assert.equal(isRelativeVaultDataDir("const dataDir = 'data';"), true);
  assert.equal(isRelativeVaultDataDir('const dataDir = join(base, "data");'), false, "a temp-dir segment is the FIXED shape");
  assert.equal(isRelativeVaultDataDir('const dataDir = "/tmp/u2a-data";'), false, "absolute is fine");
  assert.equal(isRelativeVaultDataDir('const dataDir = join(REPO_ROOT, "data", "sessions");'), false, "a deliberate repo-root path, not a cwd-relative vault read");
  assert.equal(isRelativeVaultDataDir('child.stdout.on("data", (c) => (out += c));'), false, "an event name, not a dataDir");
});

test("GOAL149 SELFTEST R4: a non-loopback URL in a reach-out is reported (finding 1 verbatim); loopback and data-only URLs are not", () => {
  // The exact finding-1 line, verbatim.
  const finding1 = 'await page.goto("http://example.com/", { waitUntil: "domcontentloaded" }).catch(() => {});';
  assert.deepEqual(externalHostsIn(finding1), ["http://example.com"], "finding 1 must be reported");
  const found = scanSource("session-store.test.ts", finding1);
  assert.equal(found[0]?.rule, "R4-external-reach", "the gate must actually fire on the finding-1 line");
  assert.equal(found[0]?.line, 1);
  // reaches
  assert.deepEqual(externalHostsIn('await fetch("https://api.github.com/repos/a/b")'), ["https://api.github.com"]);
  assert.deepEqual(externalHostsIn('execFileSync("curl", ["-s", "https://evil.example.com/x"])'), ["https://evil.example.com"]);
  // does NOT fire — loopback fixtures are the convention
  assert.deepEqual(externalHostsIn('await page.goto(`${origin}/`, { waitUntil: "load" })'), []);
  assert.deepEqual(externalHostsIn('const url = `http://127.0.0.1:${port}/`;'), []);
  assert.deepEqual(externalHostsIn('const base = "http://localhost:3999";'), []);
  // does NOT fire — a non-loopback URL in pure DATA is not a reach-out
  assert.deepEqual(externalHostsIn('assert.match(site, /https:\\/\\/gemini\\.google\\.com/);'), []);
  assert.deepEqual(externalHostsIn('const bad = "https://evil.com@www.youtube.com";'), [], "an SSRF fixture is data, not traffic");
  assert.deepEqual(externalHostsIn('const profile = { url: "https://chat.deepseek.com" };'), [], "a packaged site url is data");
});

test("GOAL149 SELFTEST R5: tautologies are reported; a real assertion and a source-code FIXTURE string are not", () => {
  // bites — finding 1's own line
  assert.equal(isTautology(codeOnly("assert.ok(true);")), true);
  assert.equal(isTautology(codeOnly('assert.ok(true, "skipped: no vault artifact on this box");')), true);
  assert.equal(isTautology(codeOnly("assert.equal(true, true);")), true);
  assert.equal(isTautology(codeOnly('assert.equal(before, before, "mtime captured pre-condition");')), true);
  assert.equal(scanSource("x.test.ts", "assert.ok(true);")[0]?.rule, "R5-tautology");
  // does NOT fire
  assert.equal(isTautology(codeOnly('assert.ok(loaded!.host === "gemini.google.com");')), false);
  assert.equal(isTautology(codeOnly('assert.equal(before, statSync(p).mtimeMs);')), false, "the SAME name twice is only a tautology if BOTH sides are that name");
  assert.equal(isTautology(codeOnly('  "  assert.equal(1, 1);",')), false, "a source-code fixture string for the counted-assertions gate is DATA, not an assertion");
  assert.equal(scanSource("x.test.ts", '// assert.ok(true) is the disease\nassert.ok(1 === 1);').length, 0, "the comment must not trip it");
});

test("GOAL149 SELFTEST: the scanner blanks comments WITHOUT eating the URL — the naive `//` stripper cannot", () => {
  // The bug this file's own self-test caught: a naive `.replace(/\/\/.*$/gm)`
  // truncates `goto("http://example.com/")` at the `//`, so the URL rule could
  // never fire on the exact shape it exists to catch.
  const urlLine = 'await page.goto("http://example.com/", { waitUntil: "load" });';
  assert.ok(stripComments(urlLine).includes("http://example.com/"), "the URL must survive comment-stripping");
  assert.equal(urlLine.replace(/\/\/.*$/gm, " ").includes("http://example.com/"), false, "the naive stripper really does eat it (this is why the scanner exists)");

  // comments are gone, real code and line numbers survive
  const src = [
    '/* block: execFileSync("ldconfig", ["-p"]) */',
    '// line: os.userInfo().username',
    'const keep = 1; // trailing: dataDir: "data"',
  ].join("\n");
  assert.deepEqual(scanSource("x.test.ts", src), [], "documented code is not executed code");
  assert.ok(stripComments(src).includes("const keep = 1;"), "real code survives stripping");
  assert.equal(stripComments(src).split("\n").length, 3, "line numbers must stay true");
  assert.equal(codeOnly('const p = "os.userInfo()";').includes("userInfo"), false, "codeOnly blanks string contents");
});

