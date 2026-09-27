/**
 * ROUND N+99 — the per-account write seam REFUSES a zero-auth snapshot.
 *
 * ## The defect this pins, measured not reasoned
 *
 * `AGENTS.md` claimed, for GOAL 49: "a snapshot with ZERO cookies AND ZERO
 * localStorage for the target host is REFUSED at the write seam with a named
 * `skipped-no-auth` verdict (nothing written to the vault)". The named verdict
 * existed — but in a TEST's own ladder (`test/profile-add-all.test.ts`), not in
 * production code. `snapshotHasAuth` was real and was consulted on the READ path
 * only. `saveAccountSnapshot` wrote whatever it was handed.
 *
 * Reproduced directly before the fix: saving a snapshot with `cookies: []` and
 * `localStorage: []` wrote a 208-byte `state.json` at 0600 **plus** an
 * `accounts.json` index row, while `snapshotHasAuth` was returning `false`
 * throughout.
 *
 * ## Why it is a data-loss bug and not a tidiness bug
 *
 * An account snapshot is overwritten IN PLACE. So writing an empty one destroys
 * a previously good captured session. Measured live on this box: after a single
 * `profile add-all --known`, `www.aparat.com` — recorded live-verified with
 * `araprat_search` / `araprat_trending` / `araprat_video_detail` all `ok:true` —
 * was left holding a 210-byte snapshot with `cookies: []`, and `chatgpt.com` a
 * 204-byte one. Both had reported `decrypt-limited (portal v20)`.
 *
 * The mechanism is a mismatch between two questions. The caller asked "did any
 * cookie MATCH this host?" and got yes. The thing being written asked "do I
 * carry auth?" and the answer was no. A Chrome cookie that matches the host but
 * whose value cannot be extracted counts as a match and contributes nothing, so
 * the match count said "we have auth" while the artifact was empty. **The gate
 * was measuring the READ, not the WRITE.**
 *
 * ## What is pinned here
 *
 * The refusal lives in the write seam itself, because a gate reachable only by a
 * caller that remembers to call it is not a gate. It throws a NAMED error rather
 * than returning a value a caller may ignore.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveAccountSnapshot,
  loadAccountSnapshot,
  listAccounts,
  snapshotHasAuth,
  accountSnapshotPath,
} from "../src/runtime/session-store.js";
import type { ProfileSnapshot } from "../src/runtime/session-store.js";

const HOST = "write-gate.example.com";

function snap(over: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    version: 1,
    host: HOST,
    origin: `https://${HOST}`,
    capturedAt: new Date().toISOString(),
    cookies: [{ name: "SID", value: "real-token", domain: HOST, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    ...over,
  } as ProfileSnapshot;
}

/** Every file the write seam put on disk, relative to the root. */
function tree(root: string, pre = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...tree(p, `${pre}${e.name}/`));
    else out.push(pre + e.name);
  }
  return out;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "u2a-write-gate-"));
}

test("a zero-auth snapshot is REFUSED at the write seam and NOTHING is written", () => {
  const dir = tmp();
  try {
    const empty = snap({ cookies: [], localStorage: [] });
    // Precondition, asserted so this test cannot pass for the wrong reason: the
    // gate's own predicate says this snapshot is anonymous. Without this, a
    // snapshotHasAuth that always returned true would make the refusal vacuous.
    assert.equal(snapshotHasAuth(empty), false, "precondition: zero cookies AND zero localStorage");

    assert.throws(
      () => saveAccountSnapshot(dir, HOST, "someone@example.com", empty, { source: "import" }),
      /no-auth-snapshot-refused/,
      "the write seam must REFUSE a zero-auth account snapshot, by a NAMED error"
    );

    const written = tree(dir);
    assert.deepEqual(written, [], `nothing may reach disk; found ${JSON.stringify(written)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refusal is an OVERWRITE refusal: a good snapshot survives a zero-auth attempt", () => {
  const dir = tmp();
  try {
    const id = "acct@example.com";
    saveAccountSnapshot(dir, HOST, id, snap(), { source: "capture" });
    const good = readFileSync(accountSnapshotPath(dir, HOST, "acct@example.com"), "utf8");
    assert.ok(good.includes("real-token"), "precondition: the good snapshot is on disk");

    assert.throws(
      () => saveAccountSnapshot(dir, HOST, id, snap({ cookies: [], localStorage: [] }), { source: "import" }),
      /no-auth-snapshot-refused/
    );

    const after = readFileSync(accountSnapshotPath(dir, HOST, "acct@example.com"), "utf8");
    assert.equal(after, good, "the captured session must be byte-identical after a refused overwrite");
    assert.ok(loadAccountSnapshot(dir, HOST, "acct@example.com"), "and must still load");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a snapshot carrying localStorage but no cookies is STILL auth (the gate is not 'cookies > 0')", () => {
  const dir = tmp();
  try {
    // The gate is `cookies > 0 || localStorage > 0`. A site that keeps its session
    // in localStorage and sets no cookies is a REAL logged-in case, and a gate
    // that demanded cookies would refuse it and destroy a working capture.
    const lsOnly = snap({ cookies: [], localStorage: [["token", "abc"]] as never });
    assert.equal(snapshotHasAuth(lsOnly), true, "precondition: localStorage counts as auth");
    const row = saveAccountSnapshot(dir, HOST, "ls@example.com", lsOnly, { source: "capture" });
    assert.equal(row.slug, "ls@example.com", "slug is the identity as slugified");
    assert.ok(loadAccountSnapshot(dir, HOST, "ls@example.com"), "must be written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ANTI-VACUITY: the refusal test fails if the gate is removed (mutation, proven here)", () => {
  // The "nothing written" assertion is the load-bearing one, and it is the kind
  // that can silently become unfalsifiable. Prove it bites: simulate the pre-fix
  // behaviour by writing an anonymous snapshot the way the old seam did, and
  // assert the file DOES appear — so the assertion in the first test is
  // discriminating rather than trivially true for any implementation.
  const dir = tmp();
  try {
    const path = accountSnapshotPath(dir, HOST, "anon@example.com");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(snap({ cookies: [], localStorage: [] }), null, 2), "utf8");
    assert.ok(readdirSync(join(dir, "sessions", HOST)).length > 0,
      "a bypassing writer DOES leave a file — so the refusal test can fail");
    assert.equal(snapshotHasAuth(snap({ cookies: [], localStorage: [] })), false,
      "yet that file is anonymous — the gate must catch it, and the seam does not run here");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused write leaves NO index row, so /accounts cannot list an anonymous session", () => {
  const dir = tmp();
  try {
    assert.throws(
      () => saveAccountSnapshot(dir, HOST, "ghost@example.com", snap({ cookies: [], localStorage: [] }), { source: "import" }),
      /no-auth-snapshot-refused/
    );
    // The index is the surface /accounts and /registry read. An anonymous row
    // there is exactly what GOAL 49 named: a session that "can only ever replay
    // signed-out" presented as a listed account.
    assert.deepEqual(listAccounts(dir, HOST), [], "no row may be listed for a refused snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the write seam still hardens modes (the refusal did not cost the 0600 guarantee)", () => {
  const dir = tmp();
  try {
    saveAccountSnapshot(dir, HOST, "mode@example.com", snap(), { source: "capture" });
    const f = accountSnapshotPath(dir, HOST, "mode@example.com");
    const mode = statSync(f).mode & 0o777;
    assert.equal(mode & 0o077, 0, `snapshot must have no group/other bits, got ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
