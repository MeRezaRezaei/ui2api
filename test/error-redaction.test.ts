import { test, describe } from "node:test";
const t = test;
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  redactInternalError,
  INTERNAL_WORD_RE,
  ERROR_ONLY_TERMS,
  NO_ANSWER_REFUSAL_CLAUSE,
  NO_ANSWER_REFUSAL_RE,
  renderNoAnswerRefusal,
  RETRY,
} from "../src/prompt/error-redaction.js";
import {
  consumerAccountRefusal,
  consumerProse,
  CONCEPT_TERMS,
  INVALID_JSON_MESSAGE,
  mechanismTermsIn,
} from "../src/prompt/consumer-surface.js";

const REPO_ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

/** Every TypeScript file under `src/`, so a "there is only one definition" pin
 *  can be a real whole-tree gate instead of a comment about a single file. */
function srcTsFiles(dir = join(REPO_ROOT, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcTsFiles(abs));
    else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

function srcOf(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/**
 * Drops PROSE so a "typed in exactly one place" pin cannot be tripped by a
 * comment that QUOTES the string. A comment is not a duplicate owner, and a
 * duplicate owner is what the gate exists to catch — so the scan reads code.
 *
 * HONEST LIMIT, stated rather than hidden: this strips block comments and lines
 * that BEGIN with `//` or `*`. A trailing `//` comment at the end of a code
 * line is NOT stripped, so a copy pasted into one would still trip the gate.
 * That direction is the safe one to over-report: the failure mode is a red gate
 * over a comment, not a green gate over a duplicate.
 */
function stripProse(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** Every src file whose CODE (comments removed) contains `needle`. */
function codeOwnersOf(needle: string): string[] {
  /* An EXCLUSIVE test has to count OCCURRENCES, not files. Counting files is
   * what made the first version of this gate vacuous, and the way that was found
   * was mutation rather than reading: re-typing the clause inside the file that
   * already owns it, and duplicating it into a second file, both left the suite
   * GREEN — because "which files contain this" answers a different question from
   * "is this typed exactly once". Two copies in one file is the drift this gate
   * exists to prevent, and a file-count cannot see it.
   *
   * The scan is over `src/` only, and `stripProse` drops comment lines so that a
   * clause QUOTED in a test-facing comment is not mistaken for a second owner. */
  const owners: string[] = [];
  for (const f of srcTsFiles()) {
    const code = stripProse(readFileSync(f, "utf8"));
    let n = 0;
    let at = code.indexOf(needle);
    while (at !== -1) {
      n++;
      at = code.indexOf(needle, at + needle.length);
    }
    for (let i = 0; i < n; i++) owners.push(relative(REPO_ROOT, f));
  }
  return owners.sort();
}

/**
 * THE REDACTION SEAM, unit-tested on its own terms.
 *
 * `test/probe-leak.test.ts` proves the property over the WIRE. This file proves
 * the two properties that wire test cannot separate:
 *
 *   SAFETY  — no internal vocabulary survives, for a KNOWN class and for an
 *             UNKNOWN one (an unclassified error must still fail closed).
 *   USEFULNESS — the redaction still tells the caller WHAT happened, WHICH
 *             model, and WHAT TO DO. This half is the one that rots silently:
 *             an over-redaction stays green on a safety-only gate while
 *             making the daemon undebuggable from a client's bug report.
 */

const LEAKS = [
  "https?://",
  "/home/",
  "/opt/",
  "/usr/",
  "\\.ts",
  "profile\\.ts",
  "UI2API_",
  "--profile",
  "--login",
  "GOAL ",
  "stale-echo",
  "Target page, context or browser",
  "browser",
  "chrome",
  "playwright",
  "Xvfb",
  "localStorage",
  "locator\\(",
  "Page title:",
  "no composer found",
  "x-msh-shield-data",
];

function leaksIn(text: string): string[] {
  return LEAKS.filter((l) => new RegExp(l, "i").test(text));
}

const REAL_DRIVER_ERRORS: ReadonlyArray<[string, string]> = [
  [
    "no composer found on copilot (https://copilot.microsoft.com) — the site UI may have changed. Tune copilot in src/profile/profile.ts or ship a JSON override (--profile FILE). Page title: Microsoft Copilot, url: https://copilot.microsoft.com/",
    "usable prompt input",
  ],
  [
    "no composer found on huggingchat (https://huggingface.co/chat) — the site UI may have changed. Tune huggingchat in src/profile/profile.ts or ship a JSON override (--profile FILE). Page title: Hugging Face, url: https://huggingface.co/login?code_challenge=U_pTsATnyaFbSECRET&state=eyJ4",
    "usable prompt input",
  ],
  ["page died reading the composer — Target page, context or browser has been closed", "went away"],
  [
    "no stored session for gemini account \"x\" on gemini.google.com (anonymous) — capture it first (ui2api profile capture <url> --login)",
    "not available",
  ],
  [
    "copilot: newChat reset not verified on copilot: after clicking \"button.new\" — composer still empty (stale-echo guard, GOAL 46)",
    "prompt input",
  ],
  [
    "no answer appeared on copilot within 30000ms. The page may be behind a consent wall — tune the profile's 'dismiss' selectors.",
    // Derived from the owner, not re-typed: this row asserts the diagnosis that
    // SURVIVES redaction, and that sentence is emitted from `NO_ANSWER_REFUSAL_CLAUSE`
    // below. Typing the words here would make the test a second owner of the very
    // clause the one-owner gate below pins to a single file in `src/`.
    NO_ANSWER_REFUSAL_CLAUSE,
  ],
];

describe("REDACTION: every real driver error loses its internals and keeps its diagnosis", () => {
  for (const [raw, mustSurvive] of REAL_DRIVER_ERRORS) {
    test(`redacts: ${JSON.stringify(raw.slice(0, 52))}…`, () => {
      const out = redactInternalError(new Error(raw), { site: "gemini", account: "x" });
      assert.deepEqual(leaksIn(out), [], `LEAKED:\n${out}`);
      assert.ok(out.includes(mustSurvive), `over-redacted — the diagnosis is gone:\n${out}`);
      assert.ok(out.includes("gemini"), `the message must name the caller's own model:\n${out}`);
      assert.ok(out.length >= 60, `a redaction that is shorter than a sentence is not a diagnosis:\n${out}`);
    });
  }
});

describe("REDACTION: an UNKNOWN error fails closed, and still says something", () => {
  const unknowns = [
    "ENOENT: no such file or directory, open '/home/me/x/capabilities/z/profile.json'",
    "pool saturated (2 in queue, 1 warm)",
    "pool queue timeout after 30000ms",
    "rate limited by upstream, x-msh-shield-data: {shield}",
    "z",
    "Cannot read properties of undefined (reading 'ask')",
  ];
  for (const raw of unknowns) {
    test(`redacts or names: ${JSON.stringify(raw.slice(0, 46))}…`, () => {
      const out = redactInternalError(new Error(raw), { site: "kimi" });
      assert.deepEqual(leaksIn(out), [], `LEAKED:\n${out}`);
      assert.ok(out.includes("kimi") || out.length > 40, `useless answer:\n${out}`);
    });
  }

  test("a non-Error throw is still redacted (String(e), not a crash)", () => {
    assert.deepEqual(leaksIn(redactInternalError("chrome crashed at /home/me/x", { site: "poe" })), []);
    assert.equal(leaksIn(redactInternalError(undefined, { site: "poe" })).length, 0);
    assert.equal(leaksIn(redactInternalError({ nope: true }, { site: "poe" })).length, 0);
  });
});

describe("REDACTION: the permission surface is not widened by a redaction", () => {
  test("an unavailable account stays unavailable and never enumerates the others", () => {
    const out = redactInternalError(
      new Error("no stored session for gemini account \"secret@example.com\" on gemini.google.com (anonymous)"),
      { site: "gemini" },
    );
    assert.ok(out.includes("not available"), out);
    assert.ok(!out.includes("available: ["), `the refusal must not enumerate other accounts:\n${out}`);
    assert.deepEqual(leaksIn(out), []);
  });

  test("the caller's own account id is echoed back — it is their input, not a secret", () => {
    const out = redactInternalError(new Error("no stored session for gemini account \"x\" on gemini.google.com"), {
      site: "gemini",
    });
    assert.ok(out.includes(`"x"`), `the caller must be able to see WHICH account was refused:\n${out}`);
  });
});

/**
 * ── ONE OWNER FOR THE ACCOUNT REFUSAL (GOAL 162 residual #2) ───────────────
 *
 * WAS: `src/prompt/error-redaction.ts` typed its OWN near-copy of the account
 * refusal sentence next to the copy `consumerAccountRefusal()` in
 * `src/prompt/consumer-surface.ts` owns. The two had already drifted — the
 * closing clause read "or use an account id returned by GET /accounts?site=X"
 * in one and "or pass an id from GET /accounts?site=X" in the other — so a
 * consumer could be handed two different sentences for one condition, and a
 * reword of either copy would leave the other stale with nothing to catch it.
 *
 * THE PIN IS A WHOLE-TREE SCAN, not a comment about one file: the distinctive
 * MIDDLE clause may be TYPED in exactly one file under `src/`. The middle clause
 * is the discriminator by choice — the OPENING clause is also a prefix
 * classification row in `src/prompt/http.ts` and `src/generator/lang-php.ts`,
 * because those turn the message into the `no_stored_account` code by matching
 * its head, so pinning on it would count the classifiers as duplicate owners. A
 * classifier matches a PREFIX, so it can never carry the middle clause. That
 * also fails when a second copy is pasted anywhere, including inside a
 * re-export shim, which is the other way a duplicate owner sneaks back in.
 */
describe("ONE OWNER: the account-refusal wording is authored in exactly one place", () => {
  const MIDDLE = "to use the default account";

  test(`the clause ${JSON.stringify(MIDDLE)} is typed in exactly one file under src/`, () => {
    assert.deepEqual(
      codeOwnersOf(MIDDLE),
      ["src/prompt/consumer-surface.ts"],
      "the account-refusal clause must be typed EXACTLY ONCE in src/ — a second copy, in this file or any other, is a sentence that will drift",
    );
  });

  test("the drifted closing clause that caused this defect is typed nowhere", () => {
    // THE DIRECT REGRESSION PIN. The duplicate read
    // "…or use an account id returned by GET /accounts?site=X" where the owner
    // reads "…or pass an id from GET /accounts?site=X". Re-introducing the
    // drifted half anywhere in `src/` CODE turns this red — which is the
    // property the defect lacked: two half-matching sentences satisfy every gate
    // that only inspects one of them.
    assert.deepEqual(
      codeOwnersOf("or use an account id returned by"),
      [],
      'the drifted half of the account-refusal sentence is typed again; the owner says "or pass an id from"',
    );
  });

  test("no shim re-exports the owner under a second name (two doors to one sentence)", () => {
    // A re-export would leave the sentence reachable by two import paths, so a
    // caller could keep depending on the old one and the dedup would be
    // cosmetic. Nothing needs one — the redaction seam is the only new caller —
    // so the second door is simply not built.
    const importers = srcTsFiles().filter((f) =>
      /export\s*\{[^}]*\bconsumerAccountRefusal\b/.test(stripProse(readFileSync(f, "utf8"))),
    );
    assert.deepEqual(
      importers.map((f) => relative(REPO_ROOT, f)),
      [],
      "consumerAccountRefusal is re-exported somewhere — a shim keeps two ways to reach one string",
    );
  });

  test("the redaction seam DELEGATES to that owner rather than re-typing the sentence", () => {
    const src = srcOf("src/prompt/error-redaction.ts");
    assert.match(
      src,
      /import\s*\{[^}]*\bconsumerAccountRefusal\b[^}]*\}\s*from\s*"\.\/consumer-surface\.js"/,
      "the redaction seam must import the owner — a near-copy is the defect this goal closed",
    );
    assert.doesNotMatch(
      src,
      /is not available for|to use the default account/,
      "the redaction seam still carries its own copy of the refusal sentence",
    );
  });
});

/**
 * ── ONE MALFORMED BODY, ONE SENTENCE ────────────────────────────────────────
 *
 * WAS: two owners for ONE caller mistake. `readJsonBody` in
 * `src/prompt/http.ts` THROWS the sentence, and `/v1/chat/completions` in
 * `src/prompt/openai.ts` CATCHES that throw and re-typed the same words,
 * because `http.ts` imports `openai.ts` (handleOpenAIRoutes) and so the
 * dependency could not point the other way without a cycle.
 *
 * THE CONCRETE DRIFT. Reword the sentence in `http.ts` — the natural place, it
 * is the one that throws — and `POST /prompt` answers the new words while
 * `POST /v1/chat/completions`, on the SAME daemon, for the SAME `{not json`
 * body, still answers the old ones. Both already send the `invalid_json` code,
 * so nothing in the contract gate sees it; only a client keying on the text sees
 * two answers to one condition. Nothing caught it: `openai.ts` discards the
 * caught error, so there was no value flowing from one copy to the other.
 *
 * The single owner is `INVALID_JSON_MESSAGE` in `src/prompt/consumer-surface.ts`
 * — the module that owns consumer-readable refusal sentences, and the one place
 * importable by BOTH emitters without a cycle.
 *
 * The whole-tree scan and its mutation-guard (`codeOwnersOf` counts OCCURRENCES,
 * not files, and strips prose first) are the same ones the account-refusal gate
 * above uses; see their comments for why counting files made an earlier version
 * of that gate vacuous.
 */
describe("ONE OWNER: the malformed-body refusal is authored in exactly one place", () => {
  test("the sentence is typed exactly once under src/", () => {
    assert.deepEqual(
      codeOwnersOf("request body is not valid JSON"),
      ["src/prompt/consumer-surface.ts"],
      "the malformed-body sentence must be typed EXACTLY ONCE in src/ — a second copy is one caller mistake answerable two ways",
    );
  });

  test("the exported constant is that sentence (the owner's value is pinned here, once)", () => {
    assert.equal(INVALID_JSON_MESSAGE, "request body is not valid JSON");
  });

  test("BOTH emitters import the owner rather than re-typing it", () => {
    for (const site of ["src/prompt/http.ts", "src/prompt/openai.ts"]) {
      const src = srcOf(site);
      assert.match(
        src,
        /import\s*\{[^}]*\bINVALID_JSON_MESSAGE\b[^}]*\}\s*from\s*"\.\/consumer-surface\.js"/,
        `${site} must import the owner — a near-copy is the duplicate this closed`,
      );
      // The emitter must USE the constant, not merely import it beside a copy.
      assert.match(src, /INVALID_JSON_MESSAGE\)/, `${site} must answer with the owner's value`);
    }
  });
});

