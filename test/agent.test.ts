import { llmEnabled, llmProposeTasks } from "../src/mapper/llm.js";
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

// The no-LLM path is the FIRST branch of llmProposeTasks
// (`if (!llmEnabled()) return []`) — the promise it makes to callers is
// "no tasks proposed, and never throws". Assert the value it actually
// returns (an empty array), not merely that the value is an array.
describe("llmProposeTasks with no LLM configured", () => {
  test("llmEnabled() is false when base url and key are unset", () => {
    const prevBase = process.env.UI2API_LLM_BASE_URL;
    const prevKey = process.env.UI2API_LLM_KEY;
    const prevProvider = process.env.UI2API_LLM_PROVIDER;
    delete process.env.UI2API_LLM_BASE_URL;
    delete process.env.UI2API_LLM_KEY;
    delete process.env.UI2API_LLM_PROVIDER;
    try {
      assert.equal(llmEnabled(), false);
    } finally {
      if (prevBase === undefined) delete process.env.UI2API_LLM_BASE_URL; else process.env.UI2API_LLM_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.UI2API_LLM_KEY; else process.env.UI2API_LLM_KEY = prevKey;
      if (prevProvider === undefined) delete process.env.UI2API_LLM_PROVIDER; else process.env.UI2API_LLM_PROVIDER = prevProvider;
    }
  });

  test("returns an empty task list, and does not throw", async () => {
    const prevBase = process.env.UI2API_LLM_BASE_URL;
    const prevKey = process.env.UI2API_LLM_KEY;
    const prevProvider = process.env.UI2API_LLM_PROVIDER;
    delete process.env.UI2API_LLM_BASE_URL;
    delete process.env.UI2API_LLM_KEY;
    delete process.env.UI2API_LLM_PROVIDER;
    try {
      const t = await llmProposeTasks(["Search", "Go"], "site");
      // The behavioural claim: the no-LLM path yields NO proposed tasks.
      assert.deepEqual(t, []);
      assert.equal(t.length, 0);
    } finally {
      if (prevBase === undefined) delete process.env.UI2API_LLM_BASE_URL; else process.env.UI2API_LLM_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.UI2API_LLM_KEY; else process.env.UI2API_LLM_KEY = prevKey;
      if (prevProvider === undefined) delete process.env.UI2API_LLM_PROVIDER; else process.env.UI2API_LLM_PROVIDER = prevProvider;
    }
  });
});
