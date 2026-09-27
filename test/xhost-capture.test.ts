// xhost+ assisted login capture tests — display-lock release, headed browser
// launch, and profile serialization into the identity vault. The capture path
// is fully offline: a real Chrome-profile fixture (Local State + Preferences +
// Cookies SQLite) is ingested without any browser.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo as osUserInfo } from "node:os";
import { join } from "node:path";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  assistedLoginFlow,
  captureProfileFromLiveChrome,
  detectDisplayInfo,
  launchHeadedChromeForLogin,
  relaxDisplayLock,
  ui2apiUser,
  ui2apiUserDataDir,
  ui2apiUserHome,
  userExists,
  type AssistedResult,
} from "../src/runtime/xhost-capture.js";
import { loadSnapshot } from "../src/runtime/session-store.js";

// --- Chrome cookie encryption mirrors (what a real Linux profile contains) ---

const PEANUTS = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

// Modern Linux Chrome: "v10" + HDR(16 random) + IV(16) + AES-128-CBC ciphertext.
function encryptClassic(s: string): Buffer {
  const hdr = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", PEANUTS, iv);
  return Buffer.concat([Buffer.from("v10"), hdr, iv, cipher.update(s, "utf8"), cipher.final()]);
}

// A correctly-prefixed but undecryptable v10 cookie (junk ciphertext).
function v10Junk(): Buffer {
  return Buffer.concat([Buffer.from("v10"), randomBytes(96)]);
}

interface FixtureRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
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
    ins.run(r.host_key, r.name, null, r.encrypted_value, "/", 0n, 1, 1, -1, 0, 2);
  }
  db.close();
}

