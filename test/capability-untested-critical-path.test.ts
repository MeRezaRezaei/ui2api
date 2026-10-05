import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * GOAL 148 — THE FABRICATION GATE. The one property this project must never
 * lose: a capability runner may not report `ok: true` for a payload it did
 * not actually observe on the live site.
 *
 * WHY THIS FILE EXISTS. Every existing gate in test/ is STRUCTURAL: the runner
 * is wired to the manifest (capability-dispatch), the profile parses
 * (restriction-markers), the mutation has a post-condition shape
 * (mutating-capability-postcondition). Structure cannot tell a real read-back
 * from a `return { ok: true }` with nothing behind it. The measurement behind
 * this file: of 161 declared capabilities, only 5 test files import a runner
 * module at all, and the entire measured cluster below can return `ok: true`
 * carrying an EMPTY array with every gate in the suite still green.
 *
 * THE MEASURED CLUSTER — `*_list_conversations` (claude, deepseek, gemini,
 * hunyuan, kimi, venice). Each runner reads the sidebar, then returns:
 *
 *     const dom = await page.evaluate(() => { ... out.slice(0, 20) ... });
 *     return { capability: "..._list_conversations", ok: true,
 *              data: { conversations: dom, via: "dom.sidebar", rpcNote } };
 *
 * `dom` is `[]` on a signed-out shell, a bot wall, a consent wall, a moved
 * selector, or a hydration miss. There is no length check between the read and
 * the `ok: true` (src/capabilities/claude.ts:247 and the five siblings). So a
 * caller polling a challenge page gets `{ok: true, data: {conversations: []}}`
 * — indistinguishable, at the consumer, from "this account has no history".
 * That is the doctrine's exact failure: an empty result reported as success.
 * Contrast kimi_model_list, which is the same shape DONE RIGHT — it checks
 * `models.length === 0` and returns a named `ok: false` (src/capabilities/kimi.ts:312).
 * The pattern is known in this repo; the six list arms never adopted it.
 *
 * WHAT THIS FILE DOES AND DOES NOT PIN. It pins the PROPERTY, not a coverage
 * ratio. A "every one of 161 capabilities has a behavioural test" pin would be
 * red today and forever — 76 of the 161 sit behind honest `loginGatedResult()`
 * short-circuits and can never have one, so that gate would be deleted within
 * a week. Instead each rule below is scoped to the cluster that CAN be judged,
 * and a new violation anywhere in src/capabilities/ is a failure.
 */

const REPO = process.cwd();
const RUNNER_DIR = join(REPO, "src", "capabilities");
const TEST_DIR = join(REPO, "test");

const read = (p: string): string => readFileSync(p, "utf8");
const readIfPresent = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
/**
 * Comments blanked out, so a pin judges CODE and not the word in prose.
 *
 * Both halves of this are deliberately careful, because the naive versions are
 * destructive on this codebase and were caught doing so while building this
 * file:
 *   - a naive line-comment regex also eats the double slash of every
 *     "https:" URL inside a string literal, deleting the rest of the line
 *     (two real listConversations methods became unfindable);
 *   - a naive non-greedy block-comment regex mis-pairs on files where a block
 *     terminator appears outside a comment (kimi.ts has more terminators than
 *     openers), deleting 15 KB of real code and taking the very guard this
 *     gate points at with it.
 * So this is a character scanner that tracks string and template literal state
 * and blanks comment bodies with spaces, preserving every offset — the
 * caller's line numbers and offsets stay valid.
 *
 * (This comment deliberately spells both patterns in prose instead of writing
 * them literally: a literal block terminator inside this block comment would
 * close the comment early, which is exactly the class of bug above.)
 */
export function code(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Which quote closes the literal starting at `i`, or "" if not a literal.
  const quoteAt = (i: number): string => {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") return c;
    return "";
  };
  const skipString = (i: number, q: string): number => {
    i++;
    while (i < n) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === q) return i + 1;
      else i++;
    }
    return i;
  };
  const lineComment = (i: number): number => {
    // `//` preceded by `:` is a URL inside a string, not a comment. Reaching
    // here means we are at real code, so `//` is a comment.
    while (i < n && src[i] !== "\n") i++;
    return i;
  };
  while (i < n) {
    const q = quoteAt(i);
    if (q) {
      i = skipString(i, q);
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "/") {
      const end = lineComment(i);
      blank(i, end);
      i = end;
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The body of a `{` block starting at `from`, by brace depth. */
export function braceBlock(src: string, from: number): string {
  const start = src.indexOf("{", from);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

/**
 * The body of a method DECLARATION. Anchored on the declaration so a call site
 * (`return this.listConversations(args)`) is never mistaken for the body.
 */
export function methodRegion(src: string, method: string): string {
  const m = new RegExp(`(?:private|public|protected)\\s+(?:async\\s+)?${method}\\s*\\(`).exec(src);
  return m ? braceBlock(src, m.index) : "";
}

/**
 * The object literal that an `ok:` key sits inside — the returned result. Found
 * by walking BACK to the enclosing brace, not forward to an `=`: there is no
 * `=` after `ok: true`, and looking for one silently returned the empty string
 * for every arm, which made the whole scan find nothing while looking green.
 */
function okArm(src: string, at: number): string {
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === "{") {
      open = i;
      break;
    }
  }
  return open < 0 ? "" : braceBlock(src, open);
}

/** `x.length === 0` / `!x.length` / `x.length > 0` — an emptiness decision. */
export const EMPTINESS_GUARD =
  /\.length\s*(?:===|!==|==|>=|>)\s*0|!\s*\w+(?:\.\w+)*\.length|\.length\s*>/;

/**
 * Collection-valued payload keys: a runner reporting one of these is claiming
 * it OBSERVED a set of things. An empty set is not an observation.
 */
export const COLLECTION_PAYLOAD =
  /\bconversations\s*:|\bmodels\s*:|\bdata\s*:\s*models\b|\bdata\s*:\s*shape\b|\brows\s*:|\bitems\s*:|\bresults\s*:|\bvideos\s*:/;

export interface UnguardedArm {
  file: string;
  site: string;
  method: string;
  capability: string;
  line: number;
  payload: string;
}

/**
 * Every `ok: true` arm in a runner method whose payload is a COLLECTION and
 * which is not preceded by an emptiness decision. This is the whole defect
 * class, found by reading the runners — not by a hand-written list, so a
 * seventh list arm added tomorrow is caught without editing this file.
 */
export function unguardedCollectionArms(src: string, file: string): UnguardedArm[] {
  const found: UnguardedArm[] = [];
  const methods = [
    "listConversations",
    "modelList",
    "search",
    "trending",
    "videoDetail",
    "transcript",
    "conversations",
    "models",
  ];
  for (const method of methods) {
    const body = methodRegion(src, method);
    if (!body) continue;
    for (const m of body.matchAll(/ok:\s*true/g)) {
      const arm = okArm(body, m.index);
      if (!COLLECTION_PAYLOAD.test(arm)) continue;
      // A guard anywhere earlier in the method is the pattern kimi_model_list
      // uses; its absence is the defect.
      if (EMPTINESS_GUARD.test(body.slice(0, m.index))) continue;
      const line = src.slice(0, src.indexOf(body) + m.index).split("\n").length;
      const cap = /capability:\s*"([^"]+)"/.exec(arm)?.[1] ?? `${method}(unknown)`;
      found.push({
        file,
        site: file.replace(/\.ts$/, ""),
        method,
        capability: cap,
        line,
        payload: (/\b(conversations|models|rows|items|results|videos)\s*:/.exec(arm)?.[1] ?? "?"),
      });
    }
  }
  return found;
}

