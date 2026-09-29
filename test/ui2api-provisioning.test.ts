import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GOAL 132: the point of use must be REPRODUCIBLE and ALWAYS-ON. A new box needs
 * one command, and a reboot must not lose the Chrome daemon or the API other
 * programs call.
 *
 * These pins check the provisioning script GENERATES correct, safe units. They
 * deliberately do NOT run it as root: the script mutates the machine, and a test
 * that creates system users is its own hazard. What IS tested is the artifact it
 * produces plus the safety guards that were added after running it for real.
 *
 * ---------------------------------------------------------------- RETARGETED --
 * The provisioning script used to GENERATE all three systemd units itself, via
 * three inline `cat > .../ui2api-*.service <<EOF` heredocs. That is gone. The
 * units now have exactly ONE definition, in `scripts/ops/units/`, installed only
 * by `scripts/ops/install-services.sh`; the provision script DELEGATES. The unit
 * assertions below therefore read the real unit FILES.
 *
 * WHY THAT IS CORRECTNESS, NOT COSMETICS. The old pins did:
 *
 *     const units = s.slice(s.indexOf("ui2api-chrome.service\" <<EOF"));
 *
 * `indexOf` returns **-1** once the anchor is gone, and `slice(-1)` returns the
 * **WHOLE FILE**. Every assertion below that slice was therefore green against
 * arbitrary text — a gate reading a duplicate as its subject while silently
 * checking nothing, which is worse than no gate because it is trusted. That is
 * exactly how the git-checkout-daemon incident shipped untouched while this file
 * ASSERTED the bad shape was correct (see test/prod-bootstrap-single-source.test.ts).
 *
 * Hence the two helpers below, which are the point of the change: `readOrThrow`
 * refuses to read a file that is not there, and `anchorAt` refuses to slice on an
 * anchor it did not positively find. A refactor that moves or renames a unit now
 * produces a LOUD named red instead of a silent vacuous green. Every retargeted
 * assertion goes through one of them.
 */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const SCRIPT = "scripts/ops/provision-ui2api-user.sh";
const INSTALLER = "scripts/ops/install-services.sh";
const UNITS_DIR = "scripts/ops/units";
const CHROME_UNIT = `${UNITS_DIR}/ui2api-chrome.service`;
const API_UNIT = `${UNITS_DIR}/ui2api-api.service`;

const AGENTS = readFileSync("AGENTS.md", "utf8");
const DOC = readFileSync("docs/CHROME_POINT_OF_USE.md", "utf8");

/**
 * Read a file this gate's assertions are ABOUT, or throw by NAME.
 *
 * A bare `readFileSync` throws an opaque ENOENT and a bare `slice(-1)` returns
 * the whole file; both are silent to a reader skimming a green run. This names
 * the file and what was supposed to assert against it.
 */
function readOrThrow(rel: string, what: string): string {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    throw new Error(
      `pin-target-missing: ${rel} does not exist, but ${what} asserts against it. ` +
        "A moved or deleted unit must be a LOUD red, not a silently vacuous green.",
    );
  }
  return readFileSync(abs, "utf8");
}

/**
 * Find an anchor and refuse to proceed unless it was positively found.
 *
 * `indexOf` returning -1 is the exact bug this file used to carry. The index
 * must be **> 0**: offset 0 is refused too, because an anchor at byte 0 means
 * the caller has lost the shape it meant to anchor on.
 */
function anchorAt(text: string, anchor: string, rel: string): number {
  const i = text.indexOf(anchor);
  if (i <= 0) {
    throw new Error(
      `anchor-missing: "${anchor}" was not found at a positive offset in ${rel} ` +
        `(indexOf returned ${i}). Refusing to slice on it — an absent anchor must fail ` +
        "loudly instead of yielding the whole file and going vacuously green.",
    );
  }
  return i;
}

