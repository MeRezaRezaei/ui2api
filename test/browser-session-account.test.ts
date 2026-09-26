// GOAL 52 — consumer-surface account selection: BrowserSession's vault-account
// resolution core must pick the REQUESTED account exactly (GOAL 51 semantics),
// never a silent first-account; the ACP template must thread UI2API_ACCOUNT.
// All pins node-only (fixture vault, no browser, no data/ touch).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolveSessionAccountSnapshot } from "../src/runtime/browser-session.js";
import { acpServerTemplate } from "../src/generator/acp-template.js";
import { importSiteSnapshot } from "../src/runtime/profile-scan.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

// --- Chrome profile fixture (same layout as session-write-gate.test.ts) ---

// Chromium "v10" cookie encryption with the well-known peanuts key — mirror of
// session-write-gate.test.ts (the ingest decrypts with this exact derivation).
const PEANUTS = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

function encryptClassic(s: string): Buffer {
  const hdr = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", PEANUTS, iv);
  return Buffer.concat([Buffer.from("v10"), hdr, iv, cipher.update(s, "utf8"), cipher.final()]);
}

type FixtureRow = { host_key: string; name: string; encrypted_value: Buffer; path?: string };

function makeCookiesDb(dbPath: string, rows: FixtureRow[]): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE cookies (
    host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT,
    encrypted_value BLOB, path TEXT, expires_utc INTEGER,
    is_secure INTEGER, is_httponly INTEGER, samesite INTEGER,
    has_expires INTEGER, source_scheme INTEGER
  )`, { timeout: 120000 });
  const ins = db.prepare(
    `INSERT INTO cookies (host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,has_expires,source_scheme)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of rows) {
    ins.run(r.host_key, r.name, null, r.encrypted_value, r.path ?? "/", 4102444800000000, 1, 0, 0, 1, 1);
  }
  db.close();
}

function makeProfile(root: string, opts: { email: string; rows: FixtureRow[] }): string {
  const def = join(root, "Default", "Network");
  mkdirSync(join(root, "Default"), { recursive: true });
  writeFileSync(join(root, "Local State"), JSON.stringify({ os_crypt: {} }));
  writeFileSync(
    join(root, "Default", "Preferences"),
    JSON.stringify({ account_info: [{ email: opts.email }] })
  );
  makeCookiesDb(join(def, "Cookies"), opts.rows);
  return root;
}

async function storeAccount(dataDir: string, email: string, cookieValue: string): Promise<void> {
  const root = makeProfile(join(dataDir, "flavor-" + email), {
    email,
    rows: [{ host_key: ".google.com", name: "SID", encrypted_value: encryptClassic(cookieValue) }],
  });
  const imported = await importSiteSnapshot({ root, host: "gemini.google.com", dataDir });
  assert.equal(imported.ok, true, `import ${email} must write (collision-free fixture)`);
}

test("GOAL 52: resolveSessionAccountSnapshot picks the REQUESTED account exactly — never the first, never a folding alias", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-bs-acct-"));
  try {
    const dataDir = join(base, "data");
    const host = "gemini.google.com";
    // Two accounts, DIFFERENT slugs (no collision): first-account is "Alice",
    // the REQUESTED one is "Bob" — a silent-first-account bug would pick Alice.
    await storeAccount(dataDir, "Alice", "sid-alice");
    await storeAccount(dataDir, "Bob", "sid-bob");

    const bob = resolveSessionAccountSnapshot(dataDir, host, "Bob");
    assert.ok(bob, "requested identity resolves");
    assert.ok(
      (bob!.cookies ?? []).some((c) => c.name === "SID" && c.value === "sid-bob"),
      "REQUESTED account's snapshot wins (never accts[0]/Alice)"
    );
    const alice = resolveSessionAccountSnapshot(dataDir, host, "Alice");
    assert.ok(alice, "the other identity also resolves");
    assert.ok((alice!.cookies ?? []).some((c) => c.value === "sid-alice"));

    // Canonical slug form works; a folding alias does NOT (GOAL 51 semantics).
    assert.ok(resolveSessionAccountSnapshot(dataDir, host, "bob"), "canonical slug resolves");
    assert.equal(resolveSessionAccountSnapshot(dataDir, host, "Bob "), null, "folding variant does not resolve");
    assert.equal(resolveSessionAccountSnapshot(dataDir, host, "no-such"), null, "unknown account -> null (no silent fallback)");
    assert.equal(resolveSessionAccountSnapshot(dataDir, host, undefined), null, "undefined account -> null (caller chooses flat cookies)");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("GOAL 52: the ACP template threads UI2API_ACCOUNT / UI2API_DATA_DIR into BrowserSession", () => {
  const src = acpServerTemplate("/tmp/sites-root");
  assert.ok(
    src.includes("account: process.env.UI2API_ACCOUNT || undefined"),
    "generated ACP server reads UI2API_ACCOUNT (GOAL 52)"
  );
  assert.ok(
    src.includes("dataDir: process.env.UI2API_DATA_DIR || undefined"),
    "generated ACP server reads UI2API_DATA_DIR (GOAL 52)"
  );
  assert.ok(
    src.includes("new BrowserSession(map, SITES_ROOT, {"),
    "generated ACP server passes the account selector to BrowserSession"
  );
});
