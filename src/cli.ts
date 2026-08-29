import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { analyse } from "./analyzer/explore.js";
import { generate } from "./generator/generate.js";
import { validateActionMap } from "./schema.js";
import { sessionPath, saveCookies } from "./runtime/browser.js";
import { buildPackage } from "./registry/package.js";
import { installPackage } from "./registry/install.js";
import { startHub } from "./hub/server.js";
import { pushToMirror } from "./hub/mirror.js";
import { RegistryStore } from "./hub/store.js";
import { HubRuntime } from "./hub/runtime.js";
import { serveInstanceStdio, serveInstanceAcp } from "./hub/serve.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SITES = resolve(SRC_DIR, "..", "sites");

interface Flags {
  root?: string;
  out?: string;
  llm?: boolean;
  trust?: boolean;
  login?: boolean;
  cookies?: string;
  maxTasks?: number;
  author?: string;
  use?: string;
  registry?: string;
  dataDir?: string;
  port?: number;
  acp?: boolean;
  mirror?: boolean;
  registryRepo?: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") f.root = argv[++i];
    if (argv[i] === "--out") f.out = argv[++i];
    if (argv[i] === "--llm") f.llm = true;
    if (argv[i] === "--trust") f.trust = true;
    if (argv[i] === "--login") f.login = true;
    if (argv[i] === "--cookies") f.cookies = argv[++i];
    if (argv[i] === "--max-tasks") f.maxTasks = Number(argv[++i]) || undefined;
    if (argv[i] === "--author") f.author = argv[++i];
    if (argv[i] === "--use") f.use = argv[++i];
    if (argv[i] === "--registry") f.registry = argv[++i];
    if (argv[i] === "--data-dir") f.dataDir = argv[++i];
    if (argv[i] === "--port") f.port = Number(argv[++i]) || undefined;
    if (argv[i] === "--acp") f.acp = true;
    if (argv[i] === "--mirror") f.mirror = true;
    if (argv[i] === "--registry-repo") f.registryRepo = argv[++i];
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
  const host = new URL(url).host;

  // M7: a supplied --cookies <file> is injected into the site's session path so
  // analyse() can pick it up. We just persist it before analysis runs.
  if (flags.cookies) {
    const cookies = JSON.parse(readFileSync(flags.cookies, "utf8"));
    saveCookies(sessionPath(root, host), cookies);
    console.log(`Loaded cookies from ${flags.cookies} -> ${sessionPath(root, host)}`);
  }

  // M7: --login opens a headed browser for the user to authenticate manually,
  // then saves the resulting cookies before normal (headless) analysis runs.
  if (flags.login) {
    const cookies = await doInteractiveLogin(url);
    saveCookies(sessionPath(root, host), cookies);
    console.log(`Saved session cookies -> ${sessionPath(root, host)}`);
  }

  const map = await analyse(url, {
    root: flags.root,
    outDir: root,
    llm: flags.llm,
    maxTasks: flags.maxTasks,
  });
  mkdirSync(resolve(root, host), { recursive: true });
  writeFileSync(mapPath(host, root), JSON.stringify(map, null, 2));
  console.log(`Analyzed ${host}: ${map.actions.length} actions -> ${mapPath(host, root)}`);
  console.log("Run: ui2api generate " + host + (flags.out ? ` --out ${flags.out}` : ""));
}

// Launch a HEADED browser solely for the user to log in (M7). This is the ONLY
// place we ever call chromium.launch with headless:false. Returns the cookies.
async function doInteractiveLogin(url: string): Promise<unknown[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    console.log(`[ui2api] Login page opened. Sign in, then return here and press Enter.`);
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Press Enter once logged in: ", () => {
        rl.close();
        resolve();
      });
    });
    return await page.context().cookies();
  } finally {
    await browser.close();
  }
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
  const mapPath = resolve(serverDir, "action-map.json");
  if (!existsSync(mapPath)) throw new Error("No generated server for " + host + ". Run generate first.");
  const map = validateActionMap(JSON.parse(readFileSync(mapPath, "utf8")));
  if (!map.trusted && !flags.trust) throw new Error("action-map is untrusted — review it and re-run with --trust");
  const mod = await import(pathToFileURL(resolve(serverDir, "index.ts")).href);
  await (mod as any).runServer();
}

async function cmdPackage(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  if (!flags.author || !flags.use)
    throw new Error("usage: ui2api package <host> --author NAME --use 'authorized-use statement'");
  const dir = buildPackage(host, root, root, { author: flags.author, use: flags.use });
  console.log(`Packaged ${host} -> ${dir}`);
}

