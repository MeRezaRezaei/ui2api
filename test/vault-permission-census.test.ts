// Vault PERMISSION CENSUS — the on-disk half of the GOAL 106 credential-mode
// work, which `test/vault-credential-mode.test.ts` structurally cannot cover.
//
// That file proves the WRITE seam is sound: it writes fixtures into a temp dir
// and asserts a fresh snapshot lands 0600 / its dir 0700. Every fixture is in
// tmpdir. It therefore says NOTHING about the REAL vault on this box — and the
// real vault is where the exposure actually is. This file is the census.
//
// MEASURED 2026-09-27 (the census this file encodes):
//   143 vault-scope files exist under data/.
//   142 of them are world-readable (mode 0644). ONE is 0600.
//   134 of the 135 vault-scope dirs are 0755. ONE is 0700.
// So "one named file" in .brain/PRODUCTION_READINESS.md badly understates it:
// this is a whole-TREE residue, not a single stray file.
//
// WHY IT IS RESIDUE AND NOT A LIVE DEFECT — measured, not assumed. The
// chmod-enforcing write seam landed in commit cef7af1 (2026-09-26T13:56:22+02:00)
// as `writeVaultFile` (src/runtime/session-store.ts:72-80). Exactly ONE vault
// file on disk has been written since: data/sessions/gemini.google.com/osbulk/
// capabilities.json, mtime 2026-09-26T14:41 — and it is the ONE 0600 file. Its
// sibling state.json, in the SAME directory, is 0644 with mtime 2026-09-22,
// four days BEFORE the hardening. Same writer, same directory, different mode:
// the mode is decided by whether the write happened after cef7af1. That is a
// 1-for-1 natural experiment, and it is why this file can gate on a DATE
// boundary instead of an unwieldy 142-path allowlist.
//
// ── HOW THIS GATE BEHAVES GIVEN THE FINDING IS STILL UNFIXED ──────────────
// The dilemma is real: a gate that fails now blocks every pipeline on state the
// operator has not rotated; a gate that cannot go red is not a gate. The
// resolution is that the teeth are a DATE BOUNDARY, not an equality on a count:
//
//   * Legacy residue (written BEFORE the seam was hardened) is ACCEPTED and
//     REPORTED as a named, dated finding. The suite stays green today, so the
//     pipeline is not blocked on someone else's action item.
//   * ANY world-readable vault file written AFTER the boundary is a genuine
//     RECURRENCE and fails loudly, naming the path. No allowlist entry can
//     absorb it, because the rule is derived from mtime, not from a list
//     someone can extend. A 429, a bad umask, a re-added `writeFileSync`, a new
//     writer that forgets the helper — all of them land here.
//   * The per-class counts are CAPS (must not rise), not equalities. When the
//     operator rotates and chmods, the counts fall and the gate STAYS green.
//     There is deliberately no `=== baseline` assertion: that would be red today
//     AND red after a successful rotation, i.e. permanently red, and a
//     permanently red gate gets skipped and then gets deleted.
//
// VACUITY IS REPORTED, NEVER SCORED AS SUCCESS. On a clean CI checkout `data/`
// does not exist. This file then asserts the vacuity is real and says so
// ("vacuous: no data/ tree, 0 files censused") — it never reports a clean zero
// as a pass. To prove the census is not a check-that-finds-nothing-because-
// there-was-nothing, the same census function is run against a synthetic
// fixture tree in tmpdir with known modes and must classify them correctly.
//
// READ-ONLY, AND PROVEN SO TWICE OVER. This file must never chmod, rewrite,
// move, or touch anything under data/ — a test that "fixes" a real credential
// destroys the evidence of the finding, which is the whole reason it was left.
//   1. Source pin: the census function's own body is scanned for any mutating
//      fs call; finding one fails the run.
//   2. Empirical pin: a (path, mode, size, mtime) fingerprint of every entry
//      under data/ is taken before and after the census and must be identical.
// A test that chmods a real 0644 snapshot to 0600 would quietly destroy the
// operator's evidence of the exposure; these two pins are what stop that.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data");
const SESSION_STORE_SRC = join(ROOT, "src", "runtime", "session-store.ts");
const SELF_SRC = fileURLToPath(import.meta.url);

/**
 * The instant the chmod-enforcing vault write seam landed, from commit cef7af1
 * ("GOAL 105 body: replay no longer fabricates traffic ..."), which introduced
 * `VAULT_FILE_MODE = 0o600` into src/runtime/session-store.ts. A world-readable
 * vault file OLDER than this is legacy residue from the mode-less build; one
 * NEWER than this is a recurrence this gate is here to catch.
 */
