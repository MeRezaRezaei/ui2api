/* GOAL 157 — the RUNNING SERVICE, not the REPO.
 *
 * Two gates, both hermetic: no browser, no daemon, no network, no /opt, no
 * subprocess (every probe is injected). Both exist because each one was
 * MEASURED as a false-green on the deployed daemon at 2026-09-29:
 *
 *   1. The deployed binary predated the fix by 4h35m
 *      (`grep -c perSiteMax /opt/ui2api/dist/prompt/pool.js` = 0 against a
 *      green repo) and recorded nothing about its own build, so nothing could
 *      tell a consumer which build was answering.
 *   2. All four workers sat busy on `copilot` at `busyMs ≈ 17,157,044`
 *      (4.77h) with every model unreachable, and `GET /health` answered 200
 *      `ok:true` for the whole of it.
 *
 * The anti-flap case below is the load-bearing one: a pool at 100% BUSY is a
 * NORMAL state, and a health check that flapped on it would be worthless
 * within a week. Only STUCKNESS — busy past the pool's own watchdog bound —
 * degrades.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIdentity, BUILD_STAMP_FILENAME, type BuildIdentityDeps } from "../src/runtime/build-info.js";
import { poolStuckness, healthOk, healthVerdict, type HealthVaultBlock } from "../src/prompt/http.js";
import type { PoolStatus, PoolWorkerStatus } from "../src/prompt/pool.js";

/* ---------- (1) THE BUILD STAMP ---------- */

