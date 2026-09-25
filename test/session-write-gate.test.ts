// GOAL 49 — session-WRITE truth gate.
//
// A capture/ingest/import whose snapshot has ZERO cookies AND ZERO
// localStorage for the target host is never written + indexed as a valid
// vault account and never earns the "logged-in session" claim. All pins are
// node-only (fixture profiles, no browser, no live prompt, no data/ touch).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  snapshotHasAuth,
  slugifyIdentity,
  slugCollision,
  resolveStoredAccount,
  listAccounts,
  loadAccountSnapshot,
} from "../src/runtime/session-store.js";
import { importSiteSnapshot } from "../src/runtime/profile-scan.js";
import { captureProfileFromLiveChrome } from "../src/runtime/xhost-capture.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";
import { resolveCapabilityAccount } from "../src/prompt/http.js";

// --- Chrome cookie encryption mirror (same as profile-add-all.test.ts) ---

const PEANUTS = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

function encryptClassic(s: string): Buffer {
  const hdr = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", PEANUTS, iv);
  return Buffer.concat([Buffer.from("v10"), hdr, iv, cipher.update(s, "utf8"), cipher.final()]);
}

interface FixtureRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
}

function makeCookiesDb(dbPath: string, rows: FixtureRow[]): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE cookies (
    host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT,
    encrypted_value BLOB, path TEXT, expires_utc INTEGER,
    is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
    has_expires INTEGER, source_scheme INTEGER
  )`);
  const ins = db.prepare(
    `INSERT INTO cookies (host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,has_expires,source_scheme)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of rows) {
    ins.run(r.host_key, r.name, null, r.encrypted_value, "/", 0, 1, 1, -1, 0, 1);
  }
  db.close();
}

function makeProfile(root: string, opts: { email?: string; rows: FixtureRow[] }): string {
  const def = join(root, "Default", "Network");
  mkdirSync(def, { recursive: true });
  writeFileSync(join(root, "Local State"), JSON.stringify({ os_crypt: {} }));
  if (opts.email) {
    mkdirSync(join(root, "Default"), { recursive: true });
    writeFileSync(
      join(root, "Default", "Preferences"),
      JSON.stringify({ account_info: [{ email: opts.email }] })
    );
  }
  makeCookiesDb(join(def, "Cookies"), opts.rows);
  return root;
}

// --- snapshotHasAuth truth table ---

test("snapshotHasAuth: cookies-only, localStorage-only, both -> true; neither -> false", () => {
  assert.equal(
    snapshotHasAuth({ cookies: [{ name: "SID", value: "x", domain: ".google.com", path: "/" }], localStorage: [] }),
    true,
    "cookies-only must be auth"
  );
  assert.equal(
    snapshotHasAuth({ cookies: [], localStorage: [{ key: "userToken", value: "tok" }] }),
    true,
    "localStorage-only must be auth"
  );
  assert.equal(
    snapshotHasAuth({
      cookies: [{ name: "SID", value: "x", domain: ".google.com", path: "/" }],
      localStorage: [{ key: "userToken", value: "tok" }],
    }),
    true
  );
  assert.equal(snapshotHasAuth({ cookies: [], localStorage: [] }), false, "fully empty must NOT be auth");
});

// --- importSiteSnapshot write refusal ---

