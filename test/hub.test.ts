import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../src/hub/store.js";
import { createHubRouter } from "../src/hub/api.js";
import { createServer } from "node:http";

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

function startTestHub(dataDir: string, token = "op-secret") {
  const store = new RegistryStore(dataDir);
  const router = createHubRouter(store, { token, registryUrl: "http://none" });
  const server = createServer(router);
  server.listen(0);
  const port = (server.address() as any).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("Hub API", () => {
  it("rejects publish without token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-api-"));
    const { server, base } = startTestHub(dir);
    try {
      const r = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: {}, module: "x" }) });
      assert.equal(r.status, 401);
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("publishes and resolves with token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-api2-"));
    const { server, base } = startTestHub(dir);
    try {
      const manifest = { name: "x.test", version: "1.0.0", author: "a", authorizedUse: "own site use", license: "MIT", ui2api: "0.1.0" };
      const p = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest, module: "export default {}" }) });
      assert.equal(p.status, 200);
      const g = await fetch(`${base}/api/packages/x.test`);
      const j = await g.json() as any;
      assert.equal(j.manifest.name, "x.test");
      assert.equal(j.trust, "unreviewed");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
