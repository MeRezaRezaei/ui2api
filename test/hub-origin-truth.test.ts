import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RegistryStore } from "../src/hub/store.js";
import { HubRuntime } from "../src/hub/runtime.js";

// GOAL (plan 2026-10-04 Task 1): A NAME IS NOT A URL.
//
// `resolveBaseUrl` used to end in `return `https://${declaredHost || fallbackHost}``,
// so a package that declares NO url anywhere — not on the manifest, not in its
// captured action map — was handed an origin INVENTED FROM ITS NAME. Because the
// store keys a published package `ui2api-site-<host>`, that guess could be
// `https://ui2api-site-example.test/`, which resolves nowhere: it failed later,
// deep inside a browser, as `page.goto: net::ERR_NAME_NOT_RESOLVED` — a network
// error indistinguishable from the site being down.
//
// A test that pinned `https://${name}` would ENSHRINE THAT GUESS, so this file
// asserts the opposite: the resolver either uses a url the package DECLARES, or
// it refuses by name.

/**
 * The minimal store `resolveBaseUrl` can be reached through. The resolver reads
 * nothing from the store — it is handed `(manifest, moduleText, fallbackHost)`
 * directly — so the store exists only to satisfy the constructor, and the fake
 * keeps the key shape honest: a published package is keyed by its NAME, which is
 * what the old fallback would have turned into an origin.
 */
const STORE = {
  get: (key: string) =>
    key === "ui2api-site-nourl.test"
      ? { manifest: { host: "nourl.test", name: key }, module: "" }
      : undefined,
} as unknown as RegistryStore;

const DATA_DIR = "/tmp/codeg-acp/origin-truth";

/**
 * `resolveBaseUrl` is PRIVATE, so a test cannot call it. The repo's established
 * way to reach one is a cast through `unknown` (precedent:
 * `test/attach-gate.test.ts`, `test/boot-warm-real-cause.test.ts`) — followed
 * here rather than inventing a new way in, and rather than making the production
 * method public for a test.
 */
function resolver(): (manifest: Record<string, unknown>, moduleText: string, fallbackHost: string) => string {
  const rt = new HubRuntime({ store: STORE, dataDir: DATA_DIR });
  return (rt as unknown as {
    resolveBaseUrl: (m: Record<string, unknown>, t: string, f: string) => string;
  }).resolveBaseUrl.bind(rt);
}

test("a package with NO declared url REFUSES instead of inventing an origin from its name", () => {
  const resolveBaseUrl = resolver();
  assert.throws(
    () => resolveBaseUrl({ host: "nourl.test", name: "ui2api-site-nourl.test" }, "", "ui2api-site-nourl.test"),
    /no url/i,
    "expected a refusal naming the missing url, not an invented https://<name>",
  );
  // The refusal must NAME the package, so the operator knows which one to fix.
  assert.throws(
    () => resolveBaseUrl({ host: "nourl.test", name: "ui2api-site-nourl.test" }, "", "ui2api-site-nourl.test"),
    /ui2api-site-nourl\.test/,
    "the refusal must name the package that declares no url",
  );
});

test("a declared url IS still used verbatim, reduced to its origin", () => {
  const resolveBaseUrl = resolver();
  assert.equal(
    resolveBaseUrl({ url: "https://example.com/page" }, "", "k"),
    "https://example.com",
    "a declared url must win and be reduced to its origin",
  );
  // The action map's OWN url is the other declared source, and it outranks the
  // manifest — that is the url `ui2api analyse` captured.
  assert.equal(
    resolveBaseUrl({ url: "https://manifest.test/x" }, JSON.stringify({ url: "https://map.test/y" }), "k"),
    "https://map.test",
    "the captured action map's url must win over the manifest's",
  );
});

test("a host-only manifest gets NO origin — a name still is not a url", () => {
  // `manifest.host` alone used to be enough to synthesise `https://<host>`. A
  // bare host is a fragment of a url, not a url: the scheme may be http, the
  // site may live on a port, and the tools may need a path prefix. Guessing
  // any of those is the same defect wearing a different name, so it is refused
  // under the SAME rule rather than quietly kept as a last resort.
  const resolveBaseUrl = resolver();
  assert.throws(
    () => resolveBaseUrl({ host: "nourl.test" }, "", "ui2api-site-nourl.test"),
    /no url/i,
    "manifest.host alone must not authorise an invented origin",
  );
});
