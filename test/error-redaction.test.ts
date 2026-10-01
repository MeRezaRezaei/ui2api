import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { redactInternalError, INTERNAL_WORD_RE } from "../src/prompt/error-redaction.js";
import {
  consumerAccountRefusal,
  consumerProse,
  CONCEPT_TERMS,
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
    "did not return an answer",
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
