import { generate } from "../src/generator/generate.js";
import { validateActionMap } from "../src/schema.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe as d } from "node:test";
import { strict as assert } from "node:assert";
d("generate emits both mcp and acp servers", () => {
  const map = validateActionMap({ host: "example.test", url: "https://example.test", capturedAt: new Date().toISOString(), auth: { required: false }, actions: [
    { name: "do_thing", description: "do a thing", execution: "replay", parameters: [{ name: "x", type: "string", required: true }], recipe: { kind: "js-function", target: "window.App.doThing", argsFrom: { x: "x" }, network: { method: "POST", url: "/api/x", requestBody: "{}" } }, result: { mode: "return" }, verified: true },
  ] });
  const dir = generate(map, resolve("sites"), "acp");
  assert.ok(existsSync(resolve(dir, "acp.ts")), "acp server missing");
  const src = readFileSync(resolve(dir, "acp.ts"), "utf8");
  assert.ok(src.includes("list_tools") && src.includes("call_tool"), "acp must implement list/call");
});
d("generate writes a skill wrapper when requested", () => {
  const map = validateActionMap({ host: "example.test", url: "https://example.test", capturedAt: new Date().toISOString(), auth: { required: false }, actions: [
    { name: "do_thing", description: "do a thing", execution: "replay", parameters: [], recipe: { kind: "js-function", target: "window.App.doThing", argsFrom: {} }, result: { mode: "return" }, verified: true },
  ] });
  const dir = generate(map, resolve("sites"), "mcp", { skill: true });
  assert.ok(existsSync(resolve(dir, "SKILL.md")), "SKILL.md missing");
  assert.ok(existsSync(resolve(dir, "skill-loader.mjs")), "skill-loader missing");
});