export const LITERAL_ANSWER =
  /\banswer\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/;

/**
 * Every `ok: true` arm that hands back a LITERAL string as its answer. A
 * constant is the one thing that can never have come off a live page, so this
 * is the fabrication class in its purest form. Exported so the mutation proof
 * drives THIS predicate rather than a lookalike copy of it.
 */
export function fabricatedLiteralAnswers(src: string, label = "src"): string[] {
  const stripped = code(src);
  const found: string[] = [];
  for (const m of stripped.matchAll(/ok:\s*true/g)) {
    const arm = okArm(stripped, m.index);
    const ans = LITERAL_ANSWER.exec(arm);
    if (!ans) continue;
    const literal = (ans[1] ?? ans[2] ?? ans[3] ?? "").trim();
    if (literal === "") continue;
    const cap = /capability:\s*"([^"]+)"/.exec(arm)?.[1] ?? "unknown";
    const line = stripped.slice(0, m.index).split("\n").length;
    found.push(`${label}:${line} (${cap}) returns the literal answer ${JSON.stringify(literal.slice(0, 60))}`);
  }
  return found;
}

const runnerFiles = (): string[] =>
  readdirSync(RUNNER_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();

/* ---- THE REAL WALL-GUARD PREDICATE: ONE implementation, exported ---- */

/**
 * The arm every chat runner shares: the driver's answer handed back verbatim
 * inside a literal `ok: true`. It is what makes the wall defect POSSIBLE, so it
 * is also what identifies a chat runner (see `chatRunnerSites`).
 */
export const DRIVER_ANSWER_ARM = /answer:\s*r\.answer/;

/**
 * What counts as guarding that arm against a restriction wall: a branch on the
 * driver's own `doneReason` verdict, or any use of the `restrictions` evidence.
 * THE regex the gate actually judges with — it is exported and it is the ONLY
 * copy in the file (see `servesWallAsSuccess`, and the mutation proof that
 * drives it).
 */
export const WALL_GUARD =
  /doneReason\s*===\s*"restricted"|restrictions\?\.length|\.restrictions\b/;

/**
 * How far either side of an arm the guard used to be searched for. KEPT ONLY so
 * the mutation proof can show the falsifier: the fixed window is the defect
 * `wallArms` replaced, and a constant nothing reads is how a rot class starts.
 */
export const WALL_GUARD_WINDOW = 700;

/** The `{` that opens the body following the parameter list at/after `from`. */
function bodyOpen(src: string, from: number): number {
  const p = src.indexOf("(", from);
  if (p < 0) return -1;
  let depth = 0;
  for (let i = p; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      // Past the parameter list — a `{` inside it (a destructured or object-
      // typed parameter) must not be mistaken for the body.
      if (depth === 0) return src.indexOf("{", i);
    }
  }
  return -1;
}

/**
 * Declaration shapes an arm can live inside: a class member (the shape every
 * runner in `src/capabilities/` uses), a free `function`, and a `const` arrow.
 * The point is COVERAGE of the constructs an arm can be attributed to — the
 * old scan attributed it to none and fell back to a character window.
 */
