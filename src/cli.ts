#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { analyse } from "./analyzer/explore.js";
import { generate } from "./generator/generate.js";
import { validateActionMap } from "./schema.js";
import { sessionPath, saveCookies, buildLaunchOptions, usingUserChrome } from "./runtime/browser.js";
import { capturePageStorage, saveSnapshot, snapshotPath } from "./runtime/session-store.js";
import { buildPackage } from "./registry/package.js";
import { installPackage } from "./registry/install.js";
import { startHub } from "./hub/server.js";
import { pushToMirror } from "./hub/mirror.js";
import { RegistryStore } from "./hub/store.js";
import { HubRuntime } from "./hub/runtime.js";
import { serveInstanceStdio, serveInstanceAcp } from "./hub/serve.js";
import { servePlugin } from "./plugin/serve.js";
import { loadPluginModule } from "./plugin/loader.js";
import { resolveProfile, listProfiles, defaultSiteId } from "./profile/profile.js";
import { ChatDriver } from "./prompt/driver.js";
import { startPromptd } from "./prompt/http.js";

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
  poolMin?: number;
  poolMax?: number;
  acp?: boolean;
  mirror?: boolean;
  registryRepo?: string;
  baseUrl?: string;
  engine?: string;
  site?: string;
  profile?: string;
  json?: boolean;
  newChat?: boolean;
  timeoutMs?: number;
  sites?: boolean;
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
    if (argv[i] === "--base-url") f.baseUrl = argv[++i];
    if (argv[i] === "--engine") f.engine = argv[++i];
    if (argv[i] === "--site") f.site = argv[++i];
    if (argv[i] === "--profile") f.profile = argv[++i];
    if (argv[i] === "--json") f.json = true;
    if (argv[i] === "--new") f.newChat = true;
    if (argv[i] === "--timeout-ms") f.timeoutMs = Number(argv[++i]) || undefined;
    if (argv[i] === "--pool-min") f.poolMin = Number(argv[++i]) || undefined;
    if (argv[i] === "--pool-max") f.poolMax = Number(argv[++i]) || undefined;
    if (argv[i] === "--sites") f.sites = true;
  }
  return f;
}

function sitesRoot(flags: Flags): string {
  return flags.out || DEFAULT_SITES;
}

