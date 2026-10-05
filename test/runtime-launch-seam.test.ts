import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolvedHeadless, headlessDegradedReason } from "../src/runtime/browser.js";

/**
 * THE LAUNCH-SEAM GATE — the highest-value pin in the browser/posture layer.
 *
 * This project drives a REAL browser through a user's own logged-in session, and
 * its own measured record is that headless is what gets it blocked
 * (`--headless=new` -> `ERR_CHALLENGE`; a HEADED Chrome on Xvfb -> a real
 * DOM-read answer). Everything that makes a driven session look like a person —
 * headed vs headless, real Chrome vs bundled Chromium, the owner's profile, the
 * sandbox flag, attach-vs-spawn — is decided in ONE function, `launchBrowser()`
 * in `src/runtime/browser.ts`. The bench rule in AGENTS.md is therefore not
 * style: a launch that skips the seam is the most serious defect class in the
 * repo, because it loses the stealth posture silently. Nothing crashes. The
 * request just gets blocked, days later, with no local cause.
 *
 * So the seam's integrity is pinned here, from the SOURCE, in three
 * independent layers — because each layer alone can be defeated:
 *
 *   1. CALL SITES. Every `.launch(` / `.launchPersistentContext(` /
 *      `.connectOverCDP(` / `.launchServer(` in the tree is located (comments
 *      and string bodies blanked first, so prose about a launch is not a
 *      launch) and must be either the seam itself or a DECLARED exception.
 *      A new ad-hoc launch fails LOUD, naming the file, the line and the
 *      enclosing function.
 *   2. THE `chromium` VALUE IMPORT. A launch can be hidden behind a variable or
 *      a computed property, so this layer asks a question a call-site scan
 *      cannot: which modules are allowed to hold Playwright's browser handle at
 *      all? Only the seam and the declared exceptions may. A new module that
 *      imports `chromium` fails even if its call is written oddly.
 *   3. THE SEAM'S OWN SHAPE. `chromium.launch(` and `connectOverCDP` each occur
 *      EXACTLY ONCE in the whole tree, inside the seam. That is what makes the
 *      scan trustworthy: if a second one appears anywhere, this test fails
 *      before the call-site rules can be argued with.
 *
 * The exception table below is POLICY — a human decision, not a derivation, and
 * each row says what would invalidate it. It is not a list of "known bugs": each
 * entry is a launch with a genuinely different CONTRACT from the seam's
 * (an interactive window a human logs into; a one-off debug attach), and the
 * honest alternative — forcing it through `launchBrowser()` — would change what
 * it does. What is NOT negotiable is that they inherit the posture they can:
 * `launchHeadedChromeForLogin` derives its whole option bag from the seam's
 * `buildLaunchOptions` (pinned in test/runtime-derivation-truth.test.ts).
 *
 * SCOPE: `src/**` plus the JS in `scripts/`. A shell script cannot be scanned
 * this way, so `scripts/ops/launch-ui2api-chrome.sh` and the spawn inside
 * `scripts/ops/provision-ui2api-user.sh` are outside this gate and are reported
 * to the orchestrator instead.
 */

const ROOT = resolve("src");
const SEAM = "src/runtime/browser.ts";

/** Playwright browser-launch entry points. `connect` is NOT here on purpose:
 *  `src/plugin/serve.ts:50` is a socket connect, not a browser. */
const LAUNCH_APIS = ["launch", "launchPersistentContext", "connectOverCDP", "launchServer"] as const;
const LAUNCH_CALL_RE = new RegExp(String.raw`\.\s*(${LAUNCH_APIS.join("|")})\s*\(`, "g");

/**
 * A line that puts `--headless=new` ONTO A COMMAND LINE — `args.push("…")` or a
 * `? ["…"]` in an argument array. A warning MESSAGE that merely names the flag
 * (posture.ts's degradation notice, the daemon's remedy text) is prose, not a
 * spawn, and must not be counted; that is why the shape, not the substring, is
 * the predicate.
 */
