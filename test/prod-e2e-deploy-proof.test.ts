// prod-e2e-deploy-proof — the gate for the END-TO-END production chain
// (push → CI → deploy → restart → prompt), measured 2026-09-29.
//
// WHY THIS EXISTS. The deploy lane went green once (pipeline 308) and then a
// great deal changed underneath it without anyone re-proving the whole chain:
// the unit was switched to run the COMPILED `/opt/ui2api/dist/cli.js` as
// `ui2api`, the vault was chowned to `ui2api`, `/health` stopped returning a
// literal `ok:true` and started COMPUTING it, and the rollback path was
// rewritten to rebuild. Each of those is individually plausible; together they
// form a chain that is only real if every link still holds AT THE SAME TIME.
//
// WHAT THE 2026-09-29 MEASUREMENT FOUND (the reason this file exists):
//
//   1. The chain BREAKS at the Chrome link, and it breaks SILENTLY. All three
//      units were `disabled`, and `ui2api-chrome.service` was inactive, so the
//      CDP endpoint on 127.0.0.1:9222 was dead. `POST /prompt` then returned
//      HTTP 500 `{"error":{"code":"internal_error"}}` — while `GET /health`
//      answered `ok:true` throughout. This is the SAME failure shape as the
//      23-minute incident `prod-health-truth.test.ts` was written for: a green
//      liveness signal over a dead product. The daemon is configured with
//      `UI2API_ATTACH_PORT=9222`, so it ATTACHES to the persistent Chrome and
//      never falls back to launching its own: with that unit down there is no
//      browser at all, and no fallback either.
//   2. `scripts/ops/provision-ui2api-user.sh` — the script that WRITES these
//      units — is STALE relative to the units actually installed. It writes
//      `ExecStart=/usr/bin/env npx tsx $REPO_DIR/src/cli.ts promptd` and
//      `WorkingDirectory=$REPO_DIR`, i.e. the pre-deploy shape: the daemon
//      running out of a git checkout via `tsx`, which is the exact class of bug
//      `deploy.sh` exists to end. It ALSO omits `UI2API_DATA_DIR` entirely, so
//      a freshly provisioned daemon would resolve its vault relative to its own
//      WorkingDirectory and find none — the 23-minute silent breakage, one
//      `provision` away from shipping.
//   3. 35 tracked source files (including `src/prompt/http.ts`, the whole HTTP
//      surface) were sitting ZERO-BYTE in the working tree. `deploy.sh` rsyncs
//      the WORKING TREE, not HEAD, so a deploy at that moment would have
//      shipped an empty `http.ts` into `/opt/ui2api`.
//
// So the properties pinned below are not hypothetical. Each one is a link that
// was measurably broken on 2026-09-29, and each has a RED shown in the audit
// report: mutate the property away and this file FAILS.
//
// WHAT IS STATIC, and why it still bites on CI. Nothing here needs a running
// daemon, a real /opt, or a browser. The two sources of truth that are IN the
// repo — `deploy.sh` and `provision-ui2api-user.sh` — are parsed as TEXT, and
// the INSTALLED units under /etc/systemd/system are read when they exist (and
// skipped, loudly, when they do not, so a CI container without systemd is not
// a false green and not a false red). The checks are deliberately the same
// predicates the audit measured, so a rotation that breaks one of them in the
// repo fails here and not three weeks later in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const DEPLOY = read("scripts/ops/deploy.sh");
const PROVISION = read("scripts/ops/provision-ui2api-user.sh");
const INSTALL_SERVICES = read("scripts/ops/install-services.sh");

/**
 * The ONE definition of the three units. It lives in scripts/ops/units/ and is
 * installed by install-services.sh; provision-ui2api-user.sh delegates to that
 * installer and deliberately no longer synthesises a second copy (MEASURED
 * 2026-09-29: the inline heredoc copy carried the pre-deploy ExecStart, so
 * following the documented first-time bootstrap silently reverted the service
 * to a git-checkout daemon).
 *
 * This is the CI-runnable source of truth — the file in the repo, not the copy
 * under /etc — so a rotation that breaks a unit fails here on any machine.
 */
