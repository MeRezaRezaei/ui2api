// PRODUCTION SUPERVISION TRUTH — the deployed service's three units and its
// deploy lane, pinned as static facts so they cannot rot silently.
//
// WHY THIS FILE EXISTS. The GitLab lane redeploys on every push to main
// (pipeline 308: build + verify + deploy all success). That lane is only as
// trustworthy as the supervision underneath it, and the supervision was
// unpinned: nothing in the suite read `scripts/ops/units/*.service` or
// `scripts/ops/deploy.sh` at all. A unit could lose `Restart=always`, or be
// deleted, or lose its `[Install]` section, and every test in the repo would
// still be green while the live service silently stopped self-healing.
//
// MEASURED CONTEXT (2026-09-27, live on the box, not theory):
//   * All three units are installed, `enabled`, and `active`. `NRestarts=0`
//     across five restarts — meaning `Restart=always` has NEVER actually fired
//     in production. Every restart so far was deliberate. The policy is
//     declared and completely unexercised, which is precisely why it must be
//     pinned statically: an untested recovery policy is not a recovery policy.
//   * The unit drift that actually bit: `User=` was `me` while the vault is
//     owned `ui2api` at 0700. The API (running as `me`) could not read the
//     captured sessions, and kimi replayed signed-out —
//     "no answer appeared on kimi within 60000ms. This site requires sign-in"
//     in the journal at 21:45, 21:58, 22:07 and 22:08 — while `GET /health`
//     answered `ok: true` the entire time. That is the whole thesis of this
//     file in one incident: a health check that cannot fail on the failure
//     that actually happened is decoration.
//   * A restart survives cleanly (measured): 33 packages / 22 models / 1 kimi
//     account before AND after, health 200. The vault is not lost by a deploy.
//
// SCOPE, and what is deliberately NOT here:
//   * No `systemctl`, ever. These checks parse the unit FILES so they run on
//     CI, where no systemd exists. The installed-vs-repo unit drift is
//     therefore invisible to this file by design; `install-services.sh` is the
//     seam that reconciles them, and pinning the repo file is what pins what
//     the next install will write.
//   * Not pinned, and honestly so: the /health handler's inability to see the
//     vault. It is pinned in NO test because it cannot be — `ok: true` is a
//     literal in `src/prompt/http.ts`, so there is no property to assert short
//     of rewriting the handler. It is reported as a finding, not laundered
//     into a passing assertion.

import { test as t } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const UNITS_DIR = join(ROOT, "scripts", "ops", "units");
const DEPLOY_SH = join(ROOT, "scripts", "ops", "deploy.sh");

/** The three units, in dependency order. Order is part of the contract. */
const UNITS = ["ui2api-xvfb", "ui2api-chrome", "ui2api-api"] as const;

function unitPath(name: string): string {
  return join(UNITS_DIR, `${name}.service`);
}

/** Read a unit, refusing to continue if it is absent (never vacuously true). */
function readUnit(name: string): string {
  const p = unitPath(name);
  if (!existsSync(p)) {
    throw new Error(`unit file MISSING: ${p} — the deployed service would lose ${name}`);
  }
  return readFileSync(p, "utf8");
}

/** Last occurrence of a top-level `Key=Value` line. systemd takes the last one. */
function directive(text: string, key: string): string | null {
  const re = new RegExp(`^${key}=(.*)$`, "gm");
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1]!.trim();
  return last;
}

/**
 * Strip `#` comments. systemd ignores a line whose FIRST non-space char is `#`,
 * so `Restart=always` inside a comment block is not a directive. Every regex
 * below runs on this, or a commented-out `Restart=on-failure` would satisfy
 * the `always` pin and the gate would be a liar.
 */
function uncommented(text: string): string {
  return text
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l))
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * 1. The three units exist, are boot-enabled, and carry the Restart
 *    policy their OWN contract demands — which is not the same for all
 *    three.
 * ------------------------------------------------------------------ */

