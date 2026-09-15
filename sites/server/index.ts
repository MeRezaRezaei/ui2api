import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadPluginFromMap } from "../../src/plugin/loader.js";
import { servePlugin } from "../../src/plugin/serve.js";

const mapPath = fileURLToPath(new URL("./action-map.json", import.meta.url));
const map = JSON.parse(readFileSync(mapPath, "utf8"));
const SITES_ROOT = "/home/me/Documents/projects/ui2api/sites";
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
