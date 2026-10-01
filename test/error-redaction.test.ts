import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { redactInternalError } from "../src/prompt/error-redaction.js";
import { consumerAccountRefusal } from "../src/prompt/consumer-surface.js";

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