/**
 * EXPECTED RESTART POLICY, per unit. This is the per-unit contract, not a
 * uniform aspiration.
 *
 * DISCLOSURE — WHAT CHANGED, AND WHY EDITING THIS GATE IS THE HONEST
 * DIRECTION. This table REPLACED a blanket pin that demanded `Restart=always`
 * on all three units. The shipped `ui2api-chrome.service` does not satisfy
 * that, and should not. The chrome exemption is DELIBERATE. A future reader
 * must be able to RE-CHECK the premise instead of assuming the pin is
 * arbitrary, so here it is in full:
 *
 *   * `ui2api chrome stop` is a documented, first-class operator command
 *     (AGENTS.md; docs/CHROME_POINT_OF_USE.md) — not an internal detail.
 *   * It is NOT `systemctl stop`. `stopChromeDaemon()` in
 *     `src/runtime/chrome-daemon.ts` sends a DIRECT
 *     `process.kill(state.pid, "SIGTERM")` (measured at line 369; that file
 *     contains no `systemctl` call at all).
 *   * systemd's "an operator stop is never restarted" rule covers an
 *     operator-initiated `systemctl stop` — NOT an external SIGTERM. A death
 *     by external signal is a restart-triggering exit. So under
 *     `Restart=always`, systemd brings the browser back a second later,
 *     silently undoing a stop the operator just asked for.
 *   * The old pin's own stated reason — "a crash-looping or OOM-killed
 *     service would stay down forever" — is ALREADY met by `on-failure`,
 *     which restarts on a nonzero exit, on a fatal signal (SIGSEGV / SIGKILL /
 *     OOM), on TimeoutStopSec, and on the watchdog. `always` differs from
 *     `on-failure` in exactly one respect: it ALSO restarts a CLEAN exit.
 *     Here the clean exit IS the requested stop. So `always` buys no
 *     crash-loop self-healing that `on-failure` does not already give, and it
 *     costs a working operator workflow.
 *
 * So the contract this file now pins is the real one: SELF-HEALING, plus a
 * deliberate `chrome stop` must STICK. Both halves are pinned positively and
 * proven load-bearing in both directions in the anti-vacuity block below — a
 * flip of the chrome unit to `always` must fail LOUDLY, naming the reason.
 *
 * SIDE NOTE on these unit files, so a reader does not go looking for a knob
 * that is not there: they are NOT parameterized by `$CHROME_USER` /
 * `$XVFB_DISPLAY`. Since the single-source refactor into `scripts/ops/units/`,
 * each unit hardcodes its own values as literals — `UI2API_CHROME_USER=ui2api`
 * and `DISPLAY=:99`.
 */
const RESTART_POLICY = {
  // The display must come back on its own. Nothing an operator drives ever
  // stops it, and if DISPLAY is gone every other unit is a casualty.
  "ui2api-xvfb": "always",
  // The HTTP surface other programs call must self-heal, clean exit included.
  "ui2api-api": "always",
  // Self-heals a crash / OOM / fatal signal, but MUST NOT resurrect a
  // deliberate `ui2api chrome stop`. Premise measured above — re-check it at
  // src/runtime/chrome-daemon.ts before weakening this pin.
  "ui2api-chrome": "on-failure",
} as const;

type UnitName = keyof typeof RESTART_POLICY;

