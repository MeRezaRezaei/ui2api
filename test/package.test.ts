import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage, readPackage, packageCommandRefusal } from "../src/registry/package.js";
import { findPackageDir } from "../src/prompt/registry.js";
import type { ActionMap } from "../src/types.js";

/** A REAL action-map fixture — the strongest honest case: even a valid map with
 * a live action yields nothing servable from buildPackage. */
function realMap(host: string): ActionMap {
  return {
    host,
    url: `https://${host}/`,
    capturedAt: new Date().toISOString(),
    auth: { required: false },
    actions: [
      {
        name: "do_something",
        description: "A real captured action",
        execution: "live-js",
        parameters: [{ name: "q", type: "string", required: true }],
        recipe: { kind: "js-function", target: `window.${host}.run`, argsFrom: { q: "q" } },
        result: { mode: "return" },
        verified: true,
      },
    ],
  };
}

describe("buildPackage", () => {
  it("bundles a site action-map into packages/<host>/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-pkg-"));
    try {
      const sites = join(tmp, "sites");
      const host = "example.test";
      mkdirSync(join(sites, host), { recursive: true });
      const map: ActionMap = {
        host, url: "https://example.test/", capturedAt: new Date().toISOString(),
        auth: { required: false }, actions: [],
      };
      writeFileSync(join(sites, host, "action-map.json"), JSON.stringify(map));
      const dir = buildPackage(host, sites, tmp, { author: "alice", use: "My own account" });
      assert.ok(existsSync(join(dir, "metadata.json")));
      assert.ok(existsSync(join(dir, "action-map.json")));
      const { metadata, map: m2 } = readPackage(dir);
      assert.equal(metadata.host, host);
      assert.equal(metadata.authorizedUse, "My own account");
      assert.equal(metadata.trust, "unreviewed");
      assert.equal(m2.host, host);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("packageCommandRefusal (GOAL 66 write-truth)", () => {
  it("names the dead pair, the unread output dir, and the modern path — the full verdict", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-pkg66-"));
    try {
      const sites = join(tmp, "sites");
      const host = "example.test";
      const msg = packageCommandRefusal(host, sites);
      assert.match(msg, /DEAD metadata\.json \+ action-map\.json pair/);
      assert.match(msg, /no modern consumer reads/);
      // The unread output dir is named concretely:
      assert.match(msg, /packages\/example\.test/);
      // The modern hand-package path is named concretely:
      assert.match(msg, /capabilities\/<id>\//);
      assert.match(msg, /Refusing to write a dead artifact\./);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("buildPackage still writes the legacy pair unchanged — a REAL action-map round-trips for hub publish (regression)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-pkg66-"));
    try {
      const sites = join(tmp, "sites");
      const host = "example.test";
      mkdirSync(join(sites, host), { recursive: true });
      writeFileSync(join(sites, host, "action-map.json"), JSON.stringify(realMap(host)));
      const dir = buildPackage(host, sites, tmp, { author: "alice", use: "hub publish" });
      assert.ok(existsSync(join(dir, "metadata.json")));
      assert.ok(existsSync(join(dir, "action-map.json")));
      const { map: m2 } = readPackage(dir);
      assert.equal(m2.actions.length, 1);
      assert.equal(m2.actions[0].name, "do_something");
      assert.equal(m2.actions[0].recipe.target, `window.${host}.run`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("the packaged output is NOT servable — no manifest.json and findPackageDir never resolves it, even rebuilt from a real map", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-pkg66-"));
    try {
      const sites = join(tmp, "sites");
      const host = "example.test";
      mkdirSync(join(sites, host), { recursive: true });
      writeFileSync(join(sites, host, "action-map.json"), JSON.stringify(realMap(host)));
      const dir = buildPackage(host, sites, tmp, { author: "alice", use: "own use" });
      // The file every modern consumer (findPackageDir / listInstalledPackageIds /
      // buildRegistryPackages / resolvePackagedProfile) keys on is absent:
      assert.equal(existsSync(join(dir, "manifest.json")), false);
      // The pair carries no capability surface — metadata + action-map only:
      const { metadata } = readPackage(dir);
      assert.equal(Object.hasOwn(metadata, "capabilities"), false);
      // findPackageDir (the /registry + chat-surface resolver) never resolves
      // the legacy tree — a unique id stays null (no fabricated servability):
      const uid = `pkg66-${host}-${Date.now()}`;
      assert.equal(findPackageDir(uid), null);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
