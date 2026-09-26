// GOAL 9 criterion 3 + add-all command mechanics.
//
// Criterion 3 (verbatim): "Temp hygiene closed: every u2a-scan-read-/
// u2a-ingest-/u2a-ls- temp dir is removed after scan/import (finally-style
// cleanup, not best-effort); a test asserts a fixture-profile scan+import
// leaves ZERO residue in the tmpdir (listing the marker prefixes before/after)."
//
// These tests drive the exported scan/import functions directly (offline,
// deterministic — no browser, no tsx-spawn of the CLI, matching the crate
// where siblings exercise src exports rather than the OS-wide CLI scan path).
// The add-all read-back mechanics are asserted at the same seams the CLI uses
// (`listAccounts` + `loadAccountSnapshot` + the verdict branch in
// cmdProfileAddAll), so a fake vault + fake scan proves the "imported" /
// "decrypt-limited" / "skipped-no-auth" verdict ladder without a browser.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  slugifyIdentity,
  listAccounts,
  loadAccountSnapshot,
} from "../src/runtime/session-store.js";
import {
  scanProfilesForSites,
  importSiteSnapshot,
  withCopyCookiesForReading,
} from "../src/runtime/profile-scan.js";

// The residue assertions below list `os.tmpdir()`, but `node --test` runs each
// test FILE in its own process, and sibling files (profile-scan, profile-ingest)
// create/remove their own `u2a-*` temp dirs in the SAME shared tmpdir. A scan
// that checks "no new u2a-* entries" can therefore spuriously flag a sibling's
// in-flight dir as residue (cross-process race, not a leak). Isolate this
// process's marker namespace behind a private TMPDIR before any tmpdir() call
// (`os.tmpdir()` caches its first result, so this must run before tests):
const PRIV_TMP = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "ui2api-test-"));
process.env.TMPDIR = PRIV_TMP;
after(() => rmSync(PRIV_TMP, { recursive: true, force: true }));

// --- Chrome cookie encryption mirror (same as xhost-capture.test.ts) ---

const PEANUTS = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

// Modern Linux Chrome: "v10" + HDR(16 random) + IV(16) + AES-128-CBC ciphertext.
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

function encryptWithIv(s: string, iv: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", PEANUTS, iv);
  return Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
}

// Deterministic undecryptable v10 cookie: one CBC block with a fixed
// 16-space IV whose plaintext is NUL-prefixed. The ingester's v10-legacy
// decrypt resolves to "\0junk", which fails `looksDecrypted` — so the value
// can never round-trip, unlike a random blob that could (wrongly) look good.
function undecryptableCookie(): Buffer {
  const iv = Buffer.alloc(16, 0x20);
  return Buffer.concat([Buffer.from("v10"), encryptWithIv("\u0000junk", iv)]);
}

// --- Fixture builder (Chrome profile root: Local State + Preferences + Cookies) ---

interface FixtureRow {
  host_key: string;
  name: string;
  encrypted_value?: Buffer;
}

function makeCookiesDb(dbPath: string, rows: FixtureRow[]): void {
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
    ins.run(r.host_key, r.name, null, r.encrypted_value ?? null, "/", 0n, 1, 1, -1, 0, 2);
  }
  db.close();
}

