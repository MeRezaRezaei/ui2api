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

function mockPage(windowObj: any) {
  let reloaded = 0;
  const page: any = {
    evaluate: (recipe: string, args: unknown) =>
      // Run the real recipe against the stub window. The recipe is source text;
      // wrap it in a function body so it executes in this context.
      new Function(`return (${recipe})`)().call(null, args),
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
    const { page } = mockPage((globalThis as any).window);
    const r: JsCallResult = await execJsFunction(async () => page, idx);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { pong: "hello" });
    assert.equal(r.error, undefined);
  });

  it("honors explicit args override", async () => {
    stubWindow(true);
    const { page } = mockPage((globalThis as any).window);
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
    const { page } = mockPage((globalThis as any).window);
    const bad: JsFunctionIndex = { root: "UI2API", method: "flaky", params: [], sampleArgs: [] };
    const r = await execJsFunction(async () => page, bad);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /boom/);
  });

  it("reports ok:false when the indexed function is absent (honest)", async () => {
    stubWindow(false);
    const { page } = mockPage((globalThis as any).window);
    const r = await execJsFunction(async () => page, idx);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /not-a-function/);
  });

  it("reloads the page after success when reloadAfterSuccess is set (verbatim rule)", async () => {
    stubWindow(true);
    const { page, reloadCount } = mockPage((globalThis as any).window);
    const r = await execJsFunction(async () => page, idx, { reloadAfterSuccess: true });
    assert.equal(r.ok, true);
    assert.equal(reloadCount(), 1);
  });

  it("does NOT reload after failure", async () => {
    stubWindow(true);
    const { page, reloadCount } = mockPage((globalThis as any).window);
    const bad: JsFunctionIndex = { root: "UI2API", method: "flaky", params: [], sampleArgs: [] };
    await execJsFunction(async () => page, bad, { reloadAfterSuccess: true });
    assert.equal(reloadCount(), 0);
  });
});