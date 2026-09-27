import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pushToMirror, pickLatestVersion, MIRROR_LATEST_FILE } from "../src/hub/mirror.js";

/**
 * The mirror's `latest` sentinel, and the path gate on the mirror write seam.
 *
 * The sentinel: `src/hub/api.ts:84` asks the uplink for
 * `${registryUrl}/${name}/${version ?? "latest"}.json`, so a versionless
 * `GET /api/packages/<name>` can only be served from the mirror if
 * `<name>/latest.json` exists. The mirror only ever wrote `<name>/<version>.json`,
 * so the fetch 404'd and `uplink` collapsed that into the same
 * `404 {"error":"not found"}` a package in NEITHER the store nor the mirror
 * answers with — two different causes, one indistinguishable refusal. The writer
 * (the half the mirror owns) is what these pins hold in place; api.ts:84 is
 * unchanged and correct either way.
 *
 * The gate: the mirror is the third seam that turns a package identifier into a
 * filesystem path. `store.ts` was gated in GOAL 121, `install.ts` in GOAL 113,
 * and the mirror was left bare — a real `name: "../../ESCAPED"` wrote its JSON
 * outside the mirror work tree and the only complaint was `git commit` reporting
 * "nothing to commit". Same shared rule (`src/registry/safe-segment.ts`), third
 * call site.
 */

/**
 * A real bare repo + clone, so pushToMirror's real git path is exercised.
 *
 * The work tree is nested one level deeper (`<base>/holder/work`) on purpose: a
 * `name: "../../ESCAPED"` then resolves to `<base>/ESCAPED`, which is INSIDE the
 * temp dir this test owns. Asserting on the two-levels-up escape directly would
 * mean asserting on a shared global path (`/tmp/ESCAPED`), where any unrelated
 * process — a sibling agent's probe, a leftover fixture — turns this gate red for
 * a reason that has nothing to do with the code under test.
 */
function makeMirror(): { base: string; bare: string; work: string } {
  const base = mkdtempSync(join(tmpdir(), "u2a-mirror-latest-"));
  const bare = join(base, "mirror.git");
  const holder = join(base, "holder");
  const work = join(holder, "work");
  mkdirSync(holder, { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { timeout: 60000 });
  execFileSync("git", ["clone", bare, work], { timeout: 60000 });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: work, timeout: 60000 });
  execFileSync("git", ["config", "user.name", "t"], { cwd: work, timeout: 60000 });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: work, timeout: 60000 });
  return { base, bare, work };
}

const pkg = (version: string) => ({
  name: "shop.test",
  version,
  manifest: { name: "shop.test", version, author: "t" },
  module: `export const v = "${version}";`,
});

describe("pickLatestVersion (derived, never a caller-supplied string)", () => {
  test("the highest semver wins on each numeric component, not string order", () => {
    // String order would pick "1.9.0" over "1.10.0" — the exact reason a
    // hand-written sentinel drifts.
    assert.equal(pickLatestVersion(["1.9.0", "1.10.0"]), "1.10.0");
    assert.equal(pickLatestVersion(["1.0.0", "2.0.0", "1.10.1"]), "2.0.0");
    assert.equal(pickLatestVersion(["0.9.9", "0.10.0"]), "0.10.0");
  });

  test("any parseable semver outranks every unparseable name", () => {
    assert.equal(pickLatestVersion(["nightly", "1.0.0", "whatever"]), "1.0.0");
    // With nothing parseable the fallback is a plain codepoint max — deterministic
    // (the mirror must not pick arbitrarily between two equally-unranked names),
    // but explicitly NOT a version judgement.
    assert.equal(pickLatestVersion(["alpha", "beta"]), "beta");
    assert.equal(pickLatestVersion(["zzz", "nightly"]), "zzz", "codepoint max, measured, not assumed");
  });

  test("no versions at all -> null, and the writer then writes no sentinel", () => {
    assert.equal(pickLatestVersion([]), null);
  });
});

