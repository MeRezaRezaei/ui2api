import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionMap } from "../types.js";
import { validateActionMap } from "../schema.js";
import { acpServerTemplate } from "./acp-template.js";
import { skillTemplate, skillLoaderTemplate } from "./skill-template.js";

// Absolute path to this project's src/ so generated servers can import the
// shared runtime/types under tsx.
export const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function serverTemplate(root: string, serverDir: string): string {
  // Relative path from the emitted server file back to the repo's src/ so the
  // generated server imports the real loader/serve modules at runtime under tsx.
  // Computed per-generation so it resolves correctly regardless of where the
  // server is emitted (e.g. sites/<host>/server or the integration test's tmp).
  const rel = relative(serverDir, SRC_DIR).split(sep).join("/");
  const loaderImport = `${rel}/plugin/loader.js`;
  const serveImport = `${rel}/plugin/serve.js`;
  return `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPluginFromMap } from ${JSON.stringify(loaderImport)};
import { servePlugin } from ${JSON.stringify(serveImport)};

const mapPath = fileURLToPath(new URL("./action-map.json", import.meta.url));
const map = JSON.parse(readFileSync(mapPath, "utf8"));
const SITES_ROOT = ${JSON.stringify(root)};
const loaded = loadPluginFromMap(map, { dataDir: SITES_ROOT }, map.url);

export async function runServer(): Promise<void> {
  console.error("[ui2api] use at your own risk — only automate sites you are authorized to use.");
  await servePlugin(loaded, { transport: "stdio", trust: !!map.trusted || !!process.env.UI2API_TRUST });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
`;
}

export function generate(
  map: ActionMap,
  outDir?: string,
  target: "mcp" | "acp" = "mcp",
  opts: { skill?: boolean } = {}
): string {
  validateActionMap(map);
  const root = outDir || resolve(SRC_DIR, "..", "sites", map.host);
  const serverDir = resolve(root, "server");
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(resolve(serverDir, "index.ts"), serverTemplate(root, serverDir));
  if (target === "acp") {
    writeFileSync(resolve(serverDir, "acp.ts"), acpServerTemplate(root));
  }
  if (opts.skill) {
    writeFileSync(resolve(serverDir, "SKILL.md"), skillTemplate(map));
    writeFileSync(resolve(serverDir, "skill-loader.mjs"), skillLoaderTemplate());
  }
  const mapSrc = resolve(root, "action-map.json");
  if (existsSync(mapSrc)) {
    // keep the analyzed map as source of truth; copy into server dir
    copyFileSync(mapSrc, resolve(serverDir, "action-map.json"));
  } else {
    const generated: ActionMap = { ...map, trusted: false };
    writeFileSync(mapSrc, JSON.stringify(generated, null, 2));
    writeFileSync(resolve(serverDir, "action-map.json"), JSON.stringify(generated, null, 2));
  }
  return serverDir;
}