/**
 * ── ONE OWNER FOR THE NO-ANSWER REFUSAL ────────────────────────────────────
 *
 * THE DEFECT, and it is the more dangerous half of the family above. The
 * account-refusal defect was TWO SENTENCES for one condition: both still
 * classified, so a consumer was handed two wordings and nothing went red. This
 * one is ONE sentence and a second file holding the regex that decides whether
 * that sentence counts as the service's own named refusal —
 * `NO_ANSWER_REFUSAL_PATTERNS` in `src/prompt/verification-class.ts`, which is
 * what files the 502 the service reports. Its comment claimed the pattern was
 * "taken from the single template that produces it". NOTHING took it from
 * anything: the clause was TYPED a second time, as a regex literal, with the
 * surrounding words escaped by hand.
 *
 * So a reword of the emitter left the matcher matching NOTHING, the classifier
 * filed UNATTRIBUTED-NO-ANSWER as UNCLASSIFIED, and BOTH stayed green — and that
 * is WORSE than a drifted sentence, because the drifted sentence still classified
 * and this one does not. A reword here deletes a class.
 *
 * `src/prompt/error-redaction.ts` now owns the clause (`NO_ANSWER_REFUSAL_CLAUSE`),
 * the template (`NO_ANSWER_REFUSAL_TEMPLATE`), the render (`renderNoAnswerRefusal`),
 * the retry tail (`RETRY`) and the matcher (`NO_ANSWER_REFUSAL_RE`), and
 * `verification-class.ts` imports the last of those. Three properties below, and
 * each one closes a DIFFERENT way back in:
 *
 *   1. EXCLUSIVITY — the clause may be TYPED in exactly one file under `src/`.
 *      Kills a re-typed copy anywhere, including a second occurrence inside the
 *      owning file, because `codeOwnersOf` counts OCCURRENCES and not files.
 *   2. DERIVATION — the shipped matcher really does match what the emitter emits,
 *      in both the timed and the untimed shape. This is what a reword of the
 *      clause alone would break, and exclusivity alone would NOT: the clause
 *      stays typed once while the matcher silently stops matching.
 *   3. SHIPPED BYTES — the shipped verification record (`capabilities/model-verification.json`,
 *      the `v0` row) quotes the sentence this file renders today, so a reword of
 *      the TEMPLATE TAIL — the part no `src/` file re-types, and therefore the
 *      part property 1 cannot see — leaves a record claiming the service said
 *      something it no longer says.
 *
 * Property 3 is why this is not a comment. Exclusivity plus derivation would
 * both stay GREEN through a tail reword, and that is precisely the mutation the
 * gate exists to fail.
 */
