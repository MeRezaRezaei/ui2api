import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { sessionPath, saveCookies, loadCookies } from "../src/runtime/browser.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("session cookies", () => {
  test("cookies round-trip through save/load", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui2api-"));
    try {
      const p = sessionPath(dir, "example.test");
      saveCookies(p, [{ name: "a", value: "1", domain: "example.test", path: "/" }]);
      const c = loadCookies(p);
      assert.equal(c[0].name, "a");
      // The whole record must survive, not just the name.
      assert.deepEqual(c, [{ name: "a", value: "1", domain: "example.test", path: "/" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("sessionPath puts cookies under <outDir>/<host>/.session/cookies.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui2api-"));
    try {
      const p = sessionPath(dir, "example.test");
      assert.equal(p, join(dir, "example.test", ".session", "cookies.json"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("loadCookies returns [] for a path that was never written", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui2api-"));
    try {
      assert.deepEqual(loadCookies(sessionPath(dir, "never.test")), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("loadCookies returns [] for corrupt JSON instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui2api-"));
    try {
      const p = sessionPath(dir, "corrupt.test");
      saveCookies(p, []);
      writeFileSync(p, "{not json");
      assert.deepEqual(loadCookies(p), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("saveCookies creates the .session directory when it does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui2api-"));
    try {
      const p = sessionPath(dir, "fresh.test");
      saveCookies(p, [{ name: "s", value: "v" }]);
      assert.equal(loadCookies(p).length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