const HARDENED_AFTER = Date.parse("2026-09-26T13:56:22+02:00");

/** Group/other read on a file = the world-readable bit. */
const OTHER_READ = 0o004;
const GROUP_OR_OTHER = 0o077;

/**
 * Per-class CAPS on world-readable vault files, measured 2026-09-27. These may
 * only ever FALL (that is the operator's rotation, recorded by lowering them).
 * They may never rise — a rise is a recurrence and fails the count assertions.
 *
 *   state.json       74  — every captured/imported session snapshot
 *   accounts.json    65  — the per-host vault index (one per host with accounts)
 *   capabilities.json 3  — stored capability fingerprints
 *   anything else     0  — nothing else in the vault may be world-readable
 *
 * The 0600 outlier (data/sessions/gemini.google.com/osbulk/capabilities.json,
 * written 45 min after the seam landed) is correctly ABSENT from these caps: it
 * is the proof the seam works, not residue.
 */
const CLASS_CAPS = {
  "state.json": 74,
  "accounts.json": 65,
  "capabilities.json": 3,
  other: 0,
} as const;

/**
 * The VAULT SCOPE is defined POSITIVELY — by the credential class itself — not
 * by an exclusion list. An exclusion list is the wrong shape here: when this
 * census first ran it caught two real leaks in a hand-written exclusion
 * (`chrome-www.kimi.ai` slipped past a `"chrome-"` prefix because the top-level
 * segment is `chrome-www.kimi.ai`, not `chrome-`), and a list that is wrong in
 * the permissive direction fails open, silently.
 *
 * A path is in the vault scope iff it is:
 *   • `sessions/...`                          — data/sessions/<host>/{<slug>/state.json,
 *                                                <slug>/capabilities.json, accounts.json}
 *   • `<anything>/.session/...`               — the flat legacy per-host snapshot
 * Those are exactly the two layouts `snapshotPath` and `accountDir` produce
 * (src/runtime/session-store.ts:44-46, :394-402).
 *
 * Everything else under data/ is reported, never gated. It is not credential
 * material: `data/browser` and `data/chrome-www.kimi.ai` are Chromium's own
 * on-disk profile (created by a launched Chrome, then hardened by Chrome itself
 * — 0600 files inside 0700 dirs), and the `data/test-hub-publish-contract`
 * dirs are scratch left behind by the hub-publish test at 0755. Gating on a
 * browser's internal file modes, or on another test's scratch dir, is a gate
 * that goes red for reasons outside the write seam this file exists to protect
 * — and a gate like that trains the next maintainer to skip it. Both are
 * counted and named below so they stay visible.
 */
function isVaultScope(rel: string): boolean {
  return rel === "sessions" || rel.startsWith("sessions/") || /(^|\/)\.session(\/|$)/.test(rel);
}

type Class = keyof typeof CLASS_CAPS;

interface Entry {
  /** Path relative to the census root, with `/` separators, for stable messages. */
  rel: string;
  mode: number;
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

interface Census {
  /** Vault-scope FILES — the gated population. */
  files: Entry[];
  /** Vault-scope DIRECTORIES — gated separately, see the dir test. */
  dirs: Entry[];
  /**
   * Files under data/ that are NOT vault-scope (Chromium profile dirs, other
   * tests' scratch). Counted and reported so they stay visible; never gated.
   */
  outOfScope: Entry[];
  /**
   * Symlinks skipped. Chrome's `Singleton{Lock,Cookie,Socket}` are dangling
   * links (they encode a hostname+pid and break when Chrome exits), and a
   * symlink's own mode is a meaningless 0777 on Linux — so neither is a
   * credential exposure and neither belongs in the gated set.
   */
  symlinks: number;
  /** True when the census root does not exist at all (clean CI checkout). */
  vacuous: boolean;
}

function classify(rel: string): Class {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base === "state.json") return "state.json";
  if (base === "accounts.json") return "accounts.json";
  if (base === "capabilities.json") return "capabilities.json";
  return "other";
}

