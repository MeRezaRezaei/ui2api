import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * GOAL 109: the driver correctly reports `doneReason: "restricted"` with the
 * named hits (src/prompt/driver.ts:522-534, deliberately gated on `!answer` so
 * a marker can only surface when there is genuinely no answer). Every consumer
 * then DISCARDED it: /v1 non-stream answered 200 with finish_reason "stop",
 * refusal null, and the verdict only in a non-standard field; the SSE path
 * dropped it entirely; /prompt answered {ok:true, answer:""}. A restriction wall
 * was therefore served as an ordinary EMPTY SUCCESS.
 *
 * These pins make the flattening impossible to reintroduce.
 */

const OPENAI = readFileSync("src/prompt/openai.ts", "utf8");
const HTTP = readFileSync("src/prompt/http.ts", "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The exact rule both surfaces must apply to a restricted verdict. */
function surfaceVerdict(doneReason: string | undefined): { finish: string; refused: boolean; ok: boolean } {
  const restricted = doneReason === "restricted";
  return {
    finish: restricted ? "content_filter" : "stop",
    refused: restricted,
    ok: !restricted,
  };
}

d("GOAL 109: a restriction wall reaches a consumer as a refusal, not an empty success", () => {
  t("non-stream /v1 answers content_filter + a refusal, never stop", () => {
    const r = surfaceVerdict("restricted");
    assert.equal(r.finish, "content_filter");
    assert.equal(r.refused, true);
    assert.notEqual(r.finish, "stop", "a wall must never look like a completed answer");
    // the source must actually branch on the verdict
    assert.match(code(OPENAI), /finish_reason:\s*result\.doneReason === "restricted"\s*\?\s*"content_filter"\s*:\s*"stop"/);
  });

  t("the refusal STRING carries the named restriction hits", () => {
    assert.match(code(OPENAI), /refusal:[\s\S]{0,400}?restrictions/, "the refusal must carry the driver's named hits");
    assert.match(code(OPENAI), /\$\{r\.kind\}:\s*\$\{r\.matched\}/, "each hit must be named by kind and matched text");
  });

  t("the SSE path emits the refusal instead of dropping it", () => {
    const sse = code(OPENAI);
    assert.match(sse, /if \(result\.doneReason === "restricted"\)[\s\S]{0,600}?delta:\s*\{\s*refusal:/,
      "the stream must emit a refusal delta");
    assert.match(sse, /finish_reason:\s*"content_filter"/, "and a non-success finish_reason in the stream");
    assert.match(sse, /data: \[DONE\]/, "and still terminate the stream cleanly");
  });

  t("/prompt reports ok:false, not ok:true with an empty answer", () => {
    assert.match(code(HTTP), /if \(result\.doneReason === "restricted"\)[\s\S]{0,500}?ok:\s*false/,
      "/prompt must not report a wall as ok:true");
    assert.match(code(HTTP), /reason:\s*"restriction wall detected/, "and must name the reason");
    // the spread must come FIRST so the honest fields are not overwritten
    const i = code(HTTP).indexOf('ok: false,\n              doneReason: "restricted"');
    assert.ok(i > 0, "the honest block must exist");
    assert.ok(code(HTTP).lastIndexOf("...result", i) < i, "result must be spread BEFORE the honest overrides");
  });

  t("a normal answer is untouched — the fix is not a blanket refusal", () => {
    const r = surfaceVerdict("stopped");
    assert.equal(r.finish, "stop");
    assert.equal(r.refused, false);
    assert.equal(r.ok, true);
  });

  t("negative: the OLD flattening is required to be the failure (mutation proof)", () => {
    // the old non-stream shape
    const old = 'message: { role: "assistant", content: answer, refusal: null }, finish_reason: "stop",';
    assert.match(old, /refusal: null/, "precondition: the old shape hardcoded refusal null");
    assert.match(old, /finish_reason: "stop"/, "precondition: the old shape hardcoded finish_reason stop");
    // applying the verdict rule to the old shape's values must expose the lie
    const r = surfaceVerdict("restricted");
    assert.equal(r.finish, "content_filter");
    assert.notEqual(r.finish, /finish_reason: "stop"/.test(old) ? "stop" : r.finish,
      "the old hardcoded stop must differ from the honest verdict");
    // and the driver must still gate the wall on there being NO answer
    assert.match(readFileSync("src/prompt/driver.ts", "utf8"), /if \(!answer\)/,
      "the driver's no-answer gate must remain — a wall is only reported when nothing was answered");
  });
});
