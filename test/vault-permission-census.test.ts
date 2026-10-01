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
  /**
   * Directories the walk could NOT enter (EACCES), relative paths.
   *
   * ROUND N+102 — MEASURED on the dev box: the vault is owned by the `ui2api`
   * service user while the suite runs as the operator (`me`), and `data/` holds
   * 45 subtrees the runner legitimately cannot `scandir` — 9 of them VAULT-SCOPE
   * (`sessions/{chat.deepseek,chatgpt,deepseek,gemini.google,mail.google,
   * www.aparat,www.kimi,youtube}.com`, `www.kimi.ai/.session/chrome-login-profile`).
   * An unreadable subtree is the hardening WORKING: a 0700 dir owned by another
   * user denies exactly the other local users it exists to deny. It is recorded
   * here and reported, never silently dropped — a census that skipped them
   * quietly would under-approximate its own population.
   */
  unreadable: string[];
  /** True when there is nothing to examine — no data/ at all (clean CI checkout),
   * or present-but-empty. Either way the census reports it rather than scoring
   * an empty result as a pass. */
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
    return { files: [], dirs: [], outOfScope: [], symlinks: 0, unreadable: [], vacuous: true };
  }
  const files: Entry[] = [];
  const dirs: Entry[] = [];
  const outOfScopeFiles: Entry[] = [];
  const unreadable: string[] = [];
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
        // A subtree this process cannot enter is a SENSOR reading, not a crash:
        // the vault is owned by the `ui2api` service user, so a 0700 host dir
        // correctly denies the operator account running the suite. Recorded and
        // reported; never silently skipped, so the census's own coverage is
        // always visible in its output.
        try {
          walk(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EACCES") unreadable.push(rel);
          else throw err;
        }
        continue;
      }
      const entry: Entry = { rel, mode: st.mode & 0o777, size: st.size, mtimeMs: st.mtimeMs, isDir: false };
      if (isVaultScope(rel)) files.push(entry);
      else outOfScopeFiles.push(entry);
    }
  };
  // Same root-level tolerance as fingerprint(), for the same reason, and the
  // same reason it was needed there: the repair that made this census tolerate
  // EACCES guarded the RECURSIVE call and left this one bare. Before
  // `vault tighten --apply` the root was 0755 and readable, so the omission was
  // invisible — the vault was only ever locked at the SUBTREE level. Tightening
  // the root to 0700 (which is the point of the command) turned a latent gap
  // into the normal case, and the census died on the very hardening it exists to
  // confirm. Recorded as unreadable, not swallowed, so the under-approximation
  // is reported rather than silently becoming "clean".
  try {
    walk(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") unreadable.push(".");
    else throw err;
  }
  // ROUND N+99 — vacuous means "nothing to examine", not merely "the directory is
  // absent". MEASURED on GitLab pipeline 297: `data/` was ABSENT from the doc's
  // claim but PRESENT-AND-EMPTY on the checkout, so `existsSync` was true,
  // `vacuous` came back false, and this gate failed its own precondition
  // ("a real data/ tree has entries to fingerprint") with 1496 of 1502 tests
  // green. An environmental precondition is not a property of the census, and a
  // gate that is red on a clean checkout is a gate that gets skipped. The
  // honest question is whether there is any FILE to look at: an empty `data/`
  // still yields one directory entry (the root itself), so keying vacuity on dirs
  // left the empty case non-vacuous and red on CI. Files are what the census is
  // actually about — a tree of empty directories has nothing to expose.
  return {
    files,
    dirs,
    outOfScope: outOfScopeFiles,
    symlinks,
    unreadable,
    vacuous: files.length === 0,
  };
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
      // Same EACCES tolerance as censusTree, for the same reason: an entry we
      // cannot enter cannot be mutated by us either, so its absence from both
      // the before and the after fingerprint is symmetric and proves nothing
      // about mutation.
      if (st.isDirectory()) {
        try {
          walk(abs);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EACCES") throw err;
        }
      }
    }
  };
  // The ROOT readdir needs the same tolerance as the recursive one, and its
  // absence is what made this function look fixed when it was not. The earlier
  // repair guarded `walk(abs)` for subtrees but left `readdirSync(dir)` bare, so
  // the census tolerated being locked out of a SUBTREE and then died on being
  // locked out of data/ itself — which is exactly the state the hardening is
  // supposed to produce, and which is now the normal state on this box after
  // `vault tighten --apply` took 398 entries to owner-only. An unreadable root
  // is symmetric too: we cannot mutate what we cannot enter, so before == after
  // still holds and still proves nothing false. censusTree reports the count so
  // the reduced coverage is visible rather than silent.
  try {
    walk(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EACCES") throw err;
  }
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

  // ROUND N+99 — this branch used to require `vacuous === false` and a non-empty
  // fingerprint, i.e. it demanded that a real vault EXIST. Measured on GitLab
  // pipeline 297: a clean CI checkout has an EMPTY `data/`, so the branch was
  // entered, the fingerprint had nothing in it, and the gate failed its own
  // precondition with 1496 of 1502 tests green. An environmental precondition is
  // not a property of the census, and a gate that is red on a clean checkout is
  // a gate that gets skipped.
  //
  // The property worth holding is the one that could actually go wrong: a tree
  // that HAS files must never self-report as vacuous. That is the check-that-
  // finds-nothing-because-it-understood-nothing failure, and it is the opposite
  // direction from the one that was red.
  if (census.vacuous) {
    assert.equal(census.files.length, 0, "vacuous means no files to examine — never a silent skip");
    assert.deepEqual(before, after, "and with nothing to look at, nothing may be touched");
    return;
  }
  assert.ok(census.files.length > 0, "non-vacuous means there ARE files — never report success on nothing");
  assert.deepEqual(
    before,
    after,
    "the census mutated data/ — a mode, size or mtime changed. It must be read-only."
  );
  assert.ok(before.length > 0, "a non-vacuous tree must have entries to fingerprint");
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
      `Subtrees unreadable by THIS user (EACCES — owned by another user, so 0700 hardening is working): ` +
      `${c.unreadable.length}, of which vault-scope: ${c.unreadable.filter(isVaultScope).length}. ` +
      `Those files are NOT in the counts above; the census under-approximates by that much when run ` +
      `as a non-owner. Run as the vault owner for a complete census. ` +
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
  // user, and 0755 dirs let them enumerate every account slug on the box.
  const openDirs = c.dirs.filter((d) => d.mode & GROUP_OR_OTHER);
  console.log(
    `[vault-permission-census] ${openDirs.length} of ${c.dirs.length} vault dirs under data/ are ` +
      `group/other-accessible (0755), leaking every account slug + snapshot size to any local user.`
  );

  // ROUND N+99 — this used to assert that no 0755 dir had an mtime after the
  // hardening, and it was a PERMANENT false positive. MEASURED: the gate failed
  // with `+ [ 'sessions (mode 755, mtime 2026-09-27T17:33:09.566Z)' ]` on a tree
  // where every credential dir was already 0700. The truth, from `stat`:
  //
  //   data/sessions                    mode=755  mtime 2026-09-27 19:33   <- container
  //   data/sessions/gemini.google.com  mode=700  mtime 2026-09-22         <- sealed
  //   data/sessions/youtube.com        mode=700  mtime 2026-09-16         <- sealed
  //
  // The container's mtime moved because a legitimate capture created a directory
  // INSIDE it. **A parent directory's mtime is bumped by every correct write
  // beneath it, forever, so it carries no information about the mode** — using
  // it as a "was this created by the new build" signal is a tripwire, not a
  // gate, and it would fire on every run where any capture happens. `btime` is
  // no escape either: all three above report the same 13:07:05 despite mtimes
  // spanning eleven days.
  //
  // So the mode IS the evidence for a directory. A 0700 dir is positive proof
  // the seam sealed it, and the real question — "does the seam still create 0700
  // dirs TODAY?" — is answered behaviourally by the mkdirVaultDir pin in section
  // 4 below, which needs no `data/` at all and goes red the moment the `mode:`
  // or the chmod is dropped. What remains here is the SENSOR: the leftover state,
  // reported by name and count, never a hard red.
  const sealed = c.dirs.filter((d) => !(d.mode & GROUP_OR_OTHER)).length;
  console.log(
    `[vault-permission-census] ${sealed} of ${c.dirs.length} vault dirs are 0700 (sealed by the ` +
      `mkdirVaultDir seam). The remainder are LEGACY containers from before the hardening; the ` +
      `seam itself is pinned behaviourally, not by timestamps.`
  );
  assert.ok(
    c.dirs.some((d) => !(d.mode & GROUP_OR_OTHER)) || openDirs.length === 0,
    "sanity: the dir set must classify into sealed or open, never neither"
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
