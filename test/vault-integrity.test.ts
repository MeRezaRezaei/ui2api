// GOAL 89 — vault INTEGRITY: the account INDEX is reconciled, not assumed.
//
// The honest write seams (GOAL 49 anonymous-content, GOAL 50 slug collision,
// GOAL 60 index shape) only govern what this code writes FROM NOW ON. A
// pre-existing / hand-edited / externally-written / half-deleted index row is
// still a CLAIM with nothing behind it — and until now every consumer surface
// (GET /accounts, the registry `accounts[]`, the requirements vault verdict)
// derived straight from accounts.json, so an account that can only ever replay
// signed-out was advertised as a normal available account.
//
// The proof was live on this box: two chatgpt.com index rows whose snapshots
// carry ZERO cookies AND ZERO localStorage, green-flagged as usable.
//
// Every fixture here lives inside os.tmpdir() and is removed in `finally` —
// the real `data/` vault is NEVER written, read for fixtures, or touched. No
// cookie VALUES are ever read into an assertion (names/counts only).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VAULT_ANONYMOUS,
  VAULT_NO_INDEX_ROW,
  VAULT_SHAPE_INVALID,
  VAULT_SNAPSHOT_MISSING,
  VAULT_SNAPSHOT_UNREADABLE,
  accountSnapshotPath,
  accountsIndexPath,
  assertUsableStoredAccount,
  listAccounts,
  saveAccountSnapshot,
  unusableAccountMessage,
  verifyStoredAccount,
  type StoredAccount,
} from "../src/runtime/session-store.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "vault.example.com";

/** A throwaway vault. ALWAYS cleaned in the caller's finally. */
function vault(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `u2a-g89-${prefix}-`));
}

/** A well-formed index row (a CLAIM — nothing behind it is implied). */
function row(slug: string, over: Partial<StoredAccount> = {}): StoredAccount {
  return { slug, identity: `${slug}@example.com`, host: HOST, source: "import", capturedAt: "2026-09-25T00:00:00.000Z", ...over };
}

/** Write the index verbatim (hand-edited / stale / partial writes are the class). */
function writeIndex(dir: string, accounts: unknown[]): void {
  const p = accountsIndexPath(dir, HOST);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ accounts }, null, 2));
}

/** Write a snapshot file verbatim (bytes, not a validated save). */
function writeSnap(dir: string, slug: string, body: string): void {
  const p = accountSnapshotPath(dir, HOST, slug);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

function snapFile(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    host: HOST,
    origin: `https://${HOST}`,
    capturedAt: "2026-09-25T00:00:00.000Z",
    cookies: [{ name: "session", value: "redacted", domain: `.${HOST}` }],
    localStorage: [],
    sessionStorage: [],
    indexedDB: [],
    ...over,
  });
}

// --- (1) MISSING snapshot: the row claims an account that is not on disk ---