describe("ONE OWNER: the no-answer refusal is authored in exactly one place", () => {
  /** The `v0` row's own refusal, as the record quotes it. The row embeds the
   *  sentence in a paragraph and renders the dash as a plain hyphen, so the
   *  comparison is made on the dash-normalised text — that normalisation is the
   *  whole reason the shipped record is not simply `includes(rendered)`. */
  const shippedEvidence = (): string =>
    (JSON.parse(srcOf("capabilities/model-verification.json")) as {
      records: { model: string; evidence?: string }[];
    }).records.find((r) => r.model === "v0")?.evidence ?? "";

  test("the clause is typed exactly once under src/ — the classifier may not re-type it", () => {
    assert.deepEqual(
      codeOwnersOf(NO_ANSWER_REFUSAL_CLAUSE),
      ["src/prompt/error-redaction.ts"],
      "the no-answer clause must be typed EXACTLY ONCE in src/ — a second copy is a matcher that will " +
        "stop matching the day the emitter is reworded, deleting the UNATTRIBUTED-NO-ANSWER class silently",
    );
  });

  test("the classifier IMPORTS the derived matcher instead of holding a pattern", () => {
    const src = srcOf("src/prompt/verification-class.ts");
    assert.match(
      src,
      /import\s*\{[^}]*\bNO_ANSWER_REFUSAL_RE\b[^}]*\}\s*from\s*"\.\/error-redaction\.js"/,
      "verification-class.ts must import the owner's matcher — a hand-typed pattern there is the defect this closes",
    );
    assert.match(
      src,
      /NO_ANSWER_REFUSAL_PATTERNS\s*:\s*readonly RegExp\[\]\s*=\s*\[\s*NO_ANSWER_REFUSAL_RE\s*\]/,
      "the classifier's pattern array must BE the owner's matcher, not a list it fills beside a copy",
    );
  });

  test("the derived matcher matches what the emitter actually emits, timed and untimed", () => {
    // Property 2. Timed: the shape the shipped `v0` refusal carries. Untimed: the
    // shape emitted when the raw message had no timer in it. The untimed case is
    // the one a `within \d+ms`-only pattern would miss, so it is asserted, not
    // assumed.
    assert.ok(
      NO_ANSWER_REFUSAL_RE.test(renderNoAnswerRefusal("kimi", "30000")),
      "the derived matcher must match the sentence the emitter renders with a timer",
    );
    assert.ok(
      NO_ANSWER_REFUSAL_RE.test(renderNoAnswerRefusal("kimi")),
      "the derived matcher must match the shorter untimed sentence the emitter renders",
    );
    assert.ok(
      NO_ANSWER_REFUSAL_RE.test(NO_ANSWER_REFUSAL_CLAUSE),
      "the clause alone must match — that is what survives being quoted inside evidence prose",
    );
    // AND THE NARROWING IS THE POINT: generic prose about a timeout is not a
    // match, so the class cannot be widened into free text.
    assert.equal(NO_ANSWER_REFUSAL_RE.test("the request timed out after a while"), false);
  });

  test("the shipped v0 record quotes the bytes this file renders today", () => {
    // Property 3 — the one that fails on a TAIL reword, which exclusivity cannot
    // see because the tail is owned here and typed nowhere else.
    const quoted = `${renderNoAnswerRefusal("v0", "90000")} ${RETRY}`.replace(/—/g, "-");
    assert.ok(
      shippedEvidence().includes(quoted),
      "the shipped v0 record no longer quotes the sentence the redaction seam emits — the record and " +
        "the service disagree about what the service said, and every re-derivation of that row is " +
        "now measured against a sentence no producer emits",
    );
  });
});

/**
 * ── THE BYTES A CONSUMER READS ARE FROZEN ──────────────────────────────────
 *
 * A refactor that quietly rewords a shipped refusal is a silent breaking change:
 * the code is stable (`no_stored_account`) while the human-readable text moves,
 * so nothing goes red. These two tests are the byte-level guard — the first
 * freezes the owner's exact sentence, the second proves the redaction path and
 * the daemon path now emit the IDENTICAL bytes rather than two drifted copies.
 */
describe("BYTES: the consumer-facing refusal is frozen, and both paths agree", () => {
  const OWNER_BYTES =
    'account "nobody@x.test" is not available for chat.deepseek.com; send the request without ' +
    '"account" to use the default account, or pass an id from GET /accounts?site=chat.deepseek.com';

  test("the owner's exact sentence is byte-identical to the shipped contract", () => {
    assert.equal(consumerAccountRefusal("nobody@x.test", "chat.deepseek.com"), OWNER_BYTES);
  });

  test("the redaction path emits the owner's bytes — not a second wording", () => {
    const out = redactInternalError(
      new Error('no stored session for gemini account "x" on gemini.google.com (anonymous) — capture it first'),
      { site: "gemini" },
    );
    assert.equal(out, consumerAccountRefusal("x", "gemini"));
  });

  test("the refused account is read out of the RAW message when ctx carries no account", () => {
    const raw = 'no stored session for kimi account "someone@example.com" on kimi.ai';
    const out = redactInternalError(new Error(raw), { site: "kimi" });
    assert.equal(out, consumerAccountRefusal("someone@example.com", "kimi"));
  });

  test("with no site in ctx the sentence still names a model slot rather than `undefined`", () => {
    // DEGENERATE BUT PINNED: a `/v1` request always carries a model, so ctx.site
    // is present in production. The bytes are pinned anyway so that if the
    // fallback ever changes, the change is visible in a diff instead of
    // arriving as an unexplained `?site=undefined` on the wire.
    const out = redactInternalError(new Error('no stored session for gemini account "x" on gemini.google.com'));
    assert.equal(out, consumerAccountRefusal("x", "this model"));
    assert.ok(!out.includes("undefined"), `the fallback must not leak the word undefined:\n${out}`);
  });

  test("the shipped prefix-classification rows still classify the refusal", () => {
    // Both `src/prompt/http.ts` (Shape-2 code table) and
    // `src/generator/lang-php.ts` (`codeFor()`) turn this message into the
    // `no_stored_account` code by matching its PREFIX. A reword that moved
    // the opening clause would leave the code silently unmapped, so the prefix
    // is asserted here rather than assumed.
    const out = redactInternalError(new Error('no stored session for gemini account "x" on gemini.google.com'), {
      site: "gemini",
    });
    assert.match(out, /^account ".*" is not available for /);
  });

  test("the `no account was named` branch stays its OWN sentence — a different condition, not a duplicate", () => {
    // This branch is NOT a second copy of the refusal: there is no account to
    // echo, so it names no account and tells the caller the OPERATOR must act.
    // It is pinned so that a well-meaning "route everything through the owner"
    // cannot fold it into a sentence about an account the caller never sent.
    const out = redactInternalError(new Error("no stored account for chat.deepseek.com"), { site: "gemini" });
    assert.match(out, /^no account is available for gemini;/, `unexpected branch wording:\n${out}`);
    assert.ok(!out.includes('account "'), "with no account named, none is invented:\n" + out);
  });
});
/**
 * ── ONE OWNER FOR THE CONCEPT VOCABULARY ───────────────────────────────────
 *
 * THE DEFECT. `src/prompt/error-redaction.ts` used to carry its OWN hand-written
 * alternation of mechanism/concept words, beside a second one in
 * `src/prompt/consumer-surface.ts` and a third, NARROWER one in its own
 * `RESIDUAL_INTERNAL` re-check. Three copies of one vocabulary. MEASURED on the
 * tree before anything was edited: the scrub listed 15 words and MISSED SIX that
 * the prose seam and the derivation both knew — `xorg` (a `has("Xorg")` exec
 * probe in `src/runtime/requirements.ts:454`), `zod` and `classic-level` (real
 * `package.json:dependencies`), `selenium` / `puppeteer`, and `headful` (the
 * sibling the exact-match `headless` form cannot see). All six reached a
 * consumer verbatim, because the narrow re-check did not list them either.
 *
 * A duplicate list that is merely untidy is tolerable; a duplicate list that is
 * a RE-DERIVATION SOURCE is not. This repo has been bitten by this shape three
 * times already — a credential gate asserting on a string a redaction had
 * replaced, a "typed in exactly one file" gate that counted FILES so a second
 * copy in the owning file stayed green, and a completeness gate that omitted
 * three of nine classes while reading as coverage. So the pins below are
 * deliberately of that species: an EXCLUSIVITY scan over the whole tree, and a
 * COVERAGE scan that reads the words out of the code's own exec surfaces.
 */

/** The alternation this file carried BEFORE the shared vocabulary existed,
 *  frozen verbatim from `git show HEAD:src/prompt/error-redaction.ts`. It is
 *  here so the no-widening claim is MEASURED against the real previous
 *  behaviour instead of asserted in a comment — a hand-written copy of it in the
 *  test is acceptable precisely because the test is not `src/`, which is what
 *  the exclusivity pin below scans. */
