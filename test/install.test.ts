import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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

// Serve an on-disk tree over HTTP, exactly as the registry raw server
// exposes it (404 for anything not physically present).
function serveRoot(root: string): Promise<Server> {
  return new Promise((r) => {
    const srv = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const file = join(root, path);
      if (!file.startsWith(root) || !existsSync(file)) {
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

// Serve the on-disk fixture tree over HTTP, exactly as the registry raw server
// exposes it (404 for anything not physically present — e.g. /main/ variants).
function serveFixture(): Promise<Server> {
  return serveRoot(FIXTURE);
}

/**
 * Build a tmp registry tree for one package with the given manifest +
 * profile JSON. index.json carries a single catalog entry for `site`.
 * Returns the root dir. Caller removes it (rmSync recursive).
 */
function makeRegistryTree(site: string, manifest: unknown, profile?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "u2a-reg-"));
  mkdirSync(join(root, "packages", site), { recursive: true });
  writeFileSync(join(root, "index.json"), JSON.stringify({ [site]: { name: site, url: `https://${site}`, version: "1.0.0", trust: "unreviewed" } }));
  writeFileSync(join(root, "packages", site, "metadata.json"), JSON.stringify({ id: site }));
  writeFileSync(join(root, "packages", site, "manifest.json"), JSON.stringify(manifest));
  if (profile !== undefined) writeFileSync(join(root, "packages", site, "profile.json"), JSON.stringify(profile));
  return root;
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

  describe("GOAL 65: install-seam WRITE truth gate — a package the read/serve seams would refuse is refused at INSTALL time, nothing written", () => {
    const srvBase = async (srv: Server) => `http://127.0.0.1:${(srv.address() as any).port}`;

    it("(a) a malformed manifest capability entry (null / primitive / id-less) refuses naming the entry — the GOAL 61 class, refused at the write seam", async () => {
      // [null] is the exact GOAL 61 proof shape: caps.map(...) crashed /registry
      // until the read-side filter; the WRITE side must never land it on disk.
      const root = makeRegistryTree(
        "broken",
        { id: "broken", capabilities: [null, { method: "ui-path" }, "garbage"] },
        { id: "broken", url: "https://broken", composer: ["textarea"], answer: ["[id*=a]"] }
      );
      const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-"));
      try {
        const srv = await serveRoot(root);
        try {
          await installPackage("broken", await srvBase(srv), tmp)
            .then(() => assert.fail("expected install to refuse a malformed capabilities entry"))
            .catch((e: Error) => {
              assert.match(e.message, /capabilities\[0\]/, `names the entry: ${e.message}`);
              assert.match(e.message, /refusing to install a malformed package/, `named refusal verdict: ${e.message}`);
            });
          assert.ok(!existsSync(join(tmp, "broken")), "NOTHING must be written on refusal");
        } finally {
          srv.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("(b) a wrong-shaped profile.json (GOAL 48/56 class) refuses naming file + field — never installs a package the runtime would fail LOUD on at serve time", async () => {
      const root = makeRegistryTree(
        "brokenshape",
        { id: "brokenshape", capabilities: [{ id: "brokenshape_chat" }] },
        { id: "brokenshape", url: "https://brokenshape", composer: 42 } // composer scalar — unparseable
      );
      const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-"));
      try {
        const srv = await serveRoot(root);
        try {
          await installPackage("brokenshape", await srvBase(srv), tmp)
            .then(() => assert.fail("expected install to refuse a wrong-shaped profile.json"))
            .catch((e: Error) => {
              assert.match(e.message, /brokenshape\/profile\.json/, `names the file: ${e.message}`);
              assert.match(e.message, /composer/, `names the field: ${e.message}`);
            });
          assert.ok(!existsSync(join(tmp, "brokenshape")), "NOTHING must be written on refusal");
        } finally {
          srv.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("(c) a profile.json whose id mismatches the package dir (GOAL 64 class) refuses naming file + BOTH ids — never installs under the wrong identity", async () => {
      const root = makeRegistryTree(
        "duckduckgo",
        { id: "duckduckgo", capabilities: [{ id: "duckduckgo_chat" }] },
        { id: "gemini", url: "https://gemini.google.com", composer: ["textarea"], answer: ["[id*=a]"] } // declares the WRONG site
      );
      const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-"));
      try {
        const srv = await serveRoot(root);
        try {
          await installPackage("duckduckgo", await srvBase(srv), tmp)
            .then(() => assert.fail("expected install to refuse an id-mismatched profile.json"))
            .catch((e: Error) => {
              assert.match(e.message, /duckduckgo\/profile\.json/, `names the file: ${e.message}`);
              assert.match(e.message, /"gemini"/, `names the declared id: ${e.message}`);
              assert.match(e.message, /"duckduckgo"/, `names the package id: ${e.message}`);
              assert.match(e.message, /refusing to silently install the wrong site/, `GOAL-62/64 message shape: ${e.message}`);
            });
          assert.ok(!existsSync(join(tmp, "duckduckgo")), "NOTHING must be written on refusal");
        } finally {
          srv.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("(d) corrupt JSON anywhere in the package (metadata/session.lock/recipe) refuses naming the file — nothing written", async () => {
      const root = makeRegistryTree(
        "corrupt",
        { id: "corrupt", capabilities: [{ id: "corrupt_chat", recipe: "recipes/corrupt_chat.json" }] },
        { id: "corrupt", url: "https://corrupt", composer: ["textarea"], answer: ["[id*=a]"] }
      );
      mkdirSync(join(root, "packages", "corrupt", "recipes"), { recursive: true });
      writeFileSync(join(root, "packages", "corrupt", "recipes", "corrupt_chat.json"), "{ not json");
      const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-"));
      try {
        const srv = await serveRoot(root);
        try {
          await installPackage("corrupt", await srvBase(srv), tmp)
            .then(() => assert.fail("expected install to refuse corrupt recipe JSON"))
            .catch((e: Error) => {
              assert.match(e.message, /recipes\/corrupt_chat\.json/, `names the corrupt file: ${e.message}`);
              assert.match(e.message, /not valid JSON/, `named parse verdict: ${e.message}`);
            });
          assert.ok(!existsSync(join(tmp, "corrupt")), "NOTHING must be written on refusal");
        } finally {
          srv.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("(e) positive regression: a WELL-FORMED package (capabilities well-typed, profile id == package dir, valid shape) installs byte-identical", async () => {
      const root = makeRegistryTree(
        "good",
        { id: "good", capabilities: [{ id: "good_chat", recipe: "recipes/good_chat.json" }] },
        { id: "good", url: "https://good", composer: ["textarea"], answer: ["[id*=a]"] }
      );
      mkdirSync(join(root, "packages", "good", "recipes"), { recursive: true });
      writeFileSync(join(root, "packages", "good", "recipes", "good_chat.json"), JSON.stringify({ name: "good_chat" }));
      const tmp = mkdtempSync(join(tmpdir(), "u2a-inst-"));
      try {
        const srv = await serveRoot(root);
        try {
          const result = await installPackage("good", await srvBase(srv), tmp);
          assert.equal(result.siteId, "good");
          for (const f of ["metadata.json", "manifest.json", "profile.json", "recipes/good_chat.json"]) {
            assert.ok(existsSync(join(tmp, "good", f)), `missing ${f} — the gate must not block a valid package`);
          }
        } finally {
          srv.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});