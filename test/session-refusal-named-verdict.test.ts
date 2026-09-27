// GOAL 124 — a REFUSED session snapshot must never silently degrade into an
// anonymous run that still answers ok:true.
//
// The bug: `loadSnapshot` returned a bare `null` for THREE genuinely different
// outcomes (absent file / corrupt-unreadable file / GOAL-59 shape-invalid
// file), computed the correct reason and discarded it. Every consumer read that
// one `null` as "no session, carry on". The 12 capability runners re-checked
// and threw on the explicit-account branch, but ChatDriver had NO such throw —
// it loaded the requested account, got null, fell through to the legacy cookie
// file and then to no session at all, and answered normally. The pre-browser
// guard `resolveCapabilityAccount` only checked that an INDEX ROW existed,
// never that the snapshot behind it was readable + authed, so the refusal only
// surfaced (never) after a browser had already launched.
//
// Every assertion below is inside a real, counted `test(...)`.
// NOTHING here reads, writes, chmods or deletes anything under the real
// `data/` dir: every case works inside `os.tmpdir()`.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadSnapshot,
  loadSnapshotVerdict,
  loadAccountSnapshot,
  loadAccountSnapshotVerdict,
  listAccounts,
  saveAccountSnapshot,
  slugifyIdentity,
  snapshotPath,
  accountSnapshotPath,
  saveSnapshot,
  validateSnapshotShape,
  type ProfileSnapshot,
} from "../src/runtime/session-store.js";
import { resolveCapabilityAccount } from "../src/prompt/http.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

const HOST = "vault-test.example";
const OTHER_HOST = "other.example";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "u2a-goal124-"));
}

function snap(over: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    version: 1,
    host: HOST,
    origin: `https://${HOST}`,
    capturedAt: "2026-09-26T00:00:00.000Z",
    cookies: [{ name: "sid", value: "v", domain: `.${HOST}` }],
    localStorage: [["token", "t"]],
    sessionStorage: [],
    indexedDB: [],
    ...over,
  };
}

const profile = { id: "vault-test", url: `https://${HOST}/chat` } as ChatSiteProfile;

// A usable account: one real cookie (GOAL 49: carries auth).
function writeUsable(dataDir: string, identity: string, host = HOST): void {
  saveAccountSnapshot(dataDir, host, identity, snap({ host }), { source: "capture" });
}

// An index row that points at NOTHING usable — the exact GOAL 124 class. The
// file exists and parses, but the content is the GOAL 49 anonymous class.
// ROUND N+99: this fixture used to build the anonymous row THROUGH
// `saveAccountSnapshot`, which is exactly how the write seam's missing gate stayed
// invisible — the helper was the only way these tests made an anonymous snapshot
// exist, so "the seam happily writes one" never surfaced as a failure.
//
// The write seam now REFUSES a zero-auth snapshot (nothing written, named error), so
// this reproduces the LEGACY on-disk state instead: a real index row, paired with a
// snapshot that turned out to carry no auth. It writes a credential-bearing snapshot
// first (which legitimately creates the index row) and then overwrites the snapshot
// with the anonymous one.
//
// That is deliberate, not a workaround. An anonymous snapshot CAN still exist on
// disk — written by an older build, or by a flat non-account path — and it WILL be
// listed, because the index was written when the import looked fine. The READ-side
// named verdict these tests exist to prove must still fire on exactly that state. A
// read verdict only reachable through a writer that now refuses would be untested,
// and the blind-empty failure they guard against would be unreachable.
function writeAnonymousRow(dataDir: string, identity: string, host = HOST): void {
  const row = saveAccountSnapshot(dataDir, host, identity, snap({ host }), { source: "capture" });
  writeFileSync(
    accountSnapshotPath(dataDir, host, row.slug),
    JSON.stringify(snap({ host, cookies: [], localStorage: [] }), null, 2),
    "utf8"
  );
}