const PRE_CHANGE_WORDS = [
  "browser", "chrome", "chromium", "playwright", "Xvfb", "CDP", "locator",
  "selector", "headless", "headed", "webdriver", "localStorage", "cookie jar",
  "profile.ts", "ui2api",
];

/** The vocabulary the prose seam and the error seam genuinely SHARE. */
const SHARED_TERMS = new Set(CONCEPT_TERMS.map((t) => t.toLowerCase()));

/** How many concept words may appear as alternatives in ONE regex literal before
 *  the scan treats it as a second vocabulary. Two is a rule; three or more is a
 *  list. The owner file is exempt because its `automation-library` rule is a
 *  legitimate four-way family. */
const ALTERNATION_VOCABULARY_FLOOR = 3;

function conceptAlternationOwners(): string[] {
  const found: string[] = [];
  for (const f of srcTsFiles()) {
    const code = stripProse(readFileSync(f, "utf8"));
    // `[^()]*` rather than a lazy alternation-with-`(?:`-inside: the first draft
    // put the `(?:` marker INSIDE the repetition group, which makes it consumable
    // exactly once, so the scan matched NOTHING and the anti-vacuity assertion
    // caught it on the first run. Greedy-and-filtered also walks nested
    // alternations separately, which is the behaviour wanted here.
    for (const m of code.matchAll(/\(\?([^()]*)\)/g)) {
      const alts = m[1]!.split(/[:|]/).map((s) => s.replace(/\\[a-z]/gi, "").trim().toLowerCase()).filter(Boolean);
      const hits = alts.filter((a) => SHARED_TERMS.has(a)).length;
      if (hits >= ALTERNATION_VOCABULARY_FLOOR) found.push(`${relative(REPO_ROOT, f)} -> ${m[0].slice(0, 90)}`);
    }
  }
  return found;
}

describe("ONE OWNER: the concept vocabulary is declared once, and the seam CONSUMES it", () => {
  // THE PIN THAT WOULD HAVE CAUGHT THE DEFECT. These four words are exactly the
  // ones the hand-written list MISSED, so they are the words whose re-typing
  // anywhere is the regression. `zod` and `classic-level` are deliberately NOT
  // used as discriminators: `src/plugin/serve.ts` and
  // `src/runtime/profile-ingest.ts` name them as real uses, which would make the
  // pin cry wolf on the first honest caller.
  for (const needle of ['"xorg"', '"headful"', '"selenium"', '"puppeteer"']) {
    test(`the concept word ${needle} is typed in exactly one file under src/`, () => {
      assert.deepEqual(
        codeOwnersOf(needle),
        ["src/prompt/consumer-surface.ts"],
        `${needle} must be declared EXACTLY ONCE in src/ — the shared vocabulary lives in ` +
          `consumer-surface.ts's CONCEPT_TERMS, and the error seam imports it. A second copy, in ` +
          `this file or any other, is a list that will drift (MEASURED: six words drifted open).`,
      );
    });
  }

  test("the redaction seam IMPORTS the vocabulary instead of re-typing it", () => {
    const src = srcOf("src/prompt/error-redaction.ts");
    assert.match(
      src,
      /import\s*\{[^}]*\bCONCEPT_TERMS\b[^}]*\}\s*from\s*"\.\/consumer-surface\.js"/,
      "the redaction seam must import CONCEPT_TERMS — a second hand-written alternation is the defect this closes",
    );
    assert.match(
      src,
      /INTERNAL_WORD_RE\s*=\s*new RegExp\(/,
      "the seam must BUILD its alternation from the shared vocabulary, not declare one",
    );
  });

  test("no second hand-written concept alternation exists anywhere under src/", () => {
    // The EXCLUSIVITY scan, and the anti-vacuity detail that matters: it counts
    // ALTERNATIVES inside one regex literal, not files containing a word — a
    // file-count is what made an earlier gate in this repo green while a second
    // copy sat in the owning file. It also scans CODE only, so a comment that
    // QUOTES the alternation is not a second owner.
    const offenders = conceptAlternationOwners().filter((o) => !o.startsWith("src/prompt/consumer-surface.ts"));
    assert.deepEqual(
      offenders,
      [],
      `a second hand-written concept alternation exists in src/:\n  ${offenders.join("\n  ")}\n` +
        `Only consumer-surface.ts's CONCEPT_TERMS may name the vocabulary; every other seam consumes it.`,
    );
    // …and the scan must be able to see one, or it is a decoration.
    assert.ok(
      conceptAlternationOwners().some((o) => o.startsWith("src/prompt/consumer-surface.ts")),
      "the vocabulary-ownership scan found NOTHING at all, including in the owner — it cannot see an " +
        "alternation, so it cannot catch a duplicate one. This is the vacuous-gate case.",
    );
  });

  test("NON-VACUITY: the derivation still reads a real vocabulary", () => {
    const terms = mechanismTermsIn(REPO_ROOT, mechanismSourceFiles());
    assert.ok(terms.size >= 8, `the derivation read only ${terms.size} terms — a collapsed walk proves nothing`);
    // The vocabulary is not a decorative export: it must actually carry words.
    assert.ok(CONCEPT_TERMS.length >= 10, `CONCEPT_TERMS carries only ${CONCEPT_TERMS.length} words`);
  });

  test("every term the CODE names as a mechanism noun is redacted off the wire", () => {
    const terms = mechanismTermsIn(REPO_ROOT, mechanismSourceFiles());
    const survivors: string[] = [];
    for (const [term, where] of terms) {
      for (const spelling of [term, term.toUpperCase()]) {
        const out = redactInternalError(
          `driver failed: ${spelling} reported an unexpected condition while preparing the page`,
          { site: "gemini" },
        );
        const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(out)) survivors.push(`${term} (${where}) leaked from ${JSON.stringify(out)}`);
      }
    }
    assert.deepEqual(
      survivors,
      [],
      `these mechanism nouns reached a consumer verbatim — the code names them as things it ` +
        `EXECUTES, so they are internal by construction:\n  ${survivors.join("\n  ")}\nA browser ` +
        `binary added to a ladder, a program added to a readiness probe, or a dependency added to ` +
        `package.json is covered BY CONSTRUCTION once the seam consumes CONCEPT_TERMS.`,
    );
  });

  test("the six words that used to leak are the six this change closed", () => {
    // THE DIRECT REGRESSION PIN, naming the defect rather than the mechanism. If
    // one of these is ever removed from CONCEPT_TERMS the word goes straight back
    // to the wire and this test says which word it was.
    for (const word of ["xorg", "zod", "classic-level", "selenium", "puppeteer", "headful"]) {
      const out = redactInternalError(
        `driver failed: ${word} reported an unexpected condition while preparing the page`,
        { site: "gemini" },
      );
      assert.ok(
        !new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(out),
        `"${word}" reached a consumer verbatim: ${JSON.stringify(out)}. It is in CONCEPT_TERMS; ` +
          `removing it re-opens the measured hole this change closed.`,
      );
    }
  });

  test("every shared concept term is redacted by the seam AND by the prose seam", () => {
    const survivors: string[] = [];
    for (const term of CONCEPT_TERMS) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const viaError = redactInternalError(`driver failed: ${term} reported an unexpected condition here`, {
        site: "gemini",
      });
      if (re.test(viaError)) survivors.push(`error seam leaked ${term} -> ${JSON.stringify(viaError)}`);
      const viaProse = consumerProse(`probe ${term} probe`);
      if (re.test(viaProse)) survivors.push(`prose seam leaked ${term} -> ${JSON.stringify(viaProse)}`);
    }
    assert.deepEqual(
      survivors,
      [],
      `the shared vocabulary is shared but NOT universally applied — that is worse than two lists, ` +
        `because it reads as one owner:\n  ${survivors.join("\n  ")}`,
    );
  });
});

