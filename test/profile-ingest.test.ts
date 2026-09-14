// Profile ingester tests — Chrome's own on-disk data (Cookies SQLite + Local
// State + localStorage LevelDB) serialized into the portable ProfileSnapshot,
// fully offline. This is how the "solve the auth blockage once and for all"
// story closes: read the user's real Chrome profile databases directly, no
// headed login, no debug-channel browser, works on hosts that kill Chrome.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  decryptCookieValue,
  derivePeanutsKey,
  deriveKeysFromLocalState,
  expiresUtcToEpoch,
  cookieRowToPlaywrightCookie,
  ingestProfile,
  type CookieRow,
} from "../src/runtime/profile-ingest.js";

// --- Crypto scheme mirrors (the spec the ingester must decode) ---

const PEANUTS = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

// Modern Linux Chrome (empirically confirmed on a 2026-era profile, 257/257
// cookies): "v10" + HDR(16 random bytes) + IV(16) + AES-128-CBC ciphertext.
function encryptClassic(s: string): Buffer {
  const hdr = randomBytes(16);
  const iv = randomBytes(16); // embedded IV
  const cipher = createCipheriv("aes-128-cbc", PEANUTS, iv);
  return Buffer.concat([Buffer.from("v10"), hdr, iv, cipher.update(s, "utf8"), cipher.final()]);
}

// Legacy documented layout: "v10" + ciphertext, IV = 16 spaces.
function encryptLegacy(s: string): Buffer {
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv("aes-128-cbc", PEANUTS, iv);
  return Buffer.concat([Buffer.from("v10"), cipher.update(s, "utf8"), cipher.final()]);
}

// Keyring era: "v11" + nonce(12) + AES-256-GCM(key=32B) ciphertext+tag(16).
function encryptGcm(s: string, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v11"), nonce, ct, cipher.getAuthTag()]);
}

test("derivePeanutsKey is the documented Linux fallback key", () => {
  const k = derivePeanutsKey();
  assert.equal(k.length, 16);
  assert.deepEqual(k, PEANUTS);
});

test("decryptCookieValue round-trips the modern v10 layout (HDR+IV+ciphertext)", () => {
  const enc = encryptClassic("SID=super-secret-session");
  const out = decryptCookieValue(enc);
  assert.equal(out, "SID=super-secret-session");
});

test("decryptCookieValue also decodes the legacy v10 layout (spaces IV)", () => {
  const enc = encryptLegacy("legacy-token");
  const out = decryptCookieValue(enc);
  assert.equal(out, "legacy-token");
});

test("decryptCookieValue round-trips v11 GCM with an explicit Local-State key", () => {
  const key = randomBytes(32);
  const enc = encryptGcm("token=gcm-works", key);
  const out = decryptCookieValue(enc, { gcm: key });
  assert.equal(out, "token=gcm-works");
});

test("decryptCookieValue returns null for junk / wrong key (no false positives)", () => {
  const garbage = Buffer.concat([Buffer.from("v10"), randomBytes(64)]);
  assert.equal(decryptCookieValue(garbage), null);
  const wrong = encryptClassic("hello");
  assert.equal(decryptCookieValue(wrong, { cbc: randomBytes(16) }), null);
});

test("expiresUtcToEpoch converts Chrome FILETIME microseconds to epoch ms", () => {
  const epoch = 1700000000000; // 2023-11-14T22:13:20Z
  const filetimeUs = BigInt(epoch) * 1000n + 11644473600000000n; // epoch µs + 1601→1970 µs
  assert.equal(expiresUtcToEpoch(filetimeUs), epoch);
});

test("cookieRowToPlaywrightCookie maps the real Chrome schema", () => {
  const row: CookieRow = {
    host_key: ".google.com",
    name: "SID",
    encrypted_value: encryptClassic("sid-value"),
    path: "/",
    expires_utc: BigInt(1700000000000) * 1000n + 11644473600000000n, // 2023, FILETIME µs
    is_secure: 1,
    is_httponly: 1,
    samesite: -1,
    has_expires: 1,
    source_scheme: 2,
    value: "",
  };
  const cookie = cookieRowToPlaywrightCookie(row);
  assert.equal(cookie.name, "SID");
  assert.equal(cookie.value, "sid-value");
  assert.equal(cookie.domain, ".google.com");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(typeof cookie.expires, "number");
});