// A row whose snapshot is right-SHAPED-looking but corrupt JSON.
function writeCorruptRow(dataDir: string, identity: string, host = HOST): void {
  const row = saveAccountSnapshot(dataDir, host, identity, snap({ host }), { source: "capture" });
  writeFileSync(accountSnapshotPath(dataDir, host, row.slug), "{ this is not json", "utf8");
}
// A row whose snapshot parses but is GOAL-59 shape-invalid (cookies is a string).
function writeShapeInvalidRow(dataDir: string, identity: string, host = HOST): void {
  const row = saveAccountSnapshot(dataDir, host, identity, snap({ host }), { source: "capture" });
  writeFileSync(
    accountSnapshotPath(dataDir, host, row.slug),
    JSON.stringify({ ...snap({ host }), cookies: "not-an-array" }),
    "utf8"
  );
}

// A row whose snapshot FILE was deleted out from under the index.
function writeMissingFileRow(dataDir: string, identity: string, host = HOST): void {
  const row = saveAccountSnapshot(dataDir, host, identity, snap({ host }), { source: "capture" });
  rmSync(accountSnapshotPath(dataDir, host, row.slug), { force: true });
}

// ---------------------------------------------------------------------------
// 1. The load seam carries a NAMED verdict, not a bare null.
// ---------------------------------------------------------------------------

