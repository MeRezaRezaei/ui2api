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
  decodeLocalStorageValue,
  expiresUtcToEpoch,
  cookieRowToPlaywrightCookie,
  ingestProfile,
  detectProfileIdentity,
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

test("decodeLocalStorageValue strips Chrome's \\x01 literal marker and JSON quotes", () => {
  // Chrome stores literal string keys/values with a leading 0x01 marker byte
  // and values JSON-serialized — replaying those raw breaks injection.
  assert.equal(decodeLocalStorageValue("\u0001oai-did"), "oai-did");
  assert.equal(decodeLocalStorageValue('\u0001"c8a53cda-e1b8-43ba-9a9b-7fce9fcb24aa"'), "c8a53cda-e1b8-43ba-9a9b-7fce9fcb24aa");
  // JSON objects are stored as-is (no outer quotes to strip)
  assert.equal(decodeLocalStorageValue('{"state":{"mode":1},"version":0}'), '{"state":{"mode":1},"version":0}');
  // Plain values pass through untouched
  assert.equal(decodeLocalStorageValue("true"), "true");
  // No marker, no quotes → unchanged
  assert.equal(decodeLocalStorageValue("plain-key"), "plain-key");
  // Marker with quoted empty string
  assert.equal(decodeLocalStorageValue('\u0001""'), "");
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
  // node:sqlite DatabaseSync.exec(sql) takes ONE argument (@types/node:
  // `exec(sql: string): void`). A second `{ timeout }` bag is silently ignored by
  // node 24.20 (measured under an EXCLUSIVE lock: exec with {timeout:1500} returned
  // in 0ms, while `PRAGMA busy_timeout = 1500` blocked 1502ms), so dropping it is
  // provably behaviour-preserving. PRAGMA busy_timeout is the real mechanism.
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

// A wrong-typed `account_info` (Chrome wrote a scalar, not the documented array)
// used to throw `account_info.find is not a function` inside detectProfileIdentity,
// which both callers invoke BEFORE the vault write — so `profile add-all` aborted
// mid-loop with earlier accounts already written. Identity data that is
// unreadable must degrade to the Local State display name, never abort.
test("detectProfileIdentity survives a scalar account_info (type guard, not absence)", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-ingest-scalar-"));
  try {
    const profile = join(dir, "profile");
    mkdirSync(join(profile, "Default"), { recursive: true });
    for (const bad of ["me@example.com", 42, { email: "nested@example.com" }, true]) {
      writeFileSync(
        join(profile, "Default", "Preferences"),
        JSON.stringify({ account_info: bad })
      );
      writeFileSync(
        join(profile, "Local State"),
        JSON.stringify({ profile: { info_cache: { Default: { name: "Fallback Name" } } } })
      );
      const id = detectProfileIdentity(profile);
      assert.equal(id.best, "Fallback Name", `account_info=${JSON.stringify(bad)}`);
      assert.equal(id.email, undefined, `account_info=${JSON.stringify(bad)} leaked an email`);
    }
    // The documented array shape still works — the guard must not swallow it.
    writeFileSync(
      join(profile, "Default", "Preferences"),
      JSON.stringify({ account_info: [{ email: "array@example.com" }] })
    );
    const good = detectProfileIdentity(profile);
    assert.equal(good.email, "array@example.com");
    assert.equal(good.best, "array@example.com");
    // An array of non-object entries must not throw either.
    writeFileSync(
      join(profile, "Default", "Preferences"),
      JSON.stringify({ account_info: [null, "str", 7] })
    );
    assert.equal(detectProfileIdentity(profile).email, undefined);
    // Absent account_info is still absent (the pre-existing behaviour).
    writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({}));
    assert.equal(detectProfileIdentity(profile).email, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The sibling guard covered the CONTAINER (`account_info` must be an array) but
// not the LEAF. MEASURED (2026-10-05, this lane): a wrong-typed leaf inside an
// otherwise-correct shape — `info_cache.Default.name = 42`, or
// `account_info[0].email = 42` — flowed straight through `email`/`name`/`best`
// as a NUMBER or an OBJECT, and both callers hand `best` to
// `slugifyIdentity(best)`, which calls `.trim()` on it. So the throw landed
// AFTER the temp copy and BEFORE the vault write: the same partial-write abort
// as the scalar-`account_info` class, one read over. An unreadable leaf must
// degrade to the honest fallback (the other source, then `<user>-default`),
// never fork a non-string identity into the vault.
test("detectProfileIdentity type-guards every identity LEAF, not just the container", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-ingest-leaf-"));
  try {
    const profile = join(dir, "profile");
    mkdirSync(join(profile, "Default"), { recursive: true });
    const prefsPath = join(profile, "Default", "Preferences");
    const lsPath = join(profile, "Local State");
    const GOOD_LS = { profile: { info_cache: { Default: { name: "LocStateName" } } } };

    // `info_cache.Default.name` wrong-typed -> the email is still usable, and a
    // wrong-typed leaf must not shadow a VALID email further up.
    for (const bad of [42, { a: 1 }, ["x"], true, "", "   "]) {
      writeFileSync(
        lsPath,
        JSON.stringify({ profile: { info_cache: { Default: { name: bad } } } })
      );
      writeFileSync(prefsPath, JSON.stringify({ account_info: [{ email: "real@example.com" }] }));
      const id = detectProfileIdentity(profile);
      assert.equal(id.best, "real@example.com", `Default.name=${JSON.stringify(bad)}`);
      assert.equal(id.name, undefined, `Default.name=${JSON.stringify(bad)} leaked a non-string name`);
    }
    // Same for `user_name`, the other leaf of the Local State entry.
    writeFileSync(
      lsPath,
      JSON.stringify({ profile: { info_cache: { Default: { user_name: 42 } } } })
    );
    writeFileSync(prefsPath, JSON.stringify({ account_info: [{ email: "real@example.com" }] }));
    assert.equal(detectProfileIdentity(profile).name, undefined, "user_name=42 leaked");

    // `account_info[i].email` wrong-typed -> falls through to the Local State
    // display name (the sibling's documented degradation), never a number.
    for (const bad of [42, { a: 1 }, ["x"], true]) {
      writeFileSync(lsPath, JSON.stringify(GOOD_LS));
      writeFileSync(prefsPath, JSON.stringify({ account_info: [{ email: bad }] }));
      const id = detectProfileIdentity(profile);
      assert.equal(id.email, undefined, `email=${JSON.stringify(bad)} leaked a non-string email`);
      assert.equal(id.best, "LocStateName", `email=${JSON.stringify(bad)} did not fall through`);
      assert.equal(typeof id.best, "string", `email=${JSON.stringify(bad)} forked a non-string best`);
    }
    // An all-non-string account list must NOT stop at the first bad entry: the
    // guard skips it and a later valid email is still found.
    writeFileSync(lsPath, JSON.stringify(GOOD_LS));
    writeFileSync(
      prefsPath,
      JSON.stringify({ account_info: [{ email: 42 }, { email: "later@example.com" }] })
    );
    assert.equal(detectProfileIdentity(profile).email, "later@example.com");

    // `info_cache` is a KEYED MAP: an array is a wrong shape too. Unguarded,
    // `Object.values(array)[0]` returned an ELEMENT and attributed a named
    // profile's name to "Default" — a plausible-but-WRONG vault slug. It must
    // now read as no cache at all.
    for (const bad of [[{ name: "Person 2" }], ["Alice"], "Some Person", 42, true]) {
      writeFileSync(lsPath, JSON.stringify({ profile: { info_cache: bad } }));
      writeFileSync(prefsPath, JSON.stringify({}));
      const id = detectProfileIdentity(profile);
      assert.equal(id.best, "", `info_cache=${JSON.stringify(bad)} invented an identity`);
    }
    // `profile` itself wrong-typed -> no cache, no crash.
    for (const bad of ["nope", 5, null, [1, 2]]) {
      writeFileSync(lsPath, JSON.stringify({ profile: bad }));
      writeFileSync(prefsPath, JSON.stringify({}));
      assert.equal(detectProfileIdentity(profile).best, "", `profile=${JSON.stringify(bad)}`);
    }
    // The whole Preferences / Local State file wrong-typed (not an object).
    for (const bad of [42, "x", [1], null]) {
      writeFileSync(prefsPath, JSON.stringify(bad));
      writeFileSync(lsPath, JSON.stringify(bad));
      assert.equal(detectProfileIdentity(profile).best, "", `file=${JSON.stringify(bad)}`);
    }
    // `os_crypt.encrypted_key` wrong-typed: `Buffer.from(nonString, "base64")`
    // throws for a number/object/boolean, and silently ACCEPTS a byte ARRAY as
    // raw bytes — so a wrong-typed array FORGED a 16-byte `cbc` key (measured:
    // array-of-16-numbers -> `cbc` returned, so every cookie decrypted with a
    // garbage key instead of falling back to peanuts). Must return `{}`.
    for (const bad of [42, { a: 1 }, ["k"], true]) {
      writeFileSync(lsPath, JSON.stringify({ os_crypt: bad }));
      const keys = deriveKeysFromLocalState(lsPath);
      assert.ok(!keys.cbc && !keys.gcm, `encrypted_key=${JSON.stringify(bad)} -> peanuts fallback`);
    }
    for (const bad of [
      Array.from({ length: 16 }, (_, i) => (i * 7) % 256),
      [118, 49, 48, ...Array.from({ length: 16 }, (_, i) => (i * 7) % 256)],
    ]) {
      writeFileSync(lsPath, JSON.stringify({ os_crypt: { encrypted_key: bad } }));
      const keys = deriveKeysFromLocalState(lsPath);
      assert.ok(
        !keys.cbc && !keys.gcm,
        `encrypted_key=byte-array(${bad.length}) forged ${keys.cbc?.toString("hex") ?? keys.gcm?.toString("hex")}`
      );
    }
    // And a real base64 key still works — the guard must not swallow it. Build
    // it the way Chrome does (decode to bytes that literally start "v10"), so
    // the prefix-strip path is the one under test rather than a coincidence of
    // the base64 alphabet.
    writeFileSync(
      lsPath,
      JSON.stringify({
        os_crypt: { encrypted_key: Buffer.concat([Buffer.from("v10"), Buffer.alloc(32, 7)]).toString("base64") },
      })
    );
    assert.ok(deriveKeysFromLocalState(lsPath).gcm, "a real 32-byte base64 key is still read");
    writeFileSync(
      lsPath,
      JSON.stringify({
        os_crypt: { encrypted_key: Buffer.concat([Buffer.from("v10"), Buffer.alloc(16, 7)]).toString("base64") },
      })
    );
    assert.ok(deriveKeysFromLocalState(lsPath).cbc, "a real 16-byte base64 key is still read");
    // The documented shapes all still work — the guards must not swallow them.
    writeFileSync(
      prefsPath,
      JSON.stringify({ account_info: [{ email: "array@example.com" }] })
    );
    writeFileSync(lsPath, JSON.stringify(GOOD_LS));
    const good = detectProfileIdentity(profile);
    assert.equal(good.email, "array@example.com");
    assert.equal(good.name, "LocStateName");
    assert.equal(good.best, "array@example.com");
    // Named-profile fallback: no "Default" key -> the first cache VALUE, by TYPE.
    writeFileSync(prefsPath, JSON.stringify({}));
    writeFileSync(
      lsPath,
      JSON.stringify({ profile: { info_cache: { "Profile 1": { user_name: "Work" } } } })
    );
    assert.equal(detectProfileIdentity(profile).name, "Work");
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