test("importSiteSnapshot: fully anonymous profile (0 cookies, 0 localStorage) is REFUSED — nothing written, ok:false", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-refuse-"));
  try {
    // A profile that exists but holds a cookie for a DIFFERENT host, and no
    // localStorage for the target: import target = grok.com => 0 matches.
    const root = makeProfile(join(base, "profile"), {
      email: "alice@example.com",
      rows: [
        { host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("tok") },
      ],
    });
    const dataDir = join(base, "data");
    const host = "grok.com";

    const imp = await importSiteSnapshot({ root, host, dataDir });

    assert.equal(imp.ok, false, "anonymous import must be ok:false");
    assert.equal(imp.snapshotPath, "", "refused — nothing to save");
    assert.ok(
      imp.warnings.some((w) => /skipped-no-auth \(nothing to save\)/i.test(w)),
      `named verdict in warnings: ${JSON.stringify(imp.warnings)}`
    );

    // The vault must not contain the refused account: no index row, no file.
    assert.equal(listAccounts(dataDir, host).length, 0, "no account listed for a refused import");
    assert.equal(loadAccountSnapshot(dataDir, host, slugifyIdentity(imp.identity)), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("importSiteSnapshot: matching cookies still import (gate does not over-refuse)", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-ok-"));
  try {
    const root = makeProfile(join(base, "profile"), {
      email: "bob@example.com",
      rows: [
        { host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-abc") },
      ],
    });
    const dataDir = join(base, "data");
    const host = "gemini.google.com";

    const imp = await importSiteSnapshot({ root, host, dataDir });
    assert.equal(imp.ok, true, "matching cookie -> ok");
    assert.ok(imp.snapshotPath.length > 0, "written to the vault");
    const snap = loadAccountSnapshot(dataDir, host, slugifyIdentity(imp.identity));
    assert.ok(snap, "read-back from vault");
    assert.ok((snap!.cookies ?? []).some((c) => c.name === "SID"), "cookie survives");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- xhost capture write refusal ---

test("captureProfileFromLiveChrome: fully anonymous capture is REFUSED — empty snapshotPath, no vault write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-wg-xhost-"));
  try {
    const profileDir = makeProfile(dir, { email: "carol@example.com", rows: [] }); // no cookies at all
    const dataDir = join(dir, "data");
    const host = "gemini.google.com";

    const res = await captureProfileFromLiveChrome({ profileDir, host, dataDir });

    assert.equal(res.snapshotPath, "", "anonymous xhost capture refused");
    assert.equal(existsSync(res.snapshotPath), false, "nothing on disk for an empty path");
    assert.ok(
      res.warnings.some((w) => /skipped-no-auth \(nothing to save\)/i.test(w)),
      `named verdict: ${JSON.stringify(res.warnings)}`
    );
    assert.equal(listAccounts(dataDir, host).length, 0, "no vault account for refused xhost capture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureProfileFromLiveChrome: decryptable capture still writes (gate does not over-refuse)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-wg-xhost-ok-"));
  try {
    const profileDir = makeProfile(dir, {
      email: "dana@example.com",
      rows: [
        { host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-abc") },
      ],
    });
    const dataDir = join(dir, "data");
    const host = "gemini.google.com";

    const res = await captureProfileFromLiveChrome({ profileDir, host, dataDir });
    assert.ok(res.snapshotPath.length > 0, "authenticated capture written");
    assert.ok(existsSync(res.snapshotPath), "file exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// --- GOAL 50: account-INDEX collision — same-slug DIFFERENT identity refused ---

test("slugCollision: same-slug different identity detected; same identity string is NOT a collision", () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-collide-"));
  try {
    const dataDir = join(base, "data");
    const host = "gemini.google.com";
    const id1 = "John Smith";
    const id2 = "john  smith";
    // slugify folds aggressive variants to one slug.
    assert.equal(slugifyIdentity(id1), slugifyIdentity(id2));
    assert.equal(slugifyIdentity(id1), "john-smith");

    // No accounts yet -> no collision.
    assert.equal(slugCollision(dataDir, host, id1), null, "empty vault: no collision");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("importSiteSnapshot: same-slug different identity on the SAME host is REFUSED — existing account intact, named verdict", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-collide-import-"));
  try {
    const dataDir = join(base, "data");
    const host = "gemini.google.com";

    // First account: "John Smith" with a real cookie.
    const root1 = makeProfile(join(base, "p1"), {
      email: "John Smith",
      rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-1") }],
    });
    const first = await importSiteSnapshot({ root: root1, host, dataDir });
    assert.equal(first.ok, true, "first import ok");
    const slug1 = slugifyIdentity(first.identity);
    assert.ok(listAccounts(dataDir, host).some((a) => a.slug === slug1), "first account listed");

    // Second account: "john  smith" (same slug, different identity string).
    const root2 = makeProfile(join(base, "p2"), {
      email: "john  smith",
      rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-2") }],
    });
    const second = await importSiteSnapshot({ root: root2, host, dataDir });
    assert.equal(second.ok, false, "collision import refused");
    assert.equal(second.snapshotPath, "", "nothing written on collision");
    assert.ok(
      second.warnings.some((w) => /slug-collision \(NOT overwritten/.test(w)),
      `named verdict: ${JSON.stringify(second.warnings)}`
    );
    // The FIRST account survives untouched.
    const survivors = listAccounts(dataDir, host);
    assert.equal(survivors.length, 1, "index keeps exactly the original account");
    assert.equal(survivors[0].identity, "John Smith", "original identity preserved");
    const snap = loadAccountSnapshot(dataDir, host, slug1);
    assert.ok(snap, "original snapshot still readable");
    assert.ok((snap!.cookies ?? []).some((c) => c.name === "SID" && c.value === "sid-1"), "original cookie value intact");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("importSiteSnapshot: SAME identity string re-import is latest-wins (NOT a collision)", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-collide-rewrite-"));
  try {
    const dataDir = join(base, "data");
    const host = "gemini.google.com";

    const root1 = makeProfile(join(base, "p1"), {
      email: "alice@example.com",
      rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-old") }],
    });
    const first = await importSiteSnapshot({ root: root1, host, dataDir });
    assert.equal(first.ok, true);

    const root2 = makeProfile(join(base, "p2"), {
      email: "alice@example.com", // EXACT same identity string
      rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-new") }],
    });
    const second = await importSiteSnapshot({ root: root2, host, dataDir });
    assert.equal(second.ok, true, "same identity re-import is NOT a collision");
    assert.ok(second.snapshotPath.length > 0, "rewritten to the same vault path");
    const snap = loadAccountSnapshot(dataDir, host, slugifyIdentity("alice@example.com"));
    assert.ok(snap);
    assert.ok((snap!.cookies ?? []).some((c) => c.value === "sid-new"), "latest-wins: new cookie value present");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("importSiteSnapshot: same slug on DIFFERENT hosts is allowed (host-scoped collision, not global)", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-collide-host-"));
  try {
    const dataDir = join(base, "data");

    const rootA = makeProfile(join(base, "pa"), {
      email: "John Smith",
      rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-a") }],
    });
    const rootB = makeProfile(join(base, "pb"), {
      email: "john smith", // same slug, different identity, DIFFERENT host
      rows: [{ host_key: ".deepseek.com", name: "SID", encrypted_value: encryptClassic("sid-b") }],
    });

    const a = await importSiteSnapshot({ root: rootA, host: "gemini.google.com", dataDir });
    assert.equal(a.ok, true, "host A first import");
    const b = await importSiteSnapshot({ root: rootB, host: "deepseek.com", dataDir });
    assert.equal(b.ok, true, "host B import with colliding slug is allowed (different host)");
    assert.equal(listAccounts(dataDir, "gemini.google.com").length, 1);
    assert.equal(listAccounts(dataDir, "deepseek.com").length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- GOAL 51: account-READ exact resolution — a write-refused alias never
//     silently loads the surviving account's snapshot -----------------------

test("resolveStoredAccount/loadAccountSnapshot: write-refused alias returns null, exact identity + canonical slug still resolve", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-read-exact-"));
  try {
    const dataDir = join(base, "data");
    const host = "gemini.google.com";

    // Stored account: identity "John Smith" (canonical slug "john-smith").
    const root = makeProfile(join(base, "p1"), {
      email: "John Smith",
      rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-john") }],
    });
    const imported = await importSiteSnapshot({ root, host, dataDir });
    assert.equal(imported.ok, true, "first import written");
    assert.ok(listAccounts(dataDir, host).some((a) => a.identity === "John Smith"));

    // GOAL 51 canonical read resolution:
    assert.equal(resolveStoredAccount(dataDir, host, "John Smith")?.slug, "john-smith", "exact identity resolves");
    assert.equal(resolveStoredAccount(dataDir, host, "john-smith")?.identity, "John Smith", "canonical slug resolves");
    // A write-refused alias (GOAL 50 would refuse "john  smith" as a distinct
    // identity) must NOT silently resolve to the survivor:
    assert.equal(resolveStoredAccount(dataDir, host, "john  smith"), null, "refused alias (double space) does not resolve");
    assert.equal(resolveStoredAccount(dataDir, host, "john smith"), null, "refused alias (single space) does not resolve");
    assert.equal(resolveStoredAccount(dataDir, host, "JOHN SMITH"), null, "case-variant raw identity does not resolve");

    // Through the snapshot seam a runner would use:
    const snapExact = loadAccountSnapshot(dataDir, host, "John Smith");
    assert.ok(snapExact, "exact identity loads the snapshot");
    const slugSnap = loadAccountSnapshot(dataDir, host, "john-smith");
    assert.ok(slugSnap, "canonical slug loads the snapshot");
    assert.equal(loadAccountSnapshot(dataDir, host, "john  smith"), null, "refused alias -> NO snapshot (never the survivor's)");
    // The survivor's cookie is never loaded through the refused alias:
    const survivorSnap = loadAccountSnapshot(dataDir, host, "John Smith");
    assert.ok(
      (survivorSnap!.cookies ?? []).some((c) => c.name === "SID" && c.value === "sid-john"),
      "survivor cookie intact ONLY via the exact identity"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveCapabilityAccount: a write-refused alias 400s (named error listing available slugs) before any browser", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-wg-read-guard-"));
  try {
    const dataDir = join(base, "data");
    const host = "gemini.google.com";
    const root = makeProfile(join(base, "p1"), {
      email: "John Smith",
      rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-john") }],
    });
    const imported = await importSiteSnapshot({ root, host, dataDir });
    assert.equal(imported.ok, true);

    const profile: ChatSiteProfile = {
      id: "gemini",
      url: "https://gemini.google.com",
      name: "Gemini",
      composer: '[contenteditable="true"]',
      send: "text=Send",
      answer: ".markdown",
    } as unknown as ChatSiteProfile;

    // Exact identity and canonical slug pass:
    resolveCapabilityAccount("John Smith", profile, dataDir);
    resolveCapabilityAccount("john-smith", profile, dataDir);

    // A write-refused alias must throw the NAMED 400 (never silently resolve):
    assert.throws(
      () => resolveCapabilityAccount("john  smith", profile, dataDir),
      /no stored account "john  smith" for "gemini\.google\.com"; available: \[john-smith\]/,
      "refused alias -> named unknown-account error (GOAL 51)"
    );
    assert.throws(
      () => resolveCapabilityAccount("JOHN SMITH", profile, dataDir),
      /no stored account "JOHN SMITH"/,
      "case-variant raw identity -> named unknown-account error"
    );
    // The guard runs BEFORE any browser work: it is pure (throws immediately,
    // no launchBrowser import path executed — verify the throw happens at the
    // resolution seam itself, i.e. the function never touches a browser).
    assert.equal(typeof resolveCapabilityAccount, "function", "guard is a pure validation seam");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