test("GOAL 124: loadSnapshotVerdict names the four load outcomes (absent / unreadable / shape-invalid / ok) instead of collapsing them to null", () => {
  const base = tempRoot();
  try {
    const absent = join(base, "nothing", "state.json");

    // absent
    const a = loadSnapshotVerdict(absent);
    assert.equal(a.status, "absent", "no file -> 'absent'");
    assert.equal(a.snapshot, null, "absent carries no snapshot");

    // unreadable (corrupt JSON)
    const corrupt = join(base, "corrupt.json");
    writeFileSync(corrupt, "{ not json at all", "utf8");
    const u = loadSnapshotVerdict(corrupt);
    assert.equal(u.status, "unreadable", "corrupt JSON -> 'unreadable'");
    assert.equal(u.snapshot, null);
    assert.ok(u.detail, "unreadable names WHY");

    // shape-invalid, with the FIELD named (this reason used to be discarded)
    const bad = join(base, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...snap(), cookies: "nope" }), "utf8");
    const s = loadSnapshotVerdict(bad);
    assert.equal(s.status, "shape-invalid", "wrong-shaped -> 'shape-invalid'");
    assert.equal(s.snapshot, null);
    assert.equal(s.detail, "cookies must be an array", "the field message is KEPT, not thrown away");

    // ok
    const good = join(base, "good.json");
    writeFileSync(good, JSON.stringify(snap()), "utf8");
    const g = loadSnapshotVerdict(good);
    assert.equal(g.status, "ok", "a valid snapshot -> 'ok'");
    assert.equal(g.snapshot?.cookies.length, 1, "ok carries the snapshot");

    // The four outcomes are DISTINGUISHABLE — the whole point of the fix.
    const statuses = new Set([a.status, u.status, s.status, g.status]);
    assert.equal(statuses.size, 4, "four distinct statuses — a null-collapsing load cannot express this");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("GOAL 124 MUTATION: the OLD null-collapsing load loses the verdict — a collapse back to one null fails this test", () => {
  const base = tempRoot();
  try {
    // A faithful re-implementation of the pre-fix `loadSnapshot` (GOAL 59's
    // shape gate INCLUDED): one bare null for absent, corrupt and shape-invalid
    // alike. It is the mutation.
    const oldLoadSnapshot = (path: string): ProfileSnapshot | null => {
      try {
        if (!existsSync(path)) return null;
        const raw = JSON.parse(readFileSync(path, "utf8")) as ProfileSnapshot;
        if (!raw || raw.version !== 1 || !raw.host) return null;
        if (validateSnapshotShape(raw) !== null) return null;
        return raw;
      } catch {
        return null;
      }
    };
    const corrupt = join(base, "corrupt.json");
    const bad = join(base, "bad.json");
    const good = join(base, "good.json");
    writeFileSync(corrupt, "{ not json at all", "utf8");
    writeFileSync(bad, JSON.stringify({ ...snap(), cookies: "nope" }), "utf8");
    writeFileSync(good, JSON.stringify(snap()), "utf8");

    // The mutation collapses three DIFFERENT refusals onto one value: the
    // caller cannot tell a wrong-shaped file from a corrupt one, and the
    // "cookies must be an array" reason it computed is gone.
    assert.equal(oldLoadSnapshot(corrupt), null);
    assert.equal(oldLoadSnapshot(bad), null);
    assert.equal(oldLoadSnapshot(corrupt), oldLoadSnapshot(bad), "MUTANT: corrupt and shape-invalid are indistinguishable");

    // The fixed seam distinguishes them AND keeps the reason.
    assert.notEqual(loadSnapshotVerdict(corrupt).status, loadSnapshotVerdict(bad).status);
    assert.equal(loadSnapshotVerdict(bad).detail, "cookies must be an array");

    // And the public `loadSnapshot` shape other code depends on is preserved.
    assert.equal(loadSnapshot(corrupt), null);
    assert.equal(loadSnapshot(bad), null, "back-compat: still null for a wrong-shaped file");
    assert.equal(loadSnapshot(good)?.cookies.length, 1, "back-compat: still the snapshot when valid");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("GOAL 124: the ACCOUNT load seam names the refusal — unknown ref, missing file, corrupt, shape-invalid and ok are all distinct", () => {
  const base = tempRoot();
  try {
    const dataDir = join(base, "data");
    writeUsable(dataDir, "good@x.test");
    writeMissingFileRow(dataDir, "gone@x.test");
    writeCorruptRow(dataDir, "corrupt@x.test");
    writeShapeInvalidRow(dataDir, "bad@x.test");
    writeAnonymousRow(dataDir, "anon@x.test");

    const ok = loadAccountSnapshotVerdict(dataDir, HOST, "good@x.test");
    assert.equal(ok.status, "ok", "a usable account loads");
    assert.equal(ok.snapshot?.cookies.length, 1);
    assert.equal(ok.slug, "good@x.test", "the resolved row's slug rides on the verdict");

    const gone = loadAccountSnapshotVerdict(dataDir, HOST, "gone@x.test");
    assert.equal(gone.status, "absent", "an index row with no file on disk -> 'absent' (NOT silent null)");
    assert.equal(gone.snapshot, null);

    const corrupt = loadAccountSnapshotVerdict(dataDir, HOST, "corrupt@x.test");
    assert.equal(corrupt.status, "unreadable", "corrupt JSON -> 'unreadable'");

    const bad = loadAccountSnapshotVerdict(dataDir, HOST, "bad@x.test");
    assert.equal(bad.status, "shape-invalid");
    assert.equal(bad.detail, "cookies must be an array", "the field message survives to the account seam");

    const anon = loadAccountSnapshotVerdict(dataDir, HOST, "anon@x.test");
    assert.equal(anon.status, "ok", "an anonymous snapshot is well-shaped; the auth gate is a SEPARATE verdict");

    const unknown = loadAccountSnapshotVerdict(dataDir, HOST, "nobody@x.test");
    assert.equal(unknown.status, "no-index-row", "an unresolvable reference is named, not collapsed");
    assert.equal(unknown.snapshot, null);

    // Back-compat projection: still the old `ProfileSnapshot | null`.
    assert.equal(loadAccountSnapshot(dataDir, HOST, "corrupt@x.test"), null);
    assert.equal(loadAccountSnapshot(dataDir, HOST, "good@x.test")?.cookies.length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("GOAL 124: an UN-requested load on a host with no session is 'absent', not an error — the anonymous path stays legal", () => {
  const base = tempRoot();
  try {
    const dataDir = join(base, "data");
    const v = loadAccountSnapshotVerdict(dataDir, OTHER_HOST, undefined);
    assert.equal(v.status, "absent");
    assert.equal(v.snapshot, null, "no session for an un-requested host -> null, no throw");
    assert.equal(loadAccountSnapshot(dataDir, OTHER_HOST, undefined), null);
    // A corrupt LEGACY flat snapshot is also only absent-to-the-caller, never
    // fatal: the un-requested path stays anonymous-tolerant.
    saveSnapshot(snapshotPath(dataDir, OTHER_HOST), snap({ host: OTHER_HOST }));
    writeFileSync(snapshotPath(dataDir, OTHER_HOST), "{ nope", "utf8");
    assert.equal(loadAccountSnapshotVerdict(dataDir, OTHER_HOST, undefined).status, "unreadable");
    assert.equal(loadAccountSnapshot(dataDir, OTHER_HOST, undefined), null, "still non-fatal for the un-requested path");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The pre-browser guard refuses an unusable row BEFORE any browser launches.
// ---------------------------------------------------------------------------

test("GOAL 124: resolveCapabilityAccount 400s an UNUSABLE account row by name, before any browser work", () => {
  const base = tempRoot();
  try {
    const dataDir = join(base, "data");
    writeMissingFileRow(dataDir, "gone@x.test");
    writeCorruptRow(dataDir, "corrupt@x.test");
    writeShapeInvalidRow(dataDir, "bad@x.test");
    writeAnonymousRow(dataDir, "anon@x.test");
    writeUsable(dataDir, "good@x.test");

    for (const [identity, expected] of [
      ["gone@x.test", "snapshot-missing"],
      ["corrupt@x.test", "snapshot-unreadable"],
      ["bad@x.test", "shape-invalid"],
      ["anon@x.test", "anonymous"],
    ] as const) {
      // assertUsableStoredAccount is now WIRED into the pre-browser guard.
      assert.throws(
        () => resolveCapabilityAccount(identity, profile, dataDir),
        (e: Error) => {
          assert.match(e.message, /cannot drive requests/, "named refusal, not a bare 'no snapshot'");
          assert.match(e.message, new RegExp(expected.replace(/[()]/g, "\\$&")), `reason: ${expected}`);
          assert.match(e.message, /re-capture/, "the message says what to do");
          return true;
        },
        `account "${identity}" must REFUSE at the pre-browser guard`
      );
    }

    // A usable account still passes untouched.
    assert.doesNotThrow(() => resolveCapabilityAccount("good@x.test", profile, dataDir));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("GOAL 124: the pre-browser guard keeps the existing account contract — unknown account 400s with the SAME message, and no account / 'default' never throws", () => {
  const base = tempRoot();
  try {
    const dataDir = join(base, "data");
    writeUsable(dataDir, "alice@x.test");
    writeShapeInvalidRow(dataDir, "bob@x.test");

    // Unchanged unknown-account message shape (GOAL 51), and the available list
    // still names every LISTED row, usable or not — listing is not a verdict.
    assert.throws(
      () => resolveCapabilityAccount("nobody@x.test", profile, dataDir),
      (e: Error) => {
        assert.equal(
          e.message,
          `no stored account "nobody@x.test" for "${HOST}"; available: [alice@x.test, bob@x.test]`
        );
        return true;
      }
    );

    // The legitimate anonymous path (duckduckgo et al.) is untouched: no
    // account, or the explicit legacy "default", is never an error — even with
    // a completely empty vault.
    const empty = join(base, "empty");
    assert.doesNotThrow(() => resolveCapabilityAccount(undefined, profile, empty));
    assert.doesNotThrow(() => resolveCapabilityAccount("", profile, empty));
    assert.doesNotThrow(() => resolveCapabilityAccount("default", profile, dataDir));
    assert.doesNotThrow(() => resolveCapabilityAccount(undefined, profile, dataDir));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The accounts[0] fallbacks skip unusable rows (no cross-account bleed).
// ---------------------------------------------------------------------------

test("GOAL 124: the accounts[0] fallback predicate SKIPS unusable rows instead of driving the request with a dead account", () => {
  const base = tempRoot();
  try {
    const dataDir = join(base, "data");
    // Unusable rows FIRST in index order, so a blind accounts[0] picks a dead
    // account — the cross-account-bleed hazard.
    writeMissingFileRow(dataDir, "1-gone@x.test");
    writeCorruptRow(dataDir, "2-corrupt@x.test");
    writeShapeInvalidRow(dataDir, "3-bad@x.test");
    writeAnonymousRow(dataDir, "4-anon@x.test");
    writeUsable(dataDir, "5-good@x.test");

    const listed = listAccounts(dataDir, HOST);
    assert.equal(listed.length, 5, "every real row stays LISTED (no blind-empty) — GOAL 89");
    assert.equal(
      listAccounts(dataDir, HOST).filter((a) => a.usable === false).length,
      4,
      "four rows reconcile to unusable"
    );
    assert.equal(listed[0].usable, false, "the FIRST row is an unusable one — the bleed case is real");

    // The exact predicate youtube.ts / gmail.ts / plugin/context.ts now use.
    const usableRows = listed.filter((a) => a.usable !== false);
    assert.equal(usableRows.length, 1, "only the real account survives the filter");
    assert.equal(usableRows[0].slug, "5-good@x.test", "the usable account is picked, not the dead first row");
    assert.equal(
      loadAccountSnapshot(dataDir, HOST, usableRows[0].slug)?.cookies.length,
      1,
      "and its snapshot actually loads"
    );

    // A host whose rows are ALL unusable yields no candidate — which the
    // un-requested path correctly reads as "anonymous", not as an error.
    const deadOnly = join(base, "dead");
    writeMissingFileRow(deadOnly, "only@x.test", OTHER_HOST);
    const none = listAccounts(deadOnly, OTHER_HOST).filter((a) => a.usable !== false);
    assert.equal(none.length, 0, "no usable row -> empty candidate list, no silent dead-account pick");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The seams are wired (source pins — these need a browser to run).
//    Each pin fails if the fix is reverted in that file.
// ---------------------------------------------------------------------------

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

test("GOAL 124: ChatDriver REFUSES a requested-but-unloadable account instead of falling through to anonymous", () => {
  const s = src("src/prompt/driver.ts");
  assert.match(s, /loadAccountSnapshotVerdict\(/, "driver asks the verdict seam, not the bare-null one");
  assert.match(
    s,
    /if \(!verdict\.snapshot\) \{[\s\S]{0,400}?throw new Error\(/,
    "a null verdict snapshot THROWS (the runner contract) — it does not fall through"
  );
  assert.match(
    s,
    /this\.account && this\.account !== "default"[\s\S]{0,3000}?no stored session for \$\{this\.profile\.id\} account/,
    "the refusal names the site + the requested account"
  );
  // The anonymous path must remain: the NO-account branch still loads the flat
  // snapshot / cookie file and never throws.
  assert.match(
    s,
    /loadSnapshot\(snapshotPath\(this\.dataDir, host\)\)[\s\S]{0,300}?loadCookies\(sessionPath\(this\.dataDir, host\)\)/,
    "the un-requested anonymous path is preserved (duckduckgo must still work)"
  );
});

test("GOAL 124: the plugin and generated-consumer seams refuse a requested account by name and filter unusable fallbacks", () => {
  const plugin = src("src/plugin/context.ts");
  assert.match(plugin, /loadAccountSnapshotVerdict\(/, "plugin asks the verdict seam");
  assert.match(plugin, /if \(verdict\.snapshot\)[\s\S]{0,600}?throw new Error\(/, "an unusable requested account THROWS");
  assert.match(
    plugin,
    /listAccounts\(dataDir, host\)\.filter\(\(a\) => a\.usable !== false\)/,
    "the accounts[0] fallback skips unusable rows"
  );
  assert.match(
    plugin,
    /loadCookies\(sessionPath\(dataDir, host\)\)/,
    "the anonymous path is preserved on the plugin seam"
  );

  // The generated-consumer seam (runtime/browser-session.ts) already refused a
  // requested-but-unloadable account with a named throw; pin that it stays a
  // refusal and never silently continues.
  const bs = src("src/runtime/browser-session.ts");
  assert.match(
    bs,
    /if \(!snap\) \{[\s\S]{0,400}?throw new Error\(/,
    "BrowserSession still REFUSES a requested account it cannot load"
  );
});

test("GOAL 124: the youtube and gmail runners skip unusable accounts on the no-account fallback", () => {
  for (const rel of ["src/capabilities/youtube.ts", "src/capabilities/gmail.ts"]) {
    const s = src(rel);
    assert.match(
      s,
      /listAccounts\(this\.dataDir, h\)\.filter\(\(a\) => a\.usable !== false\)/,
      `${rel}: the accounts[0] fallback must skip rows the reconciliation marked unusable`
    );
    assert.match(
      s,
      /snap \?\?= loadSnapshot\(snapshotPath\(this\.dataDir, host\)\)/,
      `${rel}: the flat snapshot + anonymous path is preserved`
    );
  }
});
