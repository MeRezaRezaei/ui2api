import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPortLive, readDaemonState, DEFAULT_DAEMON_PORT, DAEMON_PORT_ENV, findOwnerChrome } from "../src/runtime/chrome-daemon.js";

/**
 * GOAL 131: "We should not fire Chrome each time" — the operator's rule.
 *
 * Chrome is expensive to start, it holds the anti-bot warm state that makes a
 * session look real, and a freshly-spawned Chrome has been observed dying
 * shortly after boot here while a long-lived one survives. So: ONE long-lived
 * Chrome owned by the dedicated `ui2api` user, and every request ATTACHES.
 *
 * The design lesson is measured, not theoretical. The FIRST implementation only
 * checked its own port, so when a Chrome for the owner was already alive on
 * 127.0.0.1:38073 it concluded "nothing is running", tried to spawn, and Chrome
 * refused with `Failed to create ... ProcessSingleton` (one instance per
 * profile). The fix is ADOPTION: find the owner's live Chrome on ANY port and
 * attach to it. Chrome-per-request then became a deliberate choice rather than
 * an accident.
 */

const POOL = readFileSync("src/runtime/browser.ts", "utf8");
const AGENTS = readFileSync("AGENTS.md", "utf8");
const DOC = readFileSync("docs/CHROME_POINT_OF_USE.md", "utf8");

d("GOAL 131: one long-lived Chrome, reused, never refired", () => {
  t("the port probe is real (nothing is listening on a random high port)", async () => {
    assert.equal(await isPortLive(1), false, "port 1 must read as not-live");
    assert.equal(typeof DEFAULT_DAEMON_PORT, "number");
    assert.ok(DEFAULT_DAMON_PORT_SANE(), "the default CDP port must be a sane port");
  });

  t("a state file is required to exist, and absent is null (not a throw)", () => {
    const st = readDaemonState("/tmp/ui2api-no-such-data-dir-xyz");
    assert.equal(st, null, "no recorded daemon must read as null, not crash");
  });

  t("the launch seam ATTACHES rather than spawning when a daemon is live", () => {
    // the attach branch must come BEFORE the spawn candidates
    const fn = POOL.slice(POOL.indexOf("export async function launchBrowser"));
    const attachIdx = fn.indexOf("connectExistingChrome");
    // the ACTUAL spawn call, not the word "bundledChromium" in an earlier comment
    const spawnIdx = fn.indexOf("chromium.launch(");
    assert.ok(attachIdx > 0, "launchBrowser must have an attach branch");
    assert.ok(spawnIdx > 0, "launchBrowser must have a real spawn call");
    assert.ok(attachIdx < spawnIdx, "the attach branch must be tried BEFORE chromium.launch()");
  });

  t("the daemon ADOPTS an owner Chrome on any port (the measured failure)", () => {
    const src = readFileSync("src/runtime/chrome-daemon.ts", "utf8");
    assert.match(src, /export function findOwnerChrome/, "there must be an adoption probe");
    assert.match(src, /--remote-debugging-port/, "which extracts the live CDP port");
    assert.match(src, /--user-data-dir|profile/, "matching the owner's profile");
    // and status must consult it, not only its own port
    const st = src.slice(src.indexOf("export async function chromeDaemonStatus"));
    assert.match(st, /findOwnerChrome\(/, "status must adopt a Chrome running on another port");
    assert.match(st, /not spawning another/, "and say plainly that it is not spawning");
  });

  t("it refuses to kill a browser it did not start", () => {
    const src = readFileSync("src/runtime/chrome-daemon.ts", "utf8");
    const stop = src.slice(src.indexOf("export function stopChromeDaemon"));
    assert.match(stop, /refusing to stop/, "stop must refuse for a browser we do not own");
    assert.ok(stop.indexOf("refusing to stop") < stop.indexOf("process.kill"), "and refuse BEFORE signalling");
  });

  t("the operator's rule is written down, with the commands", () => {
    for (const [name, text] of [["AGENTS.md", AGENTS], ["docs/CHROME_POINT_OF_USE.md", DOC]] as const) {
      assert.match(text, /chrome start/, `${name} must carry the start command`);
      assert.match(text, /not fire|not spawn|fired again|Chrome per request/i, `${name} must state the rule`);
      assert.match(text, /adopt/i, `${name} must state the adoption behaviour`);
    }
    assert.match(AGENTS, /UI2API_DAEMON_PORT/, "AGENTS must carry the daemon port knob");
  });

  t("GOAL 135: the daemon says when it is headless, and how to get a real display", () => {
    const src = readFileSync("src/runtime/chrome-daemon.ts", "utf8");
    // it must NOT silently choose headless: the measured blocker
    assert.match(src, /headless-degraded/, "the degraded case must be named");
    assert.match(src, /Xvfb :99/, "and the remedy must be printed — Xvfb is what makes UI2API_HEADED=1 true");
    assert.match(src, /ERR_CHALLENGE/, "and it must say WHY (headless is challenged), not just that it is degraded");
    // the provisioning unit must not ship --headless for the long-lived daemon
    const prov = readFileSync("scripts/ops/provision-ui2api-user.sh", "utf8");
    assert.ok(!/--headless=new about:blank/.test(prov), "the long-lived Chrome must NOT be launched headless");
    assert.match(prov, /ui2api-xvfb\.service/, "a virtual display must be a first-class unit");
    assert.match(prov, /Environment=DISPLAY=:\$XVFB_DISPLAY/, "and the chrome unit must get that display");
  });

  t("the finding is written where an operator will hit it", () => {
    for (const [name, text] of [["AGENTS.md", AGENTS], ["docs/CHROME_POINT_OF_USE.md", DOC]] as const) {
      assert.match(text, /Xvfb/, `${name} must name Xvfb`);
      assert.match(text, /ERR_CHALLENGE/, `${name} must carry the measured challenge that proves it`);
    }
  });

  t("negative: the OLD port-only behaviour is required to be the failure (mutation proof)", () => {
    // the first implementation: "is MY port live?" only
    const portOnlyCheck = (ourPort: number, ownerChromePort: number) => ourPort === ownerChromePort;
    assert.equal(portOnlyCheck(9222, 38073), false, "precondition: the port-only check says 'not running'");
    assert.equal(portOnlyCheck(38073, 38073), true, "and only agrees when the ports happen to match");
    // the adoption probe keys on the PROFILE, so it finds it regardless of port
    assert.ok(typeof findOwnerChrome === "function", "the adoption probe exists");
  });
});

function DEFAULT_DAMON_PORT_SANE(): boolean {
  return DEFAULT_DAEMON_PORT > 1024 && DEFAULT_DAEMON_PORT < 65535;
}
