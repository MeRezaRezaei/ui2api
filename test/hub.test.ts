import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../src/hub/store.js";
import { createHubRouter } from "../src/hub/api.js";
import { createServer } from "node:http";

describe("RegistryStore", () => {
  it("saves and resolves a package version", () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-store-"));
    try {
      const s = new RegistryStore(dir);
      s.save("example.test", "1.0.0", { name: "example.test", version: "1.0.0", author: "a", authorizedUse: "own use", license: "MIT", ui2api: "0.1.0" }, "export default {}");
      const v = s.get("example.test", "1.0.0")!;
      assert.equal(v.manifest.name, "example.test");
      assert.equal(v.trust, "unreviewed");
      assert.ok(s.get("example.test")!.manifest.version === "1.0.0");
      s.setTrust("example.test", "1.0.0", "reviewed");
      assert.equal(s.get("example.test", "1.0.0")!.trust, "reviewed");
      assert.equal(s.list().length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

function startTestHub(dataDir: string, token = "op-secret") {
  const store = new RegistryStore(dataDir);
  const router = createHubRouter(store, { token, registryUrl: "http://none" });
  const server = createServer(router);
  server.listen(0);
  const port = (server.address() as any).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("Hub API", () => {
  it("rejects publish without token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-api-"));
    const { server, base } = startTestHub(dir);
    try {
      const r = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: {}, module: "x" }) });
      assert.equal(r.status, 401);
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("publishes and resolves with token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-api2-"));
    const { server, base } = startTestHub(dir);
    try {
      const manifest = { name: "x.test", version: "1.0.0", author: "a", authorizedUse: "own site use", license: "MIT", ui2api: "0.1.0" };
      const p = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest, module: "export default {}" }) });
      assert.equal(p.status, 200);
      const g = await fetch(`${base}/api/packages/x.test`);
      const j = await g.json() as any;
      assert.equal(j.manifest.name, "x.test");
      assert.equal(j.trust, "unreviewed");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Hub uplink", () => {
  it("proxies and caches from registryUrl on miss", async () => {
    const fake = createServer((_q, r) => {
      r.writeHead(200, { "content-type": "application/json" });
      r.end(JSON.stringify({ manifest: { name: "up.test", version: "2.0.0", author: "u", authorizedUse: "own", license: "MIT", ui2api: "0.1.0" }, module: "export default {}" }));
    });
    fake.listen(0);
    const base = `http://127.0.0.1:${(fake.address() as any).port}`;
    const dir = mkdtempSync(join(tmpdir(), "u2a-up-"));
    const store = new RegistryStore(dir);
    const router = createHubRouter(store, { token: "t", registryUrl: base });
    const srv = createServer(router); srv.listen(0);
    const h = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const g = await fetch(`${h}/api/packages/up.test`);
      const j = await g.json() as any;
      assert.equal(j.manifest.version, "2.0.0");
      assert.ok(store.get("up.test", "2.0.0"), "should be cached locally");
    } finally { srv.close(); fake.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// GOAL 69 — hub publish write truth: PUT /api/packages and the uplink cache
// seam refuse artifacts the runtime deterministically cannot serve, with a
// named verdict and nothing written; a malformed JSON body is a named 400,
// never a process crash.
describe("Hub publish write truth (GOAL 69)", () => {
  const MANIFEST = { name: "gate.test", version: "1.0.0", author: "a", authorizedUse: "own site use", license: "MIT", ui2api: "0.1.0" };
  const VALID_MAP = JSON.stringify({
    host: "map.test", url: "https://map.test", capturedAt: "2026-08-29",
    auth: { required: false },
    actions: [{ name: "ping", description: "ping", execution: "live-js", parameters: [], recipe: { kind: "js-function", target: "window.ping", argsFrom: {} }, result: { mode: "return" }, verified: true }],
  });

  function startStore(registryUrl: string, token = "op-secret") {
    const dir = mkdtempSync(join(tmpdir(), "u2a-gate-"));
    const store = new RegistryStore(dir);
    const router = createHubRouter(store, { token, registryUrl });
    const server = createServer(router);
    server.listen(0);
    const port = (server.address() as any).port;
    return { store, server, base: `http://127.0.0.1:${port}`, dir };
  }

  it("(a) refuses an unloadable module with a named verdict and writes nothing", async () => {
    const { store, server, base, dir } = startStore("http://none");
    try {
      const p = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: MANIFEST, module: "this is not a module" }) });
      assert.equal(p.status, 400);
      const j = await p.json() as any;
      assert.ok(j.error.includes("module-not-loadable"), `verdict names the dead class: ${j.error}`);
      assert.equal(store.get("gate.test"), null, "nothing written");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(b) refuses an empty or omitted module", async () => {
    const { store, server, base, dir } = startStore("http://none");
    try {
      const p1 = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: MANIFEST, module: "   " }) });
      assert.equal(p1.status, 400);
      assert.ok(((await p1.json()) as any).error.includes("module required"));
      const p2 = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: MANIFEST }) });
      assert.equal(p2.status, 400);
      assert.ok(((await p2.json()) as any).error.includes("module required"));
      assert.equal(store.get("gate.test"), null, "nothing written");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(c) refuses json-without-actions", async () => {
    const { store, server, base, dir } = startStore("http://none");
    try {
      const p = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: MANIFEST, module: '{"hello":"world"}' }) });
      assert.equal(p.status, 400);
      assert.ok(((await p.json()) as any).error.includes("json-without-actions"));
      assert.equal(store.get("gate.test"), null, "nothing written");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(d) refuses an action-map that fails the schema, naming the schema message", async () => {
    const { store, server, base, dir } = startStore("http://none");
    try {
      const bad = JSON.stringify({ host: "map.test", url: "https://map.test", actions: [{ name: "bad name!" }] });
      const p = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: MANIFEST, module: bad }) });
      assert.equal(p.status, 400);
      const j = await p.json() as any;
      assert.ok(j.error.includes("action-map-invalid") && j.error.includes("snake_case"), `schema message surfaced: ${j.error}`);
      assert.equal(store.get("gate.test"), null, "nothing written");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(e) accepts a schema-valid action-map and a JS plugin module unchanged", async () => {
    const { store, server, base, dir } = startStore("http://none");
    try {
      const p1 = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: { ...MANIFEST, name: "map.test" }, module: VALID_MAP }) });
      assert.equal(p1.status, 200);
      assert.ok(store.get("map.test"), "action-map accepted and stored");
      const p2 = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: { ...MANIFEST, name: "js.test" }, module: "export default { setup(){} }" }) });
      assert.equal(p2.status, 200);
      assert.ok(store.get("js.test"), "JS module accepted and stored");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(f) answers malformed JSON with a named 400 and survives for the next request", async () => {
    const { store, server, base, dir } = startStore("http://none");
    try {
      const bad = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: '{"manifest": {"name": "x' });
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as any).error, "invalid json body");
      // the process survived — a valid publish still works
      const ok = await fetch(`${base}/api/packages`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer op-secret" }, body: JSON.stringify({ manifest: MANIFEST, module: "export default {}" }) });
      assert.equal(ok.status, 200);
      assert.ok(store.get("gate.test"), "publish after the malformed body works");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(g) uplink never caches a broken remote module — honest 404", async () => {
    const fake = createServer((_q, r) => {
      r.writeHead(200, { "content-type": "application/json" });
      r.end(JSON.stringify({ manifest: { name: "up2.test", version: "2.0.0", author: "u", authorizedUse: "own", license: "MIT", ui2api: "0.1.0" }, module: "not a module either" }));
    });
    fake.listen(0);
    const base = `http://127.0.0.1:${(fake.address() as any).port}`;
    const { store, server, base: h, dir } = startStore(base, "t");
    try {
      const g = await fetch(`${h}/api/packages/up2.test`);
      assert.equal(g.status, 404);
      assert.equal(store.get("up2.test"), null, "garbage remote module never cached");
    } finally { server.close(); fake.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