/** The failure message for a Restart mismatch, carrying the per-unit reason. */
function restartFailureMessage(name: string, expected: string, actual: string | null): string {
  const got =
    actual === null
      ? "ABSENT (=no, the systemd default — no self-healing at all)"
      : actual;
  const head = `${name}.service Restart is ${got}, expected "${expected}"`;
  if (name === "ui2api-chrome") {
    return (
      head +
      " — NOT a style preference, and not an oversight. `ui2api chrome stop` is a " +
      "documented operator command (AGENTS.md, docs/CHROME_POINT_OF_USE.md) and it is " +
      "NOT `systemctl stop`: stopChromeDaemon() in src/runtime/chrome-daemon.ts sends a " +
      "direct process.kill(state.pid, SIGTERM) (line 369; no systemctl anywhere in that " +
      "file). systemd exempts an operator-initiated `systemctl stop` from restarting, but " +
      "an EXTERNAL SIGTERM is a restart-triggering exit — so Restart=always resurrects " +
      "the browser a second later and silently undoes the stop the operator asked for. " +
      "on-failure still self-heals the whole crash surface: nonzero exit, " +
      "SIGSEGV/SIGKILL/OOM, TimeoutStopSec, watchdog. It differs from always in exactly " +
      "one way — it does not restart a CLEAN exit — and here the clean exit IS the " +
      "requested stop. Re-check that premise at src/runtime/chrome-daemon.ts before " +
      "loosening this pin."
    );
  }
  return `${head} — a crash-looping or OOM-killed service would stay down forever`;
}

/**
 * THE predicate. Both the real gate below and the anti-vacuity mutations call
 * this, so a mutation that passes here would really have passed the real gate
 * and vice versa — that is what makes the anti-vacuity block a proof rather
 * than a parallel reimplementation that could drift.
 */
function assertRestartPolicy(name: string, text: string): void {
  const expected = (RESTART_POLICY as Record<string, string>)[name]!;
  const actual = directive(uncommented(text), "Restart");
  assert.equal(actual, expected, restartFailureMessage(name, expected, actual));
}

t("prod supervision: all three unit files exist", () => {
  const missing = UNITS.filter((u) => !existsSync(unitPath(u)));
  assert.deepEqual(
    missing,
    [],
    `unit files missing from scripts/ops/units/: ${missing.join(", ")} — a deploy's ` +
      `service tree would be incomplete and nothing in the suite would notice`,
  );
});

for (const name of UNITS) {
  t(`prod supervision: ${name} is boot-enabled (WantedBy=multi-user.target)`, () => {
    const text = readUnit(name);
    const install = text.split("[Install]")[1];
    assert.ok(
      install,
      `${name}.service has no [Install] section — it can never start at boot, ` +
        `so a reboot silently takes production down with no test failing`,
    );
    assert.match(
      install,
      /^\s*WantedBy=.*multi-user\.target\s*$/m,
      `${name}.service [Install] does not WantedBy=multi-user.target — not boot-enabled`,
    );
  });

  // PER-UNIT, not uniform: the expected value comes from RESTART_POLICY, so a
  // unit that lost its policy, or gained the WRONG one, fails here. A unit
  // with NO Restart= is Restart=no — the default — so absent fails too, and it
  // fails for the right reason: no self-healing.
  t(`prod supervision: ${name} has Restart=${RESTART_POLICY[name as UnitName]} (uncommented)`, () => {
    assertRestartPolicy(name, readUnit(name));
  });
}

t("prod supervision: ui2api-chrome is on-failure, and explicitly NOT always", () => {
  // Requirement (2): this is a contract in its own right, not the mere absence
  // of a check. Stated on its own so that flipping chrome to `always` fails
  // LOUDLY on a test whose entire subject is that flip — the failure message
  // carries the whole `chrome stop` / direct-SIGTERM reasoning.
  const restart = directive(uncommented(readUnit("ui2api-chrome")), "Restart");
  assert.equal(
    restart,
    "on-failure",
    `ui2api-chrome.service Restart is ${restart ?? "ABSENT"}, expected "on-failure" — ` +
      `see the per-unit table above: on-failure already self-heals a crash, an OOM ` +
      `kill, and any fatal signal, and it is the ONLY value that does not resurrect ` +
      `the browser after a deliberate \`ui2api chrome stop\``,
  );
  assert.notEqual(
    restart,
    "always",
    "ui2api-chrome.service is Restart=always — systemd will bring the browser back a " +
      "second after the operator's `ui2api chrome stop` (a direct SIGTERM from " +
      "stopChromeDaemon(), not a `systemctl stop`, so the operator-stop exemption " +
      "does not apply), silently undoing a documented command",
  );
});