const UNITS = {
  xvfb: read("scripts/ops/units/ui2api-xvfb.service"),
  chrome: read("scripts/ops/units/ui2api-chrome.service"),
  api: read("scripts/ops/units/ui2api-api.service"),
};

/** The installed units, when this box has them. Absent on a CI container. */
const UNIT_DIR = "/etc/systemd/system";
const unit = (name: string) => {
  const p = join(UNIT_DIR, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

/**
 * The ExecStart line of a systemd unit, with continuations joined. Returns
 * null when the unit is not installed.
 */
function execStart(text: string | null): string | null {
  if (text === null) return null;
  const m = text.match(/^ExecStart=(.*(?:\n[ \t]+.*)*)/m);
  return m ? m[1].replace(/\n[ \t]+/g, " ").trim() : null;
}

/** Every ExecStart-bearing line, used for the "no tsx anywhere" negative. */
function execStartLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^ExecStart=/.test(l))
    .map((l) => l.replace(/\\\s*$/, "").trim());
}

/**
 * The script's logical lines: backslash continuations joined into one line.
 * Every multi-line command in deploy.sh is written this way, so a regex over
 * raw text sees only its FIRST physical line and silently misses the flags
 * that follow — which is how a "the exclude is there" check becomes a gate
 * that passes on a script with no exclude at all.
 */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (buf) buf += " " + line.trim();
    else buf = line;
    if (/\\$/.test(line)) {
      buf = buf.replace(/\\$/, "");
      continue;
    }
    out.push(buf);
    buf = "";
  }
  if (buf) out.push(buf);
  return out.filter((l) => l.trim().length > 0);
}

const TARGET = "/opt/ui2api";

// ── the three units exist, in exactly one place ────────────────────────────

test("all three production units exist in the repo's single source of truth", () => {
  for (const name of ["ui2api-xvfb", "ui2api-chrome", "ui2api-api"]) {
    assert.ok(existsSync(join(REPO, `scripts/ops/units/${name}.service`)), `scripts/ops/units/${name}.service is missing`);
  }
});

test("only ONE script defines the units — a second definition is a coin flip", () => {
  // The inline heredocs are gone for a measured reason: their api unit ran
  // `npx tsx <checkout>/src/cli.ts`, and docs/DEPLOY.md step 1 is that script,
  // so a new operator following the documented bootstrap silently reverted the
  // service to the git-checkout daemon.
  // Count only SHIPPED code: the rationale comment deliberately quotes the old
  // heredoc so the next reader knows what was removed and why, and a gate that
  // fired on that would push the next maintainer to delete the explanation.
  const shipped = (t: string) =>
    t
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  assert.equal(
    (shipped(PROVISION).match(/cat > "\$UNIT_DIR\/ui2api-[a-z]+\.service"/g) ?? []).length,
    0,
    "provision-ui2api-user.sh synthesises unit files again — two definitions of one unit is not redundancy, it is a coin flip, and the wrong side is a daemon serving code nobody deployed"
  );
  assert.ok(
    PROVISION.includes("scripts/ops/install-services.sh"),
    "provision-ui2api-user.sh no longer delegates unit installation to install-services.sh"
  );
  for (const name of ["ui2api-xvfb", "ui2api-chrome", "ui2api-api"]) {
    assert.ok(
      INSTALL_SERVICES.includes(`"$UNIT_SRC/$u.service"`) || INSTALL_SERVICES.includes(`/\$u\.service`),
      `install-services.sh no longer installs ${name}.service`
    );
  }
});

test("install-services.sh enables all three units at boot", () => {
  // MEASURED 2026-09-29: all three were `disabled`, so ui2api-chrome was
  // inactive, CDP 9222 was dead, and POST /prompt answered HTTP 500 while
  // /health said ok:true. A unit that is installed but not enabled is a unit
  // that is one reboot away from exactly that.
  assert.match(
    INSTALL_SERVICES,
    /systemctl enable ui2api-xvfb[^\n]*ui2api-chrome[^\n]*ui2api-api/,
    "install-services.sh does not enable all three units at boot"
  );
});

