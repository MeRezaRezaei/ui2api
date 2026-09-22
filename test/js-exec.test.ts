import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { execJsFunction, PAGE_JS_CALL, type JsFunctionIndex, type JsCallResult } from "../src/runtime/js-exec.js";

// Fully hermetic: no network, no browser. The executor is exercised through a
// mock page whose evaluate runs the real PAGE_JS_CALL recipe in a stub `window`
// (the same string the executor ships into the live page), plus unit tests for
// the reload-after-success verbatim rule and the error path.

function stubWindow(hasFn: boolean, callSeq: unknown[] = []) {
  const root: any = {};
  if (hasFn) {
    root.ping = function (...args: unknown[]) {
      callSeq.push(args);
      return { pong: args[0] };
    };
    root.flaky = function () {
      throw new Error("boom");
    };
  }
  (globalThis as any).window = { UI2API: root };
}

// Honest Playwright-evaluate mock. REAL Playwright semantics: when pageFunction
// is a FUNCTION it is serialized, re-instantiated in the page and called with
// arg; when it is a STRING it is evaluated as an EXPRESSION — it is never
// invoked with the arg, so passing the raw recipe string yields undefined
// (VERIFIED live on playwright 1.62.1: page.evaluate(PAGE_JS_CALL-as-string,
// arg) returned undefined). The aged mock treated the string as callable and
// ran it with the second arg — exactly why the seam-round-trip bug stayed
// hidden. A string is therefore: NOT callable. Only the fixed invocation (a
// real function that re-instantiates the recipe through new Function, the
// proven gemini-rpc hand-off) can run the page-side code here.
function mockPage() {
  let reloaded = 0;
  const page: any = {
    evaluate: async (pageFunction: unknown, arg?: unknown) => {
      if (typeof pageFunction === "string") {
        // String recipe passed raw -> real Playwright returns undefined; the
        // second argument is never bound into the expression.
        return undefined;
      }
      return await (pageFunction as (a?: unknown) => unknown)(arg);
    },
    reload: async () => {
      reloaded++;
    },
  };
  return { page, reloadCount: () => reloaded };
}

const idx: JsFunctionIndex = { root: "UI2API", method: "ping", params: ["arg"], sampleArgs: ["hello"] };

describe("execJsFunction", () => {
  it("calls window.<root>.<method> with sampleArgs and returns the value", async () => {
    stubWindow(true);
    const { page } = mockPage();
    const r: JsCallResult = await execJsFunction(async () => page, idx);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { pong: "hello" });
    assert.equal(r.error, undefined);
  });

  it("honors explicit args override", async () => {
    stubWindow(true);
    const { page } = mockPage();
    const callSeq: unknown[] = [];
    // re-stub so we can observe args
    const root: any = {};
    root.ping = (...args: unknown[]) => callSeq.push(args);
    (globalThis as any).window = { UI2API: root };
    const r = await execJsFunction(async () => page, idx, { args: ["world", 42] });
    assert.equal(r.ok, true);
    assert.deepEqual(callSeq, [["world", 42]]);
  });

  it("reports ok:false + error when the function throws", async () => {
    stubWindow(true);
    const { page } = mockPage();
    const bad: JsFunctionIndex = { root: "UI2API", method: "flaky", params: [], sampleArgs: [] };
    const r = await execJsFunction(async () => page, bad);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /boom/);
  });

  it("reports ok:false when the indexed function is absent (honest)", async () => {
    stubWindow(false);
    const { page } = mockPage();
    const r = await execJsFunction(async () => page, idx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /not-a-function/);
  });

  it("reloads the page after success when reloadAfterSuccess is set (verbatim rule)", async () => {
    stubWindow(true);
    const { page, reloadCount } = mockPage();
    const r = await execJsFunction(async () => page, idx, { reloadAfterSuccess: true });
    assert.equal(r.ok, true);
    assert.equal(reloadCount(), 1);
  });

  it("does NOT reload after failure", async () => {
    stubWindow(true);
    const { page, reloadCount } = mockPage();
    const bad: JsFunctionIndex = { root: "UI2API", method: "flaky", params: [], sampleArgs: [] };
    await execJsFunction(async () => page, bad, { reloadAfterSuccess: true });
    assert.equal(reloadCount(), 0);
  });

  it("subscribes observable returns (site-own dispatch pattern) and records network hits", async () => {
    const root: any = {};
    const hits: unknown[] = [];
    root.stream = function () {
      // Mirror a gemini-style sender: builds an observable; the fetch fires only
      // when the site (or the seam, standing in for it) subscribes.
      return {
        subscribe(obs: any) {
          // sync fetch like gemini's dTi -> network hit inside the page
          (globalThis as any).window.fetch("/_/BardChatUi/data/batchexecute", { method: "GET" }).catch(() => {});
          if (obs && typeof obs.next === "function") obs.next({});
          if (obs && typeof obs.complete === "function") obs.complete();
          return { unsubscribe() {} };
        },
      };
    };
    (globalThis as any).window = { UI2API: root };
    // stub window.fetch as a plain function so PAGE_JS_CALL's hit capture wraps it
    (globalThis as any).window.fetch = async (u: string) => ({ ok: true });
    const { page } = mockPage();
    const sIdx: JsFunctionIndex = { root: "UI2API", method: "stream", params: [], sampleArgs: [] };
    const r: JsCallResult = await execJsFunction(async () => page, sIdx);
    assert.equal(r.ok, true);
    assert.equal(r.subscribed, true);
    assert.equal(r.networkHits.length, 1);
    assert.deepEqual(r.networkHits[0], { url: "/_/BardChatUi/data/batchexecute", method: "GET" });
  });

  it("regression: a raw string recipe is NOT callable through bare evaluate (Playwright string-as-expression semantics)", async () => {
    stubWindow(true);
    const { page } = mockPage();
    // Real Playwright evaluates a string pageFunction as an EXPRESSION and
    // never binds the second argument — the wrapped form the executor now
    // ships re-instantiates PAGE_JS_CALL via new Function instead (gemini-rpc
    // precedent). Passing the raw string here must NOT run the call.
    const raw = await page.evaluate(PAGE_JS_CALL, {
      root: "UI2API",
      method: "ping",
      args: ["hello"],
      captureNetworkHits: true,
    });
    assert.equal(raw, undefined);
    // And the fixed wrapper — the only honest path — still round-trips.
    const r: JsCallResult = await execJsFunction(async () => page, idx);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { pong: "hello" });
  });
});