t("prod supervision: the api unit pins a real RestartSec, so 'always' is not a hot loop", () => {
  // Restart=always with RestartSec=0 is a fork bomb. The pin is that the value
  // parses as a positive number, not that it equals any particular constant.
  const sec = directive(uncommented(readUnit("ui2api-api")), "RestartSec");
  assert.ok(sec, "ui2api-api.service has no RestartSec — Restart=always would hot-loop");
  const asNum = sec!.endsWith("ms") ? Number(sec!.slice(0, -2)) : Number(sec!);
  assert.ok(
    Number.isFinite(asNum) && asNum > 0,
    `ui2api-api.service RestartSec=${sec} is not a positive duration`,
  );
});

t("prod supervision: the chrome unit pins a real RestartSec, so on-failure is not a hot loop", () => {
  // Same property as the api unit, and it matters just as much here: a
  // `Restart=on-failure` with RestartSec=0 is still a fork bomb on a unit that
  // fails instantly. `on-failure` is a RESTART policy, not a no-restart policy —
  // the exemption in RESTART_POLICY is about the clean exit, not about pacing.
  const sec = directive(uncommented(readUnit("ui2api-chrome")), "RestartSec");
  assert.ok(
    sec,
    "ui2api-chrome.service has no RestartSec — Restart=on-failure would hot-loop on an " +
      "instant failure",
  );
  const asNum = sec!.endsWith("ms") ? Number(sec!.slice(0, -2)) : Number(sec!);
  assert.ok(
    Number.isFinite(asNum) && asNum > 0,
    `ui2api-chrome.service RestartSec=${sec} is not a positive duration`,
  );
});

t("prod supervision: api unit keeps the vault OUTSIDE the deploy target (absolute, not /opt)", () => {
  // deploy.sh refuses to write `data/` into the target, and the unit points at
  // the operator's checkout instead. If this ever became relative — or moved
  // under /opt/ui2api — the service would start perfectly against an EMPTY
  // vault and replay signed-out on every site, which is the exact bug class
  // this file documents. It is a static check, so it runs on CI.
  const dataDir = directive(uncommented(readUnit("ui2api-api")), "Environment");
  const line = uncommented(readUnit("ui2api-api"))
    .split("\n")
    .find((l) => l.startsWith("Environment=UI2API_DATA_DIR="));
  assert.ok(line, "ui2api-api.service does not pin Environment=UI2API_DATA_DIR");
  assert.ok(dataDir !== null, "ui2api-api.service lost its Environment= lines");
  const value = line!.slice("Environment=UI2API_DATA_DIR=".length).trim();
  assert.ok(
    value.startsWith("/"),
    `UI2API_DATA_DIR=${value} is not absolute — it would resolve against ` +
      `WorkingDirectory=/opt/ui2api and silently find no vault`,
  );
  assert.ok(
    !value.startsWith("/opt/ui2api"),
    `UI2API_DATA_DIR=${value} points INSIDE the deploy target — the deploy would ` +
      `own the vault, and rsync --delete would take the captured sessions with it`,
  );
});

t("prod supervision: api unit attaches to the chrome daemon, does not launch its own browser", () => {
  // Chrome holds the warm anti-bot state and the profile lock. A unit that lost
  // UI2API_ATTACH_PORT would make every request launch a cold browser per call —
  // degraded, challenge-prone, and invisible to /health.
  const text = uncommented(readUnit("ui2api-api"));
  assert.match(
    text,
    /^Environment=UI2API_ATTACH_PORT=\d+$/m,
    "ui2api-api.service does not pin Environment=UI2API_ATTACH_PORT — it would launch a " +
      "fresh browser per request instead of attaching to the long-lived one",
  );
});

