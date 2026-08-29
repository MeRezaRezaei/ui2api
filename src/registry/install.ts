import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateActionMap } from "../schema.js";
import { generate } from "../generator/generate.js";
import type { ActionMap } from "../types.js";

export async function installPackage(host: string, registryBaseUrl: string, sitesRoot: string): Promise<string> {
  const base = `${registryBaseUrl.replace(/\/$/, "")}/packages/${encodeURIComponent(host)}`;
  const [metaRes, mapRes] = await Promise.all([fetch(`${base}/metadata.json`), fetch(`${base}/action-map.json`)]);
  if (!metaRes.ok || !mapRes.ok) throw new Error(`Package ${host} not found in registry (${metaRes.status}/${mapRes.status})`);
  const metadata = await metaRes.json();
  const map = validateActionMap((await mapRes.json()) as ActionMap);
  const hostDir = resolve(sitesRoot, host);
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(resolve(hostDir, "action-map.json"), JSON.stringify(map, null, 2));
  writeFileSync(resolve(hostDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  return generate(map, sitesRoot);
}
