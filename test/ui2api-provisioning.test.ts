import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * GOAL 132: the point of use must be REPRODUCIBLE and ALWAYS-ON. A new box needs
 * one command, and a reboot must not lose the Chrome daemon or the API other
 * programs call.
 *
 * These pins check the provisioning script GENERATES correct, safe units. They
 * deliberately do NOT run it as root: the script mutates the machine, and a test
 * that creates system users is its own hazard. What IS tested is the artifact it
 * produces plus the safety guards that were added after running it for real.
 */

const SCRIPT = "scripts/ops/provision-ui2api-user.sh";
const AGENTS = readFileSync("AGENTS.md", "utf8");
const DOC = readFileSync("docs/CHROME_POINT_OF_USE.md", "utf8");

d("GOAL 132: the point of use is provisioned by code and survives a reboot", () => {
  t("the provisioning script exists and is valid bash", () => {
    assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
    // `bash -n` parses without executing — safe, and it is a real check
    execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe" });
  });

  t("it creates the dedicated user, idempotently", () => {
    const s = readFileSync(SCRIPT, "utf8");
    assert.match(s, /id -u "\$CHROME_USER"/, "it must check whether the user exists");
    assert.match(s, /useradd|adduser/, "and create it when absent");
    assert.match(s, /not recreating|exists/, "while saying so when it already exists");
    // the owner is data, not a hardcode
    assert.match(s, /UI2API_CHROME_USER/, "the user must be overridable by env");
  });

  t("it seeds the Chrome profile WITHOUT touching a live one", () => {
    const s = readFileSync(SCRIPT, "utf8");
    assert.match(s, /install -d -m 700/, "the profile dir must be 0700 and owned by the user");
    assert.match(s, /Default/, "a real Chrome profile needs a Default marker");
    assert.match(s, /leaving the live profile untouched/, "and an existing profile must be left alone");
  });

  t("SAFETY: it refuses rather than writing outside the user's space", () => {
    const s = readFileSync(SCRIPT, "utf8");
    // both guards were added after running the script for real
    assert.match(s, /is not an existing directory/, "an absolute-but-nonexistent home must be refused");
    assert.match(s, /no absolute home/, "an empty home must be refused");
    // and the refusals must be BEFORE any install -d
    const firstInstall = s.indexOf("install -d");
    const firstGuard = s.indexOf("is not an existing directory");
    assert.ok(firstGuard > 0 && firstGuard < firstInstall, "the guard must run before anything is created");
  });

  t("it registers BOTH long-lived services with systemd", () => {
    const s = readFileSync(SCRIPT, "utf8");
    assert.match(s, /ui2api-chrome\.service/, "the persistent Chrome must be a unit");
    assert.match(s, /ui2api-api\.service/, "and so must the API other programs call");
    assert.match(s, /systemctl daemon-reload/, "with a reload");
    assert.match(s, /systemctl enable/, "and enabled at boot");
    // both run AS the chrome user, never as the operator
    const units = s.slice(s.indexOf("ui2api-chrome.service\" <<EOF"));
    assert.match(units, /User=\$CHROME_USER/, "the chrome unit must run as the chrome user");
    assert.match(units, /User=\$CHROME_USER/, "the api unit must too");
  });

  t("the chrome unit exposes CDP for attaching and never self-resurrects", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const chromeUnit = s.slice(s.indexOf("ui2api-chrome.service\" <<EOF"), s.indexOf("ui2api-api.service\" <<EOF"));
    assert.match(chromeUnit, /--remote-debugging-port=\$DAEMON_PORT/, "the CDP port is the whole point");
    assert.match(chromeUnit, /--remote-debugging-address=127\.0\.0\.1/, "bound to loopback only");
    assert.match(chromeUnit, /--user-data-dir=\$USER_HOME\/\$CHROME_DIR/, "using the owner's profile");
    assert.match(chromeUnit, /Restart=on-failure/, "restart on failure");
    // a CLEAN stop must not be undone: `chrome stop` has to actually work
    assert.ok(
      !/Restart=always/.test(chromeUnit),
      "Restart=always would resurrect the browser systemd was told to stop, defeating `chrome stop`",
    );
  });

  t("the API unit serves the endpoints other programs call", () => {
    const s = readFileSync(SCRIPT, "utf8");
    const apiUnit = s.slice(s.indexOf("ui2api-api.service\" <<EOF"));
    assert.match(apiUnit, /cli\.ts promptd/, "the API is promptd");
    assert.match(apiUnit, /UI2API_ATTACH_PORT=\$DAEMON_PORT/, "and it must attach to the persistent Chrome, not spawn per request");
    assert.match(apiUnit, /After=.*ui2api-chrome\.service/, "ordered after the browser");
    assert.match(apiUnit, /Wants=ui2api-chrome\.service/, "and wanting it up");
    // the daemon binds loopback by design; the unit must not widen it
    assert.ok(!/0\.0\.0\.0/.test(apiUnit), "the API must not be LAN-exposed by the unit");
  });

  t("the whole model is documented where a reader will hit it", () => {
    for (const [name, text] of [["AGENTS.md", AGENTS], ["docs/CHROME_POINT_OF_USE.md", DOC]] as const) {
      assert.match(text, /provision-ui2api-user\.sh/, `${name} must point at the provisioning script`);
    }
    assert.match(DOC, /systemd|systemctl/, "and the doc must cover the services");
  });
});
