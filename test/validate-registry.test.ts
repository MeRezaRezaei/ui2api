import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePackage } from "../scripts/validate-registry.mjs";

function writePkg(dir: string, meta: any, map: any) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "action-map.json"), JSON.stringify(map));
}

describe("validatePackage", () => {
  it("passes a clean authorized package", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      writePkg(join(tmp, "ok"), { host: "a.test", authorizedUse: "my own account", license: "MIT" },
        { host: "a.test", url: "https://a.test/", actions: [{ name: "do_thing", description: "do thing", execution: "replay", parameters: [], recipe: { kind: "js-function", target: "App.x", network: { method: "GET", url: "https://a.test/x" } }, result: { mode: "return" } }] });
      const r = validatePackage(join(tmp, "ok"));
      assert.equal(r.ok, true, r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
  it("rejects an evasion package", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      writePkg(join(tmp, "bad"), { host: "a.test", authorizedUse: "bypass cloudflare bot detection" },
        { host: "a.test", url: "https://a.test/", actions: [{ name: "do_thing", description: "solve captcha", execution: "replay", parameters: [], recipe: { kind: "js-function", target: "App.x", network: { method: "GET", url: "https://a.test/x" } }, result: { mode: "return" } }] });
      const r = validatePackage(join(tmp, "bad"));
      assert.equal(r.ok, false);
      assert.ok(r.errors.length > 0);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