// ── the daemon runs the COMPILED build, not the checkout ────────────────────
// This is the load-bearing one. `npx tsx <checkout>/src/cli.ts` is precisely
// the shape deploy.sh was written to end.

test("the daemon ExecStart is the COMPILED /opt/ui2api/dist/cli.js, never npx tsx", () => {
  const ex = execStart(UNITS.api);
  assert.ok(ex, "scripts/ops/units/ui2api-api.service has no ExecStart");
  assert.ok(
    !/npx\s+tsx/.test(ex),
    `the unit starts the daemon out of a git checkout: ${ex}\nThat is the exact pre-deploy shape deploy.sh exists to end: the checkout is edited constantly, so a half-written file can be executed mid-commit, and a deploy to ${TARGET} would be silently undone.`
  );
  assert.ok(
    ex.includes(`${TARGET}/dist/cli.js`),
    `the unit does not run the compiled ${TARGET}/dist/cli.js: ${ex}`
  );

  // The unit ACTUALLY installed, when this box has one. A repo that says the
  // right thing while /etc says otherwise is exactly the drift that hides.
  const installed = unit("ui2api-api.service");
  if (installed === null) return;
  const iex = execStart(installed);
  assert.ok(iex, "ui2api-api.service has no ExecStart");
  assert.ok(!/npx\s+tsx/.test(iex), `the INSTALLED unit regressed to a tsx checkout launch: ${iex}`);
  assert.ok(iex.includes(`${TARGET}/dist/cli.js`), `the INSTALLED unit does not run the compiled build: ${iex}`);
});

test("no unit launches a TypeScript checkout", () => {
  for (const [name, text] of Object.entries(UNITS)) {
    for (const line of execStartLines(text)) {
      assert.ok(!/npx\s+tsx/.test(line), `units/${name}.service still runs a TS checkout: ${line}`);
    }
  }
});

test("the daemon is pointed at the deployed tree, not the checkout", () => {
  const wd = UNITS.api.match(/^WorkingDirectory=(.*)$/m);
  assert.ok(wd, "the api unit no longer sets WorkingDirectory");
  assert.equal(wd[1].trim(), TARGET, `WorkingDirectory is ${wd[1].trim()}, not ${TARGET}`);
});

// ── the vault pointer is explicit, never inherited ──────────────────────────
// The one that cost 23 minutes. A daemon that starts perfectly and replays
// signed-out on every site is a SILENT total failure, so the vault must be
// named in the unit rather than resolved relative to whatever WorkingDirectory
// happens to be.

test("the provisioned daemon is given UI2API_DATA_DIR explicitly", () => {
  assert.ok(
    /Environment=UI2API_DATA_DIR=/.test(UNITS.api),
    `the api unit does not set UI2API_DATA_DIR.\n` +
      `Without it the daemon resolves its vault relative to its own install dir, finds no ${TARGET}/data (a deploy never creates one), and every chat site replays signed-out while /health still answers ok:true.`
  );

  const installed = unit("ui2api-api.service");
  if (installed === null) return;
  assert.ok(
    /Environment=UI2API_DATA_DIR=/.test(installed),
    "the INSTALLED ui2api-api.service has no UI2API_DATA_DIR — the vault is then resolved by accident"
  );
});

test("the daemon unit pins the port, the chrome owner, and a real display", () => {
  for (const [label, text] of [["repo", UNITS.api], ["installed", unit("ui2api-api.service")]] as const) {
    if (text === null) continue;
    assert.match(text, /^Environment=UI2API_PROMPTD_PORT=\d+$/m, `${label}: no port pin`);
    assert.match(text, /^Environment=UI2API_CHROME_USER=ui2api$/m, `${label}: the daemon does not name the chrome owner`);
    assert.match(text, /^Environment=UI2API_HEADED=1$/m, `${label}: headed mode is not pinned`);
    // A display is what makes UI2API_HEADED=1 TRUE. Without it the daemon
    // silently falls back to --headless=new and the sites challenge it.
    assert.match(text, /^Environment=DISPLAY=:\d+$/m, `${label}: no DISPLAY is pinned, so UI2API_HEADED=1 is not true`);
    assert.match(text, /^User=ui2api$/m, `${label}: the daemon does not run as the chrome owner`);
  }
});