/* ------------------------------------------------------------------ *
 * 2. deploy.sh health-checks and EXITS NONZERO on failure.
 * ------------------------------------------------------------------ */

function readDeploy(): string {
  if (!existsSync(DEPLOY_SH)) {
    throw new Error(`deploy script MISSING: ${DEPLOY_SH} — the CI deploy lane has nothing to run`);
  }
  return readFileSync(DEPLOY_SH, "utf8");
}

t("prod supervision: deploy.sh health-checks GET /health", () => {
  const text = readDeploy();
  assert.match(
    text,
    /\/health/,
    "deploy.sh never calls /health — a deploy that leaves a dead service would return 0",
  );
  // The probe is a CALL, and the deploy now routes it through a helper
  // (`http_probe /health`) instead of inlining `curl`. The property under test is
  // "is /health actually invoked", not "does one line contain curl and /health" —
  // and the string version of that question produced a FALSE RED against a
  // correct script, which is worse than no check: it would have blocked a good
  // deploy. Match the invocation, however it is spelled.
  assert.match(
    text,
    /(?:curl|health_probe_once|http_probe|wget)[^\n]*\/health/,
    "deploy.sh mentions /health but never probes it — the check is a comment, not a check",
  );
  // ...and the probe must inspect the RESULT, not merely run. A bare
  // `curl .../health >/dev/null` with no status check is the exact literal-ok
  // failure this whole audit exists to kill.
  assert.match(
    text,
    /http_probe[\s\S]{0,400}health|health_probe_once[\s\S]{0,400}\/health/,
    "deploy.sh probes /health but no helper carries the status back to inspect",
  );
});

t("prod supervision: deploy.sh exits nonzero when the health check fails", () => {
  const text = readDeploy();
  // The property is not "there is a fail() function" — it is that the health
  // failure PATH reaches a nonzero exit. Under `set -e` a bare `false` or an
  // unhandled failure is the only other way out, so require an explicit
  // `fail`/exit reachable from the health branch.
  // Everything after the FIRST /health mention: /health appears in the `say`
  // banner and again inside the curl, so a bare split()[1] would only cover
  // the text BETWEEN two mentions and could miss the real failure branch.
  const healthBranch = text.split(/\/health/).slice(1).join("\n");
  assert.match(
    healthBranch,
    /\bfail\b|\bexit\s+[1-9]/,
    "after the /health check deploy.sh has no `fail`/nonzero `exit` — a green deploy " +
      "with a dead service is the exact bug this lane was built to kill",
  );
  // And `fail` must actually be a nonzero exit, not an echo.
  assert.match(
    text,
    /fail\(\)\s*\{[^}]*exit\s+[1-9]/,
    "deploy.sh's fail() does not exit nonzero — a failure would print and continue",
  );
  assert.match(
    text,
    /^set -euo pipefail$/m,
    "deploy.sh lost `set -euo pipefail` — a failed rsync/npm would no longer stop the deploy",
  );
});

t("prod supervision: deploy.sh does NOT claim to roll back when it does not", () => {
  // There is no rollback, and that is a real gap. What is NOT acceptable is the
  // gap being invisible: the script must say so where an operator will read it
  // when the deploy has just failed. If someone later adds a real rollback this
  // assertion flips to needing the opposite wording, which is the point.
  // A real rollback now exists (scripts/ops/deploy.sh), so this assertion has
  // INVERTED: the old wording demanded that the script admit it had none, which
  // a correct script should no longer say. The property that actually matters is
  // that whichever of the two it is, the operator can SEE it — a silent success
  // is the failure, not the absence of rollback.
  const text = readDeploy();
  const hasRollback = /rollback\(\)|ROLLBACK OK|preserve_previous|\.rollback\b/i.test(text);
  if (hasRollback) {
    assert.match(
      text,
      /loud|ROLLBACK (OK|UNPROVEN|FAILED)|rollback/i,
      "deploy.sh has a rollback but does not announce it — a silent restore leaves the " +
        "operator believing the NEW release is live",
    );
  } else {
    assert.match(
      text,
      /previous release is NOT restored|not.*restored automatically/i,
      "deploy.sh neither rolls back nor says that it does not — a failed deploy would " +
        "leave an operator believing the previous release is still in place",
    );
  }
});