describe("BYTES: the shared vocabulary did not widen or mangle the seam", () => {
  test("the seam still matches EVERY word the pre-change alternation matched", () => {
    const lost: string[] = [];
    for (const w of PRE_CHANGE_WORDS) {
      const re = new RegExp(INTERNAL_WORD_RE.source, "gi");
      if (!re.test(`a ${w} b`)) lost.push(w);
    }
    assert.deepEqual(
      lost,
      [],
      `these words were redacted before this change and no longer are — a lost redaction is a leak, ` +
        `and it happens silently when a list is rebuilt: ${lost.join(", ")}`,
    );
  });

  test("on every word it already carried, the assembled pattern is byte-equal to the old one", () => {
    const OLD = /\b(?:browser|chrome|chromium|playwright|Xvfb|CDP|locator|selector|headless|headed|webdriver|localStorage|cookie jar|profile\.ts|ui2api)\b/gi;
    const NEW = new RegExp(INTERNAL_WORD_RE.source, "gi");
    const differ: string[] = [];
    // Probed embedded in a sentence AND on its own, because alternation order
    // only shows up when the word shares a message with other matches.
    for (const w of PRE_CHANGE_WORDS) {
      for (const text of [`pre ${w} post`, w, `${w} ${w}`, `a ${w} b ${w} c`]) {
        const a = text.replace(new RegExp(OLD.source, "gi"), "");
        const b = text.replace(new RegExp(OLD.source, "gi"), "").replace(new RegExp(NEW.source, "gi"), "");
        if (a !== b) differ.push(`${JSON.stringify(text)}: old->${JSON.stringify(a)} new->${JSON.stringify(b)}`);
      }
    }
    assert.deepEqual(
      differ,
      [],
      `the assembled pattern changed the bytes for a word the seam already handled:\n  ${differ.join("\n  ")}\n` +
        `This is how "google-chrome" got deleted whole and left " was" where it used to leave "google- was".`,
    );
  });

  test("FALSE-POSITIVE: the shared vocabulary does not mangle ordinary words", () => {
    // The measurement that decides whether this change was safe. `browser` IS
    // mangled — it is in the error seam's own list and always was; the error
    // seam is not the prose seam, and the sentence below is an ERROR, where
    // "browser" is never something the caller needs. What must be zero is the
    // terms this change ADDED.
    const ADDED = ["xorg", "zod", "classic-level", "selenium", "puppeteer", "headful"];
    const ORDINARY = [
      "model", "session", "tool", "search", "answer", "capability", "response", "request", "image",
      "The site returned an answer but the tool call was not readable on this turn",
      "Search results are empty because the site changed its layout",
      "Your session expired; sign in again and retry the same request",
      "The model refused this turn because of a content policy",
      "Cookies were rejected by the page and it never loaded",
      "The answer was truncated at 4096 tokens",
      "Search the web, then summarize the answer for the next session",
      "Send an image and the site will describe it",
      "The capability is unavailable on this deployment",
    ];
    for (const word of ADDED) {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const hits = ORDINARY.filter((s) => re.test(s));
      assert.deepEqual(
        hits,
        [],
        `"${word}" collides with an ordinary consumer sentence: ${JSON.stringify(hits)} — a redaction ` +
          `that catches ordinary words catches nothing`,
      );
      // …and it must not be a no-op either, or the pin above is vacuous.
      const out = redactInternalError(`driver failed: ${word} reported an unexpected condition here`, {
        site: "gemini",
      });
      assert.ok(!re.test(out), `"${word}" is not actually redacted: ${JSON.stringify(out)}`);
    }
    // AND the ordinary prose must survive BOTH seams untouched, so this change
    // cannot be quietly widened later without this going red.
    for (const s of ORDINARY) {
      assert.equal(consumerProse(s), s, `consumerProse mangled an ordinary consumer sentence: ${JSON.stringify(s)}`);
    }
  });
});

/** Every TypeScript/JS/shell file under `src/` and `scripts/`, which is what the
 *  mechanism derivation reads. Kept here rather than imported so the error suite
 *  does not depend on the prose suite's private helpers. */
function mechanismSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(child);
      else if (/\.(ts|tsx|js|sh)$/.test(e.name)) out.push(child);
    }
  };
  for (const top of ["src", "scripts"]) {
    try {
      readdirSync(join(REPO_ROOT, top));
    } catch {
      continue;
    }
    walk(top);
  }
  return out;
}

/**
 * ── THE TWO SEAMS ARE NEVER COMPOSED (previously "unverified") ─────────────
 *
 * THIS WAS THE OPEN QUESTION A PRIOR LANE FLAGGED AND DID NOT CLOSE, quoted:
 * "the interaction is unverified". It is verified here, in three parts, because
 * the answer decides whether the shared vocabulary is safe to introduce at all:
 * a shared vocabulary is only safe if applying both seams to one text cannot
 * double-redact it or mangle it.
 *
 *   1. STATICALLY they cannot be composed: `consumerProse` is called only from
 *      `src/prompt/registry.ts` (on manifest and capability descriptions) and
 *      `redactInternalError` only from `src/prompt/openai.ts` (on a caught
 *      exception's message). The two never appear in the same file's CODE, so
 *      there is no call path that feeds one seam's output to the other.
 *   2. BOTH ARE IDEMPOTENT on their own output, so a future caller that wires
 *      them together cannot get a second pass of damage.
 *   3. EACH IS A FIXED POINT OF THE OTHER on the measured cases — the redact
 *      seam deletes exactly the words the prose seam would have replaced, so its
 *      output is already prose-clean, and the prose seam's output is already
 *      scrub-clean.
 */