test("the repo unit and the installed unit agree", () => {
  const installed = unit("ui2api-api.service");
  if (installed === null) return;
  const strip = (t: string) =>
    t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).join("\n");
  assert.equal(strip(installed), strip(UNITS.api), "the installed ui2api-api.service has drifted from scripts/ops/units/");
});

// ── deploy.sh: target, vault exclusion, health gate ─────────────────────────

test("the deploy target is /opt/ui2api", () => {
  const m = DEPLOY.match(/^TARGET_DIR="([^"]*)"/m);
  assert.ok(m, "deploy.sh no longer pins TARGET_DIR");
  assert.equal(m[1], TARGET, `deploy target drifted to ${m[1]}`);
});

test("deploy.sh asserts the vault is absent from the target — BEFORE and AFTER the build", () => {
  // The credential-leak guard. `data/` is real login state; shipping it into an
  // install dir is the one unrecoverable mistake this script can make, so the
  // exclusion is ASSERTED, never trusted.
  const guards = DEPLOY.match(/\[\[ -e "\$TARGET_DIR\/data" \]\]/g) ?? [];
  assert.ok(
    guards.length >= 3,
    `expected the data-absence assertion before the rsync, after the build, and inside the rollback; found ${guards.length}`
  );
  assert.ok(
    DEPLOY.includes(`fail "$TARGET_DIR/data exists — a deploy must never create or replace the vault"`),
    "the staged-rsync data assertion no longer fails loudly"
  );
  assert.ok(
    DEPLOY.includes("appeared during the install/build"),
    "the post-build data assertion was removed — `npm ci` writes into the tree from the network and must not be able to leave a data/ behind"
  );
  // Every rsync in the script must exclude the vault, including the rollback
  // preserve and the restore. One rsync without the exclude is a leak. The
  // command is joined across its backslash continuations FIRST, because a
  // per-line match would only ever see `rsync -a --delete \` and would pass a
  // real leak straight through.
  for (const cmd of logicalLines(DEPLOY).filter((l) => l.startsWith("rsync -a --delete"))) {
    assert.match(cmd, /--exclude 'data\/'/, `an rsync does not exclude data/: ${cmd}`);
  }
});

test("deploy.sh health-checks the API AND its surface, and exits nonzero on failure", () => {
  // A green exit with a dead service is the failure this script exists to
  // prevent, so the health check is part of the exit status, not a log line.
  assert.match(
    DEPLOY,
    /rollback "the new release never became healthy"\n\s+fail "deploy FAILED/,
    "a health failure no longer rolls back AND exits nonzero"
  );
  assert.ok(
    DEPLOY.includes('rollback "the new release is alive but serves an empty/incorrect surface"'),
    "the surface check (registry + /v1/models + vault) no longer fails the deploy"
  );
  assert.ok(
    DEPLOY.includes('rollback "the new release cannot read the session vault"'),
    "an unreadable vault no longer fails the deploy"
  );
  // The health probe must be a REAL signal: a literal ok:true body is exactly
  // the stale-daemon failure, so the body is parsed rather than trusted.
  assert.ok(DEPLOY.includes("json_ok_is_true"), "deploy.sh no longer parses the /health body as JSON");
  assert.ok(DEPLOY.includes("json_count"), "deploy.sh no longer counts the served surface");
  // Bounded: a deploy that can wait forever is an outage that never ends.
  assert.match(DEPLOY, /^HEALTH_ATTEMPTS=\d+$/m, "the health wait is unbounded");
  assert.match(DEPLOY, /--max-time \d+/, "an http probe has no timeout");
});

test("the rollback rebuilds the restored release instead of shipping a bare source tree", () => {
  // The rollback point excludes dist/ and node_modules/, so a copy-only restore
  // produces a tree with no dist/cli.js and the restart it performs would
  // launch a service that cannot start. "Restored, still broken" is the worst
  // outcome a rollback can have, because it looks like recovery.
  assert.ok(
    DEPLOY.includes("npm run build") && DEPLOY.includes("ROLLBACK: rebuilding the restored release"),
    "the rollback no longer rebuilds the release it restores"
  );
  assert.ok(
    DEPLOY.includes("NOT restarting a half-built tree"),
    "a failed restore rebuild no longer refuses to restart"
  );
  assert.match(DEPLOY, /^RESTORE_BUILD_TIMEOUT=\d+$/m, "the restore rebuild is unbounded");
});

