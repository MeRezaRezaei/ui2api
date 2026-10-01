import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pushToMirror, namesPublicSanitizedDest } from "../src/hub/mirror.js";

describe("pushToMirror", () => {
  it("commits a package into a local mirror repo", () => {
    const base = mkdtempSync(join(tmpdir(), "u2a-mirror-test-"));
    const bare = join(base, "mirror.git");
    const work = join(base, "work");
    try {
      execFileSync("git", ["init", "--bare", "-b", "main", bare], { timeout: 120000 });
      execFileSync("git", ["clone", bare, work], { timeout: 120000 });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: work , timeout: 120000 });
      execFileSync("git", ["config", "user.name", "t"], { cwd: work , timeout: 120000 });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: work , timeout: 120000 });
      pushToMirror(
        { name: "shop.test", version: "1.0.0", manifest: { name: "shop.test", version: "1.0.0" }, module: "export default {}" },
        { repoUrl: bare, workDir: work }
      );
      const f = join(work, "shop.test", "1.0.0.json");
      assert.ok(existsSync(f), "package file written");
      const data = JSON.parse(readFileSync(f, "utf8"));
      assert.equal(data.manifest.name, "shop.test");
      const ls = execFileSync("git", ["ls-files"], { cwd: work , timeout: 120000 }).toString();
      assert.ok(ls.includes("shop.test/1.0.0.json"), "file committed");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/* ========================================================================
 * THE PUBLIC SANITIZED DESTINATION IS NOT A PACKAGE MIRROR.
 *
 * `public_mirror`'s public half is the ONLY writer of MeRezaRezaei/ui2api, and
 * it writes a full-history rewrite that has measured every forbidden class at
 * zero. This seam clones with --depth 1 and commits package JSON into whatever
 * URL it is handed, so pointing it at the public repo would be a SECOND, ungated
 * writer to a repository whose entire value is that it is a faithful mirror.
 *
 * The shape assertions matter more than the happy path: a gate that can be
 * walked around by changing the URL's SPELLING is not a gate.
 * ====================================================================== */
describe("the package-mirror seam refuses the public sanitized destination", () => {
  const hostile = [
    "https://github.com/MeRezaRezaei/ui2api.git",
    "https://github.com/MeRezaRezaei/ui2api",
    "https://github.com/MeRezaRezaei/ui2api/",
    "git@github.com:MeRezaRezaei/ui2api.git",
    "https://github.com/MeRezaRezaei/ui2api.git ",
    "HTTPS://GITHUB.COM/MeRezaRezaei/UI2API.git",
  ];

  it("recognises the destination through every URL SHAPE, including case", () => {
    for (const u of hostile) {
      assert.ok(
        namesPublicSanitizedDest(u),
        `missed the public destination in the spelling ${JSON.stringify(u)} — a gate that can be ` +
          `walked around by changing case or trailing slashes is not a gate`,
      );
    }
  });

  it("does NOT refuse a legitimate mirror target", () => {
    for (const u of [
      "https://github.com/MeRezaRezaei/ui2api-registry",
      "https://github.com/MeRezaRezaei/ui2api-full",
      "https://gitlab.pubg-sell.ir/MeRezaRezaei/ui2api.git",
    ]) {
      assert.equal(
        namesPublicSanitizedDest(u),
        false,
        `false positive: the registry mirror ${u} must stay writable`,
      );
    }
  });

  it("RED: pushToMirror REFUSES it, before any network or filesystem work", () => {
    assert.throws(
      () =>
        pushToMirror({ name: "x", version: "1.0.0", files: {} } as never, {
          repoUrl: "https://github.com/MeRezaRezaei/ui2api.git",
        }),
      /PUBLIC SANITIZED repository/,
    );
  });
});