// The only accepted engine names, symmetrical with `readEngine()` in context.ts.
function validateEngine(name: string): void {
  if (name !== "native" && name !== "wigolo") {
    throw new Error("unknown engine '" + name + "' (expected 'native' or 'wigolo')");
  }
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
  // then saves the FULL session (cookies + localStorage/sessionStorage/IndexedDB
  // profile snapshot) before normal (headless) analysis runs. The snapshot is
  // what makes later runs behave like the user's real logged-in session.
  if (flags.login) {
    const host = new URL(url).host;
    const session = await doInteractiveLogin(url, host);
    saveCookies(sessionPath(root, host), session.cookies);
    saveSnapshot(snapshotPath(root, host), session.snapshot);
    console.log(`Saved session snapshot -> ${snapshotPath(root, host)}`);
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
// place we ever call chromium.launch with headless:false. When the user has set
// UI2API_CHROME / UI2API_USER_DATA_DIR, the login happens in THEIR real Chrome
// and profile so the authenticated session lives in their own data — the core of
// the "drive the user's own browser" vision; otherwise a fresh bundled Chromium
// window is used and the resulting session is captured. Returns cookies + the
// full profile snapshot (cookies + localStorage + sessionStorage + IndexedDB).
async function doInteractiveLogin(url: string, host: string): Promise<{ cookies: unknown[]; snapshot: import("./runtime/session-store.js").ProfileSnapshot }> {
  const { chromium } = await import("playwright");
  const opts = buildLaunchOptions({ headless: false });
  const browser = await chromium.launch(opts as any);
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    console.log(`[ui2api] Login page opened${usingUserChrome() ? " (your Chrome + profile)" : ""}. Sign in, then return here and press Enter.`);
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("Press Enter once logged in: ", () => {
        rl.close();
        resolve();
      });
    });
    const cookies = await page.context().cookies();
    // The snapshot captures the same origin the page is on; if the login flow
    // redirected off the target origin, fall back to the final landing origin —
    // the FIRST-party cookies are what carry the auth.
    const snapshot = await capturePageStorage(page, {
      host,
    }).catch((e) => {
      console.error(`[ui2api] snapshot capture failed (${String(e)}) — saving cookies only`);
      return {
        version: 1 as const,
        host,
        origin: page.url().startsWith("http") ? new URL(page.url()).origin : "",
        capturedAt: new Date().toISOString(),
        cookies: cookies as unknown as Array<Record<string, unknown>>,
        localStorage: [],
        sessionStorage: [],
        indexedDB: [],
      };
    });
    return { cookies, snapshot };
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
  // Engine: --engine wins over UI2API_ENGINE. Validated so a typo fails fast.
  if (flags.engine) validateEngine(flags.engine);
  if (flags.engine) process.env.UI2API_ENGINE = flags.engine;
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
  if (!host) throw new Error("usage: ui2api hub run <host> [--acp] [--port N] [--data-dir DIR] [--engine wigolo|native]");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const store = new RegistryStore(dataDir);
  const rt = new HubRuntime({ store, dataDir });
  if (flags.engine) validateEngine(flags.engine);
  if (flags.engine) process.env.UI2API_ENGINE = flags.engine;
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

async function cmdPluginServe(modulePath: string, flags: Flags): Promise<void> {
  if (!modulePath) throw new Error("usage: ui2api plugin serve <module.ts> [--base-url URL] [--data-dir DIR]");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const baseUrl = flags.baseUrl ?? "https://example.com";
  const loaded = await loadPluginModule(resolve(modulePath), { dataDir }, baseUrl);
  console.log(`[ui2api] serving plugin ${loaded.manifest?.name ?? modulePath} (${loaded.tools.size} tools) over MCP`);
  await servePlugin(loaded, { trust: true });
}

async function cmdPrompt(text: string, flags: Flags): Promise<void> {
  if (flags.sites) {
    for (const p of listProfiles()) {
      console.log(`${p.id.padEnd(12)} ${p.name} — ${p.loginRequired ? "login required" : "anonymous"}`);
    }
    console.log(`\ndefault: ${defaultSiteId()}`);
    return;
  }
  if (!text?.trim()) {
    throw new Error(
      "usage: ui2api prompt '<text>' [--site gemini|chatgpt|claude|copilot|perplexity|huggingchat] [--profile FILE] [--new] [--timeout-ms N] [--data-dir DIR] [--json]"
    );
  }
  const profile = resolveProfile(flags.site ?? flags.profile);
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const driver = new ChatDriver(profile, { dataDir });
  try {
    const r = await driver.ask(text, { newChat: flags.newChat, timeoutMs: flags.timeoutMs });
    if (flags.json) {
      console.log(JSON.stringify({ site: profile.id, ...r }, null, 2));
    } else {
      console.log(r.answer);
      console.error(`[ui2api] ${profile.id} · ${r.doneReason} · ${r.chunkCount} reads · ${r.url}`);
    }
  } finally {
    await driver.close();
  }
}

async function cmdLiveProof(flags: Flags): Promise<void> {
  const a = Math.floor(Math.random() * 10000) + 2;
  const b = Math.floor(Math.random() * 10000) + 2;
  const expected = a + b;
  console.log(`[proof] a=${a} b=${b} expected=${expected}`);
  const profile = resolveProfile(flags.site ?? "copilot");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const question = `What is ${a} + ${b}? Reply with ONLY the number, no words or explanation.`;
  // The host can hard-kill a fresh browser seconds after spawn (int3 trap), so
  // a live proof must ride fresh spawns until one survives the streamed answer.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const driver = new ChatDriver(profile, { dataDir });
    try {
      console.log(`[proof] attempt ${attempt} — asking ${profile.id}: ${question}`);
      const r = await driver.ask(question, { timeoutMs: 55000, stableMs: 1200 });
      const match = String(r.answer).match(/[\d,]+/g);
      const got = match ? Number(match[match.length - 1]!.replace(/,/g, "")) : NaN;
      const pass = got === expected;
      console.log(`[proof] answer: ${r.answer}`);
      console.log(`[proof] parsed=${got} expected=${expected} -> ${pass ? "PASS" : "FAIL"}`);
      if (pass) {
        process.exitCode = 0;
        return;
      }
    } catch (e) {
      console.log(`[proof] attempt ${attempt} died: ${(e as Error).message.split("\n")[0].slice(0, 100)}`);
    } finally {
      await driver.close().catch(() => {});
    }
  }
  console.log("[proof] FAILED: no surviving browser completed the round-trip");
  process.exitCode = 1;
}

