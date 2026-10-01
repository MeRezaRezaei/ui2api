/**
 * THE PUBLISHED-MANIFEST CONTRACT — one object, three surfaces, one derivation.
 *
 * A `PUT /api/packages` body, the manifest `buildPackage` writes, and the
 * pre-filled template the hub UI shows the operator are the SAME object. All
 * three used to carry their own hand-typed copy of its field names, with
 * nothing tying them together, and the one value that was not a hand-typed
 * duplication had already rotted: the UI told operators to declare
 * `"ui2api": "0.1.0"` on a `0.2.0` build, and nothing detected it.
 *
 * Every gate below asserts in a real top-level `test(...)`. This repo's rule: a
 * pin nobody counts is a pin nobody reads — a `describe` body that throws still
 * fails the run but never shows up in the `tests` total, which is how
 * error-contract and lang-php silently under-reported their coverage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  PACKAGE_META_FIELDS,
  UI2API_VERSION,
  buildPackage,
  packageCommandRefusal,
} from "../src/registry/package.js";
import {
  PUBLISH_REQUIRED_FIELDS,
  PUBLISH_SYNTHESISED_FIELDS,
  PUBLISH_TEMPLATE_VALUES,
  STORE_OWNED_FIELDS,
  publishTemplateJson,
} from "../src/hub/publish-contract.js";
import { RegistryStore } from "../src/hub/store.js";
import { renderHubHtml } from "../src/hub/ui.js";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const keySet = (xs: readonly string[]) => JSON.stringify([...xs].sort());
const TUPLED_FIELDS: readonly string[] = PACKAGE_META_FIELDS;

test("the published-manifest required set is the WRITER's field set, not a third hand-typed copy", () => {
  // The derivation, spelled out as an identity so a future edit to any part of
  // it fails HERE and names which side moved.
  const expected = [
    ...TUPLED_FIELDS.filter((f) => !STORE_OWNED_FIELDS.includes(f as never)),
    ...PUBLISH_SYNTHESISED_FIELDS,
  ];
  assert.equal(
    keySet(PUBLISH_REQUIRED_FIELDS),
    keySet(expected),
    `derived required set drifted from writer-fields-minus-store-owned-plus-synthesised: ` +
      `derived=${JSON.stringify(PUBLISH_REQUIRED_FIELDS)} expected=${JSON.stringify(expected)}`
  );
  // No required field may be a field the writer never produces, and vice versa
  // the two named exclusions must actually be PackageMeta fields (a typo in
  // STORE_OWNED_FIELDS would silently re-open a gate, or gate a field nothing
  // writes, and both must be named failures).
  for (const f of STORE_OWNED_FIELDS) {
    assert.ok(TUPLED_FIELDS.includes(f), `STORE_OWNED_FIELDS names "${f}", which buildPackage never writes`);
  }
  for (const f of PUBLISH_REQUIRED_FIELDS) {
    const written = TUPLED_FIELDS.includes(f as never) || PUBLISH_SYNTHESISED_FIELDS.includes(f);
    assert.ok(written, `PUBLISH_REQUIRED_FIELDS requires "${f}", which no publish path produces — every publish would 400`);
  }
  // The two store-owned exclusions are load-bearing, not decoration: `trust` is
  // the store's authority (save() hardcodes "unreviewed"; only /review promotes
  // it) and `host` is not the key the store indexes by (it indexes by `name`).
  assert.deepEqual([...STORE_OWNED_FIELDS], ["host", "trust"], "the store-owned exclusion set changed — name the reason in publish-contract.ts");
});

test("PackageMeta's TYPE is derived from the runtime tuple, so a field cannot be added to the writer silently", () => {
  // The interface is a mapped type over PACKAGE_META_FIELDS. This is the
  // compile-time half of the gate; the runtime half is the buildPackage literal
  // below. Both must name the SAME fields, and the set must stay at the 7 the
  // legacy writer has always produced.
  const src = read("src/registry/package.ts");
  assert.match(
    src,
    /export type PackageMeta = \{ \[K in PackageMetaField\]/,
    "PackageMeta is no longer derived from PACKAGE_META_FIELDS — the type and the runtime tuple can drift again"
  );
  assert.equal(TUPLED_FIELDS.length, 7, "PACKAGE_META_FIELDS changed size; name every added/removed field in package.ts");
  assert.deepEqual(
    [...TUPLED_FIELDS],
    ["host", "name", "author", "authorizedUse", "license", "ui2api", "trust"],
    "the writer's field set changed — this is a published-contract change, so it needs a named reason here"
  );
});

test("buildPackage's written literal declares exactly the tupled fields (the runtime half of the same gate)", () => {
  // PACKAGE_META_FIELDS is the single source; the object literal in buildPackage
  // is the OTHER half. A field added to one and not the other is the exact
  // silent divergence that produced the stale UI template, so it is measured
  // rather than trusted to the compiler (a Record index signature would accept
  // an extra key; the mapped type catches a MISSING one, not an extra).
  const src = read("src/registry/package.ts");
  const lit = /const metadata: PackageMeta = \{([\s\S]*?)\n  \};/m.exec(src);
  assert.ok(lit, "buildPackage's `const metadata: PackageMeta = {…}` literal was not found — the drift gate can no longer be measured");
  const literalKeys = [...lit[1]!.matchAll(/^\s*(\w+)\s*[,:]/gm)].map((m) => m[1]!).sort();
  assert.deepEqual(
    literalKeys,
    [...TUPLED_FIELDS].sort(),
    `buildPackage writes ${JSON.stringify(literalKeys)} but PACKAGE_META_FIELDS declares ${JSON.stringify([...TUPLED_FIELDS].sort())}`
  );
});

test("the hub UI's publish template advertises EXACTLY the fields the gate demands — the drift that shipped", () => {
  // Both sides now read PUBLISH_REQUIRED_FIELDS, so this is structurally
  // guaranteed. It stays as a pin because the two surfaces are the ones an
  // operator meets in different places (the UI and a 400 from the gate), and
  // because it is the assertion that would have caught today's stale value.
  assert.equal(
    keySet(Object.keys(PUBLISH_TEMPLATE_VALUES)),
    keySet(PUBLISH_REQUIRED_FIELDS),
    "the publish template's fields and the publish gate's required fields disagree — an operator pasting the template would get `missing manifest fields`"
  );
  // …and the template is what the UI actually renders, not just what the module
  // exports. The rendered HTML is the surface the operator reads.
  // A TEMP DIR, not `data/`. This used to build its scratch store inside the
  // session vault, which is the credential store: real cookies, real Bearer
  // tokens, and — since `vault tighten --apply` — owned 0700 by `ui2api`. So a
  // test that merely needed somewhere to write was failing for anyone who did
  // not own the vault, and it only passed in CI because the container runs as
  // root. MEASURED 2026-10-01: 7 pass / 2 fail as `me` with EACCES on mkdir,
  // 9 pass / 0 fail as the owner.
  //
  // That is a test using the credential vault as scratch space, which is the
  // exact mistake test/vault-permission-census.test.ts exists to catch — and it
  // was passing only because the harness happened to be privileged. Tests write
  // to a temp dir; the vault holds credentials.
  const store = new RegistryStore(mkdtempSync(resolve(tmpdir(), "ui2api-hub-contract-")));
  const html = renderHubHtml(store, { registryUrl: "http://none" });
  const tpl = /id="manifest">([\s\S]*?)<\/textarea>/.exec(html);
  assert.ok(tpl, "the hub UI no longer renders a #manifest textarea — the publish template cannot be measured");
  const keys = [...tpl[1]!.matchAll(/"([A-Za-z0-9_]+)"\s*:/g)].map((m) => m[1]!);
  assert.equal(
    keySet(keys),
    keySet(PUBLISH_REQUIRED_FIELDS),
    `the RENDERED template advertises ${JSON.stringify(keys)} but the gate requires ${JSON.stringify([...PUBLISH_REQUIRED_FIELDS])}`
  );
});

test("the template's ui2api value is THIS build's version — not a literal that rots at the next release", () => {
  // THE BUG THIS TEST EXISTS FOR. The template hardcoded "0.1.0" while
  // package.json was 0.2.0: the operator-facing documentation of a publish body
  // asserted a compatibility the build does not have, and nothing compared it.
  const real = (JSON.parse(read("package.json")) as { version: string }).version;
  assert.equal(UI2API_VERSION, real, "UI2API_VERSION no longer reads package.json");
  assert.equal(
    PUBLISH_TEMPLATE_VALUES["ui2api"],
    real,
    `the publish template tells operators to declare ui2api ${JSON.stringify(PUBLISH_TEMPLATE_VALUES["ui2api"])} but this build is ${JSON.stringify(real)}`
  );
  // …and the RENDERED html, because the rendered text is what the operator
  // actually reads. Comparing the rendered VALUE (not just its presence) is
  // what makes this independent of the edge pin: re-inlining the old literal
  // template in ui.ts is caught here too, and again there.
  const html = renderHubHtml(new RegistryStore(mkdtempSync(resolve(tmpdir(), "ui2api-hub-contract2-"))), {
    registryUrl: "http://none",
  });
  const rendered = /id="manifest">([\s\S]*?)<\/textarea>/.exec(html);
  assert.ok(rendered, "the hub UI no longer renders a #manifest textarea");
  const renderedUi2api = /"ui2api":\s*"([^"]*)"/.exec(rendered[1]!);
  assert.ok(renderedUi2api, "the rendered template carries no ui2api field");
  assert.equal(
    renderedUi2api[1],
    real,
    `the RENDERED publish template tells operators to declare ui2api ${JSON.stringify(renderedUi2api[1])} but this build is ${JSON.stringify(real)}`
  );
});

test("every other template value stays operator-authored, and is named as such (the values-are-a-contract half of the split)", () => {
  // The keys/values discipline: the KEYS are derived, the VALUES are a published
  // sample an operator copies. These are the reasons they cannot be derived —
  // asserted here so a future refactor cannot quietly start inventing them.
  const reasons: Record<string, string> = {
    name: "a function of the operator's --host",
    version: "the PACKAGE's own version, mirroring cmdHubPublish's fallback in src/cli.ts",
    author: "operator-supplied (UI2API_HUB_AUTHOR)",
    authorizedUse: "operator-authored prose the gate requires",
    license: "an operator-chosen licence; MIT is buildPackage's overridable default",
  };
  for (const [field, why] of Object.entries(reasons)) {
    assert.ok(
      field in PUBLISH_TEMPLATE_VALUES,
      `the template lost its "${field}" entry (${why}) — a required field with no example`
    );
  }
  // `version` is the only value that mirrors a literal in a file this change
  // does NOT own, so it is pinned against that file by reading it — named here
  // so a cli.ts edit is a named failure instead of a silent divergence.
  const cli = read("src/cli.ts");
  const m = /const manifest = \{ \.\.\.metadata, version: metadata\.version \|\| "([^"]+)" \}/.exec(cli);
  assert.ok(
    m,
    "src/cli.ts's cmdHubPublish no longer builds `{ ...metadata, version: metadata.version || … }` — PUBLISH_SYNTHESISED_FIELDS must be re-derived from it"
  );
  assert.equal(
    PUBLISH_TEMPLATE_VALUES["version"],
    m[1],
    `the template's version sample drifted from cmdHubPublish's fallback (src/cli.ts)`
  );
  // The gate requires `version` precisely because cmdHubPublish synthesises it;
  // if that stopped being true the required field would be unfillable.
  assert.ok(PUBLISH_REQUIRED_FIELDS.includes("version"), "the gate stopped requiring `version`; it is the one field the publish path synthesises");
});

test("both READERS take the derivation — neither re-hand-types the set (the edge itself is pinned)", () => {
  // A gate pin that only reads the derived module cannot catch someone
  // REPLACING the derivation with a fresh literal at the reader — measured: the
  // first version of this file passed with `const REQUIRED_MANIFEST = [...7
  // names...]` hard-typed back into src/hub/api.ts, because the derived module
  // was untouched and therefore still agreed with itself. So the EDGE is pinned
  // too, the same way `realRunnerIds()` anchors to its table and refuses to
  // answer when the anchor is gone rather than reporting a plausible number.
  const api = read("src/hub/api.ts");
  assert.match(
    api,
    /import \{ PUBLISH_REQUIRED_FIELDS \} from "\.\/publish-contract\.js"/,
    "src/hub/api.ts no longer imports the derived set — REQUIRED_MANIFEST has been re-hand-typed"
  );
  assert.match(
    api,
    /const REQUIRED_MANIFEST = PUBLISH_REQUIRED_FIELDS;/,
    "src/hub/api.ts no longer gates on the derived set"
  );
  assert.doesNotMatch(
    api,
    /const REQUIRED_MANIFEST = \[/,
    "src/hub/api.ts re-declared REQUIRED_MANIFEST as a literal — the derivation is bypassed"
  );
  const ui = read("src/hub/ui.ts");
  assert.match(
    ui,
    /import \{ publishTemplateJson \} from "\.\/publish-contract\.js"/,
    "src/hub/ui.ts no longer renders the derived template — the UI is back to a hand-typed copy"
  );
  assert.match(ui, /id="manifest">\$\{publishTemplateJson\(\)\}<\/textarea>/, "the rendered template is no longer the derived one");
  assert.doesNotMatch(ui, /id="manifest">\{ "/, "src/hub/ui.ts re-inlined a literal manifest template — the derivation is bypassed");
});

test("the legacy dead-artifact refusal is unchanged (no regression in the seam that shares this file)", () => {
  // packageCommandRefusal() lives beside the derivation now; pin that adding the
  // tuple did not disturb the GOAL 66 refusal, which must still name the dead
  // pair and the modern path.
  const r = packageCommandRefusal("gemini", resolve(ROOT, "sites"));
  assert.match(r, /action-map\.json/, "the refusal no longer names the dead artifact");
  assert.match(r, /capabilities\//, "the refusal no longer names the modern packaging path");
});

test("buildPackage still writes every tupled field with a non-empty value (the derivation is not an empty claim)", () => {
  // The gate requires a TRUTHY value (`!manifest?.[k]`), so a writer that
  // emitted an empty string for a required field would make the whole publish
  // path 400. Written to a tmp dir; nothing touches capabilities/ or data/.
  const base = mkdtempSync(resolve(tmpdir(), "u2a-pubcontract-"));
  const sites = resolve(base, "sites");
  mkdirSync(resolve(sites, "example.test"), { recursive: true });
  writeFileSync(
    resolve(sites, "example.test", "action-map.json"),
    JSON.stringify({
      host: "example.test",
      url: "https://example.test/",
      trusted: false,
      actions: [
        {
          name: "ping",
          description: "read-only ping",
          execution: "live-js",
          parameters: [],
          recipe: { kind: "js-function", target: "App.ping" },
          result: { mode: "return" },
        },
      ],
    })
  );
  const dir = buildPackage("example.test", sites, resolve(base, "data"), { author: "alice", use: "own use" });
  const meta = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8")) as Record<string, unknown>;
  for (const f of PUBLISH_REQUIRED_FIELDS) {
    if (f === "version") continue; // synthesised by cmdHubPublish, not by buildPackage
    assert.ok(meta[f], `buildPackage wrote an empty "${f}" but the publish gate requires it truthy`);
  }
  assert.equal(meta["ui2api"], UI2API_VERSION, "the ui2api buildPackage stamps is not the version the template tells operators to declare");
});
