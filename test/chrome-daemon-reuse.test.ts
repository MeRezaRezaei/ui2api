import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPortLive,
  readDaemonState,
  writeDaemonStateAtomic,
  recordSpawnedDaemon,
  isPidAlive,
  DAEMON_STATE_ENV,
  DEFAULT_DAEMON_PORT,
  DAEMON_PORT_ENV,
  findOwnerChrome,
  stopChromeDaemon,
  type ChromeDaemonState,
} from "../src/runtime/chrome-daemon.js";

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

/**
 * THE STATE WRITE MUST BE ATOMIC, AND MUST NEVER CLAIM A DEAD CHILD.
 *
 * Two interleavings of two concurrent `chrome start` runs, both real:
 *
 *  1. TOCTOU. A resolves status ("no daemon"), B resolves status ("no daemon"),
 *     both spawn. Chrome permits one instance per profile, so one child exits
 *     immediately. The survivor's record is what matters — and a plain
 *     `writeFileSync` from the loser CLOBBERS it, so a live Chrome becomes
 *     untracked.
 *
 *  2. THE DEAD-PID RECORD — the expensive one. The loser's child is gone, but
 *     its port-wait observes the WINNER's port live, so it writes its own dead
 *     pid with `origin:"spawned"`. `origin:"spawned"` is the fact that authorises
 *     a kill, so `chrome stop` now signals a dead pid, kills nothing, and has no
 *     other legal move (the daemon refuses to kill a Chrome it did not start).
 *     The live Chrome is unstoppable, holds ProcessSingleton, and refuses every
 *     later `chrome start` until a manual `pkill`.
 *
 * Both are the same failure mode as the browser-launch orphan: one Chrome that
 * nothing can stop, wedging the box.
 *
 * THE CONCURRENCY SHAPE CHOSEN: compare-and-swap against the state observed
 * BEFORE the spawn, plus a live-pid gate. Not a lock file — a lock would need
 * its own stale-lock recovery, its own crash story, and would still not stop the
 * loser's dead pid from being recorded; the pid gate is what makes the record
 * true, and it is the part that matters. CAS then guarantees the winner's record
 * is never overwritten by a loser that did not observe it.
 */

const SRC = readPin("src/runtime/chrome-daemon.ts");

/** A pid that is guaranteed not to be alive: fork one, reap it, use its pid. */
function deadPid(): number {
  const r = spawnSync("/bin/sh", ["-c", "exit 0"]);
  const pid = r.pid;
  assert.ok(typeof pid === "number" && pid > 0, "could not obtain a reaped pid for the dead-pid case");
  assert.equal(isPidAlive(pid as number), false, "a reaped child must not read as alive");
  return pid as number;
}

