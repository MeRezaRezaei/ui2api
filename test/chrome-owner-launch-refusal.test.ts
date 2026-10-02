import { test as t } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchBrowser } from "../src/runtime/browser.js";

/**
 * THE CHROME-OWNER LAUNCH REFUSAL — the guard with `testfiles=0`.
 *
 * Commit `4967d9d` added `isChromeOwnerProcess()` to `src/runtime/browser.ts` and
 * made the launch seam hard-throw for a non-owner process. It shipped with no
 * test. Its follow-up `07f779a` rewrote the guard (scoping the refusal to hosts
 * that HAVE a daemon) and also shipped no test. `grep -rn "refusing to spawn\|
 * isChromeOwnerProcess" test/` was empty, so nothing asserted the refusal at all.
 *
 * WHY THAT IS NOT A COSMETIC GAP. The point of use of this project is a
 * DEDICATED linux user (`ui2api`): the operator's interactive browser cannot be
 * driven — Chrome refuses to attach to a browser a person is using, and refuses
 * `--remote-debugging-port` on a live profile. "That is a wall, not a bug to
 * engineer around." This guard is the only code that ENFORCES it at the only
 * place a browser can be born. If it silently stopped firing, the daemon would
 * drive whichever profile it could find, and the property the entire chrome-owner
 * design exists to protect would be gone with nothing to notice. MEASURED cost of
 * leaving it open: 23 orphaned Chrome processes owned by the operator while the
 * real browser belonged to `ui2api`.
 *
 * ── THE SEAM, and why no new one was invented ─────────────────────────────────
 *
 * `isChromeOwnerProcess()` is NOT exported and takes no arguments, so the test
 * cannot call it. It is reached only through `launchBrowser()`, and its answer is
 * decided by exactly three inputs:
 *
 *   1. `process.env.UI2API_CHROME_USER` — the owner's NAME. Injectable by
 *      definition: it is an env knob, and `test/chrome-point-of-use.test.ts`
 *      already pins that it selects the owner.
 *   2. `process.getuid` — the process's REAL uid. This is the whole point of the
 *      guard (its own comment: `$USER` "would make this check trivially
 *      bypassable"), and `process.getuid` is a WRITABLE, CONFIGURABLE own
 *      property of `process` (verified on this runtime), so a test can stand in a
 *      uid without the test itself reading the machine. This is the seam, and it
 *      already existed.
 *   3. `ownerUid(name)` — reads `/etc/passwd` for the name's uid, and returns the
 *      sentinel `"-1"` when there is no such line. The TEST never reads that file;
 *      the guard does, and choosing an owner name that exists nowhere makes its
 *      answer `"-1"` on every host.
 *
 * So the guard is driven entirely through (1)+(2)+(3) with NO change to `src/`.
 * `resolveChromeOwner()` is deliberately NOT used as the seam: it takes no
 * arguments either, and its `runningAsOwner` is a second, independent
 * implementation of the same question (it reads `getent`, the guard reads
 * `/etc/passwd`) — testing the guard through it would test the wrong function.
 *
 * ── NO REAL MACHINE, NO REAL BROWSER ──────────────────────────────────────────
 *
 * `test/host-independence-gate.test.ts` fails CI on host-binary execs and
 * `os.userInfo()`/`homedir()`/`hostname()`. This file calls none of them. There
 * is also no browser: every case pins `executablePath` at a CANARY script in a
 * `mkdtemp` dir which writes a MARKER file and exits 1. The marker's existence is
 * the real assertion — it proves a spawn was ATTEMPTED, which is a stronger
 * signal than any error message, and it proves the refusal happened BEFORE any
 * spawn, which is the entire safety property (a refusal that still spawned would
 * be worthless). Nothing here can launch Chrome.
 */

/**
 * An owner name that exists in no `/etc/passwd` on any host, so `ownerUid()`
 * returns its `"-1"` sentinel and the comparison
 * `String(process.getuid()) === ownerUid(name)` is decided entirely by the uid
 * this file injects. Deliberately not a plausible account name: if it ever
 * existed, the guard would compare against a real uid and the whole file's
 * premise would quietly stop holding.
 */
