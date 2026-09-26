// GOAL 106 — the vault must not hand decrypted credentials to every local user,
// and the ingest path must not leave its temp copies of the live Chrome
// `Cookies` DB + `Local State` os_crypt key on disk.
//
// Measured before the fix: `saveSnapshot` / `saveAccountSnapshot` /
// `saveCapabilities` all wrote with NO `mode`, so under the default umask a
// real snapshot (`data/sessions/aistudio.tencent.ai/<acct>/state.json`,
// carrying non-empty hunyuan_token/hunyuan_user) landed `-rw-r--r--`. And
// `copyProfileForReading` made an `u2a-ingest-` temp dir that nothing removed.
//
// HONESTY: this file NEVER reads, rewrites, or chmods a real vault file and
// never touches a real snapshot. Every fixture lives under a uniquely-named
// temp dir this test creates, and is removed in `finally`. The only real files
// read are the two SOURCE files (as text, to pin the try/finally) — reading
// source is not touching a credential.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountsIndexPath,
  accountSnapshotPath,
  capabilitiesPath,
  saveAccountSnapshot,
  saveCapabilities,
  saveSnapshot,
  type ProfileSnapshot,
} from "../src/runtime/session-store.js";
import { copyProfileForReading } from "../src/runtime/profile-ingest.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_STORE_SRC = join(ROOT, "src", "runtime", "session-store.ts");
const PROFILE_INGEST_SRC = join(ROOT, "src", "runtime", "profile-ingest.ts");
const HOST = "credential-mode.example.com";

