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
