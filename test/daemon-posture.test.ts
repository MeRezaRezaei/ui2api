import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPromptd } from "../src/prompt/http.js";
import { daemonPosture, TOKEN_ENV, type Posture } from "../src/prompt/posture.js";

/**
 * GOAL 100: the daemon disclosed nothing about its own posture. These pins make
 * the disclosure (a) honest, (b) derived from the SAME env the enforcement reads,
 * (c) incapable of leaking a secret, and (d) actually responsive to the knobs.
 */

const BROWSER_SRC = readFileSync("src/runtime/browser.ts", "utf8");

d("GOAL 100: the daemon discloses its posture honestly", () => {
  t("reports the auth mode from the SAME env the gate reads", () => {
    assert.equal(daemonPosture({}).auth, "localhost-only", "no token -> localhost-only");
    assert.equal(daemonPosture({ [TOKEN_ENV]: "s3cret-token" }).auth, "token", "a set token -> token mode");
    assert.equal(daemonPosture({ [TOKEN_ENV]: "   " }).auth, "localhost-only", "a whitespace token is not a token");
  });

  t("served /health and /status actually carry the posture block", async () => {
    // THE DISCLOSURE MUST BE ON THE WIRE. This gate USED to be a source-proximity
    // pin — `req.url === "/health"[\s\S]{0,400}posture: daemonPosture(` — which
    // is not a behaviour at all: it measures how many characters of unrelated
    // work sit between two strings in a file, so any honest edit to the /health
    // body (a vault probe, a stuckness block, a comment) broke a green property
    // while a handler that dropped posture entirely and moved the prose around
    // could still pass. Measured gap at HEAD~1 was 1784 chars, at HEAD 2038 —
    // both far past 400, while the real handler (http.ts:1247) has always put
    // `posture: daemonPosture(process.env, bindAddr)` INSIDE the /health `send()`
    // object. So the code was RIGHT and the pin was WRONG.
    //
    // What replaces it asserts the PROPERTY: boot a real daemon on loopback,
    // GET both routes, and require a genuine posture report — same keys, same
    // values the in-process `daemonPosture()` computes for the same env/bind.
    // Anti-vacuity: a missing `posture` key fails loudly with the served keys
    // named, so "the block vanished" can never read as a pass.
    const dir = mkdtempSync(join(tmpdir(), "u2a-posture-wire-"));
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [], reaperIntervalMs: 0 });
    try {
      for (const route of ["/health", "/status"] as const) {
        const res = await fetch(`http://127.0.0.1:${svc.port}${route}`);
        assert.equal(res.status, 200, `${route} must answer 200`);
        const body = (await res.json()) as Record<string, unknown>;
        const served = body.posture as Posture | undefined;
        assert.ok(served && typeof served === "object", `${route} must carry a posture object; served keys were [${Object.keys(body).join(", ")}]`);
        // not just present — IDENTICAL to what the enforcement layer computes.
        // A /health that computed its own ad-hoc copy, or reported a stale bind,
        // would diverge here.
        assert.deepEqual(served, daemonPosture(process.env, "127.0.0.1"), `${route} posture must equal the real daemonPosture() for the same env + bind`);
        // the fields the disclosure exists to answer, each named
        for (const key of ["auth", "bind", "chromeNoSandbox", "singleProcess", "attachRootsCount", "warnings"]) {
          assert.ok(key in served!, `${route} posture must disclose "${key}" (GOAL 100)`);
        }
        assert.equal(served!.bind, "127.0.0.1", `${route} posture must report the address it actually bound`);
      }
    } finally {
      await svc.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