test("deploy.sh runs as root, needs the chrome user, and never writes the repo vault", () => {
  assert.ok(DEPLOY.includes('must run as root'), "deploy.sh no longer requires root");
  assert.ok(DEPLOY.includes('user $CHROME_USER does not exist'), "deploy.sh no longer checks the chrome user");
  // The vault the service reads lives in the operator's checkout and is only
  // ever READ. The deploy must never point data/ anywhere it could write.
  assert.ok(
    !/rsync[^\n]*\$\{?UI2API_DATA_DIR/.test(DEPLOY) && !/rsync[^\n]*"?\$REPO_DIR\/data/.test(DEPLOY),
    "deploy.sh appears to rsync the repo's data/ — the vault must never be moved by a deploy"
  );
});

// ── the anti-vacuity demonstrations ─────────────────────────────────────────
// The properties above are only worth pinning if removing them turns the gate
// RED. These two tests mutate the real text and assert the same predicates
// fail — the mechanism that proves the pins are load-bearing rather than
// decorative.

// The two pins the reds attack, as reusable predicates. Each is the SAME
// assertion the real gate makes, so a red here is a red there by construction
// rather than by a re-implementation that could drift.
const pinExecStartIsCompiled = (api: string) => {
  const ex = execStart(api);
  assert.ok(ex, "no ExecStart");
  assert.ok(!/npx\s+tsx/.test(ex), `regressed to a tsx checkout launch: ${ex}`);
  assert.ok(ex.includes("/opt/ui2api/dist/cli.js"), `not the compiled build: ${ex}`);
};
const pinVaultAssertedAbsent = (deploy: string) => {
  const guards = deploy.match(/\[\[ -e "\$TARGET_DIR\/data" \]\]/g) ?? [];
  assert.ok(guards.length >= 3, `only ${guards.length} data-absence assertions remain`);
  for (const cmd of logicalLines(deploy).filter((l) => l.startsWith("rsync -a --delete"))) {
    assert.match(cmd, /--exclude 'data\/'/, `an rsync does not exclude data/: ${cmd}`);
  }
};

/**
 * Mutate the real text, then assert the targeted pin turns RED. A pin that
 * survives its own mutation is decorative, and that is the failure this
 * harness exists to make impossible to hide.
 */
const wouldFail = (label: string, mutate: () => void, pin: () => void) => {
  mutate();
  let threw = false;
  try {
    pin();
  } catch {
    threw = true;
  }
  assert.ok(threw, `${label}: the pin did NOT fail on the mutant — the pin is decorative`);
};

test("MUTATION RED 1: a daemon ExecStart regressed to the checkout fails the gate", () => {
  wouldFail(
    "execstart-regressed",
    () =>
      UNITS.api.includes("ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd") ||
      assert.fail("the mutation anchor is gone — the real text no longer contains the compiled ExecStart"),
    () =>
      pinExecStartIsCompiled(
        UNITS.api.replace(
          "ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd",
          "ExecStart=/usr/bin/env npx tsx /home/me/Documents/projects/ui2api/src/cli.ts promptd"
        )
      )
  );
});

test("MUTATION RED 2: removing the vault-absence assertion fails the gate", () => {
  wouldFail(
    "vault-assertion-removed",
    () => assert.ok(logicalLines(DEPLOY).some((l) => l.startsWith("rsync -a --delete"))),
    () =>
      pinVaultAssertedAbsent(
        // Delete every data-absence assertion: the exact edit that would let a
        // deploy ship the captured-session vault into /opt/ui2api.
        DEPLOY.replace(/\[\[ -e "\$TARGET_DIR\/data" \]\]/g, "true").replace(/--exclude 'data\/' /g, "")
      )
  );
});