async function cmdPromptd(flags: Flags): Promise<void> {
  const port = Number(flags.port ?? process.env.UI2API_PROMPTD_PORT ?? 9797);
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const profiles = flags.site ? [resolveProfile(flags.site)] : undefined;
  const svc = await startPromptd({
    port,
    dataDir,
    token: process.env.UI2API_PROMPTD_TOKEN ?? "",
    profiles,
    min: flags.poolMin,
    max: flags.poolMax,
  });
  const shown = profiles ? profiles.map((p) => p.id).join(", ") : listProfiles().map((p) => p.id).join(", ");
  console.log(`[ui2api] promptd on http://127.0.0.1:${svc.port} · sites: ${shown} · default: ${defaultSiteId()}`);
  console.log(`[ui2api] POST /prompt  {"prompt":"...", "site":"gemini", "newChat":true}`);
  console.log(`[ui2api] GET  /status  -> pool (warm/idle/busy pages)  ·  UI2API_POOL_MIN/MAX=${flags.poolMin ?? "auto"}/${flags.poolMax ?? "auto"} · UI2API_ATTACH_PORT=${process.env.UI2API_ATTACH_PORT ?? "off"}`);
  const shutdown = async (): Promise<void> => { await svc.close(); process.exit(0); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  svc.server.on("error", (e) => {
    console.error("[ui2api] promptd error:", e.message);
    process.exit(1);
  });
}

async function cmdProfileCapture(url: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const host = new URL(url).host;
  const session = await doInteractiveLogin(url, host);
  saveCookies(sessionPath(dataDir, host), session.cookies);
  saveSnapshot(snapshotPath(dataDir, host), session.snapshot);
  console.log(`[ui2api] profile captured for ${host}:`);
  console.log(`  cookies  -> ${sessionPath(dataDir, host)}`);
  console.log(`  snapshot (cookies + localStorage + sessionStorage + IndexedDB) -> ${snapshotPath(dataDir, host)}`);
  console.log(`Sites driven through ui2api now see your logged-in session — chat history persists.`);
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
    case "plugin": {
      if (arg === "serve") return cmdPluginServe(rest[0] ?? "", flags);
      throw new Error("usage: ui2api plugin serve <module.ts> [--base-url URL] [--data-dir DIR]");
    }
    case "profile": {
      if (arg === "capture") {
        if (!rest[0]) throw new Error("usage: ui2api profile capture <url> [--data-dir DIR]");
        return cmdProfileCapture(rest[0], flags);
      }
      throw new Error("usage: ui2api profile capture <url> [--data-dir DIR]");
    }
    case "prompt":
      return cmdPrompt(arg ?? "", flags);
    case "promptd":
      return cmdPromptd(flags);
    case "proof":
    case "live-proof":
      return cmdLiveProof(flags);
    default:
      console.log("UI2API — turn any website into MCP tools for AI\n");
      console.log("  ui2api analyse  <url>   [--root App] [--out DIR] [--llm] [--max-tasks N] [--login] [--cookies FILE]");
      console.log("  ui2api generate <host>  [--out DIR]");
      console.log("  ui2api serve    <host>  [--out DIR] [--engine native|wigolo]  (wigolo = drive the browser side through a local wigolo daemon)");
      console.log("  ui2api remap    <host>  [--out DIR]");
      console.log("  ui2api package  <host>  --author NAME --use 'authorized-use statement' [--out DIR]");
      console.log("  ui2api install  <host>  [--registry URL]");
      console.log("  ui2api hub            [--port N] [--data-dir DIR]  (start registry server)");
      console.log("  ui2api hub publish <host> [--mirror] [--registry-repo URL]  (build + PUT to hub; --mirror also pushes to community registry)");
      console.log("  ui2api hub run <host> [--acp] [--port N] [--data-dir DIR] [--engine native|wigolo]  (serve a registered plugin)");
      console.log("  ui2api plugin serve <module.ts> [--base-url URL]  (serve a plugin module as MCP)");
      console.log("  ui2api profile capture <url> [--data-dir DIR]  (login once, save cookies+localStorage+IndexedDB snapshot)");
      console.log("  ui2api prompt '<text>' [--site ...]  (drive an AI chat website to answer a prompt — the MVP command)");
      console.log("  ui2api promptd            [--port N] [--pool-min N] [--pool-max N]  (localhost HTTP service: POST /prompt, GET /sites, GET /health)");
      console.log("  ui2api prompt --sites                (list the configured AI chat websites)");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
