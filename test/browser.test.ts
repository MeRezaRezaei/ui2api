import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";
import { buildLaunchOptions } from "../src/runtime/browser.js";

function clearEnv() {
  for (const k of ["UI2API_CHROME", "UI2API_CHROME_PATH", "UI2API_USER_DATA_DIR"]) delete process.env[k];
}
afterEach(clearEnv);

describe("buildLaunchOptions", () => {
  it("defaults to bundled chromium (no channel)", () => {
    clearEnv();
    const o = buildLaunchOptions() as any;
    assert.equal(o.channel, undefined);
    assert.ok(Array.isArray(o.args));
  });
  it("uses system Chrome when UI2API_CHROME=1", () => {
    clearEnv();
    process.env.UI2API_CHROME = "1";
    assert.equal((buildLaunchOptions() as any).channel, "chrome");
  });
  it("reads executable path and user-data-dir from env", () => {
    clearEnv();
    process.env.UI2API_CHROME_PATH = "/usr/bin/google-chrome";
    process.env.UI2API_USER_DATA_DIR = "/home/me/profile";
    const o = buildLaunchOptions() as any;
    assert.equal(o.executablePath, "/usr/bin/google-chrome");
    assert.equal(o.userDataDir, "/home/me/profile");
  });
  it("overrides take precedence over env", () => {
    clearEnv();
    process.env.UI2API_USER_DATA_DIR = "/from/env";
    const o = buildLaunchOptions({ userDataDir: "/override" }) as any;
    assert.equal(o.userDataDir, "/override");
  });
});
