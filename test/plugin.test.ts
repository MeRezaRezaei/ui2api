import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createContext } from "../src/plugin/context.js";
import { loadPluginFromMap, loadPluginModule } from "../src/plugin/loader.js";
import { validateActionMap } from "../src/schema.js";
import type { ActionMap } from "../src/types.js";

describe("createContext", () => {
  it("exposes only the allow-listed surface", () => {
    const ctx = createContext({ dataDir: "/tmp" }, { baseUrl: "https://a.test" }) as any;
    for (const k of ["config", "logger", "registerTool", "analyse", "replay", "call", "session", "http", "dom"])
      assert.ok(ctx[k] !== undefined, `missing ${k}`);
    for (const f of ["launchBrowser", "BrowserSession", "generate", "validateActionMap"])
      assert.equal(ctx[f], undefined, `leaked ${f}`);
  });
});

const MAP: ActionMap = {
  host: "a.test", url: "https://a.test/", capturedAt: new Date().toISOString(), auth: { required: false },
  actions: [
    { name: "do_replay", description: "replay", execution: "replay", parameters: [], verified: false, recipe: { kind: "js-function", target: "App.x", argsFrom: {}, network: { method: "GET", url: "https://a.test/x" } }, result: { mode: "return" } },
    { name: "do_dom", description: "click", execution: "replay", parameters: [], verified: false, recipe: { kind: "dom-interaction", target: "#btn", argsFrom: {} }, result: { mode: "return" } },
  ],
};
describe("loader", () => {
  it("loads an action-map as a plugin with one tool per action", () => {
    const loaded = loadPluginFromMap(validateActionMap(MAP), { dataDir: "/tmp" }, "https://a.test");
    assert.equal(loaded.tools.size, 2);
    assert.ok(loaded.tools.has("do_replay") && loaded.tools.has("do_dom"));
  });
  it("loads a hand-written plugin module and runs its tool", async () => {
    const loaded = await loadPluginModule(new URL("./fixtures/sample-plugin.ts", import.meta.url).pathname, { dataDir: "/tmp/x" }, "https://a.test");
    const out = await loaded.tools.get("echo")!.handler({ hi: 1 }, {} as any) as any;
    assert.equal(out.echo.hi, 1); assert.equal(out.dataDir, "/tmp/x");
  });
  it("replay is SSRF-guarded without launching a browser", async () => {
    const loaded = loadPluginFromMap(validateActionMap(MAP), { dataDir: "/tmp" }, "https://a.test");
    await assert.rejects(() => loaded.tools.get("do_replay")!.handler({}, {} as any));
    const ctx = (await import("../src/plugin/context.js")).createContext({ dataDir: "/tmp" }, { baseUrl: "https://a.test" }) as any;
    await assert.rejects(() => ctx.replay({ url: "https://evil.test/x" }), /SSRF guard/);
  });
});
