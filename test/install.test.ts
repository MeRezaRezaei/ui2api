import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPackage,
  fetchRegistryIndex,
  normalizeRegistryBase,
  DEFAULT_REGISTRY_URL,
  DEFAULT_REGISTRY_BRANCH,
} from "../src/registry/install.js";

// The fixture is a verbatim copy of the REAL public registry shape:
// test/fixtures/registry/ is copied from the ui2api-registry repo (master branch):
//   index.json  -> the 32-site catalog (duckduckgo@0.3.0 unreviewed)
//   packages/<site>/ -> metadata.json + manifest.json + profile.json +
//                       session.lock.json + CAPABILITIES.md + recipes/<cap>.json
// (the repo has NO action-map.json — this is the modern package shape).
const FIXTURE = resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "registry");

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".md": "text/markdown",
  ".lock": "application/json",
};

// Serve the on-disk fixture tree over HTTP, exactly as the registry raw server
// exposes it (404 for anything not physically present — e.g. /main/ variants).
function serveFixture(): Promise<Server> {
  return new Promise((r) => {
    const srv = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const file = join(FIXTURE, path);
      if (!file.startsWith(FIXTURE) || !existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    srv.listen(0, "127.0.0.1", () => r(srv));
  });
}

describe("ui2api install (community registry, master branch + modern package shape)", () => {
  it("defaults the registry to the master branch raw base", () => {
    assert.match(DEFAULT_REGISTRY_URL, new RegExp(`/${DEFAULT_REGISTRY_BRANCH}$`), "DEFAULT_REGISTRY_URL must point at the master branch, not main");
    assert.match(DEFAULT_REGISTRY_URL, /^https:\/\/raw\.githubusercontent\.com\/MeRezaRezaei\/ui2api-registry\//);
    assert.equal(normalizeRegistryBase("https://github.com/MeRezaRezaei/ui2api-registry"), `${DEFAULT_REGISTRY_URL}`);
    assert.equal(normalizeRegistryBase("https://raw.githubusercontent.com/acme/reg/main/"), "https://raw.githubusercontent.com/acme/reg/main");
  });

  it("consumes the REAL registry shape onto disk (index.json catalog -> modern package files, no action-map)", async () => {
    const srv = await serveFixture();
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-"));
    try {
      const result = await installPackage("duckduckgo", base, tmp);
      assert.equal(result.siteId, "duckduckgo");
      assert.equal(result.version, "0.3.0");
      assert.equal(result.trust, "unreviewed");
      assert.equal(result.dir, join(tmp, "duckduckgo"));
      // Every modern package file + every manifest-referenced recipe lands.
      for (const f of ["metadata.json", "manifest.json", "profile.json", "session.lock.json", "CAPABILITIES.md"]) {
        assert.ok(existsSync(join(tmp, "duckduckgo", f)), `missing ${f}`);
      }
      const manifest = JSON.parse(readFileSync(join(tmp, "duckduckgo", "manifest.json"), "utf8"));
      for (const cap of manifest.capabilities as Array<{ recipe?: string }>) {
        assert.ok(cap, "capability entry expected");
        if (cap.recipe) assert.ok(existsSync(join(tmp, "duckduckgo", cap.recipe)), `missing recipe ${cap.recipe}`);
      }
      // The registry package carries a site override the repo copy lacks — verbatim.
      assert.equal(manifest.site, "duck.ai");
      // The old installer's dead artifact must never reappear.
      assert.ok(!existsSync(join(tmp, "duckduckgo", "action-map.json")), "action-map.json must not be fetched or written");
      assert.ok(!existsSync(join(tmp, "duckduckgo", "index.ts")), "generate() must not run: the daemon serves the package");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      srv.close();
    }
  });

  it("rejects a wrong-branch registry URL with the master correction hint (the /main 404)", async () => {
    const srv = await serveFixture();
    const base = `http://127.0.0.1:${(srv.address() as any).port}/main`;
    try {
      await installPackage("duckduckgo", base, mkdtempSync(join(tmpdir(), "u2a-inst-")))
        .then(() => assert.fail("expected install to throw on a /main index.json 404"))
        .catch((e: Error) => {
          assert.match(e.message, /index\.json not readable/);
          assert.match(e.message, /default branch is "master"/);
        });
    } finally {
      srv.close();
    }
  });

  it("lists the catalog for an unknown site and refuses mismatched packages", async () => {
    const srv = await serveFixture();
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const index = await fetchRegistryIndex(base);
      assert.ok(index["duckduckgo"], "catalog must carry duckduckgo");
      assert.equal(index["duckduckgo"].version, "0.3.0");
      assert.equal(index["duckduckgo"].trust, "unreviewed");
      const err = await installPackage("definitely-not-a-site", base, mkdtempSync(join(tmpdir(), "u2a-inst-")))
        .then(() => assert.fail("expected a missing-site error"))
        .catch((e: Error) => e);
      assert.match(err.message, /no package "definitely-not-a-site"/);
      assert.match(err.message, /duckduckgo@0\.3\.0/);
    } finally {
      srv.close();
    }
  });

  it("installs from the LIVE public registry when UI2API_REGISTRY_LIVE=1", { skip: process.env.UI2API_REGISTRY_LIVE !== "1" }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-live-"));
    try {
      const index = await fetchRegistryIndex(DEFAULT_REGISTRY_URL);
      assert.ok(Object.keys(index).length >= 30, "live catalog should carry the full site list");
      const result = await installPackage("duckduckgo", DEFAULT_REGISTRY_URL, tmp);
      assert.equal(result.version, "0.3.0");
      assert.ok(existsSync(join(result.dir, "metadata.json")));
      assert.ok(existsSync(join(result.dir, "recipes", "duckduckgo_web_search.json")));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});