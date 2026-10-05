import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPromptEcho } from "../src/prompt/driver.js";

/**
 * GOAL 114: the answer readback had NO echo guard, so the driver could return the
 * USER'S OWN PROMPT as a successful answer.
 *
 * MEASURED before the fix, through the real reducer
 * (`awaitAnswerFromReads(read, {timeoutMs:4000, stableMs:200, pollMs:10}, base)`):
 *   {"text":"Explain in detail the entire history of the Byzantine empire…",
 *    "chunkCount":21,"doneReason":"stable"}   returned the USER PROMPT: true
 *
 * Reachable with the REAL builtin profiles, not a synthetic fixture: `copilot`
 * uses `[data-message-type="text"]`, `huggingchat` uses `[data-testid="message"]`,
 * and the builtin at src/profile/profile.ts:425 uses `[class*="message"]` — all
 * of which match the user bubble. `maxFresh` only ever grows, so a page that
 * once echoed could never recover.
 */

const DRIVER = readFileSync("src/prompt/driver.ts", "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const PROMPT =
  "Explain in detail the entire history of the Byzantine empire, including the Justinianic reforms.";

d("GOAL 114: never serve the user's own prompt back as the answer", () => {
  t("the exact measured false positive is now an echo", () => {
    assert.equal(isPromptEcho(PROMPT, PROMPT), true, "the verbatim prompt echo MUST be detected");
  });

  t("a genuinely different answer is NOT an echo", () => {
    const answer = "The Byzantine Empire began in 330 AD when Constantine founded Constantinople.";
    assert.equal(isPromptEcho(answer, PROMPT), false, "a real answer must still be servable");
  });

  t("an echo wrapped in a slightly larger region is still caught", () => {
    // the answer region can be a container that includes the user's bubble
    assert.equal(isPromptEcho(`You said: ${PROMPT}`, PROMPT), true, "a contained verbatim echo must be caught");
  });

  t("the guard is NARROW — shared vocabulary must not trigger it", () => {
    // a real answer that legitimately repeats a phrase from the prompt
    const answer = "The Byzantine Empire's history is long; you asked about the Justinianic reforms, which came later.";
    assert.equal(isPromptEcho(answer, PROMPT), false, "the guard must not be a blunt word-overlap filter");
    assert.equal(isPromptEcho("Byzantine Empire", PROMPT), false, "a short shared phrase is not an echo");
  });

  t("empty inputs are not echoes (an empty answer is handled elsewhere)", () => {
    assert.equal(isPromptEcho("", PROMPT), false);
    assert.equal(isPromptEcho(PROMPT, ""), false);
    assert.equal(isPromptEcho("   ", "   "), false);
  });

  t("the driver REFUSES an echo by name instead of serving it", () => {
    const src = code(DRIVER);
    assert.match(src, /if \(isPromptEcho\(answer, prompt\)\)/, "askOnce must consult the echo verdict");
    assert.match(src, /throw new DriverRefusal\(\s*`answer-echo on/, "and it must throw a NAMED, TYPED refusal — the name states the cause and the TYPE is what lets `POST /prompt` answer it as itself (502 `ui2api_driver_error`) instead of erasing it into an anonymous 500; a bare `Error` here is the defect that erasure came from");
    assert.match(src, /answer selector matches the USER bubble/, "the message must name the actual cause");
  });

  t("the readback still has no path that treats an echo as `stable`", () => {
    // the pre-fix flow let a non-empty echo fall through to the success return
    const src = code(DRIVER);
    const guard = src.indexOf("if (isPromptEcho(answer, prompt))");
    const restrictions = src.indexOf("readRestrictions()", guard);
    assert.ok(guard > 0, "the guard must exist");
    assert.ok(restrictions > guard, "the guard must run BEFORE the success path continues");
  });

  t("negative: the OLD behaviour is required to be the failure (mutation proof)", () => {
    // the old rule: any non-empty fresh text that stops growing is a stable answer
    const oldVerdict = (observed: string) => (observed.trim() ? "stable" : "empty");
    assert.equal(oldVerdict(PROMPT), "stable", "precondition: the old rule returned the echo as a stable success");
    assert.equal(isPromptEcho(PROMPT, PROMPT), true, "the new verdict catches what the old one served");
    assert.notEqual(oldVerdict(PROMPT), "echo", "precondition: the old rule had no echo verdict at all");
  });
});