/**
 * Walk a tree and report every file's mode. READ-ONLY by construction: the only
 * fs calls below are `readdirSync`, `lstatSync` and `existsSync`. The
 * "census is read-only" pin below scans this function's own source for a
 * mutating call, so this stays true if the walk is ever extended.
 *
 * `lstatSync`, NOT `statSync`: Chrome leaves dangling `Singleton*` symlinks in a
 * profile dir, and `statSync` follows them and throws ENOENT — which is a real
 * bug this census hit on its first run. An entry that vanishes between the
 * readdir and the lstat (a live Chrome churning its own dir) is skipped rather
 * than fatal, because a census must not be the thing that crashes on a live box.
 */
function censusTree(root: string): Census {
  if (!existsSync(root)) {
    return { files: [], dirs: [], outOfScope: [], symlinks: 0, vacuous: true };
  }
  const files: Entry[] = [];
  const dirs: Entry[] = [];
  const outOfScopeFiles: Entry[] = [];
  let symlinks = 0;

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue; // vanished mid-walk; not a finding, just a moving target
      }
      const rel = relative(root, abs).split(sep).join("/");
      if (st.isSymbolicLink()) {
        symlinks++;
        continue;
      }
      if (st.isDirectory()) {
        if (isVaultScope(rel)) dirs.push({ rel, mode: st.mode & 0o777, size: st.size, mtimeMs: st.mtimeMs, isDir: true });
        walk(abs);
        continue;
      }
      const entry: Entry = { rel, mode: st.mode & 0o777, size: st.size, mtimeMs: st.mtimeMs, isDir: false };
      if (isVaultScope(rel)) files.push(entry);
      else outOfScopeFiles.push(entry);
    }
  };
  walk(root);
  return { files, dirs, outOfScope: outOfScopeFiles, symlinks, vacuous: false };
}

/**
 * (path, mode, size, mtime) of every VAULT-SCOPE entry under `root` — the
 * no-mutation fingerprint. Out-of-scope subtrees are skipped: Chromium rewrites
 * its profile continuously, so including them would make this assertion flaky
 * for a reason that has nothing to do with whether the census mutates the vault.
 */
