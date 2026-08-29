import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { RegistryStore } from "../src/hub/store.js";
import { renderHubHtml } from "../src/hub/ui.js";
import { createHubRouter } from "../src/hub/api.js";

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

describe("Hub UI over HTTP", () => {
  it("serves HTML at / listing a published package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-ui-http-"));
    const store = new RegistryStore(dir);
    store.save("news.test", "1.0.0", { name: "news.test", version: "1.0.0", author: "a", authorizedUse: "own", license: "MIT", ui2api: "0.1.0" }, "export default {}");
    const srv = createServer(createHubRouter(store, { token: "t", registryUrl: "http://none" }));
    srv.listen(0);
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const r = await fetch(base + "/");
      const t = await r.text();
      assert.equal(r.headers.get("content-type")?.includes("text/html"), true);
      assert.ok(t.includes("news.test"));
    } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
