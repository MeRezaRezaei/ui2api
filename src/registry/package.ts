import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionMap } from "../types.js";
import { validateActionMap } from "../schema.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI2API_VERSION = JSON.parse(readFileSync(resolve(SRC_DIR, "package.json"), "utf8")).version;

export interface PackageMeta {
  host: string;
  name: string;
  author: string;
  authorizedUse: string;
  license: string;
  ui2api: string;
  trust: "reviewed" | "unreviewed";
}

/**
 * LEGACY DEAD-ARTIFACT package writer (GOAL 66, 2026-09-25).
 *
 * Writes the `metadata.json` + `action-map.json` pair — the shape
 * src/registry/install.ts explicitly declares dead ("there is NO
 * action-map.json anymore … install can never drift back to the dead
 * metadata+action-map pair"). The output dir `<pkgRoot>/packages/<host>/` is
 * read by NO modern consumer: findPackageDir / listInstalledPackageIds /
 * buildRegistryPackages read `capabilities/<id>/manifest.json`, install reads
 * the REMOTE registry, the hub store reads `data/pkgs/<name>/<version>.json`.
 *
 * This function is kept ONLY for `cmdHubPublish` (the legacy hub runtime
 * consumes the action-map JSON as its "module") and its pinned regression in
 * test/package.test.ts. The STANDALONE `ui2api package` command refuses LOUD
 * via packageCommandRefusal() instead — it must never claim success for an
 * artifact nothing serves.
 */
export function buildPackage(
  host: string,
  sitesRoot: string,
  pkgRoot: string,
  meta: { author: string; use: string; license?: string }
): string {
  const src = resolve(sitesRoot, host, "action-map.json");
  if (!existsSync(src)) throw new Error(`No analyzed map for ${host} at ${src}`);
  const map = validateActionMap(JSON.parse(readFileSync(src, "utf8")));
  const dir = resolve(pkgRoot, "packages", host);
  mkdirSync(dir, { recursive: true });
  const metadata: PackageMeta = {
    host,
    name: `ui2api-site-${host}`,
    author: meta.author,
    authorizedUse: meta.use,
    license: meta.license || "MIT",
    ui2api: UI2API_VERSION,
    trust: "unreviewed",
  };
  writeFileSync(resolve(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
  writeFileSync(resolve(dir, "action-map.json"), JSON.stringify(map, null, 2));
  return dir;
}

export function readPackage(pkgDir: string): { metadata: PackageMeta; map: ActionMap } {
  const metadata = JSON.parse(readFileSync(resolve(pkgDir, "metadata.json"), "utf8")) as PackageMeta;
  const map = validateActionMap(JSON.parse(readFileSync(resolve(pkgDir, "action-map.json"), "utf8")));
  return { metadata, map };
}

/**
 * GOAL 66 (2026-09-25): the STANDALONE `ui2api package <host>` command must
 * refuse LOUD instead of claiming success for the dead metadata+action-map
 * artifact. Returns the named verdict: the dead pair, the unread output dir,
 * and the modern packaging path. Throwing this message writes NOTHING — no
 * "Packaged X -> dir" fabrication.
 */
export function packageCommandRefusal(host: string, sitesRoot: string): string {
  const legacyDir = resolve(sitesRoot, "packages", host);
  return (
    `ui2api package only knows the DEAD metadata.json + action-map.json pair (written to ${legacyDir}), ` +
    `which no modern consumer reads — install/registry serve capabilities/<id>/manifest.json (+ profile.json), ` +
    `and a capture-level action-map cannot yield a capability package (no runner/recipe/profile to derive). ` +
    `Package a site the modern way instead: run ui2api analyse, hand-package under capabilities/<id>/ ` +
    `(manifest.json + profile.json + session.lock.json + CAPABILITIES.md + metadata.json), then it is served ` +
    `by /registry and /capability immediately (install-gate: GOAL 65). Refusing to write a dead artifact.`
  );
}
