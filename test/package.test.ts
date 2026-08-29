import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage, readPackage } from "../src/registry/package.js";
import type { ActionMap } from "../src/types.js";

describe("buildPackage", () => {
  it("bundles a site action-map into packages/<host>/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-pkg-"));
    try {
      const sites = join(tmp, "sites");
      const host = "example.test";
      mkdirSync(join(sites, host), { recursive: true });
      const map: ActionMap = {
        host, url: "https://example.test/", capturedAt: new Date().toISOString(),
        auth: { required: false }, actions: [],
      };
      writeFileSync(join(sites, host, "action-map.json"), JSON.stringify(map));
      const dir = buildPackage(host, sites, tmp, { author: "alice", use: "My own account" });
      assert.ok(existsSync(join(dir, "metadata.json")));
      assert.ok(existsSync(join(dir, "action-map.json")));
      const { metadata, map: m2 } = readPackage(dir);
      assert.equal(metadata.host, host);
      assert.equal(metadata.authorizedUse, "My own account");
      assert.equal(metadata.trust, "unreviewed");
      assert.equal(m2.host, host);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