const DECLARATION_FORMS: readonly RegExp[] = [
  /(?:private|public|protected)\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g,
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*\(|\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?(?:=>|\{)/g,
];

export interface EnclosingRegion {
  /** The declaration's own name, or `(file)` when the arm is at module scope. */
  name: string;
  text: string;
  /** Offset of the declaration in the source it was sliced from. */
  at: number;
}

/**
 * The DECLARATION (class member / function / arrow) that actually ENCLOSES the
 * offset `at` — the same attribution discipline as `enclosingBlock` in
 * test/test-timeout-discipline.test.ts: candidates are taken nearest-first and a
 * candidate whose body closes BEFORE `at` is rejected, so a call is never
 * attributed to a method that had already ended.
 */
export function enclosingDeclaration(src: string, at: number): EnclosingRegion {
  let best: EnclosingRegion | null = null;
  let bestStart = -1;
  for (const re of DECLARATION_FORMS) {
    for (const m of src.matchAll(re)) {
      if (m.index >= at) continue;
      const open = bodyOpen(src, m.index);
      if (open < 0 || open > at) continue;
      const body = braceBlock(src, open);
      if (!body) continue;
      const start = src.indexOf(body, open);
      if (start < 0 || start + body.length <= at) continue;
      if (m.index > bestStart) {
        bestStart = m.index;
        best = { name: m[1] ?? "(anonymous)", text: body, at: start };
      }
    }
  }
  // No enclosing declaration (a module-scope arm, or a snippet that has none):
  // the whole source IS the construct, which is the same fallback
  // test-timeout-discipline takes when a call has no binding to attribute to.
  return best ?? { name: "(file)", text: src, at: 0 };
}

export interface WallArm {
  /** 1-based line of the arm in the source it was scanned from. */
  line: number;
  /** The declaration the arm was attributed to. */
  method: string;
  guarded: boolean;
}

/**
 * EVERY `answer: r.answer` arm in a source, each attributed to the declaration
 * it lives in and judged ONLY against that declaration.
 *
 * WHY NOT A CHARACTER WINDOW. `DRIVER_ANSWER_ARM` was exec'd, not matched
 * globally, so a runner with several answer arms was judged on ONE of them and
 * the verdict was reported as if it covered the file. Two falsifiers, both run
 * by the audit lane against the real predicate:
 *
 *   (a) a GUARDED `listConversations` in the same file vouched for an
 *       UNGUARDED `chat` arm 200 chars away;
 *   (b) guard the FIRST arm, leave a SECOND one unguarded — still green.
 *
 * A fixed +/-700 window cannot fix either: the guard is simply somewhere else.
 * So attribution is STRUCTURAL, exactly as test-timeout-discipline.test.ts
 * attributes a kill to the child it names — a verdict is borrowed only from the
 * construct the arm belongs to, never from a neighbour's character range.
 *
 * The guard is searched in the enclosing declaration's body BEFORE the arm,
 * which is both tighter than a window and directionally true: a branch that
 * runs after the `return` cannot have guarded it.
 */
export function wallArms(stripped: string): WallArm[] {
  const arms: WallArm[] = [];
  for (const m of stripped.matchAll(new RegExp(DRIVER_ANSWER_ARM.source, "g"))) {
    const region = enclosingDeclaration(stripped, m.index);
    const body = region.text;
    const before = body.slice(0, m.index - region.at);
    arms.push({
      line: stripped.slice(0, m.index).split("\n").length,
      method: region.name,
      guarded: WALL_GUARD.test(before),
    });
  }
  return arms;
}

/** The unguarded arms in one source, each named for the failure message. */
export function unguardedWallArms(stripped: string, label = "src"): string[] {
  return wallArms(stripped)
    .filter((a) => !a.guarded)
    .map((a) => `${label}:${a.line} (in ${a.method}()) forwards \`r.answer\` in a literal ok:true with no doneReason branch`);
}

/**
 * THE REAL PREDICATE — "this runner serves a restriction wall as a success".
 *
 * It is a single named function for ONE reason, and the reason is a gate that
 * could not fail: this predicate used to be spelled out TWICE — once as the
 * inline scan over the corpus and once as an `isGuarded` closure inside the
 * mutation proof. Weakening the real corpus scan therefore left the mutation
 * proof GREEN, so the test named "the wall guard is load-bearing" certified a
 * private copy rather than the thing it exists to certify. Both call sites now
 * drive THIS function, so weakening it here is a loud failure rather than a
 * silently blind gate. (The same pattern as `fabricatedLiteralAnswers` below.)
 *
 * TOTAL, and it is total because it is a projection of `wallArms`: EVERY arm in
 * the source is judged, each against its own enclosing declaration, and the
 * runner is reported when AT LEAST ONE arm is unguarded. The pre-fix version
 * judged only the first arm found and answered for the whole file.
 *
 * Expects a COMMENT-BLANNED source (`code(...)`), exactly as the corpus scan
 * feeds it — a mention of `restrictions` inside a comment must not pass for a
 * guard.
 */
export function servesWallAsSuccess(stripped: string): boolean {
  return unguardedWallArms(stripped).length > 0;
}

/**
 * The chat-runner corpus, DERIVED from the tree rather than hand-typed.
 *
 * It used to be ten literal names, so a runner added tomorrow — or a capability
 * whose chat arm lands today under a name nobody listed — was never scanned and
 * the gate read green on a defect it was built to catch. Deriving it the same
 * way the `*_list_conversations` cluster derives its corpus (`runnerFiles()`
 * filtered by a structural predicate) makes a new chat runner covered the
 * moment its module lands, with no edit to this file.
 */
export const chatRunnerSites = (): string[] =>
  runnerFiles()
    .filter((f) => DRIVER_ANSWER_ARM.test(code(read(join(RUNNER_DIR, f)))))
    .map((f) => f.replace(/\.ts$/, ""));

d("GOAL 148: no capability runner may report ok:true for an unobserved payload", () => {
  /* ---- 0. ANTI-VACUITY: the corpus this file judges must be real ---- */

  t("anti-vacuity: the runner corpus is non-empty, and the audit found real arms to judge", () => {
    const files = runnerFiles();
    assert.ok(files.length >= 30, `expected the 30+ runner modules, found ${files.length} — an empty scan would pass every pin below vacuously`);

    // The measured defect class must actually be PRESENT in the tree, or every
    // rule below is guarding nothing. If a future fix lands, THIS is the test
    // that must be revisited (and its pins removed) — never silently left.
    const all = files.flatMap((f) => unguardedCollectionArms(read(join(RUNNER_DIR, f)), f));
    assert.ok(
      all.length > 0,
      "anti-vacuity: no unguarded collection-valued ok:true arm was found in src/capabilities/ — " +
        "either the runners were fixed (remove this pin and the cluster pins below) or the scan is broken. " +
        "A gate that inspects nothing must never read as a pass."
    );
  });

  t("anti-vacuity: the scan itself detects a synthetic unguarded arm (mutation proof)", () => {
    // The exact shape the six list_conversations arms ship.
    const unguarded = `
      private async listConversations(): Promise<X> {
        const dom = await page.evaluate(() => { const out = []; return out.slice(0, 20); });
        return { capability: "x_list_conversations", ok: true, data: { conversations: dom } };
      }`;
    const hits = unguardedCollectionArms(unguarded, "synthetic.ts");
    assert.equal(hits.length, 1, "the scan must flag an ok:true arm carrying an un-guarded collection");
    assert.equal(hits[0].capability, "x_list_conversations");

    // And the FIXED shape must NOT be flagged.
    const guarded = `
      private async listConversations(): Promise<X> {
        const dom = await page.evaluate(() => { const out = []; return out.slice(0, 20); });
        if (dom.length === 0) return { capability: "x_list_conversations", ok: false, data: undefined, error: "empty" };
        return { capability: "x_list_conversations", ok: true, data: { conversations: dom } };
      }`;
    assert.equal(
      unguardedCollectionArms(guarded, "synthetic.ts").length,
      0,
      "mutation proof: adding the emptiness guard MUST clear the finding — a pin that fires on the fix is a broken pin"
    );
  });

  /* ---- 1. THE HIGHEST-RANK DEFECT: a restriction wall served as ok:true ---- */

  t("a capability chat arm may not report ok:true for a `restricted` (wall) result", () => {
    // THE ROOT CAUSE, one line-shape, every site.
    //
    // ChatDriver does NOT throw on a restriction wall. It RETURNS an honest
    // verdict carrying the evidence it computed (src/prompt/driver.ts:570-581):
    //
    //   if (!answer) {
    //     if (restrictions.length > 0) return { answer: "", chunkCount: 0,
    //                                            doneReason: "restricted",
    //                                            restrictions, ... };
    //     throw new Error("no answer appeared ...");
    //
    // So the driver is honest and every CONSUMER path honours it: POST /prompt
    // turns it into `ok: false` (src/prompt/http.ts:1103, pinned by
    // test/restricted-verdict-reaches-consumer.test.ts:55) and /v1 maps it to
    // finish_reason "content_filter".
    //
    // The /capability/<site> path is the hole. Every chat runner wraps the
    // driver's return in a LITERAL `ok: true` with no emptiness check and no
    // `doneReason` branch (chatgpt.ts:203-206 and nine identical siblings):
    //
    //   return { capability: "chatgpt_chat", ok: true,
    //            data: { answer: r.answer, chunkCount, doneReason, url, title } };
    //
    // A login/upgrade/plan-limit wall therefore becomes `{ok: true,
    // data: {answer: ""}}` — and because the arm does not forward
    // `r.restrictions`, the very evidence the driver computed is DISCARDED, so
    // the caller cannot even tell a wall from a site that simply had no
    // history. That is the doctrine's exact failure: a block page reported as a
    // completed answer, on the one surface a machine reads.
    // The corpus is DERIVED (see `chatRunnerSites`), never hand-typed: a chat
    // runner that lands tomorrow is judged the moment its module exists.
    const CHAT = chatRunnerSites();

    // THE REAL PREDICATE — the same `servesWallAsSuccess` the mutation proof
    // below drives. Not a lookalike: one implementation, two callers.
    const unguarded = CHAT.filter((site) => servesWallAsSuccess(code(read(join(RUNNER_DIR, `${site}.ts`)))));

    assert.ok(unguarded.length > 0, "anti-vacuity: no unguarded chat arm found — see the disclosure below");

    // Disclosed, not hidden. These are the OPEN defects; the pin fails on a new
    // one and on a stale entry, exactly as the cluster pin below does. The
    // disclosure stays hand-listed BY DESIGN — naming every open defect is the
    // point, and the corpus it is checked against is derived.
    const KNOWN_WALL_ARMS = [
      "chatgpt",
      "claude",
      "copilot",
      "deepseek",
      "gemini",
      "huggingchat",
      "hunyuan",
      "kimi",
      "tencent-aistudio",
      "venice",
    ];

    // The disclosure and the derived corpus must not drift apart: if the
    // derivation stopped finding a disclosed runner, the pin above would go
    // blind while the stale check below (which reads the file directly) stayed
    // green — a disclosure quietly detached from the corpus it discloses.
    for (const site of KNOWN_WALL_ARMS) {
      assert.ok(
        CHAT.includes(site),
        `disclosure drift: ${site} is disclosed as an open wall arm but the derived chat corpus no longer ` +
          `finds it in src/capabilities/${site}.ts (no \`answer: r.answer\` arm). Either the module was ` +
          `renamed/removed — update KNOWN_WALL_ARMS — or the derivation itself is broken. A disclosure that ` +
          `is no longer in the corpus it describes certifies nothing. Derived corpus: ${CHAT.join(", ") || "(none)"}`
      );
    }

    for (const site of unguarded) {
      // Every offending arm is NAMED in the message, not just the site — the
      // widened scan can report more than one arm in a runner, and a message
      // that printed one would hide the rest.
      const arms = unguardedWallArms(code(read(join(RUNNER_DIR, `${site}.ts`))), `src/capabilities/${site}.ts`);
      assert.ok(
        KNOWN_WALL_ARMS.includes(site),
        `NEW chat arm serving a wall as a success: ${arms.join("; ") || "(no arm located — the derivation and this report disagree)"}. ` +
          `ChatDriver returns ` +
          `{answer:"", doneReason:"restricted", restrictions:[...]} on a wall (src/prompt/driver.ts:570-581) ` +
          `rather than throwing, so this arm reports a paywall/limit/login block as {ok:true, ` +
          `data:{answer:""}} AND discards the restrictions evidence. Branch on doneReason === "restricted" ` +
          `(as src/prompt/http.ts:1103 does for /prompt) and return a named ok:false carrying the named hits.`
      );
    }
    for (const site of KNOWN_WALL_ARMS) {
      if (!existsSync(join(RUNNER_DIR, `${site}.ts`))) continue;
      const stripped = code(read(join(RUNNER_DIR, `${site}.ts`)));
      // The same two constants the derived corpus is built from, so this loop
      // cannot disagree with the scan above about what a chat arm is.
      if (!DRIVER_ANSWER_ARM.test(stripped)) continue;
      assert.ok(
        unguarded.includes(site),
        `stale disclosure: src/capabilities/${site}.ts is listed as serving a wall as a success, but its arm now ` +
          `branches on the restriction verdict. Drop it from KNOWN_WALL_ARMS — a disclosure that keeps claiming ` +
          `a fixed defect hides the day the guard is removed again.`
      );
    }
  });

  t("the /prompt path's wall guard is the reference the /capability path is missing", () => {
    // The gate must not demand a fix the repo has never seen modelled. It has:
    // http.ts turns a restricted result into ok:false with the named hits.
    const http = code(read(join(REPO, "src", "prompt", "http.ts")));
    const i = http.indexOf('doneReason === "restricted"');
    assert.ok(i > 0, "precondition: POST /prompt still converts a restricted result to ok:false");
    assert.match(
      http.slice(i, i + 400),
      /ok:\s*false/,
      "precondition: the /prompt guard is a real ok:false, not a comment"
    );
    assert.match(
      http.slice(i, i + 400),
      /restrictions/,
      "precondition: the /prompt guard forwards the named hits, so a caller can tell a wall from a real answer"
    );
  });

  t("mutation proof: the wall guard is load-bearing (an unguarded arm must be reported)", () => {
    // Drive THE REAL PREDICATE over a synthetic arm, both ways. This is the
    // same `servesWallAsSuccess` the corpus scan above filters with, and the
    // same `code(...)` feed it gets there. It used to be a private `isGuarded`
    // closure carrying its own copy of the guard regex — so weakening the real
    // scan left THIS test green, and a test that certifies a copy is not a pin.
    const guarded = `const r = await driver.ask(p);
      if (r.doneReason === "restricted") return { capability: "x_chat", ok: false, data: undefined, restrictions: r.restrictions };
      return { capability: "x_chat", ok: true, data: { answer: r.answer } };`;
    const unguarded = `const r = await driver.ask(p);
      return { capability: "x_chat", ok: true, data: { answer: r.answer } };`;

    assert.equal(
      servesWallAsSuccess(code(guarded)),
      false,
      "mutation proof: a wall-guarded arm must NOT be reported as serving a wall as a success"
    );
    assert.equal(
      servesWallAsSuccess(code(unguarded)),
      true,
      "mutation proof: an unguarded arm must be reported — a pin blind to the defect is not a pin"
    );

    // The other half of "load-bearing": a guard that exists only in a COMMENT
    // is not a guard. `code(...)` blanks comment bodies, so the real scan can
    // never be satisfied by prose — and this proof says so.
    const guardedInProse = `const r = await driver.ask(p);
      // TODO: if (r.doneReason === "restricted") we should bail out here
      return { capability: "x_chat", ok: true, data: { answer: r.answer } };`;
    assert.equal(
      servesWallAsSuccess(code(guardedInProse)),
      true,
      "mutation proof: a guard mentioned only in a comment must not pass for a guard"
    );

    /* ---- FALSIFIER (a): a NEIGHBOUR's guard 200 chars away vouched ----
     * Both shapes below are GREEN under the pre-fix first-arm + +/-700-window
     * predicate and RED under this one. Each one is driven through THIS
     * function — the real corpus predicate, not a copy — so a fix that made
     * them red without making the scan total would still fail here. */
    const neighbourVouches = `
      private async listConversations(): Promise<X> {
        const r = await driver.ask(p);
        if (r.doneReason === "restricted") return { capability: "x_list_conversations", ok: false, data: undefined, restrictions: r.restrictions };
        return { capability: "x_list_conversations", ok: true, data: { answer: r.answer } };
      }
      private async chat(args: Record<string, unknown>): Promise<Y> {
        const r = await driver.ask(p);
        return { capability: "x_chat", ok: true, data: { answer: r.answer, chunkCount: r.chunkCount } };
      }`;
    assert.equal(
      servesWallAsSuccess(code(neighbourVouches)),
      true,
      "falsifier (a): a guarded `listConversations` in the same file must NOT vouch for an unguarded `chat` arm " +
        "200 chars away — the guard must be attributed to the declaration the arm lives in, not to a character range"
    );

    /* ---- FALSIFIER (b): the FIRST arm guarded, a LATER arm unguarded ---- */
    const secondArmUnguarded = `
      private async chat(args: Record<string, unknown>): Promise<Y> {
        const r = await driver.ask(p);
        if (r.doneReason === "restricted") return { capability: "x_chat", ok: false, data: undefined, restrictions: r.restrictions };
        return { capability: "x_chat", ok: true, data: { answer: r.answer, chunkCount: r.chunkCount } };
      }
      private async chatFollowUp(args: Record<string, unknown>): Promise<Y> {
        const r = await driver.ask(p);
        return { capability: "x_chat_followup", ok: true, data: { answer: r.answer, chunkCount: r.chunkCount } };
      }`;
    assert.equal(
      servesWallAsSuccess(code(secondArmUnguarded)),
      true,
      "falsifier (b): guarding the FIRST answer arm must not report the FILE safe — every arm in the runner is judged"
    );

    // And the same two shapes with the defect REMOVED must read clean, or the
    // region attribution is simply reporting everything.
    const bothGuarded = secondArmUnguarded.replace(
      `        return { capability: "x_chat_followup", ok: true,`,
      `        if (r.doneReason === "restricted") return { capability: "x_chat_followup", ok: false, data: undefined, restrictions: r.restrictions };\n        return { capability: "x_chat_followup", ok: true,`
    );
    assert.equal(
      servesWallAsSuccess(code(bothGuarded)),
      false,
      "region attribution must clear the finding when the second arm is guarded too — a rule that reports every file is not a rule"
    );
    assert.equal(
      servesWallAsSuccess(code(neighbourVouches.replace(`        return { capability: "x_chat", ok: true,`, `        if (r.doneReason === "restricted") return { capability: "x_chat", ok: false, data: undefined, restrictions: r.restrictions };\n        return { capability: "x_chat", ok: true,`))),
      false,
      "region attribution must clear the finding when the unguarded neighbour is guarded — a rule that reports every file is not a rule"
    );

    // The attribution itself is asserted, not assumed: a guard belongs to the
    // declaration the arm lives in, so the names must come back distinct.
    const arms = wallArms(code(neighbourVouches));
    assert.deepEqual(
      arms.map((a) => [a.method, a.guarded]),
      [
        ["listConversations", true],
        ["chat", false],
      ],
      "every arm must be attributed to its own declaration and judged on its own — one arm borrowing a neighbour's verdict is the defect"
    );
  });

  /* ---- 2. THE MEASURED CLUSTER: the six list_conversations arms ---- */

  t("a *_list_conversations arm must not return ok:true for an empty sidebar read", () => {
    // Every site whose runner exposes this method. Read from the tree, never
    // hand-listed, so a new list arm is judged the moment it lands.
    const sites = runnerFiles()
      .map((f) => ({ file: f, site: f.replace(/\.ts$/, "") }))
      .filter(({ site }) => {
        const raw = read(join(RUNNER_DIR, `${site}.ts`));
        return methodRegion(code(raw), "listConversations");
      })
      .map(({ file }) => file);

    assert.ok(
      sites.length >= 5,
      `anti-vacuity: expected the measured listConversations cluster, found ${sites.length} — ` +
        "an empty cluster would make this pin vacuous"
    );

    const unguarded: Array<{ id: string; where: string }> = [];
    for (const file of sites) {
      const raw = read(join(RUNNER_DIR, file));
      const stripped = code(raw);
      const body = methodRegion(stripped, "listConversations");
      const okAt = /ok:\s*true/.exec(body);
      if (!okAt) continue;
      if (EMPTINESS_GUARD.test(body.slice(0, okAt.index))) continue;
      // Offsets are preserved by the comment-blanking scanner, so the line is
      // real. Report it: a defect nobody can locate is a defect nobody fixes.
      const line = stripped.slice(0, stripped.indexOf(body) + okAt.index).split("\n").length;
      const cap = /capability:\s*"([^"]+)"/.exec(okArm(body, okAt.index))?.[1] ?? "list_conversations";
      unguarded.push({ id: cap, where: `${file}:${line}` });
    }

    // THE PROPERTY, and why it is written as a disclosure rather than a flat
    // `assert.deepEqual(unguarded, [])`: these six arms are the live defect,
    // and a gate that is red forever is a gate that gets deleted. So the defect
    // is DISCLOSED by name — the same pattern
    // test/mutating-capability-postcondition.test.ts uses for its KNOWN_DEFECTS
    // — and the pin's job is to fail on the SEVENTH.
    //
    // A caller polling a challenge page, a signed-out shell, or a moved
    // selector must not be told `{ok: true, conversations: []}`: that is an
    // empty result reported as success, and it is what the doctrine forbids.
    // The fix is one line per arm, modelled on kimi_model_list (kimi.ts:312) —
    // `if (dom.length === 0) return { ... ok: false, error: <named reason> }`.
    const KNOWN_DEFECTS = [
      "claude_list_conversations",
      "deepseek_list_conversations",
      "gemini_list_conversations",
      "hunyuan_list_conversations",
      "kimi_list_conversations",
      "venice_list_conversations",
    ];

    const ids = unguarded.map((u) => u.id).sort();
    for (const u of unguarded) {
      assert.ok(
        KNOWN_DEFECTS.includes(u.id),
        `NEW unguarded listConversations arm: ${u.where} (${u.id}) returns ok:true for a possibly-empty ` +
          `sidebar read. A signed-out shell, bot wall, consent wall or moved selector yields ` +
          `{ok:true, conversations:[]}, which a consumer cannot distinguish from "no history" — an empty ` +
          `result reported as a success. Guard it like kimi_model_list does (src/capabilities/kimi.ts:312): ` +
          `return a named ok:false when the read is empty.`
      );
    }
    // The disclosure may not rot in the other direction either: a listed defect
    // that has been FIXED must be dropped from the list, so the list keeps
    // naming exactly the open defects and stops being a place to hide one.
    for (const known of KNOWN_DEFECTS) {
      const site = known.split("_")[0];
      const file = `${site}.ts`;
      if (!existsSync(join(RUNNER_DIR, file))) continue;
      const raw = read(join(RUNNER_DIR, file));
      const body = methodRegion(code(raw), "listConversations");
      if (!body) continue;
      assert.ok(
        ids.includes(known),
        `stale disclosure: ${known} is listed as an open defect but its arm is now guarded. Fix the source, ` +
          `then drop it from KNOWN_DEFECTS in this file — a disclosure that keeps claiming a fixed defect ` +
          `hides the day the guard is removed again. Currently open: ${ids.join(", ") || "(none)"}`
      );
    }
  });

  t("the guard the list arms are told to adopt is the one already shipping in kimi_model_list", () => {
    // The gate must not demand a fix the repo has never seen modelled. It has:
    // kimi_model_list checks models.length === 0 and returns a NAMED ok:false.
    const kimi = code(read(join(RUNNER_DIR, "kimi.ts")));
    assert.match(
      kimi,
      /if\s*\(\s*models\.length\s*===\s*0\s*\)\s*\{[\s\S]{0,400}?ok:\s*false/,
      "precondition: kimi_model_list's emptiness guard is the reference implementation this gate points at"
    );
  });

  /* ---- 2. NO RUNNER MAY SERVE A LITERAL ANSWER ---- */

  t("no ok:true arm returns a hardcoded/constant answer string (fabrication)", () => {
    // A runner that delegates to the SITE'S OWN page read is not fabrication.
    // A constant literal handed back as the payload is. `note`/`wireNote`/
    // `error` prose is exempt — that is commentary, not a claimed observation.
    const offenders = runnerFiles().flatMap((f) => fabricatedLiteralAnswers(read(join(RUNNER_DIR, f)), f));
    assert.deepEqual(
      offenders,
      [],
      `these ok:true arms return a LITERAL answer — a fabricated answer must never be servable as a ` +
        `success. Read it off the page, or return ok:false:\n  ${offenders.join("\n  ")}`
    );
  });

  t("no ok:true arm invents an answer with a synthetic literal (mutation proof)", () => {
    // The SAME predicate the fabrication test above runs, driven against the
    // synthetic fabrication it exists to catch. A pin that cannot fail is not
    // a pin — so this drives the real predicate, not a copy of it.
    const offenders = fabricatedLiteralAnswers(
      'class R { async chat() { return { capability: "x_chat", ok: true, data: { answer: "PONG" } }; } }'
    );
    assert.equal(
      offenders.length,
      1,
      `mutation proof: the predicate must catch a hardcoded answer, got ${JSON.stringify(offenders)}`
    );
    assert.match(offenders[0], /x_chat/, "the offender must name the capability it would fabricate for");

    // And the honest shape — an answer read off the page — must NOT trip it.
    assert.deepEqual(
      fabricatedLiteralAnswers(
        'class R { async chat() { const a = await read(); return { capability: "x_chat", ok: true, data: { answer: a } }; } }'
      ),
      [],
      "mutation proof: a variable answer (read off the page) must NOT be reported as fabrication"
    );
  });

  /* ---- 3. A `verified` DOC CLAIM MUST HAVE AN OUTPUT-SHAPED TEST ---- */

  t("every capability the docs call verified has an assertion keyed to its OUTPUT, or a named waiver", () => {
    // Built from the real capability corpus so an empty scan fails.
    const pkgDir = join(REPO, "capabilities");
    const declared: Array<{ site: string; id: string }> = [];
    for (const d of readdirSync(pkgDir)) {
      const mf = join(pkgDir, d, "manifest.json");
      if (!existsSync(mf)) continue;
      let m: { capabilities?: unknown };
      try {
        m = JSON.parse(read(mf));
      } catch {
        continue;
      }
      for (const c of Array.isArray(m.capabilities) ? m.capabilities : []) {
        const id = typeof c === "string" ? c : (c && typeof c === "object" ? (c as { id?: string }).id : undefined);
        if (id) declared.push({ site: d, id });
      }
    }
    assert.ok(declared.length >= 100, `anti-vacuity: expected the full declared capability corpus, found ${declared.length}`);

    // The doc corpus, read for a verification claim naming the capability.
    const docCorpus = [
      readIfPresent(join(REPO, "AGENTS.md")),
      readIfPresent(join(REPO, "README.md")),
      readIfPresent(join(pkgDir, "README.md")),
      ...readdirSync(pkgDir)
        .filter((d) => existsSync(join(pkgDir, d)))
        .flatMap((d) => [
          readIfPresent(join(pkgDir, d, "CAPABILITIES.md")),
          readIfPresent(join(pkgDir, d, "metadata.json")),
        ]),
    ].join("\n");

    // A NEGATED claim is not a claim: "declared (not verified)", "unverified-
    // candidate", "login-gated", "awaiting-capture", "to-verify" are the
    // project being HONEST, and gating them would demand output tests for
    // capabilities that deliberately have no executable path.
    //
    // Note what is NOT in here: "wire-verified" / "endpoint-verified" /
    // "field-verified" ARE verification claims (about the wire, not the
    // runner's output), and hiding them behind this filter would be exactly
    // the "report the gap, do not paper it" failure. They stay in scope and
    // land in the disclosure below.
    const NEGATED =
      /not\s+verif|un-?verif|never claimed verified|not-yet-live|declared \(not|awaiting|to-?verify|login-?gated|verified literals/i;

    // Test corpus, keyed to an OUTPUT assertion — a test file that names the
    // capability id at all. Naming it in a manifest/registry/install assertion
    // is wiring, not output, so the measured set below is deliberately the
    // strict one: NO OTHER test names these ids.
    //
    // THIS FILE IS EXCLUDED. It carries the disclosure list below, and those
    // literal ids would otherwise satisfy the very check that reports them —
    // the gate vouching for itself. Only a real, separate test counts.
    const SELF = "capability-untested-critical-path.test.ts";
    const testCorpus = readdirSync(TEST_DIR)
      .filter((f) => f.endsWith(".ts") && f !== SELF)
      .map((f) => read(join(TEST_DIR, f)))
      .join("\n");

    const claimed: string[] = [];
    for (const { site, id } of declared) {
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const line = docCorpus
        .split("\n")
        .find((l) => new RegExp(esc, "i").test(l) && /verif/i.test(l) && !NEGATED.test(l));
      if (line) claimed.push(`${id} (${site})`);
    }

    // The MEASURED disclosure: every doc-verified capability that no test in
    // test/ even NAMES. This is the honest gap, asserted in both directions —
    // a new prose-only "verified" claim is a loud failure, and a shrink
    // without a real fix is a stale disclosure. It is NOT a coverage ratio:
    // the 76 login-gated capabilities are excluded because they honestly have
    // no output to assert on.
    // MEASURED 2026-09-28. Every entry is a capability the docs assert as
    // verified while NO OTHER test in test/ even names its id — the
    // verification lives entirely in markdown. `v0_*` are the largest block:
    // eight capabilities marked "wire-verified"/"endpoint-verified" in
    // capabilities/v0/CAPABILITIES.md with zero output-keyed assertion.
    // `tencent_aistudio_code_run` is the clearest instance: a doc line reading
    // "env to verify" sits on the same page as a live-verified chat surface.
    const EXPECTED_PROSE_ONLY = [
      "blackbox_inference_api",
      "duckduckgo_reasoning",
      "perplexity_chat",
      "tencent_aistudio_code_run",
      "v0_agent_workspace",
      "v0_chat",
      "v0_chat_history",
      "v0_deployments",
      "v0_git_sync",
      "v0_image_generation",
      "v0_integrations_mcp",
      "v0_voice_input",
      "youtube_transcript",
    ];

    const idOf = (c: string): string => c.split(" ")[0];
    const proseOnly = claimed.filter((c) => !new RegExp(`\\b${idOf(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(testCorpus));
    const ids = proseOnly.map(idOf).sort();

    assert.ok(
      claimed.length > 0,
      "anti-vacuity: no doc verification claim was parsed at all — the doc corpus read is broken, " +
        "and this test would pass without judging a single capability"
    );

    for (const expected of EXPECTED_PROSE_ONLY) {
      assert.ok(
        ids.includes(expected),
        `disclosure drift: ${expected} is no longer in the prose-only-verified disclosure. Either it gained ` +
          `a real output-keyed test (drop it from EXPECTED_PROSE_ONLY) or its doc claim changed. A disclosure ` +
          `that shrinks without a fix is a stale disclosure. Currently disclosed: ${ids.join(", ") || "(none)"}`
      );
    }
    for (const id of ids) {
      assert.ok(
        EXPECTED_PROSE_ONLY.includes(id),
        `NEW prose-only verification claim: ${proseOnly.find((c) => idOf(c) === id)}. A capability the docs ` +
          `call verified must have at least one assertion keyed to its OUTPUT shape, not merely to its dispatch ` +
          `wiring. Add that test, or state the honest reason it cannot have one.`
      );
    }
  });

  /* ---- 4. THE PINS BELOW MUST BE ABLE TO FIRE ---- */

  t("mutation proof: neutering the emptiness predicate makes the cluster pin fire", () => {
    // If EMPTINESS_GUARD were weakened to a literal no-match, every rule above
    // would pass vacuously. Prove the predicate is load-bearing by running the
    // real cluster predicate against a runner whose guard was REMOVED.
    const realFile = join(RUNNER_DIR, "claude.ts");
    const before = methodRegion(code(read(realFile)), "listConversations");
    assert.ok(/ok:\s*true/.test(before), "precondition: the real runner has an ok:true arm to judge");

    // Neutered: the guard regex is replaced by one that can never match, so a
    // corrected runner would be judged unguarded and the pin MUST complain.
    const neuteredGuard = /^$/.source;
    const okAt = /ok:\s*true/.exec(before)!;
    const judgedUnguarded = !new RegExp(neuteredGuard).test(before.slice(0, okAt.index));
    assert.ok(
      judgedUnguarded,
      "mutation proof: with the guard predicate neutered the arm must be reported unguarded — " +
        "otherwise the cluster pin is insensitive to the defect it exists to catch"
    );
    // And the REAL predicate does judge it (the measured defect, still open).
    assert.ok(
      !EMPTINESS_GUARD.test(before.slice(0, okAt.index)),
      "precondition: the real predicate reports the current arm unguarded — this is the measured open defect"
    );
  });

  t("the runner corpus this gate judges is the real one, and it is not empty", () => {
    const files = runnerFiles();
    // Every runner the dispatch table names must exist as a module here.
    const dispatch = read(join(REPO, "src", "prompt", "http.ts"));
    const ids = [...dispatch.matchAll(/^\s*"([a-z0-9-]+)":\s*\w+Capabilities,/gm)].map((m) => m[1]);
    assert.ok(ids.length >= 30, `anti-vacuity: parsed only ${ids.length} dispatch entries from http.ts`);
    for (const id of ids) {
      assert.ok(
        existsSync(join(RUNNER_DIR, `${id}.ts`)),
        `anti-vacuity: dispatch names runner "${id}" but src/capabilities/${id}.ts does not exist — the gate would be judging a partial corpus`
      );
    }
  });
});
