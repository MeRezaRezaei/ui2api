import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPackage } from "../src/registry/install.js";
import type { ActionMap } from "../src/types.js";

describe("installPackage", () => {
  it("downloads a package from a registry and generates its server", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-"));
    try {
      const map: ActionMap = {
        host: "example.test", url: "https://example.test/", capturedAt: new Date().toISOString(),
        auth: { required: false }, actions: [],
      };
      const srv = createServer((req, res) => {
        const body = JSON.stringify(
          req.url!.includes("metadata.json")
            ? { host: "example.test", name: "x", author: "a", authorizedUse: "own use", license: "MIT", ui2api: "0.1.0", trust: "unreviewed" }
            : map
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      const base = `http://127.0.0.1:${(srv.address() as any).port}`;
      const dir = await installPackage("example.test", base, tmp);
      assert.ok(existsSync(join(dir, "index.ts")), "server not generated");
      assert.ok(existsSync(join(tmp, "example.test", "action-map.json")));
      srv.close();
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