const SPAWNS_HEADLESS_ARG_RE = /(?:\.push\(|\?)\s*\(?\s*\[?\s*["'`]--headless=new/;

/**
 * Launches that are NOT the seam, each with the reason it exists and what would
 * invalidate the exception.
 */
const DECLARED_EXCEPTIONS: ReadonlyArray<{ module: string; fn: string; why: string }> = [
  {
    module: "src/cli.ts",
    fn: "doInteractiveLogin",
    why:
      "analyse --login: opens ONE headed window for a human to sign in, then captures cookies. It already " +
      "derives its options from the seam's buildLaunchOptions({headless:false}) so it inherits the real-Chrome " +
      "decision and the clean flag set. Invalidated if the seam grows a first-class interactive-login entry " +
      "point — then this must route through it.",
  },
  {
    module: "src/runtime/xhost-capture.ts",
    fn: "launchHeadedChromeForLogin",
    why:
      "assisted login: `launchPersistentContext` is REQUIRED, not stylistic — Playwright's `launch()` rejects " +
      "userDataDir, and this flow must hand the OWNER's real on-disk profile to a window the user logs into and " +
      "then leaves open. Its option bag is derived from the seam's buildLaunchOptions, and headless:false is " +
      "forced (an invisible window is not a login). Invalidated if the seam gains a persistent-context login " +
      "entry point.",
  },
  {
    module: "scripts/ops/open-gemini-cdp.mjs",
    fn: "<module>",
    why:
      "a 15-line operator debug helper: attach to whatever Chrome is on 9222, print URL+title, exit. It starts " +
      "nothing, so it has no posture to inherit. Invalidated if it is ever wired into a shipped path.",
  },
];

/** Modules allowed to hold the `chromium` VALUE (not `import type`). Layer 2. */
const CHROMIUM_VALUE_HOLDERS: ReadonlySet<string> = new Set([
  SEAM,
  "src/cli.ts",
  "src/runtime/xhost-capture.ts",
  "scripts/ops/open-gemini-cdp.mjs",
]);

function sourceFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full, exts));
      continue;
    }
    if (exts.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Blank out comment BODIES (always) and, unless `keepStrings`, string bodies too
 * — while preserving every character position and newline, so a hit's
 * line/column still points at the real code. A prose mention of
 * `chromium.launch()` in a comment is not a launch site — the seam file itself
 * has one, and treating it as a call would make this gate lie.
 *
 * `keepStrings` exists for the argument-list check, which has to SEE the string
 * literal it is looking for; there the shape of the line is the discriminator,
 * not the absence of prose.
 */
function blankCommentsAndStrings(src: string, opts: { keepStrings?: boolean } = {}): string {
  const keepStrings = opts.keepStrings === true;
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    if (!keepStrings && (c === '"' || c === "'" || c === "`")) {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j++;
      }
      // keep the quotes themselves (a template literal's `${}` is real code, but
      // a launch call cannot live there in this repo, and blanking it whole is
      // the conservative direction: fewer false hits, never a missed one)
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The last column-0 declaration above `lineNo`, i.e. the enclosing symbol. */
function enclosingSymbol(lines: readonly string[], lineNo: number): string {
  const decl = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/;
  const constDecl = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)/;
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    const m = decl.exec(lines[i]) ?? constDecl.exec(lines[i]);
    if (m) return m[1];
  }
  return "<module>";
}

interface LaunchHit {
  file: string;
  line: number;
  api: string;
  fn: string;
}

function findLaunchSites(): LaunchHit[] {
  const files = [
    ...sourceFiles(ROOT, [".ts", ".mts", ".cts"]),
    ...(statSync("scripts").isDirectory() ? sourceFiles("scripts", [".mjs", ".js", ".cjs"]) : []),
  ];
  const hits: LaunchHit[] = [];
  for (const abs of files) {
    const rel = relative(".", abs).split("\\").join("/");
    const raw = readFileSync(abs, "utf8");
    const code = blankCommentsAndStrings(raw);
    const lines = code.split("\n");
    for (let ln = 0; ln < lines.length; ln++) {
      LAUNCH_CALL_RE.lastIndex = 0;
      let m = LAUNCH_CALL_RE.exec(lines[ln]);
      while (m !== null) {
        hits.push({ file: rel, line: ln + 1, api: m[1], fn: enclosingSymbol(lines, ln + 1) });
        m = LAUNCH_CALL_RE.exec(lines[ln]);
      }
    }
  }
  return hits;
}

function holdsChromiumValue(rel: string, src: string): boolean {
  // a value import of `chromium` from playwright, in any spelling
  if (/import\s*\{[^}]*\bchromium\b[^}]*\}\s*from\s*["']playwright["']/.test(src)) return true;
  // or a dynamic one that destructures it
  if (/await\s+import\(["']playwright["']\)[\s\S]{0,80}?\bchromium\b/.test(src)) return true;
  if (/import\(["']playwright["']\)[\s\S]{0,40}?\{[^}]*\bchromium\b/.test(src)) return true;
  return false;
}

test("LAYER 1 — every browser launch in the tree is the seam or a DECLARED exception", () => {
  const hits = findLaunchSites();
  assert.ok(hits.length > 0, "the scanner found no launch site at all — if this passes, the SCANNER is broken, not the tree");

  const offenders: string[] = [];
  for (const h of hits) {
    if (h.file === SEAM) continue; // the seam IS the sanctioned launch
    const ok = DECLARED_EXCEPTIONS.some((e) => e.module === h.file && (e.fn === h.fn || e.fn === "<module>"));
    if (!ok) {
      offenders.push(
        `${h.file}:${h.line} — ${h.fn}() calls .${h.api}( directly, bypassing launchBrowser(). ` +
          `A launch that skips the seam loses the stealth posture silently (headed/headless, real-Chrome-vs-` +
          `Chromium, the owner's profile, the sandbox flag, attach-vs-spawn). Route it through launchBrowser(), ` +
          `or add a DECLARED_EXCEPTIONS row saying why it cannot.`,
      );
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join("\n")}`);
});

test("LAYER 1b — the declared exceptions still EXIST (a stale exception is rot in the other direction)", () => {
  const hits = findLaunchSites();
  const live = new Set(hits.filter((h) => h.file !== SEAM).map((h) => `${h.file}::${h.fn}`));
  const stale = DECLARED_EXCEPTIONS.filter(
    (e) => e.fn !== "<module>" && ![...live].some((k) => k === `${e.module}::${e.fn}`),
  ).map((e) => `${e.module}::${e.fn} — the exception is declared but nothing launches there any more`);
  assert.deepEqual(stale, [], `\n${stale.join("\n")}`);
});

test("LAYER 2 — only the seam and the declared exceptions may hold the Playwright `chromium` handle", () => {
  // A call-site scan can be defeated by a variable or a computed property. This
  // cannot: it asks who is even ABLE to launch, independent of how they write
  // the call. `import type { Browser } from "playwright"` is not a launch and is
  // deliberately not matched.
  const files = [
    ...sourceFiles(ROOT, [".ts", ".mts", ".cts"]),
    ...sourceFiles("scripts", [".mjs", ".js", ".cjs"]),
  ];
  const holders: string[] = [];
  for (const abs of files) {
    const rel = relative(".", abs).split("\\").join("/");
    if (!holdsChromiumValue(rel, readFileSync(abs, "utf8"))) continue;
    const sanctioned =
      rel === SEAM ||
      CHROMIUM_VALUE_HOLDERS.has(rel) ||
      DECLARED_EXCEPTIONS.some((e) => e.module === rel);
    if (!sanctioned) holders.push(`${rel} — imports playwright's \`chromium\`; only the seam may launch a browser`);
  }
  assert.deepEqual(holders, [], `\n${holders.join("\n")}`);
});

test("LAYER 3 — the seam's launch surface is exactly {connectOverCDP, launch}, and each is used once", () => {
  // LAYER 1 already forbids a launch outside the seam that nobody declared. What
  // makes the SCAN trustworthy is this: the seam's own primitive set is pinned,
  // so a launch cannot appear inside the seam either without this test moving.
  // `launchPersistentContext` is deliberately NOT in the set: the seam launches a
  // Browser it owns end to end, and a persistent context is a different
  // contract (a profile handed to the process) — that belongs to the declared
  // login flow, not to the seam.
  const hits = findLaunchSites().filter((h) => h.file === SEAM);
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.api, (counts.get(h.api) ?? 0) + 1);
  assert.deepEqual(
    [...counts.keys()].sort(),
    ["connectOverCDP", "launch"],
    `the seam's launch surface changed: ${[...counts.keys()].sort().join(", ")}`,
  );
  assert.equal(counts.get("launch"), 1, "exactly one chromium.launch() in the seam (the pinned-Chromium fallback)");
  assert.equal(counts.get("connectOverCDP"), 1, "exactly one connectOverCDP() in the seam (the attach path)");
  assert.equal(hits.filter((h) => h.api === "launchPersistentContext").length, 0, "the seam never manages a persistent context");
});

test("the seam is where the posture is decided, and nothing else decides it", () => {
  // GOAL 126's split-brain: the seam computed the mode as
  // `!(wantHeadful && displayAvailable())` while other call sites read the env
  // alone, so `UI2API_HEADED=1` with no DISPLAY made callers believe they had a
  // real user while the spawn was headless. It is closed today — MEASURED, the
  // env is read in 4 places and only ONE of them turns it into a launch
  // decision. This pins that, because it is the property that keeps it closed.
  const seam = readFileSync(SEAM, "utf8");
  assert.match(seam, /export function resolvedHeadless/, "the seam must own the one resolver");
  assert.match(seam, /export function headlessDegradedReason/, "and the named headless-degraded verdict");
  assert.match(
    seam,
    /return process\.env\.UI2API_HEADED !== "1"/,
    "the env->headless decision must live in headlessDefaulted() inside the seam",
  );

  // A `--headless=new` that reaches an argument list is a browser spawned without
  // a display — MEASURED to get us blocked with ERR_CHALLENGE. Exactly two
  // modules may do it, and each must take its value from the seam's resolver.
  // A mention inside a warning MESSAGE is not a spawn and is not counted.
  const pushers: Array<{ file: string; line: number }> = [];
  for (const abs of sourceFiles(ROOT, [".ts", ".mts", ".cts"])) {
    const rel = relative(".", abs).split("\\").join("/");
    const code = blankCommentsAndStrings(readFileSync(abs, "utf8"), { keepStrings: true }).split("\n");
    for (let i = 0; i < code.length; i++) {
      if (SPAWNS_HEADLESS_ARG_RE.test(code[i])) pushers.push({ file: rel, line: i + 1 });
    }
  }
  assert.equal(
    pushers.length,
    2,
    `exactly two spawners may put --headless=new on a command line; found ${pushers.length}: ` +
      `${pushers.map((p) => `${p.file}:${p.line}`).join(", ")}`,
  );
  assert.deepEqual(
    pushers.map((p) => p.file).sort(),
    ["src/runtime/browser.ts", "src/runtime/chrome-daemon.ts"],
    "only the seam and the persistent daemon may spawn a headless Chrome",
  );
  for (const p of pushers) {
    assert.ok(
      readFileSync(p.file, "utf8").includes("resolvedHeadless("),
      `${p.file}:${p.line} spawns --headless=new but never asks the seam's resolvedHeadless() — ` +
        `that is exactly the GOAL 126 split-brain (a caller deciding headfulness from something other than the seam)`,
    );
  }
});

/**
 * THE ORPHAN KILL — a failed launch must leave NO chrome behind.
 *
 * `spawnChromeAndConnect()` is the one place in this repo that spawns a Chrome
 * it owns. Its CDP attach does not own the child, so the child is killed on
 * `disconnected`. That is only a cleanup while the launch SUCCEEDS: measured
 * source order before this fix was `spawn` -> stderr -> poll loop -> `await
 * connectWithTimeout()` (which throws on any failed/overshot attach) -> and
 * THEN the kill. So every one of those throws propagated with a REAL
 * `google-chrome` still running.
 *
 * The consequence is not a slow test, it is a bricked box: the orphan holds
 * the ProcessSingleton lock on the chrome owner's profile, so every later
 * `ui2api chrome start` fails with `Failed to create ... ProcessSingleton` until
 * a human runs `pkill` by hand. `chrome-daemon.ts` is deliberately idempotent
 * AND adopting so a leftover Chrome is never fatal — leaking one defeats a
 * property this repo advertises in AGENTS.md and docs/GIT_WIRING.md.
 *
 * This asserts the property STRUCTURALLY, on the CODE view (comments and string
 * bodies blanked, so a comment quoting the old bad order can neither satisfy
 * nor break it) rather than on prose or on a live browser: nothing is spawned,
 * nothing is killed, and no Chrome this repo did not start is ever touched.
 */
test("THE ORPHAN KILL — the spawned process is killable at the instant it exists, so no later throw can leak it", () => {
  const seamRaw = readFileSync(SEAM, "utf8");
  const seamCode = blankCommentsAndStrings(seamRaw);
  // The ORDER assertions run on the strings-blanked view, so a comment or a
  // string literal quoting the old bad order can neither satisfy nor break them.
  // The `disconnected` wiring check NEEDS its string literal, so it runs on the
  // keepStrings view — there the SHAPE (`x.on("disconnected", killGroup)`) is the
  // discriminator, not the absence of prose. Both views preserve every
  // character position, so one body extraction serves both.
  const seamKept = blankCommentsAndStrings(seamRaw, { keepStrings: true });

  // Brace-match the ONE function that owns a spawned child. Comments/strings are
  // already blanked, so braces inside them cannot skew the depth count.
  const declAt = seamCode.indexOf("function spawnChromeAndConnect(");
  assert.ok(declAt > 0, "spawnChromeAndConnect() must exist in the seam — it is the only place that owns a spawned Chrome");
  // Skip the PARAMETER list to find the body brace: a naive `indexOf("{")` lands
  // on the `= {}` DEFAULT PARAMETER and brace-matches an empty body, which would
  // make every assertion below vacuously pass.
  let parens = 0;
  let paramEnd = -1;
  for (let i = seamCode.indexOf("(", declAt); i < seamCode.length; i++) {
    const ch = seamCode[i];
    if (ch === "(") parens++;
    else if (ch === ")") {
      parens--;
      if (parens === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  assert.ok(paramEnd > declAt, "could not find the seam-spawn function's parameter list");
  const bodyStart = seamCode.indexOf("{", paramEnd);
  assert.ok(bodyStart > paramEnd, "could not find the seam-spawn function's body");
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < seamCode.length; i++) {
    const ch = seamCode[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  assert.ok(bodyEnd > bodyStart, "could not brace-match the seam-spawn function's body");
  const body = seamCode.slice(bodyStart, bodyEnd);
  const bodyKept = seamKept.slice(bodyStart, bodyEnd);
  const at = (needle: string) => body.indexOf(needle);
  const allAt = (needle: string) => {
    const out: number[] = [];
    for (let i = body.indexOf(needle); i !== -1; i = body.indexOf(needle, i + needle.length)) out.push(i);
    return out;
  };

  const spawnAt = at("spawn(exec, args");
  const killDefAt = at("const killGroup");
  assert.ok(spawnAt >= 0, "no `spawn(exec, args` in the seam-spawn function — if this fails the SCANNER is broken, not the code");
  assert.ok(killDefAt >= 0, "no `const killGroup` — the function spawns a process it owns and never learned how to kill it");

  // (1) The kill must be DEFINED AFTER the spawn (it needs `child`) and BEFORE
  //     every throw that follows the spawn. This is the pinned property: the old
  //     order put the definition after `connectWithTimeout`, whose throw is the
  //     common case (a failed CDP attach).
  assert.ok(
    killDefAt > spawnAt,
    `killGroup must be defined AFTER the spawn (spawn@${spawnAt} < killGroup@${killDefAt}) — it closes over \`child\`, ` +
      `so it cannot exist before it`,
  );
  const throws = allAt("throw ");
  assert.ok(throws.length > 0, "the function has no throw at all — the orphan-kill property is vacuous here; re-derive the assertion");
  const lateThrows = throws.filter((i) => i > spawnAt);
  assert.ok(
    lateThrows.length > 0,
    "no throw after the spawn — then there is nothing to leak and this test proves nothing; re-derive it",
  );
  const firstLateThrow = Math.min(...lateThrows);
  assert.ok(
    killDefAt < firstLateThrow,
    `killGroup is defined at @${killDefAt} but a throw sits at @${firstLateThrow} — LATER. ` +
      `A cleanup registered after the statement that can throw is skipped by exactly that statement, so this ` +
      `restores the leaked Chrome that holds the owner's ProcessSingleton lock (every later \`chrome start\` then ` +
      `fails with \`Failed to create ... ProcessSingleton\` until a human runs pkill).`,
  );

  // (2) Defining it early is not ENOUGH — it must actually be invoked on the
  //     failure path. Pin the catch: it kills, and it re-throws (never swallows,
  //     which would turn a failed launch into a silent hang or a fake success).
  const catchAt = at("} catch (e) {");
  assert.ok(catchAt > firstLateThrow, `no catch AFTER the first post-spawn throw (@${firstLateThrow}) — the kill would never run`);
  const catchBody = body.slice(catchAt);
  assert.ok(
    catchBody.indexOf("killGroup()") !== -1,
    "the post-spawn catch does not call killGroup() — the child is still leaked on every failure after the throw",
  );
  assert.ok(
    /catch\s*\(\s*e\s*\)\s*\{[^}]*throw\s+/.test(catchBody),
    "the post-spawn catch does not RE-THROW — a launch failure would be swallowed into a fake success",
  );

  // (3) The detach-time kill must survive the fix. A teardown that fires only on
  //     a FAILED launch would abandon every SUCCESSFUL launch's process on
  //     detach — the leak traded for a bigger leak.
  assert.ok(
    /on\(\s*"disconnected"\s*,\s*killGroup\s*\)/.test(bodyKept),
    "killGroup is no longer wired to the browser's `disconnected` — a successful launch's Chrome would survive its own detach",
  );

  // (4) Sanity: the kill must be idempotent/harmless when the child is already
  //     gone (a throw AFTER chrome exited early), i.e. the group kill falls back
  //     to child.kill() and swallows. Otherwise the catch itself throws and
  //     REPLACES the honest launch error with a confusing ESRCH.
  assert.ok(
    /const killGroup = \(\) => \{[\s\S]*?process\.kill\([\s\S]*?\} catch \{[\s\S]*?child\.kill\(/.test(
      body.replace(/\s+/g, " "),
    ),
    "killGroup no longer falls back to child.kill() when the process-group kill fails — the catch itself would throw",
  );
});

test("headless-degraded stays a NAMED state — a headed request with no display is never silently headless", () => {
  // The rule the brief makes non-negotiable: `UI2API_HEADED` without a display is
  // headless-degraded and must be REPORTED, never a quiet fallback. This asserts
  // the resolver's truth table against the real function (a pure resolver — it
  // launches nothing, so no browser is touched anywhere in this file) and that
  // the NAME still exists for callers to surface.
  const realDisplay = process.env.DISPLAY;
  const realWayland = process.env.WAYLAND_DISPLAY;
  const realHeaded = process.env.UI2API_HEADED;
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    process.env.UI2API_HEADED = "1";
    assert.equal(resolvedHeadless(), true, "no display + UI2API_HEADED=1 is headless (the degraded case)");
    const degraded = headlessDegradedReason();
    assert.ok(degraded !== null, "the degraded case must produce a verdict at all");
    assert.match(degraded, /headless-degraded/, "and it must be NAMED, not silent");

    process.env.UI2API_HEADED = "0";
    assert.equal(resolvedHeadless(), true, "not asked for headful -> headless, honestly not degraded");
    assert.equal(headlessDegradedReason() === null, true, "and nothing to report when headful was never requested");

    process.env.DISPLAY = ":99";
    process.env.UI2API_HEADED = "1";
    assert.equal(resolvedHeadless(), false, "a real display makes headed TRUE");
    assert.equal(headlessDegradedReason() === null, true, "and there is no degradation to name");
  } finally {
    restore("DISPLAY", realDisplay);
    restore("WAYLAND_DISPLAY", realWayland);
    restore("UI2API_HEADED", realHeaded);
  }
});
