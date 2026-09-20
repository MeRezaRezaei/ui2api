import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildRegistryPackages,
  capabilityInputSchema,
  bareCapabilityId,
} from "../src/prompt/registry.js";

describe("prompt registry", () => {
  it("derives a chat tool schema with prompt required and site toggles", () => {
    const s = capabilityInputSchema(
      "deepseek",
      "deepseek_chat",
      "ui-path",
      "composer + thinking toggle + search toggle on the wire"
    );
    assert.equal(s.type, "object");
    assert.deepEqual(s.required, ["prompt"]);
    assert.ok(s.properties.prompt);
    assert.ok(s.properties.thinking, "thinking toggle surfaced from manifest description");
    assert.ok(s.properties.search, "search toggle surfaced from manifest description");
  });

  it("derives toggle and read schemas for non-chat capabilities", () => {
    const toggle = capabilityInputSchema("deepseek", "deepseek_web_search", "ui-path", "flip Search");
    assert.equal(toggle.required.length, 0);
    assert.ok(toggle.properties.state);
    const read = capabilityInputSchema("deepseek", "deepseek_list_conversations", "ui-path", "sidebar");
    assert.ok(read.properties.limit, "read capabilities expose a limit hint");
  });

  it("strips the site prefix from capability ids for tool names", () => {
    assert.equal(bareCapabilityId("deepseek", "deepseek_chat"), "chat");
    assert.equal(bareCapabilityId("deepseek", "deepseek_list_conversations"), "list_conversations");
    assert.equal(bareCapabilityId("kimi", "model_list"), "model_list");
    // Hyphenated site, underscore-prefixed capability ids (tencent-aistudio).
    assert.equal(bareCapabilityId("tencent-aistudio", "tencent_aistudio_chat"), "chat");
  });

  it("builds registry packages from installed capability packages (served sites only)", () => {
    const packages = buildRegistryPackages();
    assert.ok(Array.isArray(packages));
    // Every installed package with a packaged profile is listed, chat model = site id.
    for (const pkg of packages) {
      assert.equal(pkg.chat.model, pkg.id);
      assert.equal(typeof pkg.name, "string");
      assert.ok(Array.isArray(pkg.tools));
      assert.equal(typeof pkg.status, "string");
      for (const tool of pkg.tools) {
        assert.ok(tool.name.startsWith(`${pkg.id}_`), `tool ${tool.name} namespaced by site`);
        assert.equal(typeof tool.id, "string", `tool ${tool.name} carries raw daemon capability id`);
        assert.equal(tool.inputSchema.type, "object");
        // The map contract distinguishes the two work types — driving the site's
        // own real UI (ui-path) versus calling the site's own JS function
        // (js-function) — and carries the reload policy so every language map
        // reflects "after each successful action the only thing we need to do
        // is to refresh the page".
        assert.ok(tool.workType === "ui-path" || tool.workType === "js-function");
        assert.equal(tool.reloadAfterSuccess, true);
      }
    }
  });
});