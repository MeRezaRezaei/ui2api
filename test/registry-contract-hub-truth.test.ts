import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RegistryStore } from "../src/hub/store.js";
import { createHubRouter } from "../src/hub/api.js";
import { renderHubHtml } from "../src/hub/ui.js";

/**
 * THE HUB'S TRUTH SEAMS: a review that did not happen must never be reported
 * as one, and no field may reach the operator's browser unescaped.
 *
 * Both are the repo's core red line, on the surfaces where a consumer reads the
 * answer: `/review` is the ONLY route in the hub that mutates `trust`, and the
 * management UI is the operator's only in-product view of the inventory.
 */

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "u2a-hubtruth-"));
}

async function startHub(token = "T"): Promise<{ base: string; store: RegistryStore; close: () => void }> {
  const dir = scratch();
  const store = new RegistryStore(dir);
  const srv: Server = createServer(createHubRouter(store, { token, registryUrl: "http://none" }));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`,
    store,
    close: () => {
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------- the /review route

test("reviewing a package that was never published is a 404, NOT a success — nothing claimed may be unverified", async () => {
  // PROVEN before the fix: `POST /api/packages/never-published/9.9.9/review`
  // answered `200 {"ok":true,"trust":"reviewed"}`. `setTrust` no-ops on a
  // missing package, and the route answered the success regardless — so an
  // operator reading that response would record a review that does not exist.
  const hub = await startHub();
  try {
    const res = await fetch(`${hub.base}/api/packages/never-published/9.9.9/review`, {
      method: "POST",
      headers: { authorization: "Bearer T" },
    });
    assert.equal(res.status, 404, `MUTATION PROOF: expected 404, got ${res.status} ${await res.clone().text()}`);
    const body = (await res.json()) as { ok?: boolean; trust?: string; error?: string };
    assert.equal(body.ok, undefined, "a review that did not happen must not answer ok:true");
    assert.equal(body.trust, undefined, "nor claim a trust state");
    assert.match(body.error ?? "", /no published package "never-published@9\.9\.9" to review/, "named verdict");
  } finally {
    hub.close();
  }
});

test("the /review route refuses a path with no name and no version — it is not a success either", async () => {
  // `parts[2]` / `parts[3]` were read with no length check, so the shortest
  // path that ends in `/review` produced `name=undefined, version=undefined`.
  const hub = await startHub();
  try {
    const res = await fetch(`${hub.base}/api/packages/review`, {
      method: "POST",
      headers: { authorization: "Bearer T" },
    });
    assert.equal(res.status, 404, `MUTATION PROOF: expected 404, got ${res.status} ${await res.clone().text()}`);
  } finally {
    hub.close();
  }
});

test("a review of a REAL published package still succeeds — the gate refuses only what did not happen", async () => {
  // The behaviour-identity half: a well-formed review of an existing target is
  // byte-identical to what the route answered before, 200 {"ok":true,...}.
  const hub = await startHub();
  try {
    const pub = await fetch(`${hub.base}/api/packages`, {
      method: "PUT",
      headers: { authorization: "Bearer T", "content-type": "application/json" },
      body: JSON.stringify({
        manifest: {
          name: "ui2api-site-example",
          version: "1.0.0",
          author: "a",
          authorizedUse: "own authorized use",
          license: "MIT",
          ui2api: "0.2.0",
        },
        module: 'export default { name: "x", setup(c){} };',
      }),
    });
    assert.equal(pub.status, 200, `precondition: the publish must land, got ${await pub.clone().text()}`);

    const res = await fetch(`${hub.base}/api/packages/ui2api-site-example/1.0.0/review`, {
      method: "POST",
      headers: { authorization: "Bearer T" },
    });
    assert.equal(res.status, 200, `a real review must still succeed, got ${res.status}`);
    assert.deepEqual(await res.json(), { ok: true, trust: "reviewed" });
    // and the trust actually landed in the index
    const listed = (await (await fetch(`${hub.base}/api/packages`)).json()) as {
      packages: Array<{ name: string; trust: string }>;
    };
    assert.equal(listed.packages[0]?.trust, "reviewed", "the review must be real, not just reported");
  } finally {
    hub.close();
  }
});

test("setTrust reports whether it landed — the boolean is the truth the route needs", () => {
  // The store-level half, so the route is not the only thing that can lie.
  const dir = scratch();
  try {
    const store = new RegistryStore(dir);
    assert.equal(store.setTrust("nope", "1.0.0", "reviewed"), false, "a missing package reports false, it does not silently succeed");
    store.save("real", "1.0.0", { author: "a" }, "export default { setup(){} };");
    assert.equal(store.setTrust("real", "1.0.0", "reviewed"), true, "an existing package reports true");
    assert.equal(store.setTrust("real", "9.9.9", "reviewed"), false, "an existing package at a MISSING VERSION reports false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the UI escape

test("every field the hub UI renders is escaped, including trust — the one that was raw", async () => {
  // PROVEN before the fix: a poisoned index entry carried
  // `trust = '"><img src=x onerror=alert(1)>'`, `store.list()` handed it back
  // verbatim (it widens trust to plain `string`, and `isRegistryIndexShape`
  // validates nothing inside an entry), and `renderHubHtml` interpolated it
  // into BOTH the text node and the `class` attribute with no `esc()` — while
  // its three siblings in the same row were all escaped.
  const dir = scratch();
  try {
    const store = new RegistryStore(dir);
    store.save("evil", "1.0.0", { author: "x" }, "export default { setup(){} };");
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const idxPath = resolve(dir, "registry.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8")) as { packages: Record<string, { versions: Record<string, { trust: string }> }> };
    idx.packages.evil.versions["1.0.0"].trust = PAYLOAD;
    writeFileSync(idxPath, JSON.stringify(idx, null, 2));

    const html = renderHubHtml(store, { registryUrl: "x" });
    assert.equal(store.list()[0]?.trust, PAYLOAD, "precondition: the poisoned value really does reach list()");
    assert.ok(!html.includes(PAYLOAD), `MUTATION PROOF: the raw payload reached the page`);
    assert.ok(!html.includes(`class="badge ${PAYLOAD}"`), "MUTATION PROOF: it reached the class attribute");
    // the escaped form IS present, so this is escaping and not a dropped field
    assert.match(html, /badge &quot;&gt;&lt;img/, `the field must still render, escaped: ${html.slice(0, 200)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the two real trust values render byte-identically — escaping trust is a no-op for them", async () => {
  // The behaviour-identity half. `store.save` hardcodes "unreviewed" and only
  // the review route ever writes "reviewed", so neither value contains a
  // character `esc()` touches; the rendered row must be unchanged.
  const dir = scratch();
  try {
    const store = new RegistryStore(dir);
    store.save("ui2api-site-example", "1.0.0", { author: "a" }, "export default { setup(){} };");
    const unreviewed = renderHubHtml(store, { registryUrl: "x" });
    store.setTrust("ui2api-site-example", "1.0.0", "reviewed");
    const reviewed = renderHubHtml(store, { registryUrl: "x" });
    assert.match(unreviewed, /<td class="badge unreviewed">unreviewed<\/td>/, "the unreviewed row is unchanged");
    assert.match(reviewed, /<td class="badge reviewed">reviewed<\/td>/, "the reviewed row is unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the segment gate the hub re-exports is the ONE definition install uses — one rule, two seams", async () => {
  // Both seams turn an identifier into a filesystem path. If they each held a
  // private copy of the charset, the install seam would again be an escape the
  // hub seam never sees — which is exactly what it was.
  const fromHub = await import("../src/hub/store.js");
  const fromLeaf = await import("../src/registry/safe-segment.js");
  assert.equal(fromHub.assertSafePackageSegment, fromLeaf.assertSafePackageSegment, "one function, not two");
  const hubSrc = readFileSync("src/hub/store.ts", "utf8");
  assert.doesNotMatch(hubSrc, /\^\[A-Za-z0-9\._-\]\+\$/, "store.ts must NOT re-inline a private copy of the charset");
  assert.match(hubSrc, /from "\.\.\/registry\/safe-segment\.js"/, "store.ts must import the shared gate");
});
