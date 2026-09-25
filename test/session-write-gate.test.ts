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
  listAccounts,
  loadAccountSnapshot,
} from "../src/runtime/session-store.js";
import { importSiteSnapshot } from "../src/runtime/profile-scan.js";
import { captureProfileFromLiveChrome } from "../src/runtime/xhost-capture.js";

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