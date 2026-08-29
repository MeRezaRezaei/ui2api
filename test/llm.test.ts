import { llmEnabled, llmDescribe } from "../src/mapper/llm.js";
import { describe as d } from "node:test";
import { strict as assert } from "node:assert";
d("llmEnabled is false without env", () => {
  const prev = process.env.UI2API_LLM_BASE_URL;
  delete process.env.UI2API_LLM_BASE_URL;
  assert.equal(llmEnabled(), false);
  if (prev) process.env.UI2API_LLM_BASE_URL = prev;
});
d("llmDescribe falls back when disabled", async () => {
  delete process.env.UI2API_LLM_BASE_URL;
  const r = await llmDescribe("send a prompt", "js-function App.sendPrompt(prompt,model)");
  assert.match(r.name, /^[a-z][a-z0-9_]*$/);
  assert.ok(r.description.length > 0);
});
