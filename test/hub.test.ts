import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../src/hub/store.js";

describe("RegistryStore", () => {
  it("saves and resolves a package version", () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-store-"));
    try {
      const s = new RegistryStore(dir);
      s.save("example.test", "1.0.0", { name: "example.test", version: "1.0.0", author: "a", authorizedUse: "own use", license: "MIT", ui2api: "0.1.0" }, "export default {}");
      const v = s.get("example.test", "1.0.0")!;
      assert.equal(v.manifest.name, "example.test");
      assert.equal(v.trust, "unreviewed");
      assert.ok(s.get("example.test")!.manifest.version === "1.0.0");
      s.setTrust("example.test", "1.0.0", "reviewed");
      assert.equal(s.get("example.test", "1.0.0")!.trust, "reviewed");
      assert.equal(s.list().length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