describe("pushToMirror — the latest sentinel", () => {
  test("a single push writes latest.json as a byte-copy of the published version file", () => {
    const { base, bare, work } = makeMirror();
    try {
      pushToMirror(pkg("1.0.0"), { repoUrl: bare, workDir: work });
      const dir = join(work, "shop.test");
      const published = readFileSync(join(dir, "1.0.0.json"), "utf8");
      assert.ok(existsSync(join(dir, MIRROR_LATEST_FILE)), "latest.json must exist for the uplink to find");
      assert.equal(
        readFileSync(join(dir, MIRROR_LATEST_FILE), "utf8"),
        published,
        "the sentinel must be a byte-copy of a REAL published file, read back off disk"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("pushing a newer version REPOINTS the sentinel at the new highest", () => {
    const { base, bare, work } = makeMirror();
    try {
      pushToMirror(pkg("1.0.0"), { repoUrl: bare, workDir: work });
      pushToMirror(pkg("1.10.0"), { repoUrl: bare, workDir: work });
      const dir = join(work, "shop.test");
      assert.equal(
        readFileSync(join(dir, MIRROR_LATEST_FILE), "utf8"),
        readFileSync(join(dir, "1.10.0.json"), "utf8"),
        "latest must follow 1.10.0, not 1.9-style string order"
      );
      assert.notEqual(
        readFileSync(join(dir, MIRROR_LATEST_FILE), "utf8"),
        readFileSync(join(dir, "1.0.0.json"), "utf8"),
        "the sentinel must not still be the old version"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("pushing an OLDER version does not drag the sentinel backwards", () => {
    const { base, bare, work } = makeMirror();
    try {
      pushToMirror(pkg("2.0.0"), { repoUrl: bare, workDir: work });
      pushToMirror(pkg("1.0.0"), { repoUrl: bare, workDir: work });
      const dir = join(work, "shop.test");
      assert.equal(
        readFileSync(join(dir, MIRROR_LATEST_FILE), "utf8"),
        readFileSync(join(dir, "2.0.0.json"), "utf8"),
        "the sentinel is derived from every version on disk, so a back-port cannot repoint it"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the sentinel payload satisfies the uplink's consumer contract (api.ts:105-106)", () => {
    // `uplink` does `data.manifest.version` and `data.module`. A POINTER file
    // would throw a TypeError there, be swallowed by `catch { return null }`, and
    // reproduce the very 404 this writer exists to remove — so the shape is pinned.
    const { base, bare, work } = makeMirror();
    try {
      pushToMirror(pkg("1.0.0"), { repoUrl: bare, workDir: work });
      const data = JSON.parse(readFileSync(join(work, "shop.test", MIRROR_LATEST_FILE), "utf8"));
      assert.equal(typeof data.manifest, "object", "uplink reads data.manifest.version");
      assert.equal(data.manifest.version, "1.0.0", "the version the mirror actually holds");
      assert.equal(data.module, 'export const v = "1.0.0";', "uplink reads data.module");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the sentinel is committed with the version, so a fresh clone gets it", () => {
    const { base, bare, work } = makeMirror();
    try {
      pushToMirror(pkg("1.0.0"), { repoUrl: bare, workDir: work });
      const ls = execFileSync("git", ["ls-files"], { cwd: work, timeout: 60000 }).toString();
      assert.ok(ls.includes("shop.test/latest.json"), "an uncommitted sentinel is invisible to every consumer");
      assert.deepEqual(
        readdirSync(join(work, "shop.test")).sort(),
        ["1.0.0.json", "latest.json"],
        "the sentinel must not be mistaken for a publishable version on the next push"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("pushToMirror — the package-target segment gate", () => {
  test("a traversal name is refused BY NAME and writes nothing outside the mirror", () => {
    const { base, bare, work } = makeMirror();
    try {
      assert.throws(
        () => pushToMirror({ ...pkg("1.0.0"), name: "../../ESCAPED" }, { repoUrl: bare, workDir: work }),
        /invalid package name: "\.\.\/\.\.\/ESCAPED".*single path segment/,
        "the refusal must name the field and the reason, before any filesystem work"
      );
      // Nothing landed: `../../ESCAPED` from `<base>/holder/work` resolves to
      // `<base>/ESCAPED`, inside the temp dir this test owns and created empty.
      assert.ok(!existsSync(join(base, "ESCAPED")), "must not write outside the mirror work tree (the proven escape)");
      assert.deepEqual(
        execFileSync("git", ["ls-files"], { cwd: work, timeout: 60000 }).toString().trim(),
        "",
        "the refused push must commit nothing at all"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a traversal VERSION is refused too — it is interpolated into the file name", () => {
    const { base, bare, work } = makeMirror();
    try {
      assert.throws(
        () => pushToMirror({ ...pkg("1.0.0"), version: "../../ESCAPED.json" }, { repoUrl: bare, workDir: work }),
        /invalid package version/,
        "version reaches the same path seam and gets the same gate"
      );
      assert.ok(!existsSync(join(base, "ESCAPED.json")), "a traversal version must write nothing either");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a real site id and a real semver still pass (the gate is a superset, not a narrowing)", () => {
    // Measured against the real corpus: the 34 capabilities/* site ids and their
    // ui2api-site-<host> package names all pass. If this ever fails, the
    // allowlist has narrowed below what this repo produces.
    for (const name of ["deepseek", "ui2api-site-chat.deepseek.com", "shop.test", "a_b-c.1"]) {
      const { base, bare, work } = makeMirror();
      try {
        pushToMirror({ ...pkg("1.0.0"), name }, { repoUrl: bare, workDir: work });
        assert.ok(existsSync(join(work, name, "1.0.0.json")), `${name} must remain installable/mirrorable`);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });
});