/** A repo-shaped temp dir, so `findRepoRoot` has somewhere real to walk to. */
function repoDir(withGit: boolean): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-buildinfo-"));
  if (withGit) mkdirSync(join(dir, ".git"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("build identity: a build stamp is the deployed source of truth", () => {
  const stamp = JSON.stringify({ commit: "4ef0dfde609dec8993d00d820238c7e18aee8598", builtAt: "2026-09-29T10:00:00.000Z", dirty: false });
  const id = buildIdentity({
    fromDir: "/nonexistent/deploy/root",
    stampExists: () => true,
    readStamp: () => stamp,
    git: () => assert.fail("git must not be consulted when a valid stamp exists"),
  });
  assert.equal(id.source, "build-stamp");
  assert.equal(id.commit, "4ef0dfde609dec8993d00d820238c7e18aee8598");
  assert.equal(id.shortCommit, "4ef0dfd");
  assert.equal(id.builtAt, "2026-09-29T10:00:00.000Z");
  assert.equal(id.dirty, false);
});

test("build identity: a NON-commit in the stamp is REFUSED, never passed through", () => {
  // The core honesty rule: a wrong build stamp is worse than an absent one.
  for (const bogus of ["", "   ", "not-a-sha", "HEAD", "../../etc/passwd", "4ef0dfdZZ", 42, null, { a: 1 }]) {
    const { dir, cleanup } = repoDir(false);
    try {
      const id = buildIdentity({
        fromDir: dir,
        stampExists: () => true,
        readStamp: () => JSON.stringify({ commit: bogus, builtAt: "2026-09-29T10:00:00.000Z" }),
        git: () => { throw new Error("no git"); },
      });
      assert.equal(id.commit, null, `stamp commit ${JSON.stringify(bogus)} must not be reported as a commit`);
      assert.equal(id.source, "unknown");
    } finally {
      cleanup();
    }
  }
});

test("build identity: a malformed / unparseable stamp falls through, it does not throw", () => {
  const { dir, cleanup } = repoDir(false);
  try {
    for (const raw of ["{not json", "[]", '"a string"', "", "null"]) {
      const id = buildIdentity({
        fromDir: dir,
        stampExists: () => true,
        readStamp: () => raw,
        git: () => { throw new Error("no git"); },
      });
      assert.equal(id.source, "unknown");
      assert.equal(id.commit, null);
    }
  } finally {
    cleanup();
  }
});

test("build identity: a git worktree is reported AS a worktree, and an uncommitted tree says so", () => {
  const { dir, cleanup } = repoDir(true);
  try {
    const dirty: BuildIdentityDeps["git"] = (args) =>
      args[0] === "rev-parse" ? "4ef0dfde609dec8993d00d820238c7e18aee8598" : " M .brain/verbatim-goals.md";
    const id = buildIdentity({ fromDir: dir, stampExists: () => false, readStamp: () => null, git: dirty });
    assert.equal(id.source, "git-worktree");
    assert.equal(id.commit, "4ef0dfde609dec8993d00d820238c7e18aee8598");
    assert.equal(id.dirty, true, "an uncommitted tree must NOT pass as a clean commit");
  } finally {
    cleanup();
  }
});

test("build identity: an unmeasurable dirty state is null, NEVER 'clean'", () => {
  const { dir, cleanup } = repoDir(true);
  try {
    const id = buildIdentity({
      fromDir: dir,
      stampExists: () => false,
      readStamp: () => null,
      git: (args) => {
        if (args[0] === "rev-parse") return "4ef0dfde609dec8993d00d820238c7e18aee8598";
        throw new Error("status unavailable");
      },
    });
    assert.equal(id.dirty, null);
  } finally {
    cleanup();
  }
});

test("build identity: NOT a worktree and no stamp is an explicit `unknown` with a NAMED reason", () => {
  const { dir, cleanup } = repoDir(false);
  try {
    const id = buildIdentity({ fromDir: dir, stampExists: () => false, readStamp: () => null });
    assert.equal(id.source, "unknown");
    assert.equal(id.commit, null);
    assert.equal(id.shortCommit, null);
    assert.ok(id.reason && id.reason.includes("no-build-stamp"), `expected a named reason, got ${id.reason}`);
  } finally {
    cleanup();
  }
});

test("build identity: git present but unreadable is NAMED, never silently 'unknown'", () => {
  const { dir, cleanup } = repoDir(true);
  try {
    const id = buildIdentity({
      fromDir: dir,
      stampExists: () => false,
      readStamp: () => null,
      git: () => { throw new Error("fatal: detected dubious ownership"); },
    });
    assert.equal(id.source, "unknown");
    assert.ok(id.reason && id.reason.includes("git-available-but-unreadable"), id.reason ?? "");
  } finally {
    cleanup();
  }
});

test("build identity: the repo's real stamp filename is a build artefact under dist/", () => {
  // Anti-drift: the reader's filename and `npm run build`'s writer must agree,
  // and the path it lands in is already gitignored (`dist/`).
  assert.equal(BUILD_STAMP_FILENAME, "build-info.json");
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const build = pkg.scripts.build;
  assert.ok(build.includes("dist/runtime/build-info.json"), "npm run build must write the stamp");
  assert.ok(build.startsWith("tsc -p tsconfig.json &&"), "the stamp must be written AFTER tsc, or it describes the previous build");
});

test("build identity: reads the REAL repo stamp/git when run on this checkout (no fabrication)", () => {
  // Not injected: the honest seam, on the machine running the test. It must
  // return a real shape and must never invent a commit.
  const id = buildIdentity();
  assert.ok(["build-stamp", "git-worktree", "unknown"].includes(id.source), id.source);
  if (id.source === "unknown") assert.equal(id.commit, null, "unknown must carry a null commit, never a guess");
  if (id.source !== "unknown") assert.match(id.commit ?? "", /^[0-9a-f]{7,40}$/);
});

/* ---------- (2) THE STUCKNESS RULE ---------- */

const BOUND = 225_000; // 75% of the 300s request deadline, as the pool derives it

function worker(p: Partial<PoolWorkerStatus> & { busy: boolean; busyMs: number | null }): PoolWorkerStatus {
  return {
    site: "copilot",
    account: null,
    health: "live",
    checkedAt: "2026-09-29T10:00:00.000Z",
    dedicated: false,
    ...p,
  } as PoolWorkerStatus;
}

function status(workers: PoolWorkerStatus[]): PoolStatus {
  return {
    busyWatchdogMs: BOUND,
    perSiteMax: 2,
    requestTimeoutMs: 300_000,
    max: 4,
    workers,
    idle: workers.filter((w) => !w.busy).length,
    busy: workers.filter((w) => w.busy).length,
    total: workers.length,
  } as unknown as PoolStatus;
}

const healthyVault: HealthVaultBlock = {
  root: "/tmp/vault",
  present: true,
  error: null,
  hosts: 1,
  skipped: 0,
  accounts: 1,
  usable: 1,
  unusable: 0,
  unusableReasons: [],
  truncated: false,
};

test("stuckness (a): EVERY worker stuck past the bound ⇒ degraded, and ok goes false", () => {
  // The measured production shape: 4/4 wedged on one site.
  const workers = Array.from({ length: 4 }, () => worker({ busy: true, busyMs: 17_157_044 }));
  const s = poolStuckness(status(workers));
  assert.equal(s.degraded, true);
  assert.equal(s.stuck, 4);
  assert.equal(s.stuckWorkers.length, 4);
  assert.match(s.reason, /STUCK/);
  assert.match(s.reason, new RegExp(String(BOUND)));
  // The verdict, end to end: a PERFECTLY healthy vault must not rescue it.
  assert.equal(healthOk(healthyVault, 22, s), false, "a usable vault with every worker wedged is NOT a serving daemon");
  assert.equal(healthVerdict(healthyVault, 22, 33, s).ok, false);
});

test("stuckness (b): SOME stuck, some not ⇒ NOT degraded", () => {
  const workers = [
    worker({ busy: true, busyMs: 17_157_044 }),
    worker({ busy: true, busyMs: 5_000 }),
    worker({ busy: false, busyMs: null }),
    worker({ busy: false, busyMs: null }),
  ];
  const s = poolStuckness(status(workers));
  assert.equal(s.degraded, false, "partial capacity is not an outage");
  assert.equal(s.stuck, 1);
  assert.equal(s.healthyBusy, 1);
  assert.match(s.reason, /usable/);
  assert.equal(healthOk(healthyVault, 22, s), true);
});

test("stuckness (c) ANTI-FLAP: 100% busy, all within the bound ⇒ NOT degraded", () => {
  // The most important case. If this fails, /health flaps on every busy moment
  // and the signal becomes worthless within a week.
  const workers = Array.from({ length: 4 }, (_, i) => worker({ busy: true, busyMs: i * 1_000 }));
  const s = poolStuckness(status(workers));
  assert.equal(s.busy, 4);
  assert.equal(s.stuck, 0);
  assert.equal(s.degraded, false, "busy is a NORMAL state under load and must never degrade health");
  assert.match(s.reason, /does NOT degrade health/);
  assert.equal(healthOk(healthyVault, 22, s), true);
});

test("stuckness (d): ZERO workers ⇒ honest empty, no invented verdict", () => {
  const s = poolStuckness(status([]));
  assert.equal(s.noWorkers, true);
  assert.equal(s.degraded, false, "a cold pool that has spawned nothing is not an outage");
  assert.match(s.reason, /no workers yet/);
  assert.ok(s.reason.length > 0);
  assert.equal(healthOk(healthyVault, 22, s), true);
});

test("stuckness: the bound is READ FROM THE POOL, never a second literal", () => {
  // Anti-drift: if the pool's own bound moves, the gate must follow it — a
  // literal here is exactly how /health and the reclaim path would disagree.
  const st = status([worker({ busy: true, busyMs: 400_000 })]);
  st.busyWatchdogMs = 500_000; // the pool says the bound is 500s
  assert.equal(poolStuckness(st).degraded, false, "400s busy is fine when the bound is 500s");
  st.busyWatchdogMs = 300_000;
  assert.equal(poolStuckness(st).degraded, true, "400s busy is stuck when the bound is 300s");
});

test("stuckness: a busy worker with a NULL busyMs is UNMEASURED, not healthy-and-not-stuck", () => {
  const s = poolStuckness(status([worker({ busy: true, busyMs: null })]));
  // Counted in healthyBusy (it is not provably past the bound) but the reason
  // must not claim the pool is fine while a measurement is missing.
  assert.equal(s.stuck, 0);
  assert.ok(s.reason.length > 0);
});

test("stuckness: healthVerdict always carries the stuckness block, healthy or not", () => {
  const s = poolStuckness(status([worker({ busy: true, busyMs: 1000 })]));
  const v = healthVerdict(healthyVault, 22, 33, s) as { stuckness?: { reason?: string } };
  assert.ok(v.stuckness, "anti-vacuity: a verdict with no stuckness block is a FAILURE");
  assert.equal(typeof v.stuckness?.reason, "string");
});