async function cmdInstall(host: string, flags: Flags): Promise<void> {
  const root = sitesRoot(flags);
  const reg = flags.registry || "https://raw.githubusercontent.com/MeRezaRezaei/ui2api-registry/main";
  const dir = await installPackage(host, reg, root);
  console.log(`Installed ${host} -> ${dir}; run: ui2api serve ${host}`);
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

async function cmdHubRun(host: string, flags: Flags): Promise<void> {
  if (!host) throw new Error("usage: ui2api hub run <host> [--acp] [--port N] [--data-dir DIR]");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const store = new RegistryStore(dataDir);
  const rt = new HubRuntime({ store, dataDir });
  const inst = await rt.getInstance(host);
  if (flags.acp) await serveInstanceAcp(inst, Number(flags.port ?? 8788));
  else await serveInstanceStdio(inst);
}

async function cmdHubPublish(host: string, flags: Flags = {}): Promise<void> {
  if (!host) throw new Error("usage: ui2api hub publish <host> [--mirror] [--registry-repo URL]");
  const sitesRoot = resolve(process.cwd(), "sites");
  const pkgRoot = resolve(process.cwd(), "data");
  const meta = {
    author: process.env.UI2API_HUB_AUTHOR || "cli",
    use: process.env.UI2API_HUB_USE || `own use of ${host}`,
  };
  const dir = buildPackage(host, sitesRoot, pkgRoot, meta);
  const metadata = JSON.parse(readFileSync(resolve(dir, "metadata.json"), "utf8"));
  const map = JSON.parse(readFileSync(resolve(dir, "action-map.json"), "utf8"));
  const manifest = { ...metadata, version: metadata.version || "1.0.0" };
  const moduleText = JSON.stringify(map, null, 2);
  const base = process.env.UI2API_HUB_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  const token = process.env.UI2API_HUB_TOKEN ?? "";
  const r = await fetch(`${base}/api/packages`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ manifest, module: moduleText }),
  });
  if (!r.ok) { console.error("publish failed:", await r.text()); process.exit(1); }
  console.log(`[ui2api] published ${manifest.name}@${manifest.version}`);
  if (flags.mirror) {
    pushToMirror({ name: manifest.name, version: manifest.version, manifest: manifest as Record<string, unknown>, module: moduleText }, { repoUrl: flags.registryRepo });
  }
}

async function main(): Promise<void> {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  // Parse flags from the whole command line so e.g. `ui2api hub --port N` works
  // even though `--port` would otherwise be swallowed into `arg`.
  const flags = parseFlags(process.argv.slice(2));
  switch (cmd) {
    case "hub": {
      if (arg === "publish") return cmdHubPublish(rest[0] ?? process.env.UI2API_HUB_HOST ?? "", flags);
      if (arg === "run") return cmdHubRun(rest[0] ?? "", flags);
      const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
      const token = process.env.UI2API_HUB_TOKEN ?? "";
      const port = Number(flags.port ?? process.env.PORT ?? 8787);
      const registryUrl = process.env.UI2API_REGISTRY_URL ?? "https://raw.githubusercontent.com/MeRezaRezaei/ui2api-registry/main";
      startHub({ port, dataDir, token, registryUrl });
      return;
    }
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
    case "package":
      if (!arg) throw new Error("usage: ui2api package <host> --author NAME --use 'authorized-use statement'");
      return cmdPackage(arg, flags);
    case "install":
      if (!arg) throw new Error("usage: ui2api install <host> [--registry URL]");
      return cmdInstall(arg, flags);
    default:
      console.log("UI2API — turn any website into MCP tools for AI\n");
      console.log("  ui2api analyse  <url>   [--root App] [--out DIR] [--llm] [--max-tasks N] [--login] [--cookies FILE]");
      console.log("  ui2api generate <host>  [--out DIR]");
      console.log("  ui2api serve    <host>  [--out DIR]");
      console.log("  ui2api remap    <host>  [--out DIR]");
      console.log("  ui2api package  <host>  --author NAME --use 'authorized-use statement' [--out DIR]");
      console.log("  ui2api install  <host>  [--registry URL]");
      console.log("  ui2api hub            [--port N] [--data-dir DIR]  (start registry server)");
      console.log("  ui2api hub publish <host> [--mirror] [--registry-repo URL]  (build + PUT to hub; --mirror also pushes to community registry)");
      console.log("  ui2api hub run <host> [--acp] [--port N] [--data-dir DIR]  (serve a registered plugin)");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
