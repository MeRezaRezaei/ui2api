import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../src/hub/store.js";
import { createHubRouter, HUB_MAX_BODY_BYTES } from "../src/hub/api.js";

/**
 * GOAL 237: the hub's body reader grew `buf += c` with NO byte cap and NO pause,
 * so any process able to open a socket to the hub port could stream an
 * arbitrarily large body until the process ran out of memory. promptd already
 * capped its own reader (`MAX_BODY_BYTES` -> 413 `payload_too_large`,
 * src/prompt/http.ts:679 / :715-733); the hub surface was simply missed.
 *
 * These are the TWO directions a cap can fail in, and the second is the one that
 * gets forgotten: a cap that is too tight silently breaks real publishes. So
 * both directions are pinned here against a real hub router on a real loopback
 * socket, and the negative is proven by the store — the assertion is that
 * NOTHING was written, not merely that a 413 came back.
 */

const ROOT = mkdtempSync(join(tmpdir(), "ui2api-hub-cap-"));

/** The largest body this hub is ever asked to accept, measured over every
 * `capabilities/<id>/` in this repo (tencent-aistudio). The cap is ~65x it. */
const REAL_UPLOAD_BYTES = 15_327;

/** A REAL manifest, read off disk rather than hand-written — so both fixtures
 * below clear the hub's own `REQUIRED_MANIFEST` gate for the honest reason (the
 * shape is real), and the only thing separating them is SIZE. A hand-rolled
 * manifest would have been refused at 400 for missing fields, which would make
 * the over-blocking pin pass or fail for an unrelated reason. The four
 * `PUBLISH_REQUIRED_FIELDS` the stored manifest does not carry are the ones
 * `cmdHubPublish` synthesizes (src/cli.ts:1058-1061, :1078), added here the same
 * way. */
const REAL_MANIFEST = JSON.parse(
  readFileSync(new URL("../capabilities/tencent-aistudio/manifest.json", import.meta.url), "utf8"),
);

const PUBLISH_MANIFEST = {
  ...REAL_MANIFEST,
  // `name` is the siteId, not the display `name` the metadata carries. A
  // DISPLAY name ("Tencent AI Studio (aistudio.tencent.ai)") is refused by the
  // store's own segment gate (src/hub/store.ts:68, `invalid package name`), so a
  // body that intends to be ACCEPTED must carry a safe segment. (Whether
  // `cmdHubPublish` should be sending the display name is a publish-path
  // question, not this goal's region — reported, not fixed here.) The point of
  // this fixture is SIZE, not the name shape.
  name: String(REAL_MANIFEST.siteId),
  version: REAL_MANIFEST.version || "1.0.0",
  author: "cli",
  authorizedUse: "own use of tencent-aistudio",
  license: "MIT",
  ui2api: "0.1.0",
};

/** A REAL action map that the hub's own publish gate accepts
 * (`validatePublishedModule` -> null, measured). Padding lives in the MANIFEST
 * so the module stays byte-identical to a real one. */
const REAL_MODULE = readFileSync(new URL("../sites/action-map.json", import.meta.url), "utf8");

function publishBody(descriptionBytes: number): string {
  const manifest = { ...PUBLISH_MANIFEST, description: "d".repeat(descriptionBytes) };
  return JSON.stringify({ manifest, module: REAL_MODULE });
}

function startHub(dataDir: string): Promise<{ server: Server; port: number }> {
  const store = new RegistryStore(dataDir);
  const router = createHubRouter(store, { token: "t", registryUrl: "http://none" });
  const server = createServer(router);
  return new Promise((res) => {
    // port 0 = an OS-assigned ephemeral loopback port; nothing is hardcoded.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      res({ server, port: addr.port });
    });
  });
}

async function put(port: number, body: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/packages`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body,
  });
  return { status: r.status, text: await r.text() };
}

/** A body that is BOTH over the cap AND a valid complete JSON package: the only
 * thing stopping it being parsed and written is the cap. If the reader regressed
 * to uncapped, this one publishes for real. */
function oversizedButWellFormed(): string {
  return publishBody(Math.ceil((HUB_MAX_BODY_BYTES * 1.5) / 1) + 1);
}

function realSizedBody(): string {
  return publishBody(14_000);
}

test("GOAL 237: an oversized publish gets the honest 413 payload_too_large and is never parsed", async () => {
  const dataDir = join(ROOT, "oversized");
  const { server, port } = await startHub(dataDir);
  try {
    const { status, text } = await put(port, oversizedButWellFormed());

    assert.equal(status, 413, `expected 413, got ${status}: ${text}`);
    const parsed = JSON.parse(text);
    // The SAME shape promptd sends (src/prompt/http.ts:1683), not a flat 400.
    assert.equal(parsed.error.code, "payload_too_large");
    assert.match(parsed.error.message, /request body exceeds 1000000 bytes/);

    // THE load-bearing assertion: not "it answered 413" but "it did not parse".
    // The body above is a COMPLETE, VALID, gate-passing package, so if the cap
    // had not fired this would be on disk.
    assert.equal(
      existsSync(join(dataDir, "pkgs", PUBLISH_MANIFEST.name)),
      false,
      "the oversized body reached the store — a refused publish WROTE something",
    );
    assert.equal(new RegistryStore(dataDir).list().length, 0, "an oversized body was parsed and published");
  } finally {
    server.close();
  }
});

test("GOAL 237: a realistic package-upload-sized body still publishes (the cap does not over-block)", async () => {
  const dataDir = join(ROOT, "realistic");
  const { server, port } = await startHub(dataDir);
  try {
    const body = realSizedBody();
    assert.ok(Buffer.byteLength(body) >= REAL_UPLOAD_BYTES - 2_000, "the fixture must be near the measured real upload size");
    assert.ok(Buffer.byteLength(body) < HUB_MAX_BODY_BYTES, "the fixture must be UNDER the cap");

    const { status, text } = await put(port, body);
    assert.equal(status, 200, `a realistic upload was refused (${status}: ${text}) — the cap is too tight`);

    // And it really landed, so this proves no over-blocking rather than proving
    // that both directions refuse.
    const listed = new RegistryStore(dataDir).list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, PUBLISH_MANIFEST.name);
  } finally {
    server.close();
  }
});

test("GOAL 237: the cap is a byte cap, and it is the documented exported constant", () => {
  assert.equal(HUB_MAX_BODY_BYTES, 1e6);
  assert.ok(
    HUB_MAX_BODY_BYTES > REAL_UPLOAD_BYTES * 10,
    `the cap (${HUB_MAX_BODY_BYTES}) is too close to the measured largest real upload (${REAL_UPLOAD_BYTES}) to be safe headroom`,
  );
});

test.after(() => { rmSync(ROOT, { recursive: true, force: true }); });