test("GOAL89: an index row pointing at a MISSING snapshot is unusable with the named reason (never served as available)", () => {
  const dir = vault("missing");
  try {
    writeIndex(dir, [row("gone")]); // index row, zero snapshot files
    const v = verifyStoredAccount(dir, HOST, "gone");
    assert.equal(v.usable, false, "a claim with nothing behind it is NOT usable");
    assert.equal(v.reason, VAULT_SNAPSHOT_MISSING, `named reason, got ${v.reason}`);
    assert.equal(v.reason, "snapshot-missing", "reason string is pinned for consumers");
    assert.equal(v.exists, false, "no snapshot file exists");
    assert.equal(v.cookies, 0);
    assert.equal(v.localStorage, 0);

    // The /accounts + registry builder surface still LISTS the row (a real
    // stored row a user may want to see and delete) — but honestly flagged.
    const listed = listAccounts(dir, HOST);
    assert.equal(listed.length, 1, "the row is still listed — never silently dropped");
    assert.equal(listed[0].slug, "gone");
    assert.equal(listed[0].usable, false, "…and never presented as usable");
    assert.equal(listed[0].reason, VAULT_SNAPSHOT_MISSING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (2) UNREADABLE / corrupt-JSON snapshot ---

test("GOAL89: a corrupt-JSON snapshot is unusable with snapshot-unreadable, distinct from missing and from shape-invalid", () => {
  const dir = vault("unreadable");
  try {
    writeIndex(dir, [row("torn")]);
    writeSnap(dir, "torn", '{"version":1,"host":"vault.example.com","cookies":[{"name":"sess');
    const v = verifyStoredAccount(dir, HOST, "torn");
    assert.equal(v.usable, false);
    assert.equal(v.reason, VAULT_SNAPSHOT_UNREADABLE, `named reason, got ${v.reason}`);
    assert.equal(v.reason, "snapshot-unreadable");
    assert.equal(v.exists, true, "the FILE exists — it is its CONTENT that is unreadable");
    assert.equal(v.cookies, 0, "an unreadable file yields no counts, never a guess");

    // A file that is not JSON at all (an HTML error page saved over it, a
    // directory-shaped artifact) is the same honest verdict, never a throw.
    writeSnap(dir, "torn", "<!doctype html><title>502</title>");
    assert.equal(verifyStoredAccount(dir, HOST, "torn").reason, VAULT_SNAPSHOT_UNREADABLE);

    // A read that THROWS (path is a directory) is refused, never propagated.
    mkdirSync(accountSnapshotPath(dir, HOST, "torn").replace(/\/state\.json$/, ""), { recursive: true });
    rmSync(accountSnapshotPath(dir, HOST, "torn"), { force: true });
    const dirCase = verifyStoredAccount(dir, HOST, "torn");
    assert.equal(dirCase.usable, false, "an unreadable path never throws out of the reconciler");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (3) ANONYMOUS snapshot — THE class green-flagged on this box ---

test("GOAL89: an ANONYMOUS snapshot (zero cookies AND zero localStorage) is refused by name — the exact class /accounts shipped as available", () => {
  const dir = vault("anon");
  try {
    writeIndex(dir, [row("osbulk"), row("merezarezaei@gmail.com")]);
    // Both rows look perfectly healthy in the INDEX — this is the lie.
    writeSnap(dir, "osbulk", snapFile({ cookies: [], localStorage: [] }));
    writeSnap(dir, "merezarezaei@gmail.com", snapFile({ cookies: [], localStorage: [], sessionStorage: [], indexedDB: [] }));

    for (const slug of ["osbulk", "merezarezaei@gmail.com"]) {
      const v = verifyStoredAccount(dir, HOST, slug);
      assert.equal(v.usable, false, `${slug}: an anonymous session can only replay signed-out`);
      assert.equal(v.reason, VAULT_ANONYMOUS, `${slug}: named reason, got ${v.reason}`);
      assert.equal(v.reason, "anonymous (no cookies and no localStorage — the GOAL 49 write gate refuses to create this)");
      assert.equal(v.exists, true);
      assert.equal(v.cookies, 0, "cookie COUNT only — never a value");
      assert.equal(v.localStorage, 0);
    }

    const listed = listAccounts(dir, HOST);
    assert.equal(listed.length, 2, "both real rows still listed");
    for (const a of listed) {
      assert.equal(a.usable, false, "a host whose accounts are ALL unusable is visible as such, not silently empty");
      assert.equal(a.reason, VAULT_ANONYMOUS);
    }

    // A stored fingerprint for an anonymous account is equally worthless.
    const refusal = unusableAccountMessage("osbulk", HOST, verifyStoredAccount(dir, HOST, "osbulk"));
    assert.match(refusal, /^stored account "osbulk" for "vault\.example\.com" cannot drive requests: anonymous \(no cookies and no localStorage/);
    assert.doesNotMatch(refusal, /redacted/, "the refusal message never carries a cookie value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (4) HEALTHY snapshot: the gate DISCRIMINATES, it never always-refuses ---

test("GOAL89: a healthy snapshot (a cookie or two) is usable:true with NO reason — the gate discriminates", () => {
  const dir = vault("healthy");
  try {
    writeIndex(dir, [row("cookies-only"), row("ls-only")]);
    writeSnap(dir, "cookies-only", snapFile({ cookies: [{ name: "a", value: "x", domain: `.${HOST}` }, { name: "b", value: "y", domain: `.${HOST}` }], localStorage: [] }));
    writeSnap(dir, "ls-only", snapFile({ cookies: [], localStorage: [["userToken", "opaque"]] }));

    const c = verifyStoredAccount(dir, HOST, "cookies-only");
    assert.equal(c.usable, true, "cookies alone are an auth signal");
    assert.equal(c.reason, undefined, "a usable row carries NO reason");
    assert.equal(c.cookies, 2);
    assert.equal(c.localStorage, 0);
    assert.equal(c.exists, true);

    const l = verifyStoredAccount(dir, HOST, "ls-only");
    assert.equal(l.usable, true, "localStorage alone is an auth signal (deepseek's userToken class)");
    assert.equal(l.reason, undefined);
    assert.equal(l.localStorage, 1);

    for (const a of listAccounts(dir, HOST)) {
      assert.equal(a.usable, true, `${a.slug}: healthy accounts must NOT be flagged`);
      assert.equal(a.reason, undefined, `${a.slug}: no reason on a usable row`);
    }
    // The real write seam agrees (it is the same snapshotHasAuth gate).
    assert.doesNotThrow(() => assertUsableStoredAccount(dir, HOST, "cookies-only"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (5) WRONG-SHAPED snapshot (the GOAL 59 class) — refuse, never crash ---

test("GOAL89: a wrong-SHAPED snapshot (cookies as a string) is shape-invalid with the field detail, and NEVER crashes the reconciler", () => {
  const dir = vault("shape");
  try {
    writeIndex(dir, [row("cookies-string"), row("localstorage-map"), row("cookie-no-domain")]);
    writeSnap(dir, "cookies-string", snapFile({ cookies: "SID=abc; other=1" }));
    writeSnap(dir, "localstorage-map", snapFile({ localStorage: { userToken: "x" } }));
    writeSnap(dir, "cookie-no-domain", snapFile({ cookies: [{ name: "SID", value: "abc" }] }));

    const shapes: Array<[string, RegExp]> = [
      ["cookies-string", /^cookies must be an array$/],
      ["localstorage-map", /^localStorage must be an array of \[key, value\] tuples$/],
      ["cookie-no-domain", /^cookies\[0\] must be \{ name: string, domain: string \}$/],
    ];
    for (const [slug, detailRe] of shapes) {
      const v = verifyStoredAccount(dir, HOST, slug);
      assert.equal(v.usable, false, `${slug}: a wrong-shaped file is not a usable account`);
      assert.equal(v.reason, VAULT_SHAPE_INVALID, `${slug}: named reason, got ${v.reason}`);
      assert.equal(v.reason, "shape-invalid (see validateSnapshotShape)");
      assert.match(String(v.detail), detailRe, `${slug}: validateSnapshotShape's own field message is the detail`);
    }
    // A wrong-shaped snapshot is NOT silently downgraded to "anonymous" — the
    // two classes stay distinguishable so the remedy (fix vs re-capture) is knowable.
    assert.notEqual(verifyStoredAccount(dir, HOST, "cookies-string").reason, VAULT_ANONYMOUS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (6) HOSTILE slug (the GOAL 60 class) — still refused, no path escape ---

test("GOAL89: a HOSTILE slug in the index is still refused (GOAL 60 regression) and never reaches a path build", () => {
  const dir = vault("hostile");
  try {
    writeIndex(dir, [
      row("../../../pwned", { identity: "attacker" }),
      // The GOAL 60 classes: a NUMERIC slug and an out-of-vocabulary source are
      // raw index rows, not rows the writer could ever produce.
      { slug: 42, identity: "num", host: HOST, source: "import", capturedAt: "2026-09-25T00:00:00.000Z" } as unknown as StoredAccount,
      { ...row("no-source"), source: "not-a-source" } as unknown as StoredAccount,
      row("good"),
    ]);
    writeSnap(dir, "good", snapFile());

    // Excluded from every listing surface, exactly as GOAL 60 established.
    assert.deepEqual(listAccounts(dir, HOST).map((a) => a.slug), ["good"]);

    // Asked for DIRECTLY, a hostile reference is refused by NAME and no path
    // is ever built for it — the traversal cannot escape the vault.
    for (const hostile of ["../../../pwned", "42", "..", "attacker", "no-source"]) {
      const v = verifyStoredAccount(dir, HOST, hostile);
      assert.equal(v.usable, false, `${hostile}: must be refused`);
      assert.equal(v.reason, VAULT_NO_INDEX_ROW, `${hostile}: named reason, got ${v.reason}`);
      assert.equal(v.reason, "no index row");
      assert.equal(v.exists, false, `${hostile}: nothing on disk was pointed at`);
      assert.throws(() => assertUsableStoredAccount(dir, HOST, hostile), /no index row|no stored account|cannot drive requests/);
    }
    assert.equal(existsSync(join(dir, "sessions", HOST, "pwned")), false, "no traversal target was created/read");
    assert.equal(existsSync(resolve(dir, "..", "pwned")), false, "nothing escaped the vault root");

    // A hostile ROW OBJECT (not a string) is refused the same way.
    assert.equal(verifyStoredAccount(dir, HOST, row("../../../pwned")).reason, VAULT_NO_INDEX_ROW);
    // GOAL 51 exactness preserved: no folding, no fallback to a survivor.
    assert.equal(verifyStoredAccount(dir, HOST, "Good").reason, VAULT_NO_INDEX_ROW, "resolution stays exact (identity or slug, never folded)");
    assert.equal(verifyStoredAccount(dir, HOST, "good").usable, true, "the exact stored slug still resolves");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (7) NON-VACUITY: the real reconciler CAN fail, and every reason is a
//        non-empty human-actionable string on a real, non-empty fixture set ---

test("GOAL89 non-vacuity: the REAL exported reconciler fails on the fixture set, and every reason is a non-empty action string", () => {
  const dir = vault("nonvacuous");
  try {
    const fixtures: Array<{ slug: string; snap: string | null; usable: boolean; reason?: string }> = [
      { slug: "f-missing", snap: null, usable: false, reason: VAULT_SNAPSHOT_MISSING },
      { slug: "f-unreadable", snap: "{not json", usable: false, reason: VAULT_SNAPSHOT_UNREADABLE },
      { slug: "f-anon", snap: snapFile({ cookies: [], localStorage: [] }), usable: false, reason: VAULT_ANONYMOUS },
      { slug: "f-shape", snap: snapFile({ cookies: "nope" }), usable: false, reason: VAULT_SHAPE_INVALID },
      { slug: "f-healthy", snap: snapFile(), usable: true },
    ];
    assert.ok(fixtures.length >= 5, "fixture set is non-empty");
    writeIndex(dir, fixtures.map((f) => row(f.slug)));
    for (const f of fixtures) if (f.snap !== null) writeSnap(dir, f.slug, f.snap);

    // Drive the REAL export (imported above) — never a re-implemented copy.
    const observed = fixtures.map((f) => verifyStoredAccount(dir, HOST, f.slug));
    assert.equal(observed.length, fixtures.length);

    // It CAN fail: at least one unusable verdict came back from the real gate.
    const failures = observed.filter((v) => v.usable === false);
    assert.ok(failures.length >= 4, `the reconciler must be able to fail (got ${failures.length} unusable)`);
    assert.ok(observed.some((v) => v.usable === true), "…and it discriminates: healthy rows still pass");
    assert.ok(observed.every((v) => v.exists === (v.reason !== VAULT_SNAPSHOT_MISSING && v.reason !== VAULT_NO_INDEX_ROW)), "exists is honest per row");

    // Every refusal reason is a non-empty string a human can act on, and every
    // refusal is a NAMED, distinct class (no blanket "invalid").
    for (const [i, v] of failures.entries()) {
      assert.equal(typeof v.reason, "string", `failure #${i}: reason is a string`);
      assert.ok((v.reason as string).trim().length > 0, `failure #${i}: reason is non-empty`);
      assert.ok(v.reason !== "unknown", `failure #${i}: never a placeholder reason`);
    }
    assert.equal(
      new Set(failures.map((v) => v.reason)).size,
      failures.length,
      "each fixture class yields its OWN named reason (they discriminate, not collapse)"
    );
    // The named refusal a request seam would throw names the reason + remedy.
    const msg = unusableAccountMessage("f-anon", HOST, observed[2]);
    assert.match(msg, /cannot drive requests: anonymous \(no cookies and no localStorage/);
    assert.match(msg, /re-capture: 'profile add-all --known'/, "the refusal carries the actionable remedy");
    assert.throws(
      () => assertUsableStoredAccount(dir, HOST, "f-anon"),
      (e: Error) => e.message === msg,
      "assertUsableStoredAccount throws exactly the named refusal for an anonymous account"
    );
    assert.doesNotThrow(() => assertUsableStoredAccount(dir, HOST, "f-healthy"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (8) the WRITE seam never persists a derived verdict into accounts.json ---

test("GOAL89: a derived verdict is READ-time state — saveAccountSnapshot must never write it into accounts.json", () => {
  const dir = vault("write-seam");
  try {
    const anon = { version: 1 as const, host: HOST, origin: `https://${HOST}`, capturedAt: "2026-09-25T00:00:00.000Z", cookies: [], localStorage: [], sessionStorage: [], indexedDB: [] };
    // The GOAL 49 write gate refuses anonymous CONTENT at the write seam; the
    // goal here is the INDEX FILE: a hand-EDITED anonymous row (or any row
    // carrying stale verdict fields) must never have them persisted back out.
    writeIndex(dir, [row("osbulk", { usable: false, reason: VAULT_ANONYMOUS })]);
    writeSnap(dir, "osbulk", JSON.stringify(anon));

    saveAccountSnapshot(
      dir,
      HOST,
      "healthy@example.com",
      { ...anon, cookies: [{ name: "session", value: "redacted", domain: `.${HOST}` }] },
      { source: "capture" }
    );

    const onDisk = JSON.parse(readFileSync(accountsIndexPath(dir, HOST), "utf8")) as { accounts: Record<string, unknown>[] };
    assert.equal(onDisk.accounts.length, 2, "the refused anonymous row is preserved, not silently dropped");
    for (const a of onDisk.accounts) {
      assert.equal("usable" in a, false, `index row ${a.slug} must carry no derived usable field`);
      assert.equal("reason" in a, false, `index row ${a.slug} must carry no derived reason field`);
      assert.equal("reasonDetail" in a, false, `index row ${a.slug} must carry no derived reasonDetail field`);
    }
    // …and the read seam still reconciles honestly after the write.
    const listed = listAccounts(dir, HOST);
    const anonymousRow = listed.find((a) => a.slug === "osbulk")!;
    assert.equal(anonymousRow.usable, false, "a re-read re-reconciles (never trusts a persisted verdict)");
    assert.equal(anonymousRow.reason, VAULT_ANONYMOUS);
    assert.equal(listed.find((a) => a.slug === "healthy@example.com")!.usable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (9) SOURCE-LEVEL PIN: neither surface can go back to trusting the index ---

test("GOAL89 source pin: BOTH the listAccounts builder and the registry accounts[] builder call the reconciler", () => {
  const store = readFileSync(join(ROOT, "src/runtime/session-store.ts"), "utf8");
  const reg = readFileSync(join(ROOT, "src/prompt/registry.ts"), "utf8");

  // listAccounts' own body (up to the next top-level export) must reconcile.
  const start = store.indexOf("export function listAccounts");
  assert.ok(start > 0, "listAccounts found in src/runtime/session-store.ts");
  const end = store.indexOf("\nexport function", start + 1);
  const body = store.slice(start, end > 0 ? end : undefined);
  assert.match(body, /verifyStoredAccount/, "listAccounts must call the reconciler, not trust accounts.json");
  assert.match(body, /withAccountVerdict/, "listAccounts must attach the verdict to the served row");

  // The registry's accounts[] builder must reconcile too — the registry is the
  // ONLY info source a consumer has, so an honest /accounts + a blind /registry
  // would let the lie survive.
  const regStart = reg.indexOf("let accounts: StoredAccount[]");
  assert.ok(regStart > 0, "registry accounts[] builder found in src/prompt/registry.ts");
  const regEnd = reg.indexOf("packages.push(", regStart);
  const regBody = reg.slice(regStart, regEnd > 0 ? regEnd : undefined);
  assert.match(regBody, /verifyStoredAccount/, "registry accounts[] must call the same reconciler");
  assert.match(regBody, /withAccountVerdict/, "registry accounts[] must attach the verdict");
  assert.match(regBody, /accountsSummary/, "registry must roll the verdict up per host (an all-unusable host stays visible)");
  assert.match(reg, /from "\.\.\/runtime\/session-store\.js"/, "registry imports the reconciler from the vault module");
  assert.match(reg, /verifyStoredAccount,/, "verifyStoredAccount is imported (not re-implemented)");

  // The reconciler itself is fs-only and reuses the existing gates.
  const vStart = store.indexOf("export function verifyStoredAccount");
  const vEnd = store.indexOf("\nexport function", vStart + 1);
  const vBody = store.slice(vStart, vEnd > 0 ? vEnd : undefined);
  for (const helper of ["resolveStoredAccount", "accountSnapshotPath", "existsSync", "readFileSync", "validateSnapshotShape", "snapshotHasAuth"]) {
    assert.match(vBody, new RegExp(helper), `verifyStoredAccount must REUSE ${helper} (never re-implement it)`);
  }
  for (const forbidden of ["writeFileSync", "mkdirSync", "launchBrowser", "fetch(", "chromium"]) {
    assert.doesNotMatch(vBody, new RegExp(forbidden.replace("(", "\\(")), `verifyStoredAccount must stay pure — no ${forbidden}`);
  }
  // Every reason is an exported, pinned constant (consumers can match on it).
  for (const [name, value] of [
    ["VAULT_NO_INDEX_ROW", "no index row"],
    ["VAULT_SNAPSHOT_MISSING", "snapshot-missing"],
    ["VAULT_SNAPSHOT_UNREADABLE", "snapshot-unreadable"],
    ["VAULT_SHAPE_INVALID", "shape-invalid (see validateSnapshotShape)"],
    ["VAULT_ANONYMOUS", "anonymous (no cookies and no localStorage — the GOAL 49 write gate refuses to create this)"],
  ] as const) {
    assert.ok(store.includes(`export const ${name} =`), `${name} must be an exported constant`);
    assert.equal((store.match(new RegExp(value.replace(/[()]/g, "\\$&"), "g")) ?? []).length >= 1, true, `${name} value pinned: ${value}`);
  }
});

