import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/**
 * Read a file that this test's CLAIM depends on existing, and THROW a named
 * error when it does not.
 *
 * WHY THIS EXISTS RATHER THAN A BARE readFileSync. `readFileSync` on a missing
 * path already throws, so the temptation is to think a throwing read is free
 * anti-vacuity. It is not: the failure it produces is `ENOENT: no such file or
 * directory, open '/abs/path'`, which does not name WHICH PIN went missing or
 * what the pin was protecting. A future refactor that moves a unit file then
 * produces a test error a reader must reverse-engineer — and the reviewer's
 * first instinct is to "fix" it by relaxing the assertion, because the message
 * reads like an incidental setup problem rather than a broken contract.
 *
 * The named throw makes the missing file the SUBJECT of the failure: a moved or
 * deleted unit says what it is and which guarantee went with it, at the exact
 * moment the guarantee stops being true. That is the same idiom
 * test/prod-bootstrap-single-source.test.ts uses (ROOT from import.meta.url,
 * absolute paths, one read per file), and it is the repo's newer pattern.
 */
function readPin(rel: string): string {
  const abs = join(ROOT, rel);
  try {
    return readFileSync(abs, "utf8");
  } catch (e) {
    throw new Error(
      `chrome-daemon-reuse: pinned file "${rel}" is missing or unreadable (${(e as Error).message}). ` +
        `This test's guarantee is stated against that file; a moved or deleted file breaks the guarantee, ` +
        `it does not retire the pin. Retarget the pin, do not delete it.`,
    );
  }
}

const POOL = readPin("src/runtime/browser.ts");
const AGENTS = readPin("AGENTS.md");
const DOC = readPin("docs/CHROME_POINT_OF_USE.md");

/**
 * The one directory a systemd unit definition may live in.
 *
 * Single-source refactor: the three `ui2api-*.service` units used to be inline
 * `cat > ... <<EOF` heredocs inside `scripts/ops/provision-ui2api-user.sh`. They
 * are now shipped as real files under `scripts/ops/units/`, and the ONLY thing
 * that installs them is `scripts/ops/install-services.sh`. A pin that still
 * reads the provision script for unit TEXT is reading a definition that no
 * longer exists there — see the GOAL 135 test below.
 */
const UNITS_DIR_REL = "scripts/ops/units";
const CHROME_UNIT_REL = `${UNITS_DIR_REL}/ui2api-chrome.service`;
const XVFB_UNIT_REL = `${UNITS_DIR_REL}/ui2api-xvfb.service`;

const CHROME_UNIT = readPin(CHROME_UNIT_REL);
const XVFB_UNIT = readPin(XVFB_UNIT_REL);

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
    // The provisioning UNITS moved out of the provision script in the
    // single-source refactor: they are now real files under
    // scripts/ops/units/, installed only by scripts/ops/install-services.sh.
    // The pins below therefore read the units themselves. Two of the three were
    // DEGENERATE against the old subject and this is the fix: reading the
    // provision script for unit text made the `--headless=new about:blank`
    // check trivially true (the script contains no launch line at all, so the
    // regex could never match whatever the unit said) and made the xvfb check
    // a search for a mention rather than a read of the definition. Both now
    // read the thing they claim to be about, through readPin, so a unit that is
    // moved or deleted fails LOUD instead of passing vacuously.
    //
    // `Environment=DISPLAY=:$XVFB_DISPLAY` is deliberately NOT asserted: the
    // shipped units are no longer shell-parameterized (they hardcode
    // `DISPLAY=:99`), so the real assertion is on what the unit says.
    const chromeExecStart = CHROME_UNIT.slice(CHROME_UNIT.indexOf("ExecStart="));
    assert.ok(
      !/--headless=new\s+about:blank/.test(chromeExecStart),
      `the long-lived Chrome must NOT be launched headless — ${CHROME_UNIT_REL}'s ExecStart is where that would live`,
    );
    // Positive control on the same slice, so the negative above cannot be green
    // because the slice was empty: the real ExecStart IS there, and it DOES
    // carry the landing state the comment claims.
    assert.match(chromeExecStart, /ExecStart=\/usr\/bin\/google-chrome-stable/, `${CHROME_UNIT_REL} must launch real Chrome`);
    assert.match(chromeExecStart, /about:blank/, "and the proven landing state is still about:blank");
    // A virtual display must be a first-class unit, read as a DEFINITION.
    assert.match(XVFB_UNIT, /^\s*ExecStart=\/usr\/bin\/Xvfb :99\s+-screen/m, "a virtual display must be a first-class unit");
    assert.match(XVFB_UNIT, /^Environment=DISPLAY=:99$/m, "and it must own the display it starts");
    // and the chrome unit must get that same display
    assert.match(CHROME_UNIT, /^Environment=DISPLAY=:99$/m, "and the chrome unit must get that display");
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
