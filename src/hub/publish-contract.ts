/**
 * THE PUBLISHED-MANIFEST CONTRACT — derived once, read by the gate AND the docs.
 *
 * Three surfaces describe the same object — the manifest body a publish carries:
 *
 *   1. `src/registry/package.ts` buildPackage()  — WRITES it (the only writer)
 *   2. `src/hub/api.ts`        REQUIRED_MANIFEST — GATES on it (PUT /api/packages)
 *   3. `src/hub/ui.ts`         publish template  — DOCUMENTS it (the operator's
 *                                                     only in-product example)
 *
 * All three used to hold their own hand-typed copy of the field names, with
 * nothing tying them together. That is the rot class this repo keeps finding:
 * a hand-written table where a derived one is available, quietly disagreeing
 * with the code it describes. The two copies agreed on today's data (measured
 * 6/6 keys, 0 differing) — the point is that agreement was luck, not
 * construction, and the one value that was NOT luck had already rotted: the UI
 * template told operators to declare `"ui2api": "0.1.0"` while this build is
 * `0.2.0`.
 *
 * THE KEYS/VALUES SPLIT, and why:
 *
 *  - The KEY SET is derived. It is a fact about the writer: which fields
 *    `buildPackage` puts in the object, minus the fields the STORE owns, plus
 *    the one field the publish path synthesises. All three parts are named
 *    below with the reason they are not simply "every PackageMeta field".
 *
 *  - The VALUES stay written out. A field name is a fact about this repo; the
 *    example values are a PUBLISHED CONTRACT an operator copies — `"MIT"` is a
 *    sample of a licence the operator chooses, `"own authorized use"` is
 *    operator-authored prose, and the package `name`/`author` are the operator's
 *    own. None can be derived from the code, and inventing one would be the
 *    fabrication this repo forbids. The single exception is `ui2api`, which IS
 *    a fact about this build (the value `buildPackage` stamps), and that one is
 *    derived — see UI2API_VERSION.
 *
 * WHY A SEPARATE MODULE: `src/hub/api.ts` already imports `src/hub/ui.ts`, so
 * `ui.ts` importing the gate back would close a cycle. The derived set lives
 * here — a leaf that imports only the WRITER — so both readers take the same
 * edge in the same direction. Checked, not assumed: the transitive closure of
 * this module is {publish-contract, registry/package, schema, types} and reaches
 * no other file under src/hub/, so neither edge can close a loop.
 */
import { PACKAGE_META_FIELDS, UI2API_VERSION, type PackageMetaField } from "../registry/package.js";

/**
 * Fields `buildPackage` writes that the PUBLISH GATE deliberately does not
 * require. Each is a fact about the store, not about the package:
 *
 *  - `host` — the store keys packages by `name` (RegistryStore.save(name, …)),
 *    so `host` is a redundant second identity in the published body. Requiring
 *    it would 400 a manifest the store handles perfectly well.
 *  - `trust` — the STORE's authority, not the publisher's: `RegistryStore.save`
 *    hardcodes `trust: "unreviewed"` on the index entry and only
 *    `POST /api/packages/:name/:version/review` promotes it to `reviewed`. A
 *    publisher that could satisfy a `trust` requirement would be claiming a
 *    review that did not happen, so the field is written (it is in the legacy
 *    metadata) but never required.
 */
export const STORE_OWNED_FIELDS: readonly PackageMetaField[] = ["host", "trust"];

/**
 * Field a publish body carries that `buildPackage` does NOT write.
 *
 * `cmdHubPublish` (src/cli.ts:504) builds the body as
 * `{ ...metadata, version: metadata.version || "1.0.0" }`. `PackageMeta` has no
 * `version` member — `ui2api` is the ui2api version, a different thing — so the
 * published manifest's own `version` is ALWAYS that fallback. It is therefore a
 * real required field of a publish body, and it is named here rather than
 * hand-typed into the gate's list a second time.
 */
export const PUBLISH_SYNTHESISED_FIELDS: readonly string[] = ["version"];

/**
 * The field set a `PUT /api/packages` body must carry: everything the writer
 * produces, less what the store owns, plus what the publish path synthesises.
 * Order is the writer's order, then the synthesised field — stable, so the UI
 * template renders the same order every time.
 */
export const PUBLISH_REQUIRED_FIELDS: readonly string[] = [
  ...PACKAGE_META_FIELDS.filter((f) => !STORE_OWNED_FIELDS.includes(f)),
  ...PUBLISH_SYNTHESISED_FIELDS,
];

/**
 * The example values the hub UI pre-fills into its publish form, keyed by
 * field. The KEYS come from PUBLISH_REQUIRED_FIELDS (never hand-listed, so the
 * template cannot advertise a field the gate ignores or omit one it demands).
 *
 * Each VALUE carries its reason for staying typed, and every one of them is an
 * operator choice except `ui2api`, which is this build's own version and is
 * derived. A test pins that the value map covers every required field, so a new
 * required field cannot ship without a template entry.
 */
export const PUBLISH_TEMPLATE_VALUES: Readonly<Record<string, string>> = {
  // The package's own identity — a function of the operator's `--host`, so a
  // sample is the honest illustration (buildPackage stamps `ui2api-site-<host>`).
  name: "",
  // The PACKAGE's version, not ui2api's. `cmdHubPublish` falls back to "1.0.0"
  // because PackageMeta has no `version`; kept literal as the published sample,
  // and pinned against src/cli.ts so a change there is a named failure.
  version: "1.0.0",
  // Operator-supplied (UI2API_HUB_AUTHOR), so it is empty in the template.
  author: "",
  // Operator-authored prose. The gate requires it (validate-registry.mjs
  // `validateManifest` refuses <4 chars); the wording is theirs, not ours.
  authorizedUse: "own authorized use",
  // A licence the operator chooses. "MIT" is buildPackage's DEFAULT (an
  // overridable one), shown as the sample — deriving the default here would
  // make an override look like it was ignored.
  license: "MIT",
  // THE ONE DERIVED VALUE. This is what buildPackage stamps into every
  // metadata.json, so it is what a publish body must declare. Hardcoding it here
  // is what made the template claim "0.1.0" on a 0.2.0 build.
  ui2api: UI2API_VERSION,
};

/** The pre-filled manifest JSON the hub UI shows the operator. Derived. */
export function publishTemplateJson(): string {
  return `{ ${PUBLISH_REQUIRED_FIELDS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(PUBLISH_TEMPLATE_VALUES[k] ?? "")}`).join(", ")} }`;
}
