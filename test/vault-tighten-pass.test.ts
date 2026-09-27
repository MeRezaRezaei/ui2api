// The chmod-only vault tighten pass. The load-bearing assertion here is the
// CONTENT HASH: a pass that re-wrote a session file would corrupt a credential
// while still looking like a successful "fix", so every tree is hashed before
// and after and required to be byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { tightenVaultModes } from "../src/runtime/session-store.js";

function treeHash(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (lstatSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

function assertSameContent(before: Map<string, string>, after: Map<string, string>): void {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "the pass added or removed a file");
  for (const [p, hash] of before) assert.equal(after.get(p), hash, `content of ${p} changed`);
}

/** A vault-shaped tree with deliberately loose legacy modes. */
function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "ui2api-tighten-"));
  mkdirSync(join(root, "gemini.com", "me@example.com"), { recursive: true, mode: 0o755 });
  writeFileSync(join(root, "gemini.com", "state.json"), '{"cookies":[{"name":"a","value":"secret"}]}', { mode: 0o644 });
  writeFileSync(join(root, "gemini.com", "accounts.json"), '{"accounts":[]}', { mode: 0o666 });
  // umask can mask a requested mode, so the legacy modes are set explicitly.
  chmodSync(join(root, "gemini.com", "accounts.json"), 0o666);
  writeFileSync(join(root, "gemini.com", "me@example.com", "state.json"), '{"cookies":[]}', { mode: 0o640 });
  return root;
}

test("tightenVaultModes only removes bits and leaves content byte-identical", () => {
  const root = makeVault();
  try {
    const before = treeHash(root);
    const r = tightenVaultModes(root);
    assertSameContent(before, treeHash(root));
    assert.ok(r.changes.length > 0, "nothing was tightened — vacuous");
    for (const c of r.changes) {
      assert.equal(c.newMode, c.oldMode & (c.kind === "dir" ? 0o700 : 0o600), `${c.path} wrong new mode`);
      assert.equal((c.oldMode & c.newMode), c.newMode, `${c.path} was LOOSENED, not tightened`);
    }
    assert.equal(statSync(join(root, "gemini.com", "state.json")).mode & 0o7777, 0o600);
    assert.equal(statSync(root).mode & 0o7777, 0o700);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tightenVaultModes leaves anything already tighter untouched and reports it", () => {
  const root = mkdtempSync(join(tmpdir(), "ui2api-tighten-"));
  try {
    const p = join(root, "locked.json");
    writeFileSync(p, "{}", { mode: 0o400 }); // tighter than 0600 (no write bit)
    const r = tightenVaultModes(root);
    assert.equal(statSync(p).mode & 0o7777, 0o400, "a tighter file was modified");
    assert.equal(r.unchanged, 2, "root dir + tighter file should be counted as already-tight");
    assert.equal(r.changes.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tightenVaultModes is idempotent", () => {
  const root = makeVault();
  try {
    const first = tightenVaultModes(root);
    const h1 = treeHash(root);
    const second = tightenVaultModes(root);
    assertSameContent(h1, treeHash(root));
    assert.equal(second.changes.length, 0, "second pass changed something");
    assert.equal(second.unchanged, first.changes.length + first.unchanged);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tightenVaultModes never follows a symlink out of the vault", () => {
  const root = makeVault();
  const outside = mkdtempSync(join(tmpdir(), "ui2api-outside-"));
  const victim = join(outside, "victim.json");
  writeFileSync(victim, "do-not-touch", { mode: 0o644 });
  try {
    symlinkSync(victim, join(root, "link-to-victim.json"));
    // Chrome's dangling Singleton* links: a symlink whose target does not exist.
    symlinkSync(join(root, "nope-gone"), join(root, "SingletonLock"));
    const r = tightenVaultModes(root);
    assert.equal(statSync(victim).mode & 0o7777, 0o644, "chmod followed a symlink outside the vault");
    assert.ok(r.skippedSymlinks.length >= 2, `expected 2 skipped symlinks, got ${r.skippedSymlinks.length}`);
    assert.equal(r.errors.filter(e => e.error.includes("ENOENT")).length, 0, "a dangling link was treated as an error");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the content-hash assertion is NOT vacuous: a rewriting pass fails it", () => {
  const root = makeVault();
  try {
    const before = treeHash(root);
    // Simulate the destructive re-capture that overwrote captured sessions:
    // same shape as the real pass, but it rewrites the file it "fixes".
    writeFileSync(join(root, "gemini.com", "state.json"), "{}\n");
    assert.throws(() => assertSameContent(before, treeHash(root)), /content of .*changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tightenVaultModes reports every change with path and both modes", () => {
  const root = makeVault();
  try {
    const r = tightenVaultModes(root);
    const loose = r.changes.find(c => c.path.endsWith("accounts.json"));
    assert.ok(loose, "accounts.json (0666) was not reported");
    assert.equal(loose!.oldMode, 0o666);
    assert.equal(loose!.newMode, 0o600);
    assert.equal(loose!.kind, "file");
    assert.ok(r.changes.every(c => c.path.startsWith(root)), "a report row carries a foreign path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
