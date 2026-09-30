import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { redactInternalError } from "../src/prompt/error-redaction.js";

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