import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../src/hub/store.js";
import { HubRuntime } from "../src/hub/runtime.js";

describe("HubRuntime", () => {
  it("loads a published package into a managed instance with its tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-rt-"));
    try {
      const store = new RegistryStore(dir);
      const module = `export default { name: "demo.test", setup(c){ c.registerTool({ name:"ping", description:"p", inputSchema:{}, handler: async()=>({content:[{type:"text",text:"pong"}]}) }); } };`;
      store.save("demo.test", "1.0.0", { name: "demo.test", version: "1.0.0", author: "a", authorizedUse: "own", license: "MIT", ui2api: "0.1.0" }, module);
      const rt = new HubRuntime({ store, dataDir: dir });
      const inst = await rt.getInstance("demo.test");
      assert.equal(inst.host, "demo.test");
      assert.ok(inst.plugin.context, "context present");
      // The registered tool should be visible on the loaded plugin
      const toolNames = inst.plugin.tools ? [...inst.plugin.tools.values()].map((t:any)=>t.def.name) : [];
      assert.ok(toolNames.includes("ping"), `tools: ${toolNames.join(",")}`);
      await rt.closeInstance("demo.test");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
