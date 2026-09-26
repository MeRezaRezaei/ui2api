import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gmailSendConfirmed, GMAIL_SEND_UNVERIFIED } from "../src/capabilities/gmail.js";

/**
 * GOAL 101: `gmail_send` is the one capability that performs an IRREVERSIBLE
 * outward action, and its read-back was a tautology —
 *   /sent|message sent/i.test(body) || !/Send\b/.test(body)
 * — which returned true for a blank page, a logged-out page and a FAILED send
 * alike. These pins make claiming an unproven send structurally impossible.
 */

const SRC = readFileSync("src/capabilities/gmail.ts", "utf8");
const MANIFEST = readFileSync("capabilities/gmail/manifest.json", "utf8");

d("GOAL 101: gmail_send can never report an unproven send", () => {
  t("refuses a blank page, a logged-out page and a failed send", () => {
    assert.equal(gmailSendConfirmed({ confirmationText: "" }), false, "a blank page is not a sent confirmation");
    assert.equal(gmailSendConfirmed({ confirmationText: "   " }), false, "whitespace is not a confirmation");
    assert.equal(gmailSendConfirmed({ loggedOut: true, confirmationText: "Message sent" }), false, "logged out must refuse");
    assert.equal(gmailSendConfirmed({ sendFailed: true, confirmationText: "Message sent" }), false, "a visible send error must refuse");
    assert.equal(gmailSendConfirmed({}), false, "no evidence at all must refuse");
  });

  t("absence of the word Send is NEVER success (the tautology is gone)", () => {
    // the old predicate returned TRUE for every one of these
    for (const text of ["", "Inbox", "Compose", "Your account", "Draft saved"]) {
      assert.equal(gmailSendConfirmed({ confirmationText: text }), false, `"${text}" must not read as a send`);
    }
  });

  t("a body-wide nav label is not a confirmation; only a real phrase is", () => {
    // Gmail's own left nav contains "Sent" — the old /sent/i matched on that
    assert.equal(gmailSendConfirmed({ confirmationText: "Inbox Starred Snoozed Sent Drafts" }), false, "the nav label must not confirm a send");
    assert.equal(gmailSendConfirmed({ confirmationText: "Message sent" }), true, "a real confirmation phrase is accepted");
    assert.equal(gmailSendConfirmed({ confirmationText: "Your message was sent" }), true, "and its documented variant");
  });

  t("negative: the OLD tautology is proven to fail these pins (mutation proof)", () => {
    // Reproduce the exact predicate that shipped, and require that it FAILS —
    // if the old code could pass this file, the pin would be worthless.
    const oldPredicate = (t: string) => /sent|message sent/i.test(t) || !/Send\b/.test(t);
    for (const text of ["", "Inbox", "Draft saved", "Sign in to continue"]) {
      assert.equal(oldPredicate(text), true, "precondition: the old predicate wrongly claims success here");
      assert.equal(gmailSendConfirmed({ confirmationText: text }), false, "the fixed predicate must refuse what the old one accepted");
    }
  });

  t("the honest refusal is NAMED and the manifest's promise is now structural", () => {
    assert.match(GMAIL_SEND_UNVERIFIED, /login-gated/, "the refusal must name the real reason");
    assert.match(GMAIL_SEND_UNVERIFIED, /never reported as done|NEVER reported as done/i, "and state the no-fabrication contract");
    // the CODE no longer contains the tautology. Comments are stripped first,
    // because this file's own doc comment deliberately QUOTES the old predicate
    // to document what was replaced — matching a comment would be a false alarm.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\|\|\s*!\/Send\\b\//.test(code), "the tautology must be gone from the executable code");
    assert.ok(!/\.test\(t\)\s*\|\|/.test(code), "no body-wide substring test may stand in for a real read-back");
    // and the manifest claim is now true in code, not only in prose
    assert.match(MANIFEST, /stays login-gated until a live round-trip/, "the manifest promise is retained");
    assert.match(SRC, /GMAIL_SEND_UNVERIFIED/, "the call site must use the honest reason");
  });
});
