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

  describe("user-chrome mode (VISION)", () => {
    function userChromeEnv() {
      clearEnv();
      process.env.UI2API_CHROME = "1";
      process.env.UI2API_USER_DATA_DIR = "/home/me/real-profile";
    }
    it("uses channel chrome + the user profile with NO hardening args", () => {
      userChromeEnv();
      const o = buildLaunchOptions() as any;
      assert.equal(o.channel, "chrome");
      assert.equal(o.userDataDir, "/home/me/real-profile");
      // The user's own Chrome must not get fingerprint-altering flags
      // (--no-sandbox/--disable-gpu/--disable-dev-shm-usage) — see docs/VISION.md.
      assert.ok(Array.isArray(o.args));
      assert.ok(!o.args.some((a: string) => a.includes("no-sandbox")));
      assert.ok(!o.args.some((a: string) => a.includes("disable-gpu")));
      assert.ok(!o.args.some((a: string) => a.includes("disable-dev-shm")));
    });
    it("bundled chromium keeps the hardening args", () => {
      clearEnv();
      const o = buildLaunchOptions() as any;
      assert.equal(o.channel, undefined);
      assert.ok(o.args.some((a: string) => a.includes("no-sandbox")));
    });
    it("exposes the user profile for wigolo passthrough", async () => {
      clearEnv();
      process.env.UI2API_USER_DATA_DIR = "/home/me/real-profile";
      const mod = await import("../src/runtime/browser.js");
      assert.equal(mod.userChromeProfile?.(), "/home/me/real-profile");
      assert.equal(mod.usingUserChrome?.(), true);
    });
  });
});
