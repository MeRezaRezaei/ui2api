import { llmProposeTasks } from "../src/mapper/llm.js";
import { strict as assert } from "node:assert";
import { describe as d } from "node:test";
d("llmProposeTasks returns [] without LLM", async () => {
  delete process.env.UI2API_LLM_BASE_URL;
  const t = await llmProposeTasks(["Search", "Go"], "site");
  assert.ok(Array.isArray(t));
});
