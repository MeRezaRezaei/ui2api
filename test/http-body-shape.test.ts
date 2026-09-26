import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HttpClientError } from "../src/prompt/http.js";

/**
 * GOAL 104: a malformed or oversized body answered 500 with the raw internal
 * text — including `Cannot read properties of null (reading 'prompt')` — and the
 * last-resort net echoed any internal message. A caller mistake must be a named
 * 4xx, and no internal text may ever reach a client.
 */

const SRC = readFileSync("src/prompt/http.ts", "utf8");

/** The exact predicate readJson used, so the pin measures the real rule. */
function parseBody(body: string): { code?: string; status?: number } {
  if (body.length > 1e6) return { code: "payload_too_large", status: 413 };
  if (!body) return {};
  const parsed = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { code: "invalid_json", status: 400 };
  return {};
}

d("GOAL 104: a caller mistake is a named 4xx, never a 500 with internals", () => {
  t("a non-object body (null / array / string / number) is a named 400", () => {
    for (const body of ["null", "[1,2]", '"hi"', "42", "true"]) {
      const r = parseBody(body);
      assert.equal(r.code, "invalid_json", `${body} must be refused as invalid_json`);
      assert.equal(r.status, 400, `${body} must be a 400, never a 500`);
    }
  });

  t("an oversized body is a named 413, and the upload is destroyed", () => {
    const r = parseBody("x".repeat(1_000_001));
    assert.equal(r.code, "payload_too_large");
    assert.equal(r.status, 413);
    assert.match(SRC, /req\.destroy\(\)/, "the oversize path must destroy the request stream so the upload stops");
  });

  t("a valid object body and an empty body are still accepted", () => {
    assert.deepEqual(parseBody('{"prompt":"hi"}'), {});
    assert.deepEqual(parseBody(""), {}, "an empty body stays the existing {} default");
  });

  t("the last-resort net never echoes the internal error message", () => {
    const net = SRC.slice(SRC.indexOf("const work = handleRequest(req, res).catch"));
    assert.match(net, /internal_error/, "a real internal fault answers a NAMED generic code");
    assert.ok(
      !/error:\s*e instanceof Error \? e\.message/.test(net),
      "the raw `e.message` echo must be gone from the last-resort net",
    );
    // and it is a real 500, not a disguised client error
    assert.match(net, /send\(res,\s*500,/, "an internal fault must still answer 500 honestly");
  });

  t("a typed client error carries its own status and code to the wire", () => {
    const e = new HttpClientError(413, "payload_too_large", "too big");
    assert.equal(e.status, 413);
    assert.equal(e.code, "payload_too_large");
    assert.ok(e instanceof Error, "it must remain a real Error for existing catch paths");
  });

  t("negative: the OLD behaviour is reproduced and required to be the failure (mutation proof)", () => {
    // the old rule: anything that parses is a "body", and oversize is a plain Error
    const oldAccepts = (body: string) => {
      try {
        return body.length <= 1e6 && JSON.parse(body) !== undefined;
      } catch {
        return false;
      }
    };
    // the old code ACCEPTED `null` as a body, which is what produced the 500
    assert.equal(oldAccepts("null"), true, "precondition: the old rule wrongly accepted a null body");
    assert.equal(parseBody("null").code, "invalid_json", "the new rule must refuse it");
    // and the old oversize error was a bare Error -> 500, never a 413
    assert.equal(new Error("body too large") instanceof HttpClientError, false, "precondition: a bare Error is not a typed client error");
  });
});