d("GOAL 132: the point of use is provisioned by code and survives a reboot", () => {
  t("the provisioning script exists and is valid bash", () => {
    assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
    // `bash -n` parses without executing — safe, and it is a real check
    execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe", timeout: 15_000 });
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
    // and the refusals must be BEFORE any install -d. anchorAt (not indexOf) so
    // a moved guard cannot turn the ordering comparison into a quiet pass.
    const firstInstall = anchorAt(s, "install -d", SCRIPT);
    const firstGuard = anchorAt(s, "is not an existing directory", SCRIPT);
    assert.ok(firstGuard < firstInstall, "the guard must run before anything is created");
  });

  t("it registers BOTH long-lived services with systemd", () => {
    // daemon-reload / enable moved OUT of the provision script along with the
    // units: installing units is install-services.sh's job, so a deploy can
    // install them without re-running the script that touches credentials.
    const installer = readOrThrow(INSTALLER, "the daemon-reload / enable pins");
    assert.match(installer, /systemctl daemon-reload/, `${INSTALLER} must reload systemd after installing`);
    assert.match(
      installer,
      /systemctl enable ui2api-xvfb ui2api-chrome ui2api-api/,
      `${INSTALLER} must enable all three at boot`,
    );
    assert.match(
      installer,
      /install -m 0644 "\$UNIT_SRC\/\$u\.service" "\$UNIT_DIR\/\$u\.service"/,
      `${INSTALLER} must COPY the shipped unit, not synthesise one`,
    );
    assert.match(
      readFileSync(SCRIPT, "utf8"),
      /install-services\.sh/,
      "the provisioning script must still delegate to the single installer",
    );

    // BOTH units run as the chrome user, never as the operator. The shipped
    // units deliberately HARDCODE `User=ui2api`: they are NOT parameterized by
    // $CHROME_USER any more, so a throwaway test user cannot rewrite the real
    // point of use. Assert what they really say, not what the removed heredoc
    // used to interpolate.
    for (const rel of [CHROME_UNIT, API_UNIT]) {
      const unit = readOrThrow(rel, "the User=/Group= pins");
      assert.match(
        unit,
        /^User=ui2api$/m,
        `${rel} hardcodes User=ui2api — the units are deliberately NOT parameterized by $CHROME_USER`,
      );
      assert.match(unit, /^Group=ui2api$/m, `${rel} must run as the same user's group`);
      assert.match(unit, /^WantedBy=multi-user\.target$/m, `${rel} must be enabled at boot`);
      // non-vacuity: it must really be a unit, or the pins above could be
      // matching prose. A file with no [Service] cannot carry User=/ExecStart=.
      assert.match(unit, /^\[Service\]$/m, `${rel} must really be a systemd unit ([Service] section)`);
      assert.match(unit, /^ExecStart=/m, `${rel} must really carry an ExecStart`);
    }
  });

  t("the chrome unit exposes CDP for attaching and never self-resurrects", () => {
    const chromeUnit = readOrThrow(CHROME_UNIT, "the CDP / restart pins");
    // the CDP port is the whole point — hardcoded 9222, NOT a $DAEMON_PORT
    // interpolation: there is no shell left to expand it in.
    assert.match(
      chromeUnit,
      /--remote-debugging-port=9222/,
      "the CDP port is the whole point (hardcoded 9222 — a .service file has no shell to expand $DAEMON_PORT)",
    );
    assert.match(chromeUnit, /--remote-debugging-address=127\.0\.0\.1/, "bound to loopback only");
    assert.match(
      chromeUnit,
      /--user-data-dir=\/home\/ui2api\/\.config\/ui2api-chrome/,
      "using the dedicated owner's real profile path",
    );
    assert.match(chromeUnit, /^Restart=on-failure$/m, "restart on failure");
    // a CLEAN stop must not be undone: `chrome stop` has to actually work
    assert.ok(
      !/Restart=always/.test(chromeUnit),
      "Restart=always would resurrect the browser systemd was told to stop, defeating `chrome stop`",
    );
    assert.match(chromeUnit, /^Environment=DISPLAY=:99$/m, "the unit must carry the virtual display");
    assert.match(
      chromeUnit,
      /^Environment=UI2API_DAEMON_PORT=9222$/m,
      "the daemon-port env must agree with the ExecStart flag, or CDP consumers read the wrong port",
    );
  });

  t("the API unit serves the endpoints other programs call", () => {
    const apiUnit = readOrThrow(API_UNIT, "the ExecStart / attach-port pins");
    // the DEPLOYED build, not a git checkout — the incident this refactor exists
    // to prevent. `cli.ts promptd` here is the exact rot prod-bootstrap gates.
    assert.match(
      apiUnit,
      /^ExecStart=\/usr\/bin\/node \/opt\/ui2api\/dist\/cli\.js promptd$/m,
      "the API is promptd running the COMPILED deployed tree, not `cli.ts promptd` out of a checkout",
    );
    assert.ok(
      !/cli\.ts promptd/.test(apiUnit),
      "a `cli.ts promptd` ExecStart is the git-checkout daemon — deploy.sh exists to eliminate exactly that",
    );
    assert.match(
      apiUnit,
      /^Environment=UI2API_ATTACH_PORT=9222$/m,
      "it must attach to the persistent Chrome, not spawn a browser per request",
    );
    assert.match(apiUnit, /^After=.*ui2api-chrome\.service$/m, "ordered after the browser");
    // Wants covers network-online and the display ONLY. Chrome is deliberately
    // after-but-NOT-required so promptd still comes up and answers honestly
    // ("no browser") rather than not coming up at all.
    assert.match(
      apiUnit,
      /^Wants=network-online\.target ui2api-xvfb\.service$/m,
      "Wants must cover network-online and the display",
    );
    assert.ok(
      !/^Wants=.*ui2api-chrome\.service$/m.test(apiUnit),
      "Chrome must NOT be Wanted: making it wanted would stop promptd coming up honestly when Chrome is down",
    );
    assert.ok(
      !/^Requires=.*ui2api-chrome\.service$/m.test(apiUnit),
      "Chrome must not be Required either — same reason",
    );
    // the daemon binds loopback by design; the unit must not widen it
    assert.ok(!/0\.0\.0\.0/.test(apiUnit), "the API must not be LAN-exposed by the unit");
  });

  t("the provision script DELEGATES: it installs units, it does not define them", () => {
    const s = readFileSync(SCRIPT, "utf8");
    assert.ok(
      s.includes(UNITS_DIR) || s.includes("install-services.sh"),
      `${SCRIPT} must delegate to ${UNITS_DIR} (directly or via ${INSTALLER})`,
    );
    assert.match(
      s,
      /refusing: no unit definitions at \$UNIT_SRC/,
      "a missing units dir must be a named refusal, never a fallback to inline units",
    );
    assert.match(
      s,
      /refusing: no installer at \$INSTALL_SERVICES/,
      "a missing installer must be a named refusal too",
    );
    // The absence pin. A shell `#` line writes nothing, and this script's
    // comments QUOTE the removed heredoc to explain the incident — so comments
    // are stripped structurally, before any write-shape is judged. Matching raw
    // text would go red on the very comment explaining the fix, and a gate with
    // that false red is a gate that gets deleted.
    const offenders = s
      .split("\n")
      .map((lineText, i) => ({ lineText, line: i + 1 }))
      .filter(({ lineText }) => !/^\s*#/.test(lineText))
      .filter(({ lineText }) => /(cat\s*>>?\s|tee\s|printf?\b[^|]*>\s*)/.test(lineText) && /\.(service)\b/.test(lineText))
      .map(({ lineText, line }) => `${line}: ${lineText.trim()}`);
    assert.deepEqual(
      offenders,
      [],
      `${SCRIPT} must contain no inline .service write — one definition, in ${UNITS_DIR}`,
    );
  });

  t("the whole model is documented where a reader will hit it", () => {
    for (const [name, text] of [["AGENTS.md", AGENTS], ["docs/CHROME_POINT_OF_USE.md", DOC]] as const) {
      assert.match(text, /provision-ui2api-user\.sh/, `${name} must point at the provisioning script`);
    }
    assert.match(DOC, /systemd|systemctl/, "and the doc must cover the services");
  });
});