/* ------------------------------------------------------------------ *
 * 3. deploy.sh excludes data/ AND asserts it is absent from the target.
 * ------------------------------------------------------------------ */

t("prod supervision: deploy.sh excludes data/ from the rsync", () => {
  const text = readDeploy();
  // EVERY rsync must exclude the vault, not one of them. The deploy now has
  // several (the preservation copy and the stage copy), and `split("rsync")[1]`
  // inspected whichever happened to be second — so a correct script carrying the
  // exclusion in every block was reported as not excluding it at all. The vault
  // is real credentials; one unguarded copy is one credential leak.
  // COMMAND invocations only. Splitting on the WORD matched prose: the deploy
  // explains its own rsync policy in three comment blocks, and each of those
  // "rsyncs" was then judged as an unguarded copy of the vault. Measured: 4 of
  // the 7 hits were comment lines and the 3 real commands ALL excluded data/.
  //
  // This is the third variant of the same disease in this one file — a check that
  // matches text where it needed to match behaviour. A false red here would have
  // blocked a correct deploy, which is strictly worse than no check at all.
  const INVOCATION = /^[ \t]*(?:sudo[ \t]+)?rsync\b[^;]*/gm;
  const rsyncs = text.match(INVOCATION) ?? [];
  assert.ok(rsyncs.length > 0, "deploy.sh has no rsync command at all");
  for (const block of rsyncs) {
    assert.match(
      block,
      /--exclude\s+['"]?\/?data\/?['"]?/,
      "deploy.sh has an rsync that does not exclude data/ — a developer's captured " +
        "credentials would be shipped into the install dir",
    );
  }
});

t("prod supervision: deploy.sh ASSERTS data/ is absent from the target after staging", () => {
  // The exclude alone is not the gate: rsync exclude patterns are easy to get
  // subtly wrong (trailing slash, leading slash, a nested data/ dir). The
  // assertion is what makes it safe — it checks the RESULT, not the intent.
  const text = readDeploy();
  assert.match(
    text,
    /if\s+\[\[\s+-e\s+"?\$\{?TARGET_DIR\}?\/data"?\s*\]\]/,
    "deploy.sh does not assert that $TARGET_DIR/data is absent after staging — the " +
      "exclusion is trusted rather than verified",
  );
  assert.match(
    text,
    /TARGET_DIR\}?\/data exists/,
    "the data/ absence assertion has no named failure message",
  );
});

t("prod supervision: deploy.sh builds BEFORE it points the service at the new tree", () => {
  // A deploy that swaps first and builds after leaves a service that starts and
  // serves nothing. Ordering is the property; assert the build precedes restart.
  const text = readDeploy();
  // LAST occurrences, not first. The rollback path contains its own
  // `systemctl restart` (restarting the restored release), so `search` found
  // that one and compared it against the main flow's build — reporting a FALSE
  // RED on a script whose main path builds first. What must hold is that the
  // deploy's own success path builds before it restarts, and the success path is
  // the last one in the file.
  const buildAt = text.lastIndexOf("npm run build");
  const restartAt = text.lastIndexOf("systemctl restart ui2api-api");
  assert.ok(buildAt > -1, "deploy.sh never runs `npm run build`");
  assert.ok(restartAt > -1, "deploy.sh never restarts ui2api-api");
  assert.ok(
    buildAt < restartAt,
    "deploy.sh restarts the service BEFORE building — a compile error would ship a " +
      "service that starts and serves nothing",
  );
});