/** The pin: no group or other permission bit may be set on a credential file. */
const GROUP_OTHER_BITS = 0o077;

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** A snapshot with a NON-EMPTY secret value, so "it was really credential-bearing". */
function credentialSnapshot(host = HOST): ProfileSnapshot {
  return {
    version: 1,
    host,
    origin: `https://${host}`,
    capturedAt: new Date().toISOString(),
    cookies: [
      {
        name: "session_token",
        value: "SUPER_SECRET_VALUE_NOT_REAL",
        domain: `.${host}`,
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    localStorage: [["authToken", "SUPER_SECRET_LS_VALUE_NOT_REAL"]],
    sessionStorage: [],
    indexedDB: [],
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "u2a-vault-mode-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ingestTempDirs(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter((n) => n.startsWith("u2a-ingest-") || n.startsWith("u2a-ls-"))
  );
}

test("GOAL 106: saveSnapshot writes a credential-bearing snapshot 0600, dir 0700", () => {
  withTempDir((dataDir) => {
    const snap = credentialSnapshot();
    // The real write path, a fresh (never-before-existing) target.
    saveSnapshot(accountSnapshotPath(dataDir, HOST, "acct"), snap);

    const file = accountSnapshotPath(dataDir, HOST, "acct");
    assert.ok(existsSync(file), "snapshot must exist after the real write path");
    assert.equal(
      readFileSync(file, "utf8").includes("SUPER_SECRET_VALUE_NOT_REAL"),
      true,
      "fixture really is credential-bearing (else the mode pin proves nothing)"
    );
    assert.equal(
      modeOf(file) & GROUP_OTHER_BITS,
      0,
      `snapshot must have NO group/other bits, got ${modeOf(file).toString(8)}`
    );
    for (const dir of [dataDir, dirname(dirname(file)), dirname(file)]) {
      assert.equal(
        statSync(dir).mode & GROUP_OTHER_BITS,
        0,
        `${dir} must not be group/other accessible, got ${(statSync(dir).mode & 0o777).toString(8)}`
      );
    }
  });
});

test("GOAL 106: a PRE-EXISTING 0644 snapshot is tightened to 0600 on rewrite", () => {
  withTempDir((dataDir) => {
    const file = accountSnapshotPath(dataDir, HOST, "legacy");
    mkdirSync(dirname(file), { recursive: true });
    // Simulate a file written by the OLD (mode-less) build.
    writeFileSync(file, JSON.stringify(credentialSnapshot()));
    chmodSync(file, 0o644);
    // 0644 = rw-r--r-- => group/other bits are exactly 0o044 (owner write is not
    // a group/other bit, so it is deliberately excluded from the predicate).
    assert.equal(modeOf(file) & GROUP_OTHER_BITS, 0o044, "precondition: 0644 is world-readable");

    saveSnapshot(file, credentialSnapshot());
    assert.equal(
      modeOf(file) & GROUP_OTHER_BITS,
      0,
      `rewrite must ENFORCE 0600, not merely request it — got ${modeOf(file).toString(8)}`
    );
  });
});

test("GOAL 106: accounts index + capability fingerprint are equally restrictive", () => {
  withTempDir((dataDir) => {
    // slugifyIdentity("person@example.com") keeps `@` (it is in the slug
    // alphabet) — the real slug, not a hand-guessed one.
    const slug = "person@example.com";
    saveAccountSnapshot(dataDir, HOST, "person@example.com", credentialSnapshot(), {
      source: "capture",
    });
    saveCapabilities(dataDir, HOST, slug, {
      probed: true,
      host: HOST,
      capabilities: { chat: { ok: true } },
    });

    const index = accountsIndexPath(dataDir, HOST);
    const snapshot = accountSnapshotPath(dataDir, HOST, slug);
    const fingerprint = capabilitiesPath(dataDir, HOST, slug);
    for (const [label, p] of [
      ["accounts.json", index],
      ["account snapshot", snapshot],
      ["capabilities.json", fingerprint],
    ] as const) {
      assert.ok(existsSync(p), `${label} must exist`);
      assert.equal(
        modeOf(p) & GROUP_OTHER_BITS,
        0,
        `${label} must have NO group/other bits, got ${modeOf(p).toString(8)}`
      );
    }
    assert.equal(
      statSync(dirname(fingerprint)).mode & GROUP_OTHER_BITS,
      0,
      "account dir must not be group/other accessible"
    );
    // Read-back sanity: the restrictive mode did not corrupt the content.
    assert.equal(JSON.parse(readFileSync(index, "utf8")).accounts.length, 1);
  });
});

test("GOAL 106 MUTATION: an unrestricted 0o644 mode would FAIL the pin predicate", () => {
  // Proves the pin is not vacuous: if the write seam regressed to the default
  // umask, these assertions would fail rather than silently pass.
  withTempDir((dir) => {
    const worldReadable = join(dir, "world-readable.json");
    writeFileSync(worldReadable, JSON.stringify(credentialSnapshot()));
    chmodSync(worldReadable, 0o644);
    assert.equal(
      modeOf(worldReadable) & GROUP_OTHER_BITS,
      0o044,
      "a 0644 file MUST be detected as group/other readable"
    );

    const worldReadableDir = join(dir, "sub");
    mkdirSync(worldReadableDir);
    chmodSync(worldReadableDir, 0o755);
    assert.notEqual(
      statSync(worldReadableDir).mode & GROUP_OTHER_BITS,
      0,
      "a 0755 dir MUST be detected as group/other accessible"
    );

    // And the real write path in the same conditions stays clean.
    saveSnapshot(join(dir, "sub", "state.json"), credentialSnapshot());
    assert.equal(modeOf(join(dir, "sub", "state.json")) & GROUP_OTHER_BITS, 0);
  });
});

test("GOAL 106: copyProfileForReading removes its u2a-ingest- temp dir deterministically", () => {
  withTempDir((root) => {
    // A SYNTHETIC fake Chrome profile in a temp location — no real profile is
    // read, copied, or modified.
    const profileDir = join(root, "fake-chrome");
    const def = join(profileDir, "Default");
    mkdirSync(def, { recursive: true });
    writeFileSync(join(profileDir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "ZmFrZQ==" } }));
    writeFileSync(join(def, "Cookies"), "SQLite format 3\0fake-not-a-db");
    writeFileSync(join(def, "Cookies-wal"), "fake-wal");
    // Make the SOURCE files world-readable on purpose: the copies must still be
    // tightened, since cpSync otherwise inherits the source's permissive mode.
    chmodSync(join(def, "Cookies"), 0o644);
    chmodSync(join(profileDir, "Local State"), 0o644);

    const before = ingestTempDirs();
    const seen: string[] = [];
    const result = copyProfileForReading(profileDir, ({ dbPath, localStatePath }) => {
      seen.push(dbPath, localStatePath);
      // The copies exist during the callback (the read happens here) ...
      assert.ok(existsSync(dbPath), "temp copy must exist while in use");
      assert.ok(existsSync(localStatePath), "temp Local State copy must exist while in use");
      assert.equal(statSync(dbPath).mode & GROUP_OTHER_BITS, 0, "temp cookie DB copy must be 0600");
      assert.equal(
        statSync(localStatePath).mode & GROUP_OTHER_BITS,
        0,
        "temp os_crypt key copy must be 0600"
      );
      assert.ok(dbPath.includes("u2a-ingest-"), "sanity: temp dir uses the u2a-ingest- prefix");
      return "read-result";
    });
    assert.equal(result, "read-result", "the callback's return value is passed through");
    assert.equal(seen.length, 2);

    // ... and NOTHING is left behind.
    const leaked = [...ingestTempDirs()].filter((n) => !before.has(n));
    assert.deepEqual(leaked, [], `copyProfileForReading leaked temp dirs: ${leaked.join(", ")}`);
    for (const p of seen) assert.equal(existsSync(p), false, `${p} must be gone after the read`);
  });
});