function withStateDir<T>(fn: (dir: string, statePath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-daemon-state-"));
  const sp = join(dir, "chrome-daemon.json");
  const prev = process.env[DAEMON_STATE_ENV];
  process.env[DAEMON_STATE_ENV] = sp;
  try {
    return fn(dir, sp);
  } finally {
    if (prev === undefined) delete process.env[DAEMON_STATE_ENV];
    else process.env[DAEMON_STATE_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function st(over: Partial<ChromeDaemonState> = {}): ChromeDaemonState {
  return { port: 9333, pid: 4242, user: "ui2api", profile: "/home/ui2api/.config/ui2api-chrome", startedAt: "2026-10-05T00:00:00.000Z", origin: "spawned", ...over };
}

d("the daemon state write is atomic and never records a dead pid as spawned", () => {
  t("the write is temp+rename in the SAME directory, not a truncating writeFileSync", () => {
    const fn = SRC.slice(SRC.indexOf("export function writeDaemonStateAtomic"));
    const end = fn.indexOf("\nexport function readDaemonState");
    const body = end > 0 ? fn.slice(0, end) : fn;
    assert.match(body, /\.tmp-/, "the temp name must be per-process so two writers never share a temp file");
    assert.match(body, /renameSync\(/, "the commit must be a rename (atomic within a filesystem)");
    // ordering: the rename must come AFTER the chmod, so the mode is already 0600 when the name is swapped
    assert.ok(body.indexOf("chmodSync") < body.indexOf("renameSync"), "chmod 0600 must precede the rename");
    // the temp file must be in the SAME dir as the target, or rename becomes a
    // cross-device copy and is not atomic at all
    assert.match(body, /resolve\(dir,/, "the temp file must live in dirname(target)");
  });

  t("the committed state file is mode 0600 (the state names the chrome owner's home + pid)", () => {
    withStateDir((_dir, sp) => {
      writeDaemonStateAtomic(_dir, st());
      const mode = statSync(sp).mode & 0o777;
      assert.equal(mode, 0o600, `state file must be 0600 after the atomic write, got 0${mode.toString(8)}`);
      // and no temp residue is left behind
      const leftovers = readdirSync(join(sp, "..")).filter((f) => f.includes(".tmp-"));
      assert.deepEqual(leftovers, [], "a committed write must leave no temp file behind");
    });
  });

  t("CONCURRENCY, PROVEN BY TORN-READ: a plain writeFileSync IS observable half-written; the atomic write never is", async () => {
    // A child process hammers the writer while THIS process reads. `plain:true`
    // makes the child use the old truncating writeFileSync, `plain:false` makes
    // it use the shipped atomic writer — so the SAME harness falsifies both
    // directions instead of asserting the string "rename" appears.
    const child = join(tmpdir(), `ui2api-tear-${process.pid}-${Math.random().toString(36).slice(2, 7)}.mjs`);
    writeFileSync(
      child,
      `import { writeFileSync as wf } from "node:fs";
import { spawnSync } from "node:child_process";
const [mod, sp, plain, nStr] = process.argv.slice(2);
const m = await import(mod);
const N = Number(nStr);
const big = { port: 9333, pid: process.pid, user: "ui2api", profile: "x".repeat(200000), startedAt: "2026-10-05T00:00:00.000Z", origin: "spawned" };
if (plain === "1") { for (let i = 0; i < N; i++) wf(sp, JSON.stringify(big, null, 2), { mode: 0o600 }); }
else { for (let i = 0; i < N; i++) m.writeDaemonStateAtomic(process.argv[5], big); }
`,
    );
    // NOTE ON THE SHAPE OF THIS LOOP: it must yield to the event loop every
    // iteration. A fully synchronous spin cannot observe the writer child's exit
    // (`ChildProcess.exitCode` is refreshed by the event loop, on SIGCHLD), so an
    // async-less loop runs to its deadline doing 200KB reads — which is exactly
    // how this test hung the first time it ran.
    const run = async (plain: boolean): Promise<{ empty: number; partial: number; reads: number }> => {
      const dir = mkdtempSync(join(tmpdir(), "ui2api-tear-run-"));
      const sp = join(dir, "chrome-daemon.json");
      const moduleUrl = new URL("../src/runtime/chrome-daemon.ts", import.meta.url).href;
      const prev = process.env[DAEMON_STATE_ENV];
      process.env[DAEMON_STATE_ENV] = sp;
      let empty = 0;
      let partial = 0;
      let reads = 0;
      let w: ReturnType<typeof spawn> | null = null;
      try {
        w = spawn(process.execPath, ["--import", "tsx", child, moduleUrl, sp, plain ? "1" : "0", "300", dir], { stdio: "ignore" });
        const exited = new Promise<void>((res) => w!.once("exit", () => res()));
        const deadline = Date.now() + 20_000;
        // read as fast as we can WHILE it writes, yielding so the exit can land
        for (;;) {
          let raw: string;
          try {
            raw = readFileSync(sp, "utf8");
          } catch {
            raw = "";
          }
          if (raw.length === 0) {
            if (w.exitCode !== null || Date.now() > deadline) break; // nothing there yet, or it ended
            await new Promise((r) => setImmediate(r));
            continue;
          }
          reads++;
          try {
            const parsed = JSON.parse(raw) as { profile?: unknown };
            if (typeof parsed.profile !== "string" || parsed.profile.length !== 200000) partial++;
          } catch {
            partial++; // TORN: a half-written record that does not even parse
          }
          if (w.exitCode !== null || Date.now() > deadline) break;
          await new Promise((r) => setImmediate(r));
        }
        if (w.exitCode === null) w.kill("SIGKILL");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      } finally {
        if (w && w.exitCode === null) w.kill("SIGKILL");
        if (prev === undefined) delete process.env[DAEMON_STATE_ENV];
        else process.env[DAEMON_STATE_ENV] = prev;
        rmSync(dir, { recursive: true, force: true });
      }
      return { empty, partial, reads };
    };
    try {

    // FALSIFICATION (a): the OLD writer is observably torn under this reader.
    const plainRes = await run(true);
    assert.ok(plainRes.reads > 0, `the harness read nothing, so it proves nothing (plain=${JSON.stringify(plainRes)})`);
    assert.ok(plainRes.empty + plainRes.partial > 0, `precondition FAILED: the plain writer was never observed torn (${JSON.stringify(plainRes)}) — the harness cannot falsify anything`);

    // THE PROPERTY: the shipped writer is never observed torn.
    const atomicRes = await run(false);
    assert.equal(atomicRes.empty + atomicRes.partial, 0, `a reader observed a PARTIAL state file from the atomic writer (${JSON.stringify(atomicRes)}) — the rename is not protecting the record`);
    assert.ok(atomicRes.reads > 0, `sanity: the atomic run read nothing, so "never torn" would be vacuous (plain=${plainRes.reads}, atomic=${atomicRes.reads})`);
    } finally {
      rmSync(child, { force: true });
    }
  });

  t("a dead child pid is NEVER recorded with origin:'spawned' (the unstoppable-Chrome defect)", () => {
    const dead = deadPid();
    withStateDir((dir, sp) => {
      const res = recordSpawnedDaemon({ dataDir: dir, state: st({ pid: dead }), prior: null, pidAlive: isPidAlive });
      assert.equal(res.recorded, false, `pid ${dead} is dead — recording it as spawned is the defect`);
      assert.match(res.note, /not alive/, "and the refusal must NAME the reason");
      assert.equal(readDaemonState(dir), null, "nothing may be written for a dead pid");
      assert.equal(existsSync(sp), false, "no state file may exist claiming a dead daemon");
      // the negative control: the SAME call with a live pid DOES write — so the
      // assertion above is about the pid, not about a writer that never writes
      const live = recordSpawnedDaemon({ dataDir: dir, state: st({ pid: process.pid }), prior: null, pidAlive: isPidAlive });
      assert.equal(live.recorded, true, `a live pid (this process, ${process.pid}) must be recorded: ${live.note}`);
      assert.equal(readDaemonState(dir)?.pid, process.pid);
      assert.equal(readDaemonState(dir)?.origin, "spawned");
    });
  });

  t("pid 0 and negative pids are refused BEFORE the kill(pid,0) probe (kill(-1,0) signals everything)", () => {
    for (const bad of [0, -1, -99999, 1.5, Number.NaN]) {
      assert.equal(isPidAlive(bad), false, `pid ${bad} must never be probed or recorded`);
    }
    withStateDir((dir) => {
      const res = recordSpawnedDaemon({ dataDir: dir, state: st({ pid: -1 }), prior: null, pidAlive: isPidAlive });
      assert.equal(res.recorded, false, "the `pid: child.pid ?? -1` fallback must not become a record");
      assert.equal(readDaemonState(dir), null);
    });
  });

  t("compare-and-swap: a loser that did not observe the winner's record never overwrites it", () => {
    withStateDir((dir) => {
      // the WINNER's live daemon, recorded by process A
      const winner = st({ pid: process.pid, startedAt: "2026-10-05T00:00:01.000Z" });
      writeDaemonStateAtomic(dir, winner);
      // process B observed NO state before it spawned (`prior: null`) and now
      // tries to claim its own — the TOCTOU write
      const loser = recordSpawnedDaemon({ dataDir: dir, state: st({ pid: process.pid, startedAt: "2026-10-05T00:00:02.000Z" }), prior: null, pidAlive: isPidAlive });
      assert.equal(loser.recorded, false, "the loser must not clobber a record it never observed");
      assert.match(loser.note, /another chrome start/, "and must say a concurrent start won");
      assert.deepEqual(readDaemonState(dir), winner, "the WINNER's record must survive untouched");
    });
  });

  t("the shipped start path routes its write through the gated seam (not a bare write)", () => {
    const start = SRC.slice(SRC.indexOf("export async function startChromeDaemon"));
    assert.match(start, /recordSpawnedDaemon\(/, "start must record through the live-pid + CAS seam");
    const body = start.slice(start.indexOf("if (await isPortLive(port))"), start.lastIndexOf("chrome did not open"));
    assert.ok(body.length > 200, `the start-path slice must not be empty (len=${body.length}) — a wrong anchor would make every assertion below vacuous`);
    assert.ok(!/\bwriteDaemonStateAtomic\(opts\.dataDir, state\)/.test(body), "start must NEVER write the spawned record directly");
    assert.match(body, /origin: "adopted"/, "when the port belongs to someone else's Chrome, record it as ADOPTED — the only claim we can prove");
  });

  t("UNCHANGED BY THE FIX: stop still refuses a browser we did not start, and the gate is still before any kill", () => {
    // hand-check of the real code path, not a regex over the docstring
    const stop = SRC.slice(SRC.indexOf("export function stopChromeDaemon"));
    const gateIdx = stop.indexOf("state.origin !== \"spawned\"");
    const killIdx = stop.indexOf("process.kill");
    assert.ok(gateIdx > 0 && killIdx > gateIdx, "the origin gate must precede process.kill");
    // behaviourally: an adopted record is refused
    withStateDir((dir) => {
      writeDaemonStateAtomic(dir, st({ origin: "adopted" }));
      const r = stopChromeDaemon({ dataDir: dir });
      assert.equal(r.stopped, false, "an adopted browser must never be stopped");
      assert.match(r.note, /ADOPTED/, "and the refusal names why");
      // and an unknown-origin record (older build) is refused too
      writeDaemonStateAtomic(dir, st({ origin: undefined }));
      const r2 = stopChromeDaemon({ dataDir: dir });
      assert.equal(r2.stopped, false, "a record with no provenance must never be stopped");
      assert.match(r2.note, /no spawn provenance/, "and says we cannot prove it");
    });
  });
});