// Build a realistic-ish Cookies database (the columns the ingester queries).
interface FixtureRow {
  host_key: string;
  name: string;
  value?: string | null;
  encrypted_value?: Buffer | null;
  path?: string;
  expires_utc?: bigint;
  is_secure?: number;
  is_httponly?: number;
  samesite?: number;
  has_expires?: number;
  source_scheme?: number;
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
    const v: Array<string | number | bigint | Buffer | null> = [
      r.host_key, r.name, r.value ?? null, r.encrypted_value ?? null,
      r.path ?? "/", r.expires_utc ?? 0n, r.is_secure ?? 0, r.is_httponly ?? 0,
      r.samesite ?? -1, r.has_expires ?? 0, r.source_scheme ?? 2,
    ];
    ins.run(...(v as [never]));
  }
  db.close();
}

test("ingestProfile reads a copied Chrome profile and builds a host-filtered snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-ingest-"));
  try {
    const profile = join(dir, "profile");
    const def = join(profile, "Default");
    mkdirSync(def, { recursive: true });
    writeFileSync(
      join(profile, "Local State"),
      JSON.stringify({ os_crypt: {} }) // no encrypted_key -> peanuts fallback
    );
    makeCookiesDb(join(def, "Cookies"), [
      { host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("real-side-token") },
      { host_key: ".google.com", name: "__Secure-Test", encrypted_value: encryptClassic("secure-token"), is_secure: 1 },
      { host_key: ".other.com", name: "Noise", encrypted_value: encryptClassic("unrelated") },
      { host_key: "gemini.google.com", name: "HostOnly", encrypted_value: encryptClassic("host-only-token") },
      { host_key: ".google.com", name: "Broken", encrypted_value: randomBytes(80) },
    ]);

    const { snapshot, stats, warnings } = await ingestProfile({
      profileDir: profile,
      targetHost: "gemini.google.com",
    });

    assert.equal(stats.cookiesTotal, 5, `stats: ${JSON.stringify(stats)}`);
    assert.ok(stats.cookiesMatched >= 4, `matched: ${stats.cookiesMatched}`);
    const names = snapshot.cookies.map((c) => c.name).sort();
    assert.ok(names.includes("SID"), `cookies: ${JSON.stringify(names)}`);
    assert.ok(names.includes("__Secure-Test"));
    assert.ok(names.includes("HostOnly"));
    assert.ok(!names.includes("Noise"), "unrelated-domain cookie excluded");
    const sid = snapshot.cookies.find((c) => c.name === "SID")!;
    assert.equal(sid.value, "real-side-token", "cookie value decrypted");
    assert.equal(sid.domain, ".google.com");
    assert.ok(snapshot.origin.startsWith("https://"), `origin: ${snapshot.origin}`);
    // Broken (undecryptable) cookie is skipped, not allowed to poison the set.
    assert.ok(!names.includes("Broken"), "undecryptable cookie dropped");
    assert.ok(stats.undecryptable >= 1);
    assert.ok(Array.isArray(warnings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestProfile errors clearly when no Chrome profile is found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-ingest2-"));
  try {
    await assert.rejects(
      ingestProfile({ profileDir: join(dir, "nope"), targetHost: "x.example" }),
      /no chrome profile|cookies database/i
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveKeysFromLocalState tolerates the missing-key Linux case", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-ingest3-"));
  try {
    writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: {} }));
    const keys = deriveKeysFromLocalState(join(dir, "Local State"));
    assert.ok(!keys.cbc && !keys.gcm, "neither key present -> caller falls back to peanuts");
    assert.ok(existsSync(join(dir, "Local State")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});