const ABSENT_OWNER = "ui2a-absent-owner-canary-zz9";

/** The refusal text, as one pattern. Its absence is what the owner case asserts. */
const REFUSAL = /refusing to spawn a browser: this process is not the chrome owner/;

/** The uid the guard returns for a name with no `/etc/passwd` line. */
const SENTINEL_UID = "-1";

const SEAM = readFileSync("src/runtime/browser.ts", "utf8");

/** The two env vars + the two profile knobs that must not leak in from the box. */
const OWNED_ENV = [
  "UI2API_ATTACH_PORT",
  "UI2API_CHROME_USER",
  "UI2API_USER_DATA_DIR",
  "UI2API_CHROME_PROFILE_PATH",
  "UI2API_CHROME_PATH",
  "UI2API_CHROME",
  "UI2API_CHROME_OWNER_PROFILE",
] as const;

/**
 * Run `launchBrowser` against a hermetic canary, with the guard's inputs
 * injected. Returns what the seam DID, not merely what it said.
 *
 * `attachPort` is passed through `overrides` rather than the env so the case is
 * about the guard's own `expectedPort` read, which reads `env ?? overrides`.
 */
async function attempt(opts: {
  uid: number | "absent" | "throws";
  attachPort?: number;
  /** `undefined` keeps ABSENT_OWNER; `null` DELETES the var (the default owner). */
  ownerEnv?: string | null;
}): Promise<{ message: string; spawned: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "ui2a-owner-guard-"));
  const marker = join(dir, "spawned");
  const canary = join(dir, "canary");
  // Writes the marker, then exits non-zero. `spawnChromeAndConnect` surfaces
  // this as "chrome exited early (code 1)" — a NAMED failure that is not the
  // refusal, so the two outcomes can never be confused.
  writeFileSync(canary, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });

  const realGetuid = process.getuid;
  const savedEnv = { ...process.env };
  try {
    // Start from a known-empty owner-related environment: an ambient
    // UI2API_ATTACH_PORT or a UI2API_CHROME_OWNER_PROFILE on the box would
    // otherwise decide the case.
    for (const k of OWNED_ENV) delete process.env[k];
    process.env.UI2API_CHROME_USER = ABSENT_OWNER;
    // ONLY an explicit `null` means "unset the var"; `undefined` means "leave the
    // canary name alone". Reading `undefined` as "delete" silently turned every
    // default-owner case into an ABSENT_OWNER case, which is why the first run of
    // this file reported `ui2api` cases answered with the canary name.
    if (opts.ownerEnv === null) delete process.env.UI2API_CHROME_USER;
    else if (opts.ownerEnv !== undefined) process.env.UI2API_CHROME_USER = opts.ownerEnv;
    if (opts.attachPort !== undefined) process.env.UI2API_ATTACH_PORT = String(opts.attachPort);

    if (opts.uid === "absent") process.getuid = undefined as unknown as typeof process.getuid;
    else if (opts.uid === "throws")
      process.getuid = (() => {
        throw new Error("getuid is unavailable on this platform");
      }) as typeof process.getuid;
    else process.getuid = (() => opts.uid) as typeof process.getuid;

    const overrides: Record<string, unknown> = { executablePath: canary, userDataDir: join(dir, "profile") };
    if (opts.attachPort !== undefined) overrides.attachPort = opts.attachPort;

    let message = "RESOLVED (a browser came up)";
    try {
      await launchBrowser(0, overrides as never);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    return { message, spawned: existsSync(marker) };
  } finally {
    process.getuid = realGetuid;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────── the refusal fires ──

t("a non-owner process is REFUSED when a daemon is expected, and NOTHING is spawned", async () => {
  // The load-bearing case: the guard must stop the spawn, not merely complain
  // afterwards. TWO uids are used and both must refuse, because a single injected
  // uid could in principle collide with a real `/etc/passwd` entry on some host —
  // two distinct ones cannot be the same uid, so the verdict cannot be an
  // accident of the box.
  for (const uid of [4242, 4243]) {
    const r = await attempt({ uid, attachPort: 1 });
    assert.match(r.message, REFUSAL, `uid ${uid}: a non-owner must be refused, got: ${r.message.slice(0, 120)}`);
    assert.equal(
      r.spawned,
      false,
      `uid ${uid}: the refusal fired but a browser was STILL spawned — the guard refused after the fact, which is worthless`,
    );
  }
});

t("the refusal fires on a non-POSIX process too — no getuid means never the owner", async () => {
  // `typeof process.getuid === "function"` is the first clause of the guard. A
  // host without it (Windows) must fail CLOSED, not open: "I cannot prove I am
  // the owner" is a non-owner, not an owner.
  const absent = await attempt({ uid: "absent", attachPort: 1 });
  assert.match(absent.message, REFUSAL, `a process with no getuid must be refused, got: ${absent.message.slice(0, 120)}`);
  assert.equal(absent.spawned, false, "and nothing may be spawned");

  // Same for a getuid that THROWS — the guard's own `catch { return false }`.
  const threw = await attempt({ uid: "throws", attachPort: 1 });
  assert.match(threw.message, REFUSAL, `a throwing getuid must be refused, got: ${threw.message.slice(0, 120)}`);
  assert.equal(threw.spawned, false, "and nothing may be spawned");
});

// ─────────────────────────────────────────────────────────── the owner proceeds ──

t("the owner process is NOT refused — it is allowed through to the spawn", async () => {
  // The other half, and without it the file would only pin a refusal. The uid is
  // the guard's own `"-1"` sentinel, which is what `ownerUid()` returns for a name
  // with no `/etc/passwd` line — so this drives the REAL comparison
  // `String(process.getuid()) === ownerUid(name)`, not a bypass of it.
  const r = await attempt({ uid: Number(SENTINEL_UID), attachPort: 1 });
  assert.doesNotMatch(
    r.message,
    REFUSAL,
    "the owner must never be refused — that is the guard refusing the one process it exists to admit",
  );
  assert.equal(
    r.spawned,
    true,
    "the owner must be allowed to SPAWN (the canary's own exit is the expected ending here); a spawned=false means the refusal fired",
  );
});

t("the owner is admitted by its REAL uid from the passwd file, not by the -1 sentinel", async () => {
  // MEASURED GAP this case was written for. The owner case above drives the
  // guard's `"-1"` sentinel (what `ownerUid()` returns for a name that exists
  // nowhere). A mutation that made EVERY name resolve to the sentinel — i.e.
  // deleted the `/etc/passwd` lookup outright — was observed to leave the whole
  // file GREEN: with every uid equal to `"-1"`, the comparison cannot tell a
  // resolved owner from a missing one. That is precisely the mutation this case
  // exists to kill, and it is the difference between "the guard admits its owner"
  // and "the guard admits anybody whose uid happens to be -1".
  //
  // `root` is uid 0 on every POSIX system by definition, so this asserts a fact
  // about the guard using a universally-true account WITHOUT reading the host:
  // nothing here inspects `/etc/passwd`, `getent` or the real uid — the uid is
  // injected, and the account name is a constant that is true everywhere.
  const real = await attempt({ uid: 0, attachPort: 1, ownerEnv: "root" });
  assert.doesNotMatch(
    real.message,
    REFUSAL,
    `uid 0 IS root, so a root owner must be admitted; got: ${real.message.slice(0, 120)}`,
  );
  assert.equal(real.spawned, true, "and the spawn must be attempted");

  // The other half of the same discrimination, and it is what makes the case
  // bite: the SAME injected uid must still be refused for a name that does not
  // exist. Without this, "admit uid 0" could be satisfied by admitting everything.
  const absent = await attempt({ uid: 0, attachPort: 1, ownerEnv: ABSENT_OWNER });
  assert.match(
    absent.message,
    REFUSAL,
    "uid 0 must still be refused when the owner NAME does not exist — the name is resolved, not ignored",
  );
  assert.equal(absent.spawned, false, "and nothing may be spawned");
});

t("ROUND N+106: with NO daemon expected, even a non-owner is not refused", async () => {
  // This is the `07f779a` rewrite, and it is why this file must pin BOTH
  // directions. Pipeline 472 died because the ORIGINAL guard refused unconditionally
  // — "a host with NO daemon has no duplicate to prevent, and refusing there buys
  // nothing except a broken test suite". Re-tightening it would be a real
  // regression; loosening it back is the original defect. The scoping is the
  // behaviour, so it is pinned as behaviour.
  const r = await attempt({ uid: 4242 });
  assert.doesNotMatch(
    r.message,
    REFUSAL,
    `with no attach port there is no duplicate to prevent, so the spawn must be allowed; got: ${r.message.slice(0, 120)}`,
  );
  assert.equal(r.spawned, true, "the spawn must actually be attempted when no daemon is expected");
});

// ─────────────────────────────────────────────────────────── the refusal's TEXT ──

t("the refusal names the owner it compared against, and both remedies", async () => {
  // The message is the only thing an operator sees, and it is the operator's only
  // route out of the refusal. Two requirements: it names the OWNER (so the fix is
  // "run as THIS user"), and it names both ways out (run as them, or attach).
  const custom = await attempt({ uid: 4242, attachPort: 1, ownerEnv: ABSENT_OWNER });
  assert.ok(
    custom.message.includes(ABSENT_OWNER),
    `the refusal must name the owner it compared against; got: ${custom.message.slice(0, 160)}`,
  );
  assert.match(custom.message, /UI2API_ATTACH_PORT/, "and it must name the attach knob as a remedy");
  assert.match(custom.message, /Run as that user/, "and the run-as-the-owner remedy");

  // The DEFAULT owner is `ui2api` when the env is unset — pinned with a non-owner
  // uid, and again with two uids so no `/etc/passwd` collision can explain it.
  for (const uid of [4242, 4243]) {
    const dflt = await attempt({ uid, attachPort: 1, ownerEnv: null });
    assert.match(dflt.message, REFUSAL, `uid ${uid}: the default owner must still be enforced`);
    assert.ok(
      dflt.message.includes("ui2api"),
      `uid ${uid}: with UI2API_CHROME_USER unset the refusal must name the DEFAULT owner (ui2api); got: ${dflt.message.slice(0, 160)}`,
    );
  }
});

// ───────────────────────────────────────── the property the comparison rests on ──

t("the guard compares the REAL uid, never $USER — which would be spoofable", async () => {
  // The guard's own comment says why: `os.userInfo()` "reflects the REAL uid, not
  // $USER, which an operator can set to anything and which would make this check
  // trivially bypassable". That is a security property of the comparison, and a
  // refactor to `$USER` would keep every behavioural case in this file GREEN while
  // removing the only thing that makes the guard worth having. So it is pinned
  // from the seam's source.
  //
  // COMMENTS ARE BLANKED before judging, and that is load-bearing rather than
  // hygiene: the guard's own comment NAMES `os.userInfo()` to explain why it is
  // NOT used. Scanned raw, the comment would make this predicate fire on correct
  // code — and a pin that fires on correct code is a pin whose fix is to delete
  // the explanation, which is exactly how gates rot. Prose is not a call.
  const raw = SEAM.slice(SEAM.indexOf("function isChromeOwnerProcess"));
  assert.ok(raw.length > 0, "the guard must still exist — if this fails, the seam was renamed or removed");
  const body = raw
    .slice(0, raw.indexOf("\n}"))
    .split("\n")
    .map((l) => {
      const c = l.indexOf("//");
      return c === -1 ? l : l.slice(0, c);
    })
    .join("\n");
  assert.match(body, /process\.getuid/, "the guard must read the real uid via process.getuid()");
  assert.doesNotMatch(body, /process\.env\.USER\b/, "the guard must NOT read $USER: it is operator-controlled and spoofable");
  assert.doesNotMatch(
    body,
    /\b(?:userInfo|homedir|hostname)\s*\(/,
    "the guard must not CALL any other real-identity source — process.getuid() is the one it is built on",
  );
  // And the control: the blanking really is what made the difference, so the
  // predicate is not vacuously green on a body it never really read.
  assert.match(
    raw.slice(0, raw.indexOf("\n}")),
    /userInfo/,
    "CONTROL: the guard's comment does name os.userInfo(); if this ever stops being true the blanking above is untested",
  );
});
