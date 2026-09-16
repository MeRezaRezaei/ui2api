import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  slugifyIdentity,
  listAccounts,
} from "../src/runtime/session-store.js";
import {
  findAllChromeProfilesOnOs,
  scanProfilesForSites,
  importSiteSnapshot,
  renderCheckboxList,
} from "../src/runtime/profile-scan.js";

// Run with: node --import tsx --test test/profile-scan.test.ts

// --- Crypto helpers (mirror profile-ingest.test.ts) ---

const PEANUTS = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

function encryptClassic(s: string): Buffer {
  const hdr = randomBytes(16);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", PEANUTS, iv);
  return Buffer.concat([
    Buffer.from("v10"),
    hdr,
    iv,
    cipher.update(s, "utf8"),
    cipher.final(),
  ]);
}

// --- Fixture builder ---

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

function createFixture(
  root: string,
  opts: { email?: string; rows: FixtureRow[] }
): string {
  const def = join(root, "Default", "Network");
  mkdirSync(def, { recursive: true });
  writeFileSync(
    join(root, "Local State"),
    JSON.stringify({ os_crypt: { encrypted_key: "" } })
  );
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

// Canonical fixture rows: 2 gemini, 1 chatgpt, 1 notion, 1 localhost (filtered), 1 vanitydomain (no-dot, filtered)
const FIXTURE_ROWS: FixtureRow[] = [
  { host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("tok-1") },
  { host_key: "gemini.google.com", name: "session", encrypted_value: encryptClassic("tok-2") },
  { host_key: "chatgpt.com", name: "auth", encrypted_value: encryptClassic("tok-3") },
  { host_key: "www.notion.so", name: "token", encrypted_value: encryptClassic("tok-4") },
  { host_key: "localhost", name: "dev", encrypted_value: encryptClassic("tok-5") },
  { host_key: "vanitydomain", name: "v", encrypted_value: encryptClassic("tok-6") },
];

// ---- Tests ----

test("scanProfilesForSites aggregates valid hosts with correct counts and known flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-scan-agg-"));
  try {
    const root = createFixture(join(dir, "profile"), {
      email: "alice@example.com",
      rows: [...FIXTURE_ROWS],
    });
    const result = scanProfilesForSites([{ root, user: "testuser" }]);

    // localhost + vanitydomain filtered → 3 valid hosts
    assert.equal(result.hits.length, 3);

    const byHost = Object.fromEntries(result.hits.map((h) => [h.host, h.cookieCount]));
    assert.equal(byHost["gemini.google.com"], 2);
    assert.equal(byHost["chatgpt.com"], 1);
    assert.equal(byHost["www.notion.so"], 1);

    // known flags
    const knownHosts = new Set(result.hits.filter((h) => h.known).map((h) => h.host));
    assert.ok(knownHosts.has("gemini.google.com"));
    assert.ok(knownHosts.has("chatgpt.com"));
    assert.ok(knownHosts.has("www.notion.so"));

    // sorted by cookieCount desc
    assert.equal(result.hits[0].host, "gemini.google.com");

    // byProfile
    assert.equal(result.byProfile.length, 1);
    assert.equal(result.byProfile[0].root, root);
    assert.equal(result.byProfile[0].user, "testuser");
    assert.equal(result.byProfile[0].hosts.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanProfilesForSites normalizes host_key: strips leading dot and lowercases", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-scan-norm-"));
  try {
    const root = createFixture(join(dir, "p"), {
      rows: [
        { host_key: ".Example.COM", name: "a", encrypted_value: encryptClassic("x") },
        { host_key: "Notion.SO", name: "b", encrypted_value: encryptClassic("y") },
      ],
    });
    const result = scanProfilesForSites([{ root, user: "u" }]);
    assert.equal(result.hits.length, 2);
    const hosts = result.hits.map((h) => h.host).sort();
    assert.deepEqual(hosts, ["example.com", "notion.so"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importSiteSnapshot writes snapshot with detected identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-scan-import-"));
  try {
    const root = join(dir, "profile");
    createFixture(root, {
      email: "alice@example.com",
      rows: [
        { host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("tok-a") },
      ],
    });
    const result = await importSiteSnapshot({
      root,
      host: "gemini.google.com",
      dataDir: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.identity, "alice@example.com");
    assert.ok(existsSync(result.snapshotPath), `snapshot not at ${result.snapshotPath}`);
    const accounts = listAccounts(dir, "gemini.google.com");
    assert.ok(accounts.length > 0, "no accounts saved");
    assert.equal(accounts[0].identity, "alice@example.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importSiteSnapshot falls back to os-user-default identity when prefs have no email", async () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-scan-fb-"));
  try {
    const root = join(dir, "profile2");
    createFixture(root, {
      rows: [
        { host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("tok-b") },
      ],
    });
    const result = await importSiteSnapshot({
      root,
      host: "gemini.google.com",
      dataDir: dir,
    });
    assert.ok(result.identity.length > 0, "identity must be non-empty");
    assert.ok(
      result.identity.includes("-default"),
      `identity "${result.identity}" should contain "-default"`
    );
    const accounts = listAccounts(dir, "gemini.google.com");
    assert.ok(accounts.length > 0);
    assert.ok(accounts[0].identity.includes("-default"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slugifyIdentity normalizes email-like identities", () => {
  assert.equal(slugifyIdentity("Alice@Example.COM"), "alice@example.com");
});

test("renderCheckboxList produces checkbox-format output with [KNOWN] markers", () => {
  const hits = [
    { host: "gemini.google.com", cookieCount: 47, profiles: ["/a", "/b"], known: true },
    { host: "random-site.com", cookieCount: 3, profiles: ["/c"], known: false },
  ];
  const text = renderCheckboxList(hits);
  assert.ok(text.includes("[ ]"), "missing checkbox marker");
  assert.ok(text.includes("[KNOWN]"), "missing [KNOWN] marker");
  assert.ok(text.includes("2 profiles, 47 cookies"));
  assert.ok(text.includes("1 profile, 3 cookies"));
});

test("findAllChromeProfilesOnOs includes extraRoots in results", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-scan-find-"));
  try {
    const root = join(dir, "profile");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "Local State"), JSON.stringify({ os_crypt: {} }));
    mkdirSync(join(root, "Default"), { recursive: true });
    const result = findAllChromeProfilesOnOs({ extraRoots: [root] });
    const found = result.profiles.find((p) => p.root === root);
    assert.ok(found, `fixture root ${root} not found in profiles`);
    assert.equal(found!.user, userInfo().username);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