test("GOAL 106: copyProfileForReading cleans up even when the read throws", () => {
  withTempDir((root) => {
    const profileDir = join(root, "fake-chrome-throw");
    const def = join(profileDir, "Default");
    mkdirSync(def, { recursive: true });
    writeFileSync(join(profileDir, "Local State"), "{}");
    writeFileSync(join(def, "Cookies"), "not-a-db");

    const before = ingestTempDirs();
    assert.throws(() =>
      copyProfileForReading(profileDir, () => {
        throw new Error("synthetic read failure");
      })
    , /synthetic read failure/);

    const leaked = [...ingestTempDirs()].filter((n) => !before.has(n));
    assert.deepEqual(leaked, [], `cleanup must run on the throw path too; leaked: ${leaked.join(", ")}`);
  });
});

test("GOAL 106: BOTH temp helpers source-pin a try/finally that removes the temp dir", () => {
  const src = readFileSync(PROFILE_INGEST_SRC, "utf8");

  const copyBody = src.slice(src.indexOf("export function copyProfileForReading"));
  const copyEnd = copyBody.indexOf("\n}\n");
  assert.ok(copyEnd > 0, "could not locate copyProfileForReading's body");
  const copyFn = copyBody.slice(0, copyEnd);
  assert.match(copyFn, /try\s*{/, "copyProfileForReading must wrap its body in try");
  assert.match(copyFn, /finally\s*{/, "copyProfileForReading must have a finally");
  assert.match(copyFn, /rmSyncSafe\(\s*tmp\s*,\s*\{\s*recursive:\s*true/, "the finally must rm the temp dir it created");

  // readLocalStorageFor (u2a-ls-) — the sibling helper, pinned for the same
  // guarantee even though it already had it (a regression here must be loud).
  const lsBody = src.slice(src.indexOf("async function readLocalStorageFor"));
  const lsEnd = lsBody.indexOf("\n}\n");
  assert.ok(lsEnd > 0, "could not locate readLocalStorageFor's body");
  const lsFn = lsBody.slice(0, lsEnd);
  assert.match(lsFn, /finally\s*{/, "readLocalStorageFor must have a finally");
  assert.match(lsFn, /rmSyncSafe\(\s*tmp\s*\)/, "readLocalStorageFor's finally must rm its temp dir");

  // The write seam must not regress to a mode-less write.
  const store = readFileSync(SESSION_STORE_SRC, "utf8");
  assert.match(store, /const VAULT_FILE_MODE = 0o600/, "session-store must pin a 0600 file mode");
  assert.match(store, /const VAULT_DIR_MODE = 0o700/, "session-store must pin a 0700 dir mode");
  // No bare credential write may survive: every write goes through the helper.
  for (const m of store.matchAll(/writeFileSync\(([^;]*?)\);/g)) {
    const call = m[0];
    if (/VAULT_FILE_MODE/.test(call)) continue;
    assert.fail(`unrestricted writeFileSync survived in session-store.ts: ${call}`);
  }
});