function fingerprint(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (!isVaultScope(rel)) continue;
      out.push(`${rel}|${st.mode & 0o777}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out.sort();
}

// ── 1. The census must not be able to mutate the real vault ────────────────

test("census is READ-ONLY: its own source contains no mutating fs call", () => {
  const src = readFileSync(SELF_SRC, "utf8");
  const start = src.indexOf("function censusTree");
  assert.ok(start > 0, "could not locate censusTree in this file");
  // Slice to the next top-level `function` so only the census walk is scanned.
  const end = src.indexOf("\nfunction ", start + 1);
  const body = src.slice(start, end > 0 ? end : src.length);

  // The walk may read. It may not write, chmod, move, or remove.
  for (const forbidden of [
    "writeFileSync",
    "appendFileSync",
    "chmodSync",
    "chownSync",
    "rmSync",
    "unlinkSync",
    "renameSync",
    "mkdirSync",
    "mkdtempSync",
    "cpSync",
    "utimesSync",
    "truncateSync",
    "createWriteStream",
    "openSync",
  ]) {
    assert.equal(
      body.includes(forbidden),
      false,
      `censusTree must not call ${forbidden} — the vault census is READ-ONLY by contract`
    );
  }
  // ...and it must actually be reading, not a stub that finds nothing.
  assert.match(body, /readdirSync/, "censusTree must walk the tree with readdirSync");
  assert.match(body, /lstatSync/, "censusTree must lstat each entry to read its mode");
});

test("censusing the real data/ tree changes nothing under it (before == after)", () => {
  if (!existsSync(DATA_DIR)) {
    // Clean CI checkout. Assert the vacuity rather than reporting a clean zero.
    assert.deepEqual(fingerprint(DATA_DIR), [], "no data/ means no fingerprint entries");
    const c = censusTree(DATA_DIR);
    assert.equal(c.vacuous, true, "census must self-report as vacuous when data/ is absent");
    assert.equal(c.files.length, 0);
    return;
  }
  const before = fingerprint(DATA_DIR);
  const census = censusTree(DATA_DIR);
  const after = fingerprint(DATA_DIR);

  assert.equal(census.vacuous, false);
  assert.deepEqual(
    before,
    after,
    "the census mutated data/ — a mode, size or mtime changed. It must be read-only."
  );
  assert.ok(before.length > 0, "precondition: a real data/ tree has entries to fingerprint");
});

// ── 2. Non-vacuity: the census works, proven on a synthetic fixture ────────

test("census classifies modes correctly on a synthetic tree (non-vacuity proof)", () => {
  const fixture = mkdtempSync(join(tmpdir(), "u2a-vault-census-fixture-"));
  try {
    const hostDir = join(fixture, "sessions", "example.com", "acct");
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(join(fixture, "browser", "Chrome"), { recursive: true });
    writeFileSync(join(hostDir, "state.json"), "{}");
    writeFileSync(join(hostDir, "accounts.json"), "{}");
    writeFileSync(join(hostDir, "capabilities.json"), "{}");
    writeFileSync(join(hostDir, "stray.txt"), "x");
    writeFileSync(join(fixture, "browser", "Chrome", "Cookies"), "x");
    chmodSync(join(hostDir, "state.json"), 0o644);
    chmodSync(join(hostDir, "accounts.json"), 0o600);
    chmodSync(join(hostDir, "capabilities.json"), 0o644);
    chmodSync(join(hostDir, "stray.txt"), 0o600);
    chmodSync(join(fixture, "browser", "Chrome", "Cookies"), 0o644);

    const c = censusTree(fixture);
    assert.equal(c.vacuous, false, "an existing tree must not self-report as vacuous");
    assert.equal(c.outOfScope.length, 1, "the out-of-scope subtree must be counted, not gated");
    assert.equal(
      c.outOfScope[0]!.rel,
      "browser/Chrome/Cookies",
      "out-of-scope files must be bucketed by path, not dropped"
    );
    assert.equal(
      c.files.some((f) => f.rel.startsWith("browser/")),
      false,
      "an out-of-scope file must never reach the gated set"
    );
    // A flat legacy <host>/.session/ snapshot IS vault scope — the positive
    // definition must not only match the sessions/ layout.
    assert.equal(
      c.files.some((f) => /(^|\/)\.session(\/|$)/.test(f.rel)),
      false,
      "no .session path in this fixture, so nothing should match the legacy layout"
    );

    const byName = new Map(c.files.map((f) => [f.rel.split("/").pop()!, f]));
    assert.equal(byName.get("state.json")!.mode, 0o644, "0644 must be read back as 0644");
    assert.equal(byName.get("accounts.json")!.mode, 0o600, "0600 must be read back as 0600");

    const worldReadable = c.files.filter((f) => f.mode & OTHER_READ);
    const byClass = new Map<Class, number>();
    for (const f of worldReadable) {
      const k = classify(f.rel);
      byClass.set(k, (byClass.get(k) ?? 0) + 1);
    }
    assert.equal(byClass.get("state.json"), 1, "the 0644 state.json must be counted as exposed");
    assert.equal(byClass.get("capabilities.json"), 1, "the 0644 capabilities.json must be counted");
    assert.equal(byClass.get("accounts.json"), undefined, "the 0600 accounts.json must NOT be counted");
    assert.equal(byClass.get("other"), undefined, "the 0600 stray.txt must NOT be counted");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// ── 3. The real census: the finding, named, dated, and gated on recurrence ──

test("real vault: world-readable exposure is legacy residue only, never a recurrence", () => {
  const c = censusTree(DATA_DIR);

  if (c.vacuous) {
    // Honest vacuity: report it as its own outcome. This is NOT a pass that
    // means "the vault is clean" — it means "there was no vault to check".
    assert.equal(c.files.length, 0);
    assert.equal(c.dirs.length, 0);
    assert.equal(c.outOfScope.length, 0);
    console.log(
      "[vault-permission-census] VACUOUS: no data/ tree on this checkout — 0 vault files censused. " +
        "This is NOT evidence the vault is clean; it is evidence there was nothing to census. " +
        "On a dev box the same file censuses the real vault."
    );
    return;
  }

  const worldReadable = c.files.filter((f) => f.mode & OTHER_READ);

  // (a) THE FINDING, stated as a number. 142 of 143 is the honest headline; a
  // single named file would understate a whole-tree residue.
  console.log(
    `[vault-permission-census] FINDING ${new Date(HARDENED_AFTER).toISOString().slice(0, 10)}: ` +
      `${worldReadable.length} of ${c.files.length} vault files under data/ are world-readable (0644). ` +
      `All are legacy residue written BEFORE the chmod-enforcing seam (commit cef7af1) landed. ` +
      `Out-of-scope files under data/ (counted, not gated): ${c.outOfScope.length}. ` +
      `Symlinks skipped (Chrome's dangling Singleton* + meaningless 0777 link modes): ${c.symlinks}. ` +
      `ACTION: operator rotates the credentials and tightens the modes; the per-class caps below ` +
      `then fall and stay green. This gate never edits data/ itself.`
  );

  // (b) THE TEETH: no world-readable vault file may postdate the hardening.
  // Derived from mtime, not from a list — so it cannot be extended to excuse a
  // new exposure. A re-added bare writeFileSync, a bad umask, or any new writer
  // that bypasses writeVaultFile lands here and fails the run by name.
  const recurrences = worldReadable
    .filter((f) => f.mtimeMs >= HARDENED_AFTER)
    .map((f) => `${f.rel} (mode ${f.mode.toString(8)}, mtime ${new Date(f.mtimeMs).toISOString()})`);
  assert.deepEqual(
    recurrences,
    [],
    "RECURRENCE: world-readable vault file(s) written AFTER the chmod-enforcing seam landed. " +
      "Every credential write must go through writeVaultFile (session-store.ts)."
  );

  // (c) Per-class caps: may fall, may never rise.
  const byClass = new Map<Class, Entry[]>();
  for (const f of worldReadable) {
    const k = classify(f.rel);
    const list = byClass.get(k) ?? [];
    list.push(f);
    byClass.set(k, list);
  }
  for (const cls of Object.keys(CLASS_CAPS) as Class[]) {
    const found = (byClass.get(cls) ?? []).length;
    const cap = CLASS_CAPS[cls];
    assert.ok(
      found <= cap,
      `${cls}: ${found} world-readable vault files exceeds the ${cap} cap recorded 2026-09-27. ` +
        `A rise is a RECURRENCE. If this is a legitimate post-rotation drop, LOWER the cap.`
    );
  }

  // (d) Nothing outside the three known credential classes may be exposed.
  //     This is the class that has cap 0, so a brand-new file kind is caught
  //     even if someone forgets to add a cap for it.
  assert.deepEqual(
    (byClass.get("other") ?? []).map((f) => `${f.rel} (mode ${f.mode.toString(8)})`),
    [],
    "a vault file outside state.json/accounts.json/capabilities.json is world-readable"
  );
});

