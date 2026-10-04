import { RegistryStore } from "./store.js";
import { validateManifest } from "../../scripts/validate-registry.mjs";
import { validatePublishedModule } from "./module-gate.js";
import { renderHubHtml } from "./ui.js";
import { PUBLISH_REQUIRED_FIELDS } from "./publish-contract.js";
import { IncomingMessage, ServerResponse } from "node:http";

// DERIVED, not hand-typed (src/hub/publish-contract.ts): the field set a publish
// body must carry is the WRITER's field set (buildPackage's PackageMeta) less the
// two the store owns (host, trust) plus the one cmdHubPublish synthesises
// (version). This used to be a six-name literal with nothing tying it to the
// writer or to the UI template that documents the same object.
const REQUIRED_MANIFEST = PUBLISH_REQUIRED_FIELDS;

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
      } catch (e) {
        // GOAL 237: an oversized body is a TYPED fault and keeps its own status,
        // code and message — the same shape promptd sends
        // (src/prompt/http.ts:1683), so one refusal reads the same everywhere.
        // `connection: close` + destroy-on-finish because the upload is still in
        // flight and was deliberately stopped mid-stream: the socket must not be
        // reused. Answer FIRST, destroy after the flush — the reverse order is
        // what made this class unsendable in promptd. NOTE this whole branch runs
        // BEFORE store.save, so capping the body moves NO validation after a
        // write: a refused publish still writes nothing.
        if (e instanceof HubClientError) {
          json(res, e.status, { error: { code: e.code, message: e.message } }, { connection: "close" });
          if (e.code === "payload_too_large") res.once("finish", () => req.destroy());
          return;
        }
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
      // A review that did not happen must never be reported as one. This route
      // is the ONLY thing in the hub that mutates `trust`, and it used to
      // answer `200 {"ok":true,"trust":"reviewed"}` unconditionally:
      // `setTrust` silently no-ops when `packages[name].versions[version]` is
      // absent, and `parts[2]`/`parts[3]` were read with no length check, so
      // `POST /api/packages/review` (no name, no version) and a review of a
      // package that was never published both returned that same success. An
      // operator reading it would record a review that does not exist — the
      // fabrication this repo's core red line forbids, on a mutation route.
      // Well-formed requests are unchanged: the target exists -> 200, as before.
      if (!name || !version) return json(res, 404, { error: "no route" });
      if (!store.setTrust(name, version, "reviewed")) {
        return json(res, 404, { error: `no published package "${name}@${version}" to review` });
      }
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

/**
 * GOAL 237: the hub's body reader had NO byte cap and NO pause — `buf += c` grew
 * until the process ran out of memory, reachable by any process that can open a
 * socket to the hub port. The precedent this ports is promptd's own reader
 * (`MAX_BODY_BYTES` + the 413 `payload_too_large`, src/prompt/http.ts:679 and
 * :715-733); the hub is simply the surface that was missed.
 *
 * WHY 1 MB, and not promptd's number copied on faith: a hub publish body is
 * `{ manifest, module }` (src/cli.ts:1087) — JSON METADATA plus one action-map
 * text, never a binary blob. Measured over every `capabilities/<id>/` in this
 * repo, the LARGEST body this hub is ever asked to accept is 15,327 bytes
 * (tencent-aistudio: a 15 KB manifest + a metadata-derived module). 1 MB is
 * ~65x that, so no real package can be refused, while a caller that streams
 * past it is stopped at 1 MB instead of at whatever the box's free memory
 * happens to be. Going tighter would risk refusing a legitimately large
 * action-map; going wider buys nothing, because the ceiling is a DoS bound and
 * not a feature.
 *
 * A named exported constant rather than a `UI2API_*` knob on purpose: this repo
 * GATES knobs (test/ci-contract-knob-cites.test.ts + the AGENTS.md knob table
 * both fail on a knob with no documented row), and the publish surface is a
 * localhost, single-operator path where a tunable limit is not worth a contract.
 */
export const HUB_MAX_BODY_BYTES = 1e6;

/**
 * A TYPED client fault, ported from promptd's `HttpClientError`
 * (src/prompt/http.ts:668). It exists so the oversized-body refusal is
 * DISTINGUISHABLE from a malformed body: both reject out of `readJson`, and
 * without a type the caller's `catch` answers every failure with a flat 400 —
 * which is exactly how a 1 GB upload becomes "invalid json body", a refusal
 * class that names neither the size nor the real cause.
 */
export class HubClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HubClientError";
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    // GOAL 237: count BYTES, not string units — chunks arrive as Buffers (no
    // encoding is set), so `c.length` IS the byte count, and the refusal names
    // bytes. Same correction as src/prompt/http.ts:708-713.
    let size = 0;
    let refused = false;
    req.on("data", (c) => {
      if (refused) return;
      size += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (size > HUB_MAX_BODY_BYTES) {
        // Stop reading IMMEDIATELY, and drop what we have. Two separate
        // obligations, both load-bearing:
        //  - `pause()` + dropping the `data` listener stop the client's stream
        //    at the cap instead of feeding a server that already refused it.
        //  - `buf = ""` + `refused` make a PARTIAL PARSE IMPOSSIBLE: the buffer
        //    is the first HUB_MAX_BODY_BYTES of a body we never saw the end of,
        //    so it must never reach `JSON.parse`. `refused` additionally stops
        //    the `end` handler below from doing anything at all, so a promise
        //    that already rejected cannot be walked into a parse by a late
        //    `end`. (The socket is NOT destroyed HERE — see the caller's
        //    `payload_too_large` branch, which answers first and destroys after
        //    the flush, because destroying here is what made this code
        //    unsendable in promptd: the client got ECONNRESET and no answer.)
        refused = true;
        buf = "";
        req.pause();
        req.removeAllListeners("data");
        reject(new HubClientError(413, "payload_too_large", `request body exceeds ${HUB_MAX_BODY_BYTES} bytes`));
        return;
      }
      buf += c;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (refused) return;
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("invalid json body"));
      }
    });
  });
}
function json(res: ServerResponse, code: number, obj: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}
function html(res: ServerResponse, code: number, s: string) { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(s); }