/* ------------------------------------------------------------------ *
 * ANTI-VACUITY. A gate that finds nothing because it looked in the wrong
 * place must FAIL, not pass. Every check above is proven here to actually
 * reject a broken unit/script, using synthetic text — no filesystem, no
 * systemd, so it holds on CI.
 * ------------------------------------------------------------------ */

t("anti-vacuity: the unit checks REJECT a missing unit", () => {
  // Proves the existence gate is real: readUnit throws on a name with no file.
  assert.throws(
    () => readUnit("ui2api-does-not-exist"),
    /MISSING/,
    "readUnit accepted a nonexistent unit — the existence gate is vacuous",
  );
});

t("anti-vacuity: the Restart gate REJECT Restart=on-failure and Restart=no", () => {
  for (const bad of ["on-failure", "no"]) {
    const mutated = uncommented(readUnit("ui2api-api")).replace(/^Restart=.*$/m, `Restart=${bad}`);
    assert.equal(
      directive(mutated, "Restart"),
      bad,
      "mutation setup failed — the anti-vacuity test would prove nothing",
    );
    assert.notEqual(
      directive(mutated, "Restart"),
      "always",
      `a unit with Restart=${bad} satisfied the "always" pin — the gate is vacuous`,
    );
    // ADAPTED (not dropped): route the mutation through the REAL predicate as
    // well, so this proves `assertRestartPolicy` itself rejects it and not just
    // a parallel expression that could drift from it. The `on-failure` case
    // matters more now that on-failure is a LEGAL value — for the chrome unit,
    // not for this one.
    assert.throws(
      () => assertRestartPolicy("ui2api-api", mutated),
      new RegExp(`expected "always"`),
      `a unit with Restart=${bad} passed the real per-unit gate — the gate is vacuous`,
    );
  }
});

t("anti-vacuity: the Restart gate REJECT an ABSENT Restart (systemd default is no)", () => {
  const mutated = uncommented(readUnit("ui2api-api")).replace(/^Restart=.*$/m, "");
  assert.equal(
    directive(mutated, "Restart"),
    null,
    "an absent Restart still read as 'always' — the gate would pass a unit that " +
      "never restarts (systemd's default Restart=no)",
  );
});

t("anti-vacuity: the per-unit gate REJECT Restart=always on ui2api-chrome (resurrection hazard)", () => {
  // The other direction, and the one this file's per-unit table exists for. The
  // api-direction mutations above all move AWAY from `always`; this one moves
  // TOWARD it, so it is the only mutation that can catch a future edit flipping
  // the chrome unit back to `always` — the edit that silently resurrects the
  // browser after a deliberate `ui2api chrome stop`.
  const original = uncommented(readUnit("ui2api-chrome"));
  const mutated = original.replace(/^Restart=.*$/m, "Restart=always");
  // MUTATION APPLIED? A no-op mutation would make every assertion below pass
  // trivially and prove nothing, so check the text actually changed first.
  assert.equal(
    directive(mutated, "Restart"),
    "always",
    "mutation setup failed — the anti-vacuity test would prove nothing (the replace " +
      "did not take, or a second Restart= line won the last-occurrence read)",
  );
  assert.notEqual(
    directive(mutated, "Restart"),
    directive(original, "Restart"),
    "mutation setup failed — mutating ui2api-chrome to Restart=always changed nothing, " +
      "so the rejection below would be vacuous",
  );
  // And the REAL gate rejects it, with the reason in the message — a flip to
  // `always` must fail loudly, not silently pass.
  assert.throws(
    () => assertRestartPolicy("ui2api-chrome", mutated),
    /chrome stop/,
    "a chrome unit set to Restart=always PASSED the real per-unit gate — the gate is " +
      "vacuous, and the `ui2api chrome stop` resurrection hazard is unguarded",
  );
  // POSITIVE CONTROL: the real shipped unit passes the SAME predicate the
  // mutation just failed, so this is a gate that discriminates, not one that is
  // simply always-red (which would "pass" anti-vacuity while testing nothing).
  assert.doesNotThrow(
    () => assertRestartPolicy("ui2api-chrome", original),
    "POSITIVE CONTROL FAILED — the real ui2api-chrome.service does not satisfy the same " +
      "predicate the mutation was rejected by, so the rejection above proves nothing " +
      "(the gate is always-red rather than discriminating)",
  );
});