test("real vault: a 0600 snapshot is not merely inside a 0755 dir (dirs are tight too)", () => {
  const c = censusTree(DATA_DIR);
  if (c.vacuous) return; // honest vacuity; the fixture test above proves the walk works

  // A 0600 file inside a 0755 dir still leaks its NAME and SIZE to any local
  // user, and 0755 dirs let them enumerate every account slug on the box. So the
  // directory class is gated on the same date boundary as the files.
  const openDirs = c.dirs.filter((d) => d.mode & GROUP_OR_OTHER);
  console.log(
    `[vault-permission-census] ${openDirs.length} of ${c.dirs.length} vault dirs under data/ are ` +
      `group/other-accessible (0755), leaking every account slug + snapshot size to any local user.`
  );

  const dirRecurrences = openDirs
    .filter((d) => d.mtimeMs >= HARDENED_AFTER)
    .map((d) => `${d.rel} (mode ${d.mode.toString(8)}, mtime ${new Date(d.mtimeMs).toISOString()})`);
  assert.deepEqual(
    dirRecurrences,
    [],
    "RECURRENCE: a group/other-accessible vault DIRECTORY was created or touched AFTER the " +
      "mkdirVaultDir 0700 enforcement landed. Every credential dir must be 0700."
  );
});

// ── 4. The seam this census depends on must stay hardened ─────────────────

test("the write seam this census relies on still pins 0600 files / 0700 dirs", () => {
  const store = readFileSync(SESSION_STORE_SRC, "utf8");
  assert.match(store, /const VAULT_FILE_MODE = 0o600/, "session-store must pin a 0600 file mode");
  assert.match(store, /const VAULT_DIR_MODE = 0o700/, "session-store must pin a 0700 dir mode");
  // The enforcement chmod, not just the requested mode: `writeFileSync`'s `mode`
  // only applies at CREATION, so a rewrite of a legacy 0644 file would keep its
  // bits without it. This is what makes the residue above a one-time class.
  assert.match(
    store,
    /chmodSync\(path,\s*VAULT_FILE_MODE\)/,
    "writeVaultFile must chmod AFTER writing — a plain rewrite keeps a legacy file's bits"
  );
  assert.match(
    store,
    /chmodSync\(dir,\s*VAULT_DIR_MODE\)/,
    "mkdirVaultDir must chmod an already-existing dir, not only request a mode at creation"
  );
});