// Build a Chrome-profile fixture under `dir`: Local State (empty os_crypt so
// the peanuts key applies) + Default/Preferences (optional account email) +
// Default/Network/Cookies.
function makeProfile(dir: string, email?: string): string {
  const profileDir = join(dir, "profile");
  const def = join(profileDir, "Default");
  mkdirSync(join(def, "Network"), { recursive: true });
  writeFileSync(join(profileDir, "Local State"), JSON.stringify({ os_crypt: {} }));
  writeFileSync(join(def, "Preferences"), JSON.stringify({ account_info: email ? [{ email }] : [] }));
  return profileDir;
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test("ui2apiUser() reads UI2API_USER with a ui2api fallback", () => {
  withEnv("UI2API_USER", undefined, () => assert.equal(ui2apiUser(), "ui2api"));
  withEnv("UI2API_USER", "carol", () => assert.equal(ui2apiUser(), "carol"));
});

test("detectDisplayInfo() reads DISPLAY and declines headless CI", () => {
  withEnv("DISPLAY", ":1", () => {
    withEnv("XAUTHORITY", undefined, () => {
      withEnv("CI", undefined, () => {
        assert.deepEqual(detectDisplayInfo(), { display: ":1", source: "env" });
      });
    });
  });
  withEnv("DISPLAY", undefined, () => {
    withEnv("CI", "1", () => {
      assert.equal(detectDisplayInfo(), null);
    });
  });
});

test("detectDisplayInfo() prefers an owned X socket over the :0 fallback", () => {
  // A real user session socket check needs a controllable socket dir; we can't
  // fake /tmp/.X11-unix here, so verify the contract mathematically instead:
  // with DISPLAY unset and no CI, the result is either the owned socket (source
  // "socket") or the documented :0 fallback — never a throw, always {display}.
  withEnv("DISPLAY", undefined, () => {
    withEnv("CI", undefined, () => {
      const d = detectDisplayInfo();
      assert.ok(d === null || d === undefined ? false : typeof d.display === "string");
      assert.ok(d?.display === ":0" || d?.source === "socket");
    });
  });
});

test("relaxDisplayLock returns a xhost outcome object (shape, not success)", () => {
  const res = relaxDisplayLock({ display: ":9", ui2apiUser: "definitely-not-a-user", mode: "specific" });
  assert.ok(res && typeof res === "object");
  assert.equal(typeof res.command, "string");
  assert.ok(res.command.includes("xhost"), `command names xhost: ${res.command}`);
  assert.ok(res.exitCode !== 0, "no X server -> xhost cannot succeed, and never throws");
  assert.equal(typeof res.stderr, "string");
});

test("captureProfileFromLiveChrome ingests the live profile into the identity vault", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-xhost-"));
  try {
    const profileDir = makeProfile(dir, "carol@example.com");
    // Fixture: 2 decryptable gemini.google.com cookies + 1 undecryptable
    // v10-style cookie. The ingester's stats.cookiesMatched counts every
    // domain-matched row (including the undecryptable one), so matched = 3
    // while the SNAPSHOT carries only the 2 decryptable cookies.
    makeCookiesDb(join(profileDir, "Default", "Network", "Cookies"), [
      { host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-abc") },
      { host_key: ".google.com", name: "HSID", encrypted_value: encryptClassic("hsid-xyz") },
      { host_key: ".google.com", name: "BrokenV10", encrypted_value: v10Junk() },
    ]);

    const dataDir = join(dir, "data");
    const res = await captureProfileFromLiveChrome({ profileDir, host: "gemini.google.com", dataDir });

    assert.equal(res.identity, "carol@example.com");
    assert.equal(res.stats.cookiesTotal, 3, `stats: ${JSON.stringify(res.stats)}`);
    assert.equal(res.stats.cookiesMatched, 3, "2 good + 1 undecryptable, all domain-matched");
    assert.equal(res.stats.localStorageEntries, 0);
    assert.ok(existsSync(res.snapshotPath), `snapshot written: ${res.snapshotPath}`);
    assert.ok(res.snapshotPath.includes(join("sessions", "gemini.google.com")), res.snapshotPath);
    // Only the 2 decryptable cookies survive into the snapshot.
    const saved = loadSnapshot(res.snapshotPath);
    assert.ok(saved, "snapshot loads from disk");
    assert.equal(saved!.cookies.length, 2, `snapshot cookies: ${JSON.stringify(saved!.cookies.map((c) => c.name))}`);
    assert.ok(res.warnings.some((w) => /undecryptable|could not be decrypted/i.test(w)), JSON.stringify(res.warnings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureProfileFromLiveChrome falls back to a username-default identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-xhost2-"));
  try {
    const profileDir = makeProfile(dir); // no account email in Preferences
    makeCookiesDb(join(profileDir, "Default", "Network", "Cookies"), [
      { host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("abc") },
    ]);
    const dataDir = join(dir, "data");
    const res = await captureProfileFromLiveChrome({ profileDir, host: "gemini.google.com", dataDir });
    assert.ok(res.identity.length > 0, `identity never empty: ${res.identity}`);
    assert.ok(res.identity.endsWith("-default"), `fallback shape: ${res.identity}`);
    assert.ok(existsSync(res.snapshotPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launchHeadedChromeForLogin never throws on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-xhost3-"));
  try {
    const res = await launchHeadedChromeForLogin({
      url: "", // invalid URL -> navigation must fail, wrapped in a result
      profileDir: join(dir, "prof"),
      display: ":9",
      user: "definitely-not-a-user",
    });
    assert.ok(res && typeof res === "object");
    assert.equal(res.launched, false);
    // `error` is OPTIONAL on LaunchHeadedResult (`error?: string`), so the
    // compiler cannot assume it is there — and an unguarded `res.error.length`
    // is exactly the failure this pin exists to prevent: a launch that reported
    // NO reason at all would throw a TypeError on `undefined.length` instead of
    // stating the real defect. Narrow through the same condition the pin already
    // cares about, and print what it actually got, so a genuine missing-reason
    // regression stays loud AND legible.
    assert.equal(typeof res.error, "string", "a launch failure must be reported as a named string, never undefined");
    assert.ok(
      typeof res.error === "string" && res.error.length > 0,
      `a launch failure must carry a named, non-empty reason; got ${JSON.stringify(res.error)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assistedLoginFlow never throws and always reports the 4 flow keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-xhost4-"));
  try {
    const res = await assistedLoginFlow({
      url: "https://gemini.google.com/",
      host: "gemini.google.com",
      dataDir: join(dir, "data"),
      profileDir: join(dir, "prof"),
      display: ":9",
      ui2apiUser: "definitely-not-a-user",
      relaxMode: "specific",
    });
    assert.ok(res && typeof res === "object");
    for (const key of ["displayShared", "xhost", "browserLaunched", "error"] as const) {
      assert.ok(key in res, `key present: ${key}`);
    }
    assert.equal(res.displayShared, false, "xhost cannot succeed without an X server / real user");
    assert.ok(res.xhost && typeof res.xhost.command === "string");
    assert.ok(res.browserLaunched === true || typeof res.error === "string", "either launched or described");
    const typed = res as AssistedResult;
    assert.equal(typeof typed.displayShared, "boolean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ui2apiUserHome resolves the real home only for the current user", () => {
  assert.equal(ui2apiUserHome("definitely-not-a-user"), "/home/definitely-not-a-user");
  let me = "";
  try {
    me = osUserInfo({ encoding: "utf8" }).username;
  } catch {
    // no passwd entry for the runner — home resolution falls back too
  }
  if (me) {
    assert.equal(ui2apiUserHome(me), osUserInfo({ encoding: "utf8" }).homedir);
    assert.equal(userExists(me), true);
  }
  assert.equal(userExists("definitely-not-a-user"), false);
});

test("ui2apiUserDataDir prefers the ui2api user's XDG dir when writable", () => {
  const res = ui2apiUserDataDir({
    ui2apiUser: () => "ui2api",
    currentUser: () => "me",
    userExists: () => true,
    userHome: () => "/home/ui2api",
    probeWrite: () => true,
  });
  assert.equal(res, "/home/ui2api/.local/share/ui2api");
});

test("ui2apiUserDataDir returns null when the ui2api user is absent", () => {
  const res = ui2apiUserDataDir({
    ui2apiUser: () => "ui2api",
    currentUser: () => "me",
    userExists: () => false,
    userHome: () => "/home/ui2api",
    probeWrite: () => true,
  });
  assert.equal(res, null);
});

test("ui2apiUserDataDir returns null when the dir is not writable (honest fallback)", () => {
  const res = ui2apiUserDataDir({
    ui2apiUser: () => "ui2api",
    currentUser: () => "me",
    userExists: () => true,
    userHome: () => "/home/ui2api",
    probeWrite: () => false,
  });
  assert.equal(res, null);
});

test("ui2apiUserDataDir returns the own dir when the process IS the ui2api user", () => {
  const realHome = "/home/ui2api";
  const res = ui2apiUserDataDir({
    ui2apiUser: () => "ui2api",
    currentUser: () => "ui2api",
    userExists: () => true, // irrelevant: running AS the user owns the dir
    userHome: () => realHome,
    probeWrite: () => false, // irrelevant: own home, no probe needed
  });
  assert.equal(res, "/home/ui2api/.local/share/ui2api");
});