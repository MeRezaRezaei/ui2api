import { RegistryStore } from "./store.js";
import { validateManifest } from "../../scripts/validate-registry.mjs";
import { validatePublishedModule } from "./module-gate.js";
import { renderHubHtml } from "./ui.js";
import { IncomingMessage, ServerResponse } from "node:http";

const REQUIRED_MANIFEST = ["name", "version", "author", "authorizedUse", "license", "ui2api"];

export function createHubRouter(store: RegistryStore, opts: { token: string; registryUrl: string }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const auth = req.headers["authorization"];
    const okToken = auth === `Bearer ${opts.token}`;

    // GET / and /ui — management UI (public read surface)
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      return html(res, 200, renderHubHtml(store, { registryUrl: opts.registryUrl }));
    }

    // GET /api/packages[/:name[/:version]]
    if (req.method === "GET" && url.pathname.startsWith("/api/packages")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["api","packages",name?,version?]
      if (parts.length === 2) {
        return json(res, 200, { packages: store.list() });
      }
      const name = parts[2]; const version = parts[3];
      let pkg = store.get(name, version);
      if (!pkg) pkg = await uplink(store, opts.registryUrl, name, version);
      if (!pkg) return json(res, 404, { error: "not found" });
      return json(res, 200, { manifest: pkg.manifest, trust: pkg.trust });
    }

    // PUT /api/packages  (publish)
    if (req.method === "PUT" && url.pathname === "/api/packages") {
      if (!okToken) return json(res, 401, { error: "unauthorized" });
      let body: any;
      try {
        body = (await readJson(req)) as any;
      } catch {
        return json(res, 400, { error: "invalid json body" });
      }
      const { manifest, module } = body;
      const missing = REQUIRED_MANIFEST.filter((k) => !manifest?.[k]);
      if (missing.length) return json(res, 400, { error: `missing manifest fields: ${missing.join(",")}` });
      const err = validateManifest(manifest, module);
      if (err) return json(res, 400, { error: err });
      const modErr = validatePublishedModule(module);
      if (modErr) return json(res, 400, { error: modErr });
      // GOAL 121: a store refusal is a NAMED 4xx, never an unhandled rejection.
      // A traversal name used to throw straight out of the async router with no
      // try/catch, which killed the hub process — and if the target had been the
      // index itself, the store stayed poisoned across restarts.
      try {
        store.save(manifest.name, manifest.version, manifest, module);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return json(res, 400, { error: message, code: "invalid_package_target" });
      }
      return json(res, 200, { ok: true });
    }

    // POST /api/packages/:name/:version/review  (trust)
    if (req.method === "POST" && url.pathname.endsWith("/review")) {
      if (!okToken) return json(res, 401, { error: "unauthorized" });
      const parts = url.pathname.split("/").filter(Boolean);
      const name = parts[2]; const version = parts[3];
      store.setTrust(name, version, "reviewed");
      return json(res, 200, { ok: true, trust: "reviewed" });
    }

    json(res, 404, { error: "no route" });
  };
}

async function uplink(store: RegistryStore, registryUrl: string, name?: string, version?: string) {
  if (!name || registryUrl === "http://none") return null;
  try {
    const u = `${registryUrl}/${name}/${version ?? "latest"}.json`;
    const r = await fetch(u); if (!r.ok) return null;
    const data = await r.json() as any;
    // Write-truth: never cache an artifact the runtime cannot serve — a broken
    // remote module answers an honest 404 instead of a cache-then-crash.
    if (validatePublishedModule(data.module) !== null) return null;
    store.save(name, data.manifest.version, data.manifest, data.module);
    return store.get(name, data.manifest.version);
  } catch { return null; }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("error", reject);
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
  });
}
function json(res: ServerResponse, code: number, obj: unknown) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
function html(res: ServerResponse, code: number, s: string) { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(s); }