t("anti-vacuity: the per-unit gate REJECT an ABSENT Restart on ui2api-chrome", () => {
  // A chrome unit with no Restart= at all is Restart=no — systemd's default —
  // so the browser would NOT come back after a crash, an OOM kill, or a
  // segfault. This is the other half of the on-failure contract: exempt from
  // the clean exit, still self-healing on every fault. Dropping the line is
  // therefore a real regression, and it must not slip through the exemption.
  const original = uncommented(readUnit("ui2api-chrome"));
  const mutated = original.replace(/^Restart=.*$/m, "");
  assert.equal(
    directive(mutated, "Restart"),
    null,
    "mutation setup failed — the absent-Restart mutation did not apply, so the " +
      "rejection below would prove nothing",
  );
  assert.throws(
    () => assertRestartPolicy("ui2api-chrome", mutated),
    /ABSENT/,
    "a chrome unit with an ABSENT Restart= passed the real per-unit gate — the gate " +
      "would ship a browser that stays down forever after a crash, an OOM kill, or a " +
      "segfault (systemd's default Restart=no)",
  );
  // Positive control again, same predicate.
  assert.doesNotThrow(
    () => assertRestartPolicy("ui2api-chrome", original),
    "POSITIVE CONTROL FAILED — the real ui2api-chrome.service does not satisfy the same " +
      "predicate, so the rejection above proves nothing",
  );
});

t("anti-vacuity: the Restart gate REJECT Restart=always that is COMMENTED OUT", () => {
  // The exact shape of a plausible bad edit: someone comments the line out to
  // "temporarily" stop a restart loop. uncommented() must strip it.
  const mutated = readUnit("ui2api-api").replace(/^Restart=always$/m, "#Restart=always");
  assert.ok(
    /^\s*#\s*Restart=always/m.test(mutated),
    "mutation setup failed — the comment mutation did not apply",
  );
  assert.equal(
    directive(uncommented(mutated), "Restart"),
    null,
    "a COMMENTED-OUT Restart=always satisfied the pin — uncommented() is not applied, " +
      "so a disabled restart policy would read as enabled",
  );
});

t("anti-vacuity: the boot-enable gate REJECT a unit with no [Install] section", () => {
  const mutated = readUnit("ui2api-api").split("[Install]")[0]!;
  assert.equal(
    mutated.split("[Install]")[1],
    undefined,
    "the [Install]-less mutation still had an [Install] section",
  );
  assert.ok(
    !/^\s*WantedBy=.*multi-user\.target\s*$/m.test(mutated),
    "a unit with no [Install] section still matched WantedBy — the boot gate is vacuous",
  );
});

t("anti-vacuity: the health-failure gate REJECT a deploy that only LOGS the failure", () => {
  // The bad shape this file exists to kill: /health is curled, failure is
  // printed, and the script still exits 0.
  const vacuous = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'curl -fsS --max-time 3 "http://127.0.0.1:9797/health" || true',
    'echo "health check FAILED"',
  ].join("\n");
  const afterHealth = vacuous.split(/\/health/)[1] ?? "";
  assert.ok(
    !/\bfail\b|\bexit\s+[1-9]/.test(afterHealth),
    "mutation setup failed — the vacuous deploy still looked like it failed loudly",
  );
  assert.ok(
    !/fail\(\)\s*\{[^}]*exit\s+[1-9]/.test(vacuous),
    "the log-only deploy still defined a failing fail() — anti-vacuity proves nothing",
  );
});
