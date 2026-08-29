import { strict as assert } from "node:assert";
import { describe as d } from "node:test";
import { sessionPath, saveCookies, loadCookies } from "../src/runtime/browser.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
d("session cookies round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-"));
  try {
    const p = sessionPath(dir, "example.test");
    saveCookies(p, [{ name: "a", value: "1", domain: "example.test", path: "/" }]);
    const c = loadCookies(p);
    assert.equal(c[0].name, "a");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
