import { RegistryStore } from "./store.js";
import { validatePackage } from "../../scripts/validate-registry.mjs";
import { IncomingMessage, ServerResponse } from "node:http";

const REQUIRED_MANIFEST = ["name", "version", "author", "authorizedUse", "license", "ui2api"];

export function createHubRouter(store: RegistryStore, opts: { token: string; registryUrl: string }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const auth = req.headers["authorization"];
    const okToken = auth === `Bearer ${opts.token}`;

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
      const body = await readJson(req) as any;
      const { manifest, module } = body;
      const missing = REQUIRED_MANIFEST.filter((k) => !manifest?.[k]);
      if (missing.length) return json(res, 400, { error: `missing manifest fields: ${missing.join(",")}` });
      const err = validatePackage(manifest, module);
      if (err) return json(res, 400, { error: err });
      store.save(manifest.name, manifest.version, manifest, module);
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
    store.save(name, data.manifest.version, data.manifest, data.module);
    return store.get(name, data.manifest.version);
  } catch { return null; }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ""; req.on("data", (c) => (buf += c)); req.on("end", () => resolve(buf ? JSON.parse(buf) : {})); req.on("error", reject);
  });
}
function json(res: ServerResponse, code: number, obj: unknown) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
