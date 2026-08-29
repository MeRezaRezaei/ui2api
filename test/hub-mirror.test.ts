import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pushToMirror } from "../src/hub/mirror.js";

describe("pushToMirror", () => {
  it("commits a package into a local mirror repo", () => {
    const base = mkdtempSync(join(tmpdir(), "u2a-mirror-test-"));
    const bare = join(base, "mirror.git");
    const work = join(base, "work");
    try {
      execFileSync("git", ["init", "--bare", "-b", "main", bare]);
      execFileSync("git", ["clone", bare, work]);
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: work });
      execFileSync("git", ["config", "user.name", "t"], { cwd: work });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: work });
      pushToMirror(
        { name: "shop.test", version: "1.0.0", manifest: { name: "shop.test", version: "1.0.0" }, module: "export default {}" },
        { repoUrl: bare, workDir: work }
      );
      const f = join(work, "shop.test", "1.0.0.json");
      assert.ok(existsSync(f), "package file written");
      const data = JSON.parse(readFileSync(f, "utf8"));
      assert.equal(data.manifest.name, "shop.test");
      const ls = execFileSync("git", ["ls-files"], { cwd: work }).toString();
      assert.ok(ls.includes("shop.test/1.0.0.json"), "file committed");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
