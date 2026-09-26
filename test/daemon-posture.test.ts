import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daemonPosture, TOKEN_ENV } from "../src/prompt/posture.js";

/**
 * GOAL 100: the daemon disclosed nothing about its own posture. These pins make
 * the disclosure (a) honest, (b) derived from the SAME env the enforcement reads,
 * (c) incapable of leaking a secret, and (d) actually responsive to the knobs.
 */

const HTTP_SRC = readFileSync("src/prompt/http.ts", "utf8");
const BROWSER_SRC = readFileSync("src/runtime/browser.ts", "utf8");

d("GOAL 100: the daemon discloses its posture honestly", () => {
  t("reports the auth mode from the SAME env the gate reads", () => {
    assert.equal(daemonPosture({}).auth, "localhost-only", "no token -> localhost-only");
    assert.equal(daemonPosture({ [TOKEN_ENV]: "s3cret-token" }).auth, "token", "a set token -> token mode");
    assert.equal(daemonPosture({ [TOKEN_ENV]: "   " }).auth, "localhost-only", "a whitespace token is not a token");
  });

  t("served /health and /status actually carry the posture block", () => {
    // the disclosure must be on the WIRE, not merely computed somewhere
    assert.match(HTTP_SRC, /req\.url === "\/health"[\s\S]{0,400}posture: daemonPosture\(/, "/health must carry posture");
    assert.match(HTTP_SRC, /req\.url === "\/status"[\s\S]{0,400}posture: daemonPosture\(/, "/status must carry posture");
  });

  t("the reported sandbox flag mirrors browser.ts's real condition", () => {
    // browser.ts: `--no-sandbox` unless a real profile OR the knob is "0"
    assert.match(BROWSER_SRC, /UI2API_CHROME_NO_SANDBOX === "0"/, "browser.ts condition changed — posture must follow");
    assert.equal(daemonPosture({}).chromeNoSandbox, true, "default posture on this box IS sandbox-disabled");
    assert.equal(daemonPosture({ UI2API_CHROME_NO_SANDBOX: "0" }).chromeNoSandbox, false, "the documented opt-out flips it");
  });

  t("NEVER leaks a secret value — only shapes and counts", () => {
    const SECRET = "super-secret-token-value";
    const p = daemonPosture({ [TOKEN_ENV]: SECRET, UI2API_ATTACH_ROOTS: "/home/me/private:/srv/x" });
    const serialised = JSON.stringify(p);
    assert.ok(!serialised.includes(SECRET), "the token VALUE must never appear in the posture block");
    // an attach ROOT is a filesystem location — report the count, never the path
    assert.ok(!serialised.includes("/home/me/private"), "attach root PATHS must never be disclosed");
    assert.equal(p.attachRootsCount, 2, "the count is disclosed instead");
    assert.equal(p.auth, "token", "the auth MODE is disclosed instead");
  });

  t("warns honestly on the dangerous combinations", () => {
    const open = daemonPosture({}, "0.0.0.0");
    assert.ok(open.warnings.some((w) => /NO token/.test(w)), "a non-loopback bind with no token must warn loudly");
    const roots = daemonPosture({ UI2API_ATTACH_ROOTS: "/a:/b:/c" });
    assert.ok(roots.warnings.some((w) => /3 attach root/.test(w)), "widened attach roots must warn with the real count");
    const none = daemonPosture({});
    assert.ok(none.warnings.some((w) => /attach path form refused/.test(w)), "the closed default must be stated, not implied");
  });

  t("negative: the report RESPONDS to a trust knob flipping (mutation proof)", () => {
    const before = daemonPosture({ UI2API_SINGLE_PROCESS: "0" });
    const after = daemonPosture({ UI2API_SINGLE_PROCESS: "1" });
    assert.equal(before.singleProcess, false);
    assert.equal(after.singleProcess, true, "flipping the env must change the reported posture");
    assert.ok(!before.warnings.some((w) => /SINGLE_PROCESS/.test(w)));
    assert.ok(after.warnings.some((w) => /SINGLE_PROCESS/.test(w)), "the new posture must raise its own warning");
  });
});