function makeProfile(
  root: string,
  opts: { email?: string; rows: FixtureRow[] }
): string {
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

// --- Temp-marker listing (criterion 3's "listing the marker prefixes before/after") ---

function u2aTmpEntries(): Set<string> {
  try {
    return new Set(readdirSync(tmpdir()).filter((e) => e.startsWith("u2a-")));
  } catch {
    return new Set();
  }
}

function assertNoNewU2aEnts(before: Set<string>, ctx: string): void {
  const after = u2aTmpEntries();
  for (const name of after) {
    assert.ok(
      before.has(name),
      `${ctx}: ${name} is new u2a-* residue in ${tmpdir()} (after=${[...after].join(",")})`
    );
  }
}

// --- Add-all read-back verdict (verbatim mirror of cmdProfileAddAll's branch,
// lines ~686-702 of src/cli.ts) — same seams, no browser ---

function addAllVerdict(
  imp: { stats: { cookiesMatched: number }; ok?: boolean; snapshotPath?: string },
  dataDir: string,
  host: string,
  slug: string
): string {
  if (!imp.ok || !imp.snapshotPath) return "skipped-no-auth (nothing to save)";
  const listed = listAccounts(dataDir, host).some((a) => a.slug === slug);
  const snap = loadAccountSnapshot(dataDir, host, slug);
  if (!listed || !snap) return "failed(read-back-missing)";
  const cookies = (snap.cookies ?? []).length;
  const ls = (snap.localStorage ?? []).length;
  if (cookies === 0 && imp.stats.cookiesMatched > 0) {
    return "decrypt-limited (portal v20)";
  }
  if (cookies > 0 || ls > 0) return "imported";
  return "skipped-no-auth";
}

// ---- Tests ----

test("scan leaves zero u2a-* residue in the tmpdir (success path)", () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-addall-scan-"));
  try {
    const root = makeProfile(join(base, "profile"), {
      email: "alice@example.com",
      rows: [
        { host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("tok-1") },
        { host_key: "chatgpt.com", name: "auth", encrypted_value: encryptClassic("tok-3") },
      ],
    });
    const before = u2aTmpEntries();

    const result = scanProfilesForSites([{ root, user: "testuser" }]);
    assert.ok(result.hits.some((h) => h.host === "gemini.google.com"), "scan must find the host");

    assertNoNewU2aEnts(before, "scanProfilesForSites");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("withCopyCookiesForReading removes its temp dir even when the read throws (finally-style)", () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-addall-throw-"));
  try {
    const root = makeProfile(join(base, "profile"), {
      rows: [{ host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("t") }],
    });
    const before = u2aTmpEntries();

    assert.throws(
      () =>
        withCopyCookiesForReading(root, (dbPath) => {
          assert.ok(dbPath.includes("u2a-scan-read-"), dbPath);
          throw new Error("read exploded");
        }),
      /read exploded/
    );

    assertNoNewU2aEnts(before, "withCopyCookiesForReading throw-in-fn");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("withCopyCookiesForReading leaves no residue when the cookie COPY stage throws", () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-addall-copythrow-"));
  try {
    // `Default/Network/Cookies` is a DIRECTORY: existsSync passes, then the
    // recursive copy of a directory onto a file path throws (ERR_FS_EISDIR)
    // after mkdtemp — copyCookiesForReading must clean up its own temp dir.
    const root = join(base, "profile");
    mkdirSync(join(root, "Default", "Network", "Cookies"), { recursive: true });
    writeFileSync(join(root, "Local State"), JSON.stringify({ os_crypt: {} }));
    mkdirSync(join(root, "Default"), { recursive: true });
    writeFileSync(join(root, "Default", "Preferences"), JSON.stringify({ account_info: [] }));
    const before = u2aTmpEntries();

    assert.throws(() => withCopyCookiesForReading(root, (p) => p));

    assertNoNewU2aEnts(before, "withCopyCookiesForReading copy-stage throw");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("scan+import leaves zero u2a-* residue (sweeps u2a-ingest- cross-module)", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-addall-import-"));
  try {
    const root = makeProfile(join(base, "profile"), {
      email: "alice@example.com",
      rows: [
        { host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("tok-a") },
      ],
    });
    const dataDir = join(base, "data");
    const before = u2aTmpEntries();

    const result = await importSiteSnapshot({
      root,
      host: "gemini.google.com",
      dataDir,
    });
    assert.equal(result.ok, true);

    assertNoNewU2aEnts(before, "importSiteSnapshot (ingest sweep)");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("add-all read-back: known host with cookies -> account listed, snapshot usable, 'imported'", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-addall-ok-"));
  try {
    const root = makeProfile(join(base, "profile"), {
      email: "alice@example.com",
      rows: [
        { host_key: ".google.com", name: "SID", encrypted_value: encryptClassic("sid-abc") },
      ],
    });
    const dataDir = join(base, "data");
    const host = "gemini.google.com";

    const imp = await importSiteSnapshot({ root, host, dataDir });
    assert.equal(imp.host, host);
    assert.equal(imp.ok, true, `cookies matched: ${imp.stats.cookiesMatched}`);
    assert.equal(imp.identity, "alice@example.com");

    const slug = slugifyIdentity(imp.identity);
    assert.equal(slug, "alice@example.com");

    const listed = listAccounts(dataDir, host).find((a) => a.slug === slug);
    assert.ok(listed, "account must be listed in the vault index");
    const snap = loadAccountSnapshot(dataDir, host, slug);
    assert.ok(snap, "snapshot must read back from the vault");
    assert.ok((snap!.cookies ?? []).length > 0, "snapshot carries cookies");
    assert.ok((snap!.cookies ?? []).some((c) => c.name === "SID"));

    assert.equal(addAllVerdict(imp, dataDir, host, slug), "imported");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("add-all read-back: matched-but-zero cookies -> honest 'decrypt-limited (portal v20)'", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-addall-limited-"));
  try {
    const root = makeProfile(join(base, "profile"), {
      email: "carol@example.com",
      rows: [
        { host_key: ".google.com", name: "AppBound", encrypted_value: undecryptableCookie() },
      ],
    });
    const dataDir = join(base, "data");
    const host = "gemini.google.com";

    const imp = await importSiteSnapshot({ root, host, dataDir });
    assert.equal(imp.stats.cookiesMatched, 1, "the HAD a cookie for the host");
    assert.equal(imp.ok, true, "matched>0 -> ok (captured), but unusable");

    const slug = slugifyIdentity(imp.identity);
    const snap = loadAccountSnapshot(dataDir, host, slug);
    assert.ok(snap);
    assert.equal((snap!.cookies ?? []).length, 0, "undecryptable cookies must not survive");
    assert.ok(
      imp.warnings.some((w) => /could not be decrypted/i.test(w)),
      `warning present: ${JSON.stringify(imp.warnings)}`
    );

    assert.equal(addAllVerdict(imp, dataDir, host, slug), "decrypt-limited (portal v20)");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("add-all read-back: matched-zero host -> 'skipped-no-auth'", async () => {
  const base = mkdtempSync(join(tmpdir(), "u2a-addall-skip-"));
  try {
    // Profile has a gemini cookie but we import a DIFFERENT known host the
    // user never visited here: matched=0, snapshot has no cookies/storage.
    const root = makeProfile(join(base, "profile"), {
      email: "dana@example.com",
      rows: [
        { host_key: "gemini.google.com", name: "SID", encrypted_value: encryptClassic("tok") },
      ],
    });
    const dataDir = join(base, "data");
    const host = "grok.com";

    const imp = await importSiteSnapshot({ root, host, dataDir });
    assert.equal(imp.ok, false, "no cookie matched -> NOT logged in");
    assert.equal(imp.snapshotPath, "", "GOAL 49: fully anonymous import is REFUSED at the write seam — nothing written");
    assert.ok(imp.warnings.some((w) => /skipped-no-auth \(nothing to save\)/i.test(w)), JSON.stringify(imp.warnings));

    const slug = slugifyIdentity(imp.identity);
    // GOAL 49: the vault MUST NOT contain the refused account — no index row,
    // no snapshot on disk (the old behavior of writing the anonymous snapshot
    // "as an honest record" is what made /accounts + the age gate surface a
    // fake account as fresh + valid).
    assert.equal(listAccounts(dataDir, host).some((a) => a.slug === slug), false, "refused import must NOT be listed");
    assert.equal(loadAccountSnapshot(dataDir, host, slug), null, "no snapshot for a refused import");

    assert.equal(addAllVerdict(imp, dataDir, host, slug), "skipped-no-auth (nothing to save)");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});