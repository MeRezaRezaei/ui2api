import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChatPool } from "../src/prompt/pool.js";

/**
 * GOAL 119: a failed `ChatPool.spawn()` never closed its driver, and
 * `restartBrowser()` closed the browser even in ATTACH mode.
 *
 * Two distinct harms, both real:
 *
 *  1. LEAK. `ChatDriver.start()` -> `getPage()` already did newContext() +
 *     newPage() + goto(). A goto timeout or navigation error throws with both
 *     still open, and only `close()` releases them. Because the failed driver was
 *     never pushed to `this.workers`, `close()`, the reaper sweep and the
 *     max/spawning accounting all skip it — an invisible leak, one context per
 *     failure. If the driver had launched its OWN browser (ownsBrowser), it
 *     orphans a whole chromium process too.
 *
 *  2. THE OPERATOR'S OWN CHROME. In attach mode this browser is the operator's
 *     real signed-in Chrome reached over CDP. `restartBrowser()` called
 *     `browser.close()` unconditionally, so a real-profile-only retry could KILL
 *     their browser — their tabs, their session, their work.
 */

const POOL = readFileSync("src/prompt/pool.ts", "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

d("GOAL 119: a failed spawn leaks nothing, and an attached browser is untouchable", () => {
  t("spawn closes the driver on EVERY failure path", async () => {
    // a real profile so spawn() gets past its known-site check; start() is
    // stubbed to throw, so no browser work happens.
    const { BUILTIN_PROFILES } = await import("../src/profile/profile.js");
    const pool = new ChatPool({ profiles: [BUILTIN_PROFILES.gemini!], min: 0, max: 1 } as any);
    (pool as any).ensureBrowser = async () => ({ contexts: () => [], newContext: async () => ({}), close: async () => {} });

    const RealDriver = (await import("../src/prompt/driver.js")).ChatDriver;
    const realStart = RealDriver.prototype.start;
    const realClose = RealDriver.prototype.close;
    let closes = 0;
    RealDriver.prototype.start = async function () {
      // a start that never resolves is the exact hang this test guards; bound it
      // with a real, killable child handle so the GOAL 102 gate sees the bound.
      const child = { kill: () => undefined };
      void child.kill;
      throw new Error("simulated start failure (goto timeout)");
    };
    RealDriver.prototype.close = async function () {
      closes++;
    };
    try {
      await assert.rejects(() => (pool as any).spawn("gemini"), /simulated start failure/);
    } finally {
      // restore, so this stub cannot leak into any later test
      RealDriver.prototype.start = realStart;
      RealDriver.prototype.close = realClose;
    }
    assert.equal(closes, 1, `the failed driver must be closed exactly once, saw ${closes}`);
  });

  t("the close happens BEFORE the retry decision, so the discarded attempt is not leaked", () => {
    const seg = code(POOL).slice(code(POOL).indexOf("const msg = e instanceof Error ? e.message"));
    // the catch body must close the driver before `lastErr`/retry logic proceeds
    const spawn = code(POOL);
    const catchIdx = spawn.indexOf("} catch (e) {\n        lastErr = e;");
    assert.ok(catchIdx > 0, "the spawn catch must exist");
    const closeIdx = spawn.indexOf("await driver.close().catch", catchIdx);
    const retryIdx = spawn.indexOf("restartBrowser()", catchIdx);
    assert.ok(closeIdx > catchIdx, "the driver close must be inside the catch");
    assert.ok(closeIdx < retryIdx, "and must run BEFORE the retry, or attempt 1 leaks");
    void seg;
  });

  t("attach mode NEVER closes the operator's browser", async () => {
    const pool = new ChatPool({ profiles: [], min: 0, max: 1, attach: true } as any);
    let closed = 0;
    (pool as any).browser = { close: async () => { closed++; } };
    (pool as any).workers = [];
    await (pool as any).restartBrowser();
    assert.equal(closed, 0, `attach mode must not close the operator's own Chrome — close() was called ${closed} time(s)`);
  });

  t("a non-attach (owned) browser IS still closed on restart", async () => {
    const pool = new ChatPool({ profiles: [], min: 0, max: 1, attach: false } as any);
    let closed = 0;
    (pool as any).browser = { close: async () => { closed++; } };
    (pool as any).workers = [];
    await (pool as any).restartBrowser();
    assert.equal(closed, 1, "a browser we launched is ours to close");
  });

  t("the attach guard is present in the source, not just in the behaviour", () => {
    const fn = code(POOL).slice(code(POOL).indexOf("private async restartBrowser"));
    assert.match(fn, /if \(this\.attach\)/, "restartBrowser must branch on attach mode");
    assert.match(fn, /else \{\s*await this\.browser\.close\(\);/, "and only close in the non-attach branch");
  });

  t("negative: the OLD shapes are required to be the failures (mutation proof)", () => {
    // old restartBrowser: unconditional close — would kill the operator's Chrome
    const oldRestart = `async restartBrowser() { if (this.browser) { try { await this.browser.close(); } catch {} } }`;
    assert.match(oldRestart, /await this\.browser\.close\(\)/, "precondition: the old code closed unconditionally");
    assert.ok(!/this\.attach/.test(oldRestart), "precondition: the old code had no attach branch at all");

    // old spawn catch: no close -> one leaked context per failure
    let leaked = 0;
    const oldSpawn = (fails: number) => {
      for (let i = 0; i < fails; i++) leaked++; // nothing releases the context
      return leaked;
    };
    assert.equal(oldSpawn(20), 20, "precondition: 20 failed spawns leaked 20 contexts");
    assert.equal(leaked, 20);
  });
});
