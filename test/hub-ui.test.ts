import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../src/hub/store.js";
import { renderHubHtml } from "../src/hub/ui.js";

describe("Hub UI", () => {
  it("renders a package row with trust badge", () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-ui-"));
    try {
      const store = new RegistryStore(dir);
      store.save("shop.test", "1.2.0", { name: "shop.test", version: "1.2.0", author: "a", authorizedUse: "own", license: "MIT", ui2api: "0.1.0" }, "export default {}");
      const html = renderHubHtml(store, { registryUrl: "http://none" });
      assert.ok(html.includes("shop.test"), "shows package name");
      assert.ok(html.includes("unreviewed"), "shows trust badge");
      assert.ok(html.includes("PUT /api/packages"), "has publish form");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