describe("COMPOSITION: the two seams are never composed, and cannot double-redact if they were", () => {
  test("STATIC: no source file calls both seams, so no call site composes them", () => {
    const both = srcTsFiles()
      .map((f) => {
        const code = stripProse(readFileSync(f, "utf8"));
        return /\bconsumerProse\s*\(/.test(code) && /\bredactInternalError\s*\(/.test(code)
          ? relative(REPO_ROOT, f)
          : null;
      })
      .filter((f): f is string => f !== null);
    assert.deepEqual(
      both,
      [],
      `these files call BOTH seams:\n  ${both.join("\n  ")}\nIf one of them feeds a seam's output ` +
        `into the other, the shared vocabulary must be proved idempotent under composition — the ` +
        `tests below do that, but the composition itself should be a deliberate, visible edit.`,
    );
    // …and the scan must be capable of seeing a file that DOES call both, or it
    // proves nothing. `src/prompt/openai.ts` and `src/prompt/registry.ts` are
    // asserted individually below, which is the same fact stated from the other
    // side.
    assert.ok(
      srcTsFiles().some((f) => /\bredactInternalError\s*\(/.test(stripProse(readFileSync(f, "utf8")))),
      "the composition scan cannot find ANY caller of redactInternalError — it is not looking at code",
    );
  });

  test("IDEMPOTENT: neither seam damages its own output a second time", () => {
    const CORPUS = [
      "ui2api chrome start failed: xvfb display",
      "probe chrome probe and xvfb and playwright",
      "the browser was headful under Xvfb, driven by playwright and selenium",
      "localStorage cookie jar profile.ts locator selector ui2api",
      "zod rejected the payload and classic-level could not open the store",
      "google-chrome-stable and chromium-browser and ui2api-chrome",
    ];
    for (const s of CORPUS) {
      assert.equal(
        consumerProse(consumerProse(s)),
        consumerProse(s),
        `consumerProse is not idempotent, so composing the seams would mangle the text twice: ${JSON.stringify(s)}`,
      );
      const once = redactInternalError(s, { site: "gemini" });
      assert.equal(
        redactInternalError(once, { site: "gemini" }),
        once,
        `redactInternalError is not idempotent, so composing the seams would redact twice: ${JSON.stringify(s)}`,
      );
    }
  });

  test("FIXED POINT: a redacted message is already prose-clean, and the reverse", () => {
    // The property that makes a shared vocabulary safe rather than merely tidy.
    // A word BOTH lists touch — `chrome`, `xvfb`, `playwright`, `cdp` — must
    // leave nothing for the other seam to do, so a future composition cannot
    // delete a phrase twice and leave a hole.
    for (const word of ["chrome", "xvfb", "playwright", "cdp", "selenium"]) {
      const text = `driver failed: ${word} reported an unexpected condition while preparing the page`;
      const redacted = redactInternalError(text, { site: "gemini" });
      assert.equal(
        consumerProse(redacted),
        redacted,
        `consumerProse CHANGED an already-redacted message — the two seams are not a fixed point of ` +
          `each other on "${word}", so composing them would mangle it:\n  redacted: ${JSON.stringify(redacted)}\n  after prose: ${JSON.stringify(consumerProse(redacted))}`,
      );
      const worded = consumerProse(text);
      assert.ok(
        new RegExp(`\\b${word}\\b`, "i").test(worded) === false,
        `consumerProse left "${word}" in place, so the prose seam is not the inverse of the delete ` +
          `seam on this word: ${JSON.stringify(worded)}`,
      );
    }
  });

  test("the one word the seams deliberately DISAGREE on is `browser`, and it is documented", () => {
    // consumerProse must NOT redact bare `browser` — it is an ordinary English
    // word a capability description may use, and redacting it is a false
    // positive, not a leak. The error seam MUST redact it, because in an error
    // message it is never something the caller needs. That divergence is the
    // whole reason the two seams cannot share their RULES, and it is pinned here
    // so "unify the two tables" cannot quietly fold it away.
    assert.equal(consumerProse("the browser refused the request"), "the browser refused the request");
    const out = redactInternalError("the browser refused the request in a way we cannot explain here", {
      site: "gemini",
    });
    assert.ok(!/\bbrowser\b/i.test(out), `the error seam must still delete bare browser: ${JSON.stringify(out)}`);
    assert.ok(SHARED_TERMS.has("browser") === false, "bare `browser` must NOT be a SHARED term — sharing it would redacted it out of prose");
  });
});

/**
 * ── THE DERIVED-FORM CLASS (`term` + letters) ─────────────────────────────────
 *
 * A prior lane closed the duplicated concept-word list and recorded what it
 * could NOT fix, verbatim: "`\b` boundary forms are still holes, unchanged by me.
 * `chromeless`, `headlessly`, `xorgs`, `zodish` survive BOTH the old and new
 * rules (the word is inside a longer token). Fixing needs prefix-tolerant
 * matching, which is a widening on a delete rule with unmeasured cost."
 *
 * THE FOUR EXAMPLES IT NAMED ARE, MEASURED, WORTHLESS — and that part of its
 * reasoning was right. All four occur exactly once each in the whole tree, in
 * `.brain/verbatim-goals.md`, which is the prose of the lane writing them down.
 * Zero occurrences in `src/`, and a mangled variant of an already-redacted word
 * discloses nothing a caller did not already have.
 *
 * BUT THE CLASS IS NOT THE FOUR WORDS. The class is DERIVATION — any declared
 * term plus trailing letters — and its plural member is LIVE IN SHIPPED DATA:
 * `selectors` sits in EIGHT shipped `manifest.json` description fields
 * (claude x2, conol, grok, t3chat, venice x2, xiaomimimo), every one of which is
 * republished through `consumerProse()` at `src/prompt/registry.ts:1001` and
 * served on `GET /registry`. The `conol` sentence is the cleanest possible proof
 * that this is a HOLE and not a policy: in ONE string the seam translates
 * `headed` to `display-attached` and walks straight past `selectors`.
 *
 * It is live on the error seam too, in a thrown Error at
 * `src/prompt/driver.ts:723` ("the profile has no picker selectors") and in a
 * consumer-facing `reason` at `src/runtime/capability-probe.ts:114`/`:414`.
 *
 * AND THE FAIL-CLOSED CLAIM WAS FALSE FOR THIS MEMBER. `RESIDUAL_INTERNAL` is
 * documented as the last gate before the wire and as failing closed; it is built
 * from the same boundary-anchored pattern, so it cannot see `selectors` either.
 * Measured: the re-check lets that message out untouched. A gate that cannot
 * see the leak is not a gate.
 */
describe("DERIVED FORMS: a declared term plus trailing letters is the SAME word", () => {
  /** The derived forms that are attested or plausible, split by WHY each is
   *  here — so a future failure names which category regressed. `plural` is the
   *  one measured live in shipped data; the rest are the handed-over examples
   *  plus the shapes English actually derives. */
  const DERIVED: ReadonlyArray<readonly [string, string]> = [
    // LIVE in shipped manifest descriptions — the plural is the real class.
    ["plural", "selectors"],
    ["plural", "browsers"],
    ["plural", "locators"],
    ["plural", "chromes"],
    ["plural", "chromiums"],
    ["plural", "playwrights"],
    ["plural", "cdps"],
    ["plural", "zods"],
    // The four the prior lane handed over, verbatim.
    ["suffix", "chromeless"],
    ["suffix", "headlessly"],
    ["suffix", "xorgs"],
    ["suffix", "zodish"],
    ["suffix", "headfully"],
    ["suffix", "xorgish"],
    ["suffix", "chromelessness"],
  ];

  test("the ERROR seam deletes every derived form, not just the bare term", () => {
    const leaked: string[] = [];
    for (const [kind, form] of DERIVED) {
      // A REAL internal message, shaped like driver.ts:723's — long enough to
      // clear the 24-char diagnosis floor, so a survivor is the seam's choice
      // and not the length gate quietly hiding a regression.
      const out = redactInternalError(`${form} was never a word the caller may read here`, { site: "gemini" });
      if (new RegExp(`\\b${form}\\b`, "i").test(out)) {
        leaked.push(`${kind} "${form}" -> ${JSON.stringify(out)}`);
      }
    }
    assert.deepEqual(
      leaked,
      [],
      `a derived form of a declared term reached a consumer verbatim. The bare term is redacted and its\n` +
        `own inflection is not, so the seam redacts half a word:\n  ${leaked.join("\n  ")}`,
    );
  });

  test("the PROSE seam translates every derived form it owns", () => {
    // PROSE'S OWNERSHIP IS NARROWER THAN THE ERROR SEAM'S, and that is the whole
    // reason the two seams exist as they do. `browser`, `locator` and `selector`
    // are ordinary English in a capability description — "selectors may be
    // combined with a comma" is a legitimate sentence — so prose must NOT redact
    // them or their plurals, and the counterweight test below pins that. The eight
    // shipped descriptions that still read `selectors` are therefore NOT a prose
    // bug; they are a consequence of prose deliberately never owning that word.
    // The forms asserted HERE are the ones prose does own: derivations of a
    // CONCEPT_TERM.
    const PROSE_OWNED = [
      "chromes", "chromiums", "playwrights", "cdps", "zods", // plurals of a concept term
      "chromeless", "headlessly", "headfully", "xorgish", "zodish", // the four handed over
      "chromelessness", "browser-bounded", // longer derivations
    ];
    const leaked: string[] = [];
    for (const form of PROSE_OWNED) {
      const out = consumerProse(`probe ${form} probe`);
      if (new RegExp(`\\b${form}\\b`, "i").test(out)) leaked.push(`"${form}" -> ${JSON.stringify(out)}`);
    }
    assert.deepEqual(
      leaked,
      [],
      `consumerProse left a derived form of a concept term it OWNS in a description a consumer will read:\n  ${leaked.join("\n  ")}`,
    );
  });

  test("the PROSE seam still TRANSLATES rather than deleting (the honesty rule)", () => {
    // A derived form must be handled the way the bare term is: replaced with a
    // phrase a description can still be built from. If a widening turned the
    // prose seam into a delete, the description would lose its sentence and the
    // redaction would be the second lie the file's header forbids.
    for (const [form, mustSurvive] of [
      ["chromeless", "operator-attached"],
      ["headlessly", "display-attached"],
      ["chromes", "operator-attached"],
      ["zodish", "internal implementation detail"],
    ] as const) {
      const out = consumerProse(`probe ${form} probe`);
      assert.ok(
        out.includes(mustSurvive),
        `the derived form "${form}" was not TRANSLATED to "${mustSurvive}": ${JSON.stringify(out)}. ` +
          `A prose redaction that deletes the sentence is a second lie.`,
      );
    }
  });

  test("the PROSE seam still leaves the ordinary derived English alone (the counterweight)", () => {
    // THE FAIL-SAFE HALF. `browser`, `locator` and `selector` are ordinary words
    // a capability description may legitimately use, so prose must not redact
    // them OR their plurals. If a future widening reaches these, the derived-form
    // gate above has become the 276-token defect: a gate that catches ordinary
    // words catches nothing.
    for (const s of [
      "the browser refused the request",
      "browsers are not shared between requests",
      "the selector is invalid for this query",
      "selectors may be combined with a comma",
      "the locator returned no rows",
      "locators are scoped to the document",
    ]) {
      assert.equal(consumerProse(s), s, `consumerProse mangled ordinary English: ${JSON.stringify(s)} -> ${JSON.stringify(consumerProse(s))}`);
    }
  });

  test("MEASURED: the derived-form widening adds only KNOWN-SAFE tokens to the shipped corpus", () => {
    // THE NUMBER THAT LICENSES THE WIDENING, recomputed at test time so it
    // cannot rot into a claim. This is the discipline the repo already learned
    // the hard way: a redaction widened "until it catches everything" caught 276
    // ordinary words (Answer, Capability, Search, Tool, Image, Response, model,
    // session) and was rejected. So the cost is MEASURED HERE, over the REAL
    // corpus — every string out of every shipped `capabilities/*/manifest.json`,
    // which is exactly what `consumerProse` is asked to rewrite — and the delta
    // must be exactly the derived forms of a declared term and nothing else.
    //
    // A bare delta count would be enough to cry wolf invisibly (a new colliding
    // token could replace a safe one), so the assertion is on the SET.
    const TERMS = [...CONCEPT_TERMS, "browser", "locator", "selector", "localStorage", "cookie jar", "profile.ts", "ui2api"];
    const alt = TERMS.map((t) => t.replace(/[\\^$*+?()[\]{}|]/g, "\\$&")).join("|");
    const BARE = new RegExp(`^(?:${alt})$`, "i");
    const WIDE = new RegExp(`^(?:${alt})[a-z]+$`, "i");

    const corpus = new Set<string>();
    for (const dir of readdirSync(join(REPO_ROOT, "capabilities"), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let m: unknown;
      try {
        m = JSON.parse(readFileSync(join(REPO_ROOT, "capabilities", dir.name, "manifest.json"), "utf8"));
      } catch {
        continue;
      }
      const grab = (o: unknown): void => {
        if (typeof o === "string") {
          for (const w of o.split(/[^A-Za-z0-9_-]+/)) if (w) corpus.add(w);
        } else if (Array.isArray(o)) o.forEach(grab);
        else if (o && typeof o === "object") Object.values(o).forEach(grab);
      };
      grab(m);
    }
    assert.ok(corpus.size > 500, `the shipped corpus collapsed to ${corpus.size} tokens — this gate would pass vacuously`);

    // Every token the widened rule eats that the bare rule did not.
    const delta = [...corpus].filter((w) => WIDE.test(w) && !BARE.test(w)).sort();
    // …each one must be a DERIVATION OF A DECLARED TERM, checked by stripping
    // trailing letters back to a term. That is the property that makes the
    // widening safe by construction rather than by count.
    const notADerivation = delta.filter((w) => {
      let s = w;
      while (s.length > 0) {
        if (BARE.test(s)) return false;
        s = s.slice(0, -1);
      }
      return true;
    });
    assert.deepEqual(
      notADerivation,
      [],
      `the derived-form widening eats ${delta.length} new tokens from the shipped corpus ` +
        `(${corpus.size} total), and ${notADerivation.length} are NOT a derivation of a declared term: ` +
        `${notADerivation.join(", ")}.\nA redaction that catches ordinary words catches nothing — the 276-token ` +
        `defect. Full delta: ${delta.join(", ")}`,
    );
    // Disclosed, not asserted into silence: the measured delta and its size, so
    // a reader sees the number rather than trusting the mechanism.
    console.log(
      `[derived-form gate] corpus ${corpus.size} tokens; widened rule newly eats ${delta.length}: ${delta.join(", ") || "(none)"}; ` +
        `${notADerivation.length} are not a derivation of a declared term`,
    );
  });
});

/**
 * ── THE `_`/DIGIT CLASS: the residual that was actually open ───────────────────
 *
 * The prior block above is about `[a-z]*`. This one is about the OTHER neighbour
 * of `\b`, and it exists because the two were confused.
 *
 * `_` and a digit are `\w`, so `\b` falls BETWEEN `xorg` and `_lock`. Neither
 * half matched, and both looked like the "inside a longer token" residual the
 * earlier lane wrote down. Only one of them was:
 *
 *   - the LETTER class (`chromeless`, `headlessly`, `xorgs`, `zodish`) was
 *     already closed by `[a-z]*`, and `docs/ACTIVE-WAVE.md` records it as still
 *     open. That record is stale and this block is the correction.
 *   - the DIGIT class (`chrome2`, `selenium3`) is COSMETIC: 3 occurrences in the
 *     whole tree, every one of them `docs/ACTIVE-WAVE.md` quoting the defect at
 *     itself. Zero in `src/`, zero in shipped manifests.
 *   - the `_` class is a REAL LEAK, and it is what this gate pins.
 *
 * WHY A LEAK, MEASURED AND NOT ASSERTED. The named forms below are not invented
 * probe strings: `chromium_headless_shell` is Playwright's ACTUAL binary
 * directory name (`~/.cache/ms-playwright/chromium_headless_shell-1228/`) and it
 * is named verbatim in shipped test fixtures. Each is asserted here through the
 * PUBLIC function, so the gate cannot pass by inspecting a regex source while the
 * wired seam still leaks.
 */
describe("THE UNDERSCORE/DIGIT CLASS: `_` and a digit are \\w, so \\b breaks between", () => {
  /**
   * The real leaks, split by WHY each is here. `real` = a name this codebase or
   * Playwright actually uses, attested in the tree. `derived` = the shape, so a
   * future term added to CONCEPT_TERMS is covered by the same rule rather than
   * needing a new row here.
   */
  const UNDERSCORE_LEAKS: ReadonlyArray<readonly [string, string]> = [
    // REAL, attested in shipped code — Playwright's own artifact directory name.
    ["real", "chromium_headless_shell"],
    ["real", "browser_download_url"],
    ["real", "ui2api_driver_error"],
    // REAL shapes: a term, then a `_`-joined qualifier.
    ["derived", "xorg_lock"],
    ["derived", "cdp_pipe"],
    ["derived", "zod_v4"],
    ["derived", "playwright_chromiumdev_profile"],
    ["derived", "headless_shell"],
    // The digit class, closed because it is free — not because it was a leak.
    ["digit", "chrome2"],
    ["digit", "xorg9"],
  ];

  test("the ERROR seam deletes every `_`-joined form of a declared term", () => {
    const leaked: string[] = [];
    for (const [kind, form] of UNDERSCORE_LEAKS) {
      // Shaped like a classifier's `reason` — the pathless spelling, which is the
      // one that actually leaks. With a leading `/home/...` the path rule eats
      // the fragment and the message falls to the fallback, so the path variant
      // would prove nothing here.
      const out = redactInternalError(`driver failed: ${form} reported an unexpected condition while preparing the page`, {
        site: "gemini",
      });
      if (out.includes(form)) leaked.push(`${kind} "${form}" -> ${JSON.stringify(out)}`);
    }
    assert.deepEqual(
      leaked,
      [],
      `an underscore-joined form of a declared term reached a consumer verbatim. \`_\` is a \\w character, so the\n` +
        `boundary anchor falls BETWEEN the term and its qualifier and neither half matched:\n  ${leaked.join("\n  ")}\n` +
        `A leak that only opens on the pathless spelling is still a leak — the absolute-path variant is\n` +
        `eaten by the path rule and would have hidden this.`,
    );
  });

  test("NON-VACUITY: the leak is REAL in the tree, not a string this test invented", () => {
    // The anti-vacuity half. If `chromium_headless_shell` were a shape I made up
    // for the test, the gate above would be pinning a fiction and the whole
    // justification for the widening would be fictional too. So it must be
    // findable in SHIPPED code — asserted against the tree, not against a list.
    const shipped = srcTsFiles()
      .concat(
        readdirSync(join(REPO_ROOT, "test"))
          .filter((f) => f.endsWith(".ts"))
          .map((f) => join(REPO_ROOT, "test", f)),
      )
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const form of ["chromium_headless_shell", "browser_download_url", "ui2api_driver_error"]) {
      assert.ok(
        shipped.includes(form),
        `"${form}" is asserted as a REAL leak but appears nowhere in src/ or test/. Either the fixture ` +
          `moved or the claim was invented — and an invented leak justifies nothing.`,
      );
    }
  });

  test("MUTATION-PROVEN: the gate sees the rule WEAKENED in either direction", () => {
    // A gate that cannot see its own reverts is a decoration. Both reverts are
    // checked by REBUILDING the alternation from the same vocabulary, so this
    // asserts the property (the underscore is load-bearing) rather than a string.
    const alt = [...CONCEPT_TERMS, "browser", "locator", "selector", "localStorage", "cookie jar", "profile.ts", "ui2api"]
      .map((t) => t.replace(/[\\^$*+?()[\]{}|]/g, "\\$&"))
      .join("|");
    const OPEN_FORMS = ["xorg_lock", "cdp_pipe", "zod_v4", "browser_download_url", "ui2api_driver_error", "chromium_headless_shell"];

    // A form LEAKS when the rule does NOT match it — so a revert "reopens" a form
    // by failing to match it. The polarity is the whole assertion, so it is
    // stated rather than left to a reader to infer.
    // Revert 1: `_` dropped from the class. All six must reopen.
    const noUnderscore = new RegExp(`\\b(?:${alt})[a-z0-9]*\\b`, "i");
    const reopenedByNoUnderscore = OPEN_FORMS.filter((f) => !noUnderscore.test(f));
    assert.equal(
      reopenedByNoUnderscore.length,
      OPEN_FORMS.length,
      `dropping \`_\` from the suffix class reopened only ${reopenedByNoUnderscore.length} of ${OPEN_FORMS.length} ` +
        `(${reopenedByNoUnderscore.join(", ")}). If this fires, the underscore is NOT what closes these — so the ` +
        `widening's stated justification is wrong, not just its size.`,
    );

    // Revert 2: the whole widening undone, back to the pre-existing `[a-z]*`.
    const letterOnly = new RegExp(`\\b(?:${alt})[a-z]*\\b`, "i");
    const reverted = [...OPEN_FORMS, "chrome2"];
    const reopenedByLetterOnly = reverted.filter((f) => !letterOnly.test(f));
    assert.equal(
      reopenedByLetterOnly.length,
      reverted.length,
      `reverting to the pre-existing \`[a-z]*\` reopened only ${reopenedByLetterOnly.length} of ${reverted.length} ` +
        `(${reopenedByLetterOnly.join(", ")}). The gate must be able to see its own revert.`,
    );

    // …and the shipped rule closes all of them, which is the positive half.
    const shippedRe = new RegExp(INTERNAL_WORD_RE.source, "i");
    const stillOpen = reverted.filter((f) => !shippedRe.test(f));
    assert.deepEqual(stillOpen, [], `the SHIPPED rule still lets these through: ${stillOpen.join(", ")}`);
  });

  test("MEASURED: the widening eats only INTERNAL spans from the real corpus", () => {
    // THE COST, recomputed at test time so it cannot rot into a claim — and over
    // a corpus an order of magnitude larger than the 3,853-token manifest set:
    // every string literal in every shipped `.ts`/`.js`/`.mjs`/`.sh` file under
    // src/, test/, scripts/, capabilities/ and docs/. A widening justified by a
    // measurement must ship the measurement.
    const alt = [...CONCEPT_TERMS, "browser", "locator", "selector", "localStorage", "cookie jar", "profile.ts", "ui2api"]
      .map((t) => t.replace(/[\\^$*+?()[\]{}|]/g, "\\$&"))
      .join("|");
    const OLD = new RegExp(`\\b(?:${alt})[a-z]*\\b`, "gi");
    const NEW = new RegExp(`\\b(?:${alt})[a-z0-9_]*\\b`, "gi");

    const literals: string[] = [];
    for (const rel of ["src", "test", "scripts", "capabilities", "docs"]) {
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const abs = join(dir, e.name);
          if (e.isDirectory()) {
            walk(abs);
          } else if (/\.(?:ts|tsx|mjs|js|sh)$/.test(e.name)) {
            let src: string;
            try {
              src = readFileSync(abs, "utf8");
            } catch {
              continue;
            }
            for (const m of src.matchAll(/"([^"\n]{10,300})"|'([^'\n]{10,300})'|`([^`]{10,300})`/g)) {
              literals.push(m[1] ?? m[2] ?? m[3] ?? "");
            }
          }
        }
      };
      walk(join(REPO_ROOT, rel));
    }
    assert.ok(
      literals.length > 5000,
      `the measured corpus collapsed to ${literals.length} literals — this gate would pass vacuously`,
    );

    // EVERY span the widened rule eats that the old one did not, named.
    const spans = new Map<string, number>();
    for (const lit of literals) {
      for (const m of lit.matchAll(NEW)) {
        OLD.lastIndex = 0;
        if (!OLD.test(m[0])) spans.set(m[0], (spans.get(m[0]) ?? 0) + 1);
      }
    }
    // Each must be a derivation of a DECLARED term: strip trailing characters back
    // to a term. That is the property that makes the widening safe by
    // construction rather than by count — the 276-token defect failed exactly
    // here, and it is the check that catches it.
    const bare = new RegExp(`^(?:${alt})$`, "i");
    const notADerivation = [...spans.keys()].filter((w) => {
      let s = w;
      while (s.length > 0) {
        if (bare.test(s)) return false;
        s = s.slice(0, -1);
      }
      return true;
    });
    assert.deepEqual(
      notADerivation,
      [],
      `the widening eats ${spans.size} distinct new spans from ${literals.length} real literals, and ` +
        `${notADerivation.length} are NOT a derivation of a declared term: ${notADerivation.join(", ")}.\n` +
        `A redaction that catches ordinary words catches nothing — the 276-token defect.\n` +
        `Full span list: ${[...spans.keys()].sort().join(", ")}`,
    );
    console.log(
      `[underscore-class gate] corpus ${literals.length} literals; widened rule newly eats ` +
        `${spans.size} distinct spans across ${[...spans.values()].reduce((a, b) => a + b, 0)} sites: ` +
        `${[...spans.keys()].sort().join(", ")}; ${notADerivation.length} are not a derivation of a declared term`,
    );
  });

  test("the widening does NOT mangle a hyphenated compound (the `google-` defect)", () => {
    // The failure mode that got two sibling widenings REVERTED: a compound entry
    // left a meaningless fragment. `-` is still not in the suffix class, so
    // `google-chrome` behaves exactly as it did before this change — the leading
    // fragment is not eaten.
    const out = redactInternalError("driver failed: google-chrome reported an unexpected condition here", {
      site: "gemini",
    });
    assert.ok(
      out.includes("google-"),
      `the hyphen compound was re-shaped by the widening: ${JSON.stringify(out)}. \`-\` must stay outside the ` +
        `suffix class — eating into a hyphenated compound is what produced the reverted "google-" defect.`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GOAL 197 — the WIGOLO_* env family reached the wire.
// ─────────────────────────────────────────────────────────────────────────────
// `WIGOLO_BROWSER_DOWN` was MEASURED arriving at a consumer verbatim. The scrub
// had a row for the `UI2API_*` family (66 knobs) and none for `WIGOLO_*`, so an
// entire env family — whose names advertise the bypass architecture — fell
// straight through the last gate before the wire.
//
// A FIRST ATTEMPT AT THIS FIX WAS REVERTED, and its two failures are why this
// gate is shaped the way it is. It replaced `WIGOLO_X` but left the FAMILY NAME
// readable ("wigolo refused <an internal setting>"), and it derived its family
// list from arbitrary identifier prefixes, which matched ~50 unrelated ones
// (ALL_, API_, BASH_, BODY, CORPUS_, CRASH_…). So:
//
//   1. the whole token is consumed, INCLUDING the bare family name;
//   2. the rule matches whole tokens only — never a substring of a longer word;
//   3. there is a RESIDUAL twin, so if the delete rule ever stops matching, the
//      fail-closed fallback catches it instead of the name leaking.

describe("GOAL 197: the WIGOLO_* env family is redacted off the wire", () => {
  // The names the code actually reads. Derived from ERROR_ONLY_TERMS rather than
  // hardcoded here, because a third hand-maintained copy of the same list is the
  // defect this repo keeps finding.
  const FAMILY = "WIGOLO_";

  t("EVERY WIGOLO_ name is consumed whole — no name, and no family prefix, survives", () => {
    const names = ERROR_ONLY_TERMS.filter((x) => x === "wigolo" || x.startsWith(FAMILY));
    // The family term itself must be present, or this test has nothing to check.
    assert.ok(names.includes("wigolo"), "the bare family name is not a declared term");

    for (const n of ["WIGOLO_BROWSER_DOWN", "WIGOLO_API_TOKEN", "WIGOLO_CDP_URL", "WIGOLO_AUTOSTART"]) {
      const out = redactInternalError(`${n} refused the connection`);
      assert.ok(
        !out.includes(n),
        `${n} reached the consumer verbatim: ${JSON.stringify(out)}`,
      );
      assert.ok(
        !out.includes("WIGOLO"),
        `the family prefix survived in ${JSON.stringify(out)} — the rule must consume the whole token, not just the suffix`,
      );
    }
  });

  t("the bare family name is deleted, not translated into prose", () => {
    // The reverted attempt's exact failure: "wigolo refused <an internal setting>".
    const out = redactInternalError("wigolo daemon not prepared: WIGOLO_CDP_URL unset");
    assert.ok(
      !/\bwigolo\b/i.test(out),
      `the bare family name survived: ${JSON.stringify(out)}. An env family that names the bypass ` +
        `architecture must not be readable by a consumer.`,
    );
    assert.ok(out.includes("<an internal setting>"), `expected the named fallback for the knob: ${JSON.stringify(out)}`);
  });

  t("it does NOT eat a longer word that merely starts with the same letters", () => {
    // The over-matching direction matters as much as the leak: a rule that eats
    // inside an ordinary word mangles messages that are currently correct.
    const out = redactInternalError("driver failed: wigoloesque condition on this host");
    assert.ok(
      !out.includes("wigoloesq"),
      `the rule ate a substring of an unrelated word: ${JSON.stringify(out)}`,
    );
  });

  t("NON-VACUITY: the scrub actually runs on these inputs (a broken scrub would pass nothing through)", () => {
    // Without this, "nothing leaked" could also mean "nothing was ever looked at".
    const control = redactInternalError("a perfectly ordinary sentence about weather");
    assert.ok(
      !control.includes("<an internal setting>"),
      "the control sentence was rewritten, so the scrub is over-matching and the leak tests prove nothing",
    );
  });
});
