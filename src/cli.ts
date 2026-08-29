import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyse } from "./analyzer/explore.js";
import { generate } from "./generator/generate.js";
import { validateActionMap } from "./schema.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITES = resolve(SRC_DIR, "..", "sites");

interface Flags {
  root?: string;
  out?: string;
  llm?: boolean;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") f.root = argv[++i];
    if (argv[i] === "--out") f.out = argv[++i];
    if (argv[i] === "--llm") f.llm = true;
  }
  return f;
}

function sitesRoot(flags: Flags): string {
  return flags.out || DEFAULT_SITES;
}

function mapPath(host: string, root: string): string {
  return resolve(root, host, "action-map.json");
}

async function cmdAnalyse(url: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  const map = await analyse(url, { root: flags.root, outDir: root, llm: flags.llm });
  const host = map.host;
  mkdirSync(resolve(root, host), { recursive: true });
  writeFileSync(mapPath(host, root), JSON.stringify(map, null, 2));
  console.log(`Analyzed ${host}: ${map.actions.length} actions -> ${mapPath(host, root)}`);
  console.log("Run: ui2api generate " + host + (flags.out ? ` --out ${flags.out}` : ""));
}

async function cmdGenerate(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  if (!existsSync(mapPath(host, root))) throw new Error("No action-map for " + host + ". Run analyse first.");
  const map = validateActionMap(JSON.parse(readFileSync(mapPath(host, root), "utf8")));
  const serverDir = generate(map, root);
  console.log(`Generated MCP server -> ${serverDir}/index.ts`);
}

async function cmdServe(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  const serverDir = resolve(root, host, "server");
  const mod = await import(pathToFileURL(resolve(serverDir, "index.ts")).href);
  await (mod as any).runServer();
}

async function cmdRemap(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  const prevPath = mapPath(host, root);
  if (!existsSync(prevPath)) throw new Error("No action-map for " + host + ". Run analyse first.");
  const prev = validateActionMap(JSON.parse(readFileSync(prevPath, "utf8")));
  const map = await analyse(prev.url, { root: flags.root, outDir: root });
  // Diff: keep stable names, flag removed as deprecated.
  const prevNames = new Set(prev.actions.map((a) => a.name));
  const newNames = new Set(map.actions.map((a) => a.name));
  const added = [...newNames].filter((n) => !prevNames.has(n));
  const removed = [...prevNames].filter((n) => !newNames.has(n));
  writeFileSync(mapPath(host, root), JSON.stringify(map, null, 2));
  writeFileSync(
    resolve(root, host, "remap-diff.json"),
    JSON.stringify({ added, removed, kept: [...newNames].filter((n) => prevNames.has(n)) }, null, 2)
  );
  console.log(`Remap done. added=${added.length} removed=${removed.length}`);
  if (removed.length) console.log("DEPRECATED (downstream-safe): " + removed.join(", "));
}

async function main(): Promise<void> {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "analyse":
      if (!arg) throw new Error("usage: ui2api analyse <url> [--root App] [--out DIR]");
      return cmdAnalyse(arg, flags);
    case "generate":
      if (!arg) throw new Error("usage: ui2api generate <host> [--out DIR]");
      return cmdGenerate(arg, flags);
    case "serve":
      if (!arg) throw new Error("usage: ui2api serve <host> [--out DIR]");
      return cmdServe(arg, flags);
    case "remap":
      if (!arg) throw new Error("usage: ui2api remap <host> [--out DIR]");
      return cmdRemap(arg, flags);
    default:
      console.log("UI2API — turn any website into MCP tools for AI\n");
      console.log("  ui2api analyse  <url>   [--root App] [--out DIR]");
      console.log("  ui2api generate <host>  [--out DIR]");
      console.log("  ui2api serve    <host>  [--out DIR]");
      console.log("  ui2api remap    <host>  [--out DIR]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
