import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPluginModule } from "../src/plugin/loader.js";

describe("gemini-web plugin (contract layer)", () => {
  it("registers Gemini's web abilities as callable tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-gemini-"));
    try {
      const loaded = await loadPluginModule(
        resolve("src/plugins/gemini-web.ts"),
        { dataDir: dir },
        "https://gemini.google.com"
      );
      const names = [...loaded.tools.values()].map((t) => t.def.name);
      for (const n of ["send_prompt", "new_chat", "read_last_response"]) {
        assert.ok(names.includes(n), `missing tool ${n} in ${names.join(",")}`);
      }
      assert.equal(loaded.manifest?.name, "gemini.google.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
