#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { analyse } from "./analyzer/explore.js";
import { generate } from "./generator/generate.js";
import { validateActionMap } from "./schema.js";
import { sessionPath, saveCookies, buildLaunchOptions, usingUserChrome } from "./runtime/browser.js";
import { capturePageStorage, saveSnapshot, snapshotPath, saveAccountSnapshot, listAccounts, loadAccountSnapshot, slugifyIdentity, slugCollision, snapshotHasAuth } from "./runtime/session-store.js";
import { buildPackage } from "./registry/package.js";
import { installPackage, defaultPackagesRoot, fetchRegistryIndex, DEFAULT_REGISTRY_URL } from "./registry/install.js";
import { startHub } from "./hub/server.js";
import { pushToMirror } from "./hub/mirror.js";
import { RegistryStore } from "./hub/store.js";
import { HubRuntime } from "./hub/runtime.js";
import { serveInstanceStdio, serveInstanceAcp } from "./hub/serve.js";
import { servePlugin } from "./plugin/serve.js";
import { loadPluginModule } from "./plugin/loader.js";
import { resolveProfile, resolveProfileWithOverride, defaultSiteId } from "./profile/profile.js";
import { defaultChatProfiles, chatSurfaceStatus } from "./prompt/registry.js";
import { ChatDriver } from "./prompt/driver.js";
import { startPromptd, resolveCapabilityAccount } from "./prompt/http.js";

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
  assist?: boolean;
  catalog?: boolean;
  account?: string;
  identity?: string;
  identityPrefix?: string;
  known?: boolean;
  interactive?: boolean;
  xhostAll?: boolean;
  model?: string;
  lang?: string;
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
    if (argv[i] === "--assist") f.assist = true;
    if (argv[i] === "--catalog") f.catalog = true;
    if (argv[i] === "--account") f.account = argv[++i];
    if (argv[i] === "--identity") f.identity = argv[++i];
    if (argv[i] === "--identity-prefix") f.identityPrefix = argv[++i];
    if (argv[i] === "--known") f.known = true;
    if (argv[i] === "--interactive") f.interactive = true;
    if (argv[i] === "--xhost-all") f.xhostAll = true;
    if (argv[i] === "--model") f.model = argv[++i];
    if (argv[i] === "--lang") f.lang = argv[++i];
  }
  return f;
}

// Flags that CONSUME the next argv token as their value (mirror parseFlags
// above). requirementsSiteArg needs this so a flag's VALUE is never misread as
// the <site> positional — e.g. `--data-dir /tmp/d` must not yield "/tmp/d".
const VALUE_TAKING_FLAGS = new Set([
  "--root",
  "--out",
  "--cookies",
  "--max-tasks",
  "--author",
  "--use",
  "--registry",
  "--data-dir",
  "--port",
  "--registry-repo",
  "--base-url",
  "--engine",
  "--site",
  "--profile",
  "--timeout-ms",
  "--pool-min",
  "--pool-max",
  "--account",
  "--identity",
  "--identity-prefix",
  "--model",
  "--lang",
]);

// GOAL 44: the pure flag-aware first-positional reader shared by every
// free-string positional command. Iterates argv, skipping `--flag` tokens and
// (for VALUE_TAKING_FLAGS members) their VALUE token — so a flag's value is
// never mistaken for a positional and a positional is honored no matter where
// it sits (before OR after any flag). Returns the first remaining non-flag
// token, "" if none. Callers pass the argv slice AFTER their command token
// (a flag token can never be a positional value). Pure: no env, no I/O —
// directly unit-testable.
export function firstNonFlagArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) return tok;
    if (VALUE_TAKING_FLAGS.has(tok)) i++; // skip the flag's value token
  }
  return "";
}

// GOAL 43: the requirements/doctor <site> positional, read flag-aware from the
// WHOLE command argv. `requirements --json gemini` and
// `requirements gemini --json` scope IDENTICALLY — a site token is honored no
// matter where it sits (the old positional-only dispatch silently dropped a
// site that came after a flag: full 33-package report, exit 1 driven by
// unrelated dormant sites, no error, no hint). Flags and their VALUES are
// skipped (a flag-value token is never a site, the `--json`-as-site guard is
// preserved), and no site token ⇒ "" = the full report — never a partial
// verdict. argv[0] is the command itself ("requirements"/"doctor"). Pure: no
// env, no I/O — directly unit-testable.
export function requirementsSiteArg(argv: string[]): string {
  return firstNonFlagArg(argv.slice(1));
}

// GOAL 44: the prompt <text> positional — the argv slice the prompt case sees
// (process.argv.slice(2), command token first). `prompt --json "hello"` and
// `prompt "hello" --json` MUST ask the SAME text: the old raw argv[2]
// pass-through sent the literal flag token to the live default site with
// "hello" dropped in rest (never read) — a plausible JSON answer to the wrong
// question, no error, no hint. A flag (and its value) is skipped, never sent
// as text; no text token ⇒ "" → the existing usage throw fires (honest).
export function promptTextArg(argv: string[]): string {
  return firstNonFlagArg(argv.slice(1));
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

async function cmdInstallCatalog(flags: Flags): Promise<void> {
  const reg = flags.registry ?? process.env.UI2API_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const index = await fetchRegistryIndex(reg);
  const rows = Object.entries(index).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) {
    console.log(`(registry catalog is empty at ${reg})`);
    return;
  }
  console.log(`Registry catalog (${reg}):`);
  for (const [site, e] of rows) {
    const url = typeof e.url === "string" ? e.url : "(no url)";
    console.log(`${site.padEnd(28)} v${(e.version ?? "?").padEnd(8)} ${(e.trust ?? "?").padEnd(10)} ${url}`);
  }
}

async function cmdInstall(host: string, flags: Flags): Promise<void> {
  const reg = flags.registry ?? process.env.UI2API_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  // The install target is the packages root (capabilities/<site>/) — the same
  // layout the daemon serves from (resolvePackagedProfile / buildRegistryPackages).
  // --out overrides it (e.g. into a temp dir for a clean/isolated install).
  const root = flags.out ?? defaultPackagesRoot();
  const result = await installPackage(host, reg, root);
  const profileAbs = existsSync(resolve(result.dir, "profile.json"))
    ? resolve(result.dir, "profile.json")
    : undefined;
  console.log(`Installed ${host} v${result.version} (${result.trust}) -> ${result.dir}`);
  console.log(`Files: ${result.files.join(", ")}`);
  console.log(`The daemon serves installed capability packages (package dir = defaultPackagesRoot):`);
  console.log(`  ui2api promptd`); // GET /sites, GET /capabilities/<site>, POST /capability/<site>
  console.log(`  curl -s localhost:${process.env.PORT ? Number(process.env.PORT) : 9797}/registry`);
  if (profileAbs) {
    console.log(`Or prompt it directly via the ChatDriver with its packaged profile:`);
    console.log(`  ui2api prompt "hello" --site ${host} --profile ${profileAbs}`);
  }
}

async function cmdLangGen(host: string | undefined, flags: Flags): Promise<void> {
  const lang = flags.lang ?? "php";
  if (lang !== "php")
    throw new Error("langgen: only --lang php is implemented so far (laravel-compatible composer package)");
  const { buildRegistryPackages } = await import("./prompt/registry.js");
  const { generatePhpMaps } = await import("./generator/lang-php.js");
  const packages = buildRegistryPackages();
  if (host && !packages.some((p) => p.id === host))
    throw new Error(`langgen: no served registry package for '${host}' (installed: ${packages.map((p) => p.id).join(", ") || "none"})`);
  const outRoot = flags.out || resolve(process.cwd(), "sites", "map", lang);
  const dirs = generatePhpMaps(packages, outRoot, host);
  if (dirs.length === 0) throw new Error("langgen: no served registry packages to generate (run ui2api install <site> first)");
  for (const d of dirs) console.log(`Generated ${lang} map package -> ${d} (composer.json + src/, one method per capability)`);
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
  if (!modulePath) throw new Error("usage: ui2api plugin serve <module.ts> [--base-url URL] [--data-dir DIR] [--account SLUG|EMAIL]");
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  const baseUrl = flags.baseUrl ?? "https://example.com";
  const loaded = await loadPluginModule(resolve(modulePath), { dataDir, account: flags.account }, baseUrl);
  console.log(`[ui2api] serving plugin ${loaded.manifest?.name ?? modulePath} (${loaded.tools.size} tools) over MCP`);
  await servePlugin(loaded, { trust: true });
}

async function cmdPrompt(text: string, flags: Flags): Promise<void> {
  if (flags.sites) {
    for (const p of defaultChatProfiles()) {
      const status = chatSurfaceStatus(p.id);
      const statusSuffix = status === "builtin" ? "" : status === "verified" ? " — VERIFIED" : ` — ${status}`;
      console.log(`${p.id.padEnd(12)} ${p.name} — ${p.loginRequired ? "login required" : "anonymous"}${statusSuffix}`);
    }
    console.log(`\ndefault: ${defaultSiteId()}`);
    return;
  }
  if (!text?.trim()) {
    throw new Error(
      "usage: ui2api prompt '<text>' [--site gemini|chatgpt|claude|copilot|perplexity|huggingchat] [--profile FILE] [--new] [--model NAME] [--timeout-ms N] [--data-dir DIR] [--json]"
    );
  }
  // GOAL 62: the override seam must never silently drop the tuning file —
  // --site + --profile enforces id AGREEMENT (mismatched file.id -> LOUD
  // named error), absent file.id tunes the requested site. --profile alone
  // keeps the file-id-picks-base semantics unchanged.
  const profile =
    flags.site && flags.profile
      ? resolveProfileWithOverride(flags.site, flags.profile)
      : resolveProfile(flags.site ?? flags.profile);
  const dataDir = flags.dataDir ?? resolve(process.cwd(), "data");
  // Same vault-validated account guard as the daemon surfaces: an unknown
  // account fails loudly (non-zero) BEFORE any browser work, never a silent
  // fallback to the legacy default session.
  resolveCapabilityAccount(flags.account, profile, dataDir);
  const driver = new ChatDriver(profile, { dataDir, account: flags.account });
  try {
    const r = await driver.ask(text, { newChat: flags.newChat, timeoutMs: flags.timeoutMs, ...(flags.model ? { model: flags.model } : {}) });
    if (flags.json) {
      console.log(JSON.stringify({ site: profile.id, account: flags.account ?? "default", ...r }, null, 2));
    } else {
      console.log(r.answer);
      console.error(`[ui2api] ${profile.id}${flags.account ? ` / ${flags.account}` : ""} · ${r.doneReason} · ${r.chunkCount} reads · ${r.url}`);
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
  // Same vault-validated account guard as `prompt` (live-proof rides accounts too).
  resolveCapabilityAccount(flags.account, profile, dataDir);
  const question = `What is ${a} + ${b}? Reply with ONLY the number, no words or explanation.`;
  // The host can hard-kill a fresh browser seconds after spawn (int3 trap), so
  // a live proof must ride fresh spawns until one survives the streamed answer.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const driver = new ChatDriver(profile, { dataDir, account: flags.account });
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
  const profiles = flags.site && flags.profile
    ? [resolveProfileWithOverride(flags.site, flags.profile)]
    : flags.site ? [resolveProfile(flags.site)] : flags.profile ? [resolveProfile(flags.profile)] : undefined;
  const svc = await startPromptd({
    port,
    dataDir,
    token: process.env.UI2API_PROMPTD_TOKEN ?? "",
    profiles,
    min: flags.poolMin,
    max: flags.poolMax,
  });
  const shown = profiles ? profiles.map((p) => p.id).join(", ") : defaultChatProfiles().map((p) => p.id).join(", ");
  console.log(`[ui2api] promptd on http://127.0.0.1:${svc.port} · sites: ${shown} · default: ${defaultSiteId()}`);
  console.log(`[ui2api] POST /prompt  {"prompt":"...", "site":"gemini", "newChat":true}`);
  console.log(`[ui2api] POST /capability/<site>  ·  GET /registry  ·  GET /sites  ·  GET /accounts?site=  ·  GET /v1/models  ·  POST /v1/chat/completions`);
  console.log(`[ui2api] GET  /status  -> pool (warm/idle/busy pages)  ·  GET /requirements -> OS-level readiness (GOAL 33)  ·  UI2API_POOL_MIN/MAX=${flags.poolMin ?? "auto"}/${flags.poolMax ?? "auto"} · UI2API_ATTACH_PORT=${process.env.UI2API_ATTACH_PORT ?? "off"}`);
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

  // --assist: xhost display-share flow — data prefers the ui2api user (verbatim
  // 1495: "data ill be stored in the ui2api user not the current user"). The
  // browser runs headed on the caller's X display; the user logs in the
  // regular visual way. The data dir is the explicit flag/env override, else
  // the ui2api user's XDG data dir WHEN genuinely writable from this session,
  // else the current-user data dir (honest fallback — never fake the claim).
  if (flags.assist) {
    const { assistedLoginFlow, captureProfileFromLiveChrome, ui2apiUser, ui2apiUserDataDir, detectDisplayInfo } = await import("./runtime/xhost-capture.js");
    const { resolve } = await import("node:path");
    const ui2apiDataDir = ui2apiUserDataDir();
    const dataDir = flags.dataDir ?? process.env.UI2API_DATA_DIR ?? ui2apiDataDir ?? resolve(process.cwd(), "data");
    const vaultOwner = ui2apiDataDir ? `ui2api user (${dataDir})` : `current user (${dataDir}${flags.dataDir || process.env.UI2API_DATA_DIR ? ", explicit override" : " — ui2api-user dir not writable from this session"})`;
    const waitForEnter = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question("Press Enter once logged in: ", () => {
          rl.close();
          resolve();
        });
      });
    const display = detectDisplayInfo();
    if (!display) throw new Error("--assist requires a visible X display (set DISPLAY=:0 or similar)");
    const user = ui2apiUser();
    const { existsSync } = await import("node:fs");
    const profileDir = resolve(dataDir, `chrome-${host}`);
    const result = await assistedLoginFlow({
      url, host, dataDir, profileDir, display: display.display,
      ui2apiUser: user, relaxMode: flags.xhostAll ? "all" : "specific",
      identity: flags.identity,
    });
    if (!result.browserLaunched) throw new Error(result.error ?? "failed to launch browser");
    console.log(`[ui2api] Browser launched as ${user} on display ${display.display}.`);
    console.log(`  Log in to ${host} in the browser window, then return here and press Enter.`);
    await waitForEnter();
    const captured = await captureProfileFromLiveChrome({ profileDir, host, dataDir, identity: flags.identity });
    // GOAL 49 write truth gate: an anonymous capture returns an empty
    // snapshotPath — nothing was written, so no "captured" claim and no
    // capability fingerprint against an account that does not exist.
    if (!captured.snapshotPath) {
      console.warn(`[ui2api] nothing saved — no account written for ${host} (see named verdict below)`);
      for (const w of captured.warnings) console.warn(`  ! ${w}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[ui2api] identity-keyed session captured for ${host}:`);
    console.log(`  identity: ${captured.identity}`);
    console.log(`  snapshot: ${captured.snapshotPath}`);
    console.log(`  (data vault: ${vaultOwner})`);
    // Capability reflection at capture end: probe what THIS account can do.
    try {
      const { listProfiles } = await import("./profile/profile.js");
      const profile = listProfiles().find((p) => new URL(p.url).host === host || p.url.includes(host));
      if (profile) {
        const report = await probeAccountCapabilities(profile, captured.identity, dataDir);
        console.log(`[ui2api] capability fingerprint for ${profile.id}: ${report.ok ? `ok (${report.models.length} models, tier: ${report.tier.value ?? "?"})` : `unreadable (${report.reason})`}`);
      }
    } catch (e) {
      console.warn(`[ui2api] capability probe skipped: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }

  // --login is the DEFAULT capture mode and is implied: `profile capture` is
  // login-first by design — its whole purpose is saving the user's sign-in. The
  // default path below runs the SAME interactive sign-in flow `analyse --login`
  // uses (doInteractiveLogin: headed browser via the buildLaunchOptions/launchBrowser
  // seam, the user signs in, presses Enter, and cookies + full profile snapshot
  // are saved). Accept the flag explicitly so `profile capture <url> --login` is a
  // real documented command (it was parsed by parseFlags but silently ignored here).
  if (flags.login) {
    console.log(`[ui2api] capture is login-first — opening the sign-in flow for ${host} (--login is the default capture mode)`);
  }

  // Default capture: headed browser as current user (existing flow).
  const session = await doInteractiveLogin(url, host);
  const identity = flags.identity;
  if (identity) {
    // GOAL 50 account-INDEX collision gate: a same-slug DIFFERENT identity
    // already in the vault is refused (nothing overwritten, never a silent
    // destruction of the existing account); same identity = latest-wins.
    const collision = slugCollision(dataDir, host, identity);
    if (collision) {
      console.error(`[ui2api] nothing saved — account "${collision.slug}" already exists as "${collision.identity}" (slug-collision, NOT overwritten)`);
      console.error(`  captured identity "${identity}" collides on ${host} — use the SAME identity to re-capture, or list/remove the existing account first.`);
      process.exitCode = 1;
      return;
    }
    saveAccountSnapshot(dataDir, host, identity, session.snapshot, { source: "capture" });
    console.log(`[ui2api] profile captured for ${host} (identity: ${identity}):`);
    console.log(`  snapshot -> ${snapshotPath(dataDir, host)}`);
    // Capability reflection at capture end — probe the fresh session.
    try {
      const { listProfiles } = await import("./profile/profile.js");
      const profile = listProfiles().find((p) => new URL(p.url).host === host || p.url.includes(host));
      if (profile) {
        const report = await probeAccountCapabilities(profile, identity, dataDir);
        console.log(`[ui2api] capability fingerprint for ${profile.id}: ${report.ok ? `ok (${report.models.length} models, tier: ${report.tier.value ?? "?"})` : `unreadable (${report.reason})`}`);
      }
    } catch (e) {
      console.warn(`[ui2api] capability probe skipped: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    saveCookies(sessionPath(dataDir, host), session.cookies);
    saveSnapshot(snapshotPath(dataDir, host), session.snapshot);
    console.log(`[ui2api] profile captured for ${host}:`);
    console.log(`  cookies  -> ${sessionPath(dataDir, host)}`);
    console.log(`  snapshot (cookies + localStorage + sessionStorage + IndexedDB) -> ${snapshotPath(dataDir, host)}`);
  }
  // GOAL 49 claim gate: the "logged-in session" claim only prints for a usable
  // snapshot (cookies or localStorage present). A fully anonymous capture is
  // saved for the record but never claimed as a signed-in session.
  if (snapshotHasAuth(session.snapshot)) {
    console.log(`Sites driven through ui2api now see your logged-in session — chat history persists.`);
  } else {
    console.warn(`[ui2api] warning: no cookies and no localStorage captured for ${host} (logged out?) — this capture carries no session to reuse.`);
  }
}

async function cmdProfileIngest(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { ingestProfile } = await import("./runtime/profile-ingest.js");
  const { snapshot, stats, profileDir, warnings } = await ingestProfile({
    targetHost: host,
    profileDir: flags.profile,
  });
  // GOAL 49 write truth gate: an anonymous snapshot (zero cookies AND zero
  // localStorage in the CONTENT) is refused at the write seam — never saved to
  // disk, never claimed "logged in". Named message + nonzero exit (scriptable
  // gates), so a logged-out ingest fails LOUD instead of writing a fake account.
  if (!snapshotHasAuth(snapshot)) {
    console.error(`[ui2api] nothing saved — no cookies and no localStorage matched ${host} (logged out?) — no vault account written`);
    for (const w of warnings) console.warn(`  ! ${w}`);
    process.exitCode = 1;
    return;
  }
  const target = snapshotPath(dataDir, host);
  saveSnapshot(target, snapshot);
  console.log(`[ui2api] ingested ${profileDir} -> ${target}`);
  console.log(`  cookies: ${stats.cookiesMatched}/${stats.cookiesTotal} matched for ${host} (${stats.decrypted} decrypted, ${stats.undecryptable} skipped)`);
  console.log(`  localStorage: ${stats.localStorageEntries} entries for ${snapshot.origin}`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.log("Sites driven through ui2api now see this logged-in session — chat history persists.");
}

// OS-wide Chrome profile scan: find any site with stored data in ANY Chrome
// profile on the machine (v1 gate: "scan the Linux of our user"). The result is
// a checkbox-index list of importable sessions.
async function cmdProfileScan(flags: Flags): Promise<void> {
  const { findAllChromeProfilesOnOs, scanProfilesForSites, renderCheckboxList } = await import("./runtime/profile-scan.js");
  const { profiles, skipped } = findAllChromeProfilesOnOs();
  if (profiles.length === 0) {
    console.log("[ui2api] no Chrome/Chromium profiles found on this machine.");
    console.log("  Install + sign in to Chrome (or Chromium), then re-run. Everything else stays local.");
    return;
  }
  const index = scanProfilesForSites(profiles);
  console.log(`[ui2api] scanned ${profiles.length} Chrome profile root(s):`);
  for (const p of profiles) console.log(`  - ${p.root} (user: ${p.user})`);
  console.log("");
  if (index.hits.length === 0) {
    console.log("No sites with stored cookie data were found in any profile.");
    return;
  }
  console.log("Sites found (checkbox index) — import any with:");
  console.log("  ui2api profile import <host> [--account email]");
  console.log("[ui2api] tip: add ALL known hosts in one step →  ui2api profile add-all [--known|--interactive]");
  console.log("");
  console.log(renderCheckboxList(index.hits));
  if (skipped.length > 0) {
    console.log("");
    console.warn(`Skipped (unreadable/denied): ${skipped.length} path(s) — run as the owning user or check permissions.`);
  }
  console.log("");
  console.log(`Tip: ${index.hits.filter((h) => h.known).length} of ${index.hits.length} hosts match known AI chat sites.`);
}

// Import one host from a scanned Chrome profile into the identity-keyed vault.
async function cmdProfileImport(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { findAllChromeProfilesOnOs, importSiteSnapshot } = await import("./runtime/profile-scan.js");
  const { profiles, skipped } = findAllChromeProfilesOnOs();
  const profileFilter = flags.profile;
  const chosen = profileFilter
    ? profiles.filter((p) => p.root === profileFilter || p.root.endsWith(profileFilter))
    : profiles;
  if (chosen.length === 0) {
    console.error("[ui2api] no matching Chrome profile. Available:");
    for (const p of profiles) console.error(`  ${p.root}  (user: ${p.user})`);
    if (skipped.length > 0) console.error(`  (${skipped.length} path(s) skipped — check permissions)`);
    throw new Error("no chrome profile found for import");
  }
  const wanted = host.toLowerCase();
  let found = false;
  for (const p of chosen) {
    try {
      const r = await importSiteSnapshot({ root: p.root, host: wanted, dataDir, identity: flags.identity });
      found = true;
      if (!r.snapshotPath) {
        // GOAL 49/50 write truth gates: a refused import (anonymous content,
        // or a same-slug identity collision) was NOT written — nothing saved,
        // no "imported" claim, named verdict in the warnings.
        console.warn(`[ui2api] nothing saved for ${r.host} from ${p.root}:`);
        console.warn(`  identity: ${r.identity}`);
        console.warn(`  cookies: ${r.stats.cookiesMatched}/${r.stats.cookiesTotal} matched`);
        for (const w of r.warnings) console.warn(`  ! ${w}`);
        process.exitCode = 1;
        continue;
      }
      console.log(`[ui2api] imported ${r.host} from ${p.root}:`);
      console.log(`  identity: ${r.identity}`);
      console.log(`  snapshot: ${r.snapshotPath}`);
      console.log(`  cookies: ${r.stats.cookiesMatched}/${r.stats.cookiesTotal} matched${r.ok ? "" : " (NOT logged in — no cookies matched)"}`);
      console.log(`  localStorage: ${r.stats.localStorageEntries} entries`);
      for (const w of r.warnings) console.warn(`  ! ${w}`);
    } catch (e) {
      console.warn(`  ! ${p.root}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  if (!found) console.warn(`[ui2api] no Chrome profile matched host ${host}`);
}

// List identity-keyed accounts stored in the vault for a site.
async function cmdProfileList(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const accounts = listAccounts(dataDir, host);
  if (accounts.length === 0) {
    console.log(`[ui2api] no identity-keyed accounts for ${host}.`);
    console.log("  Capture one:  ui2api profile capture https://<host> [--identity email] [--assist]");
    console.log("  Import from Chrome:  ui2api profile import <host>");
    return;
  }
  console.log(`[ui2api] accounts for ${host}:`);
  for (const a of accounts) {
    console.log(`  ${a.slug.padEnd(36)} ${a.identity}  (${a.source}, ${a.capturedAt.slice(0, 10)})`);
  }
  console.log("");
  console.log("Drive one with:  ui2api prompt '...' --site <id> --account <slug|email>");
}

// OS-level requirements readiness check (GOAL 33, the `requirements`/`doctor`
// command): reports every package's verdict — ready / working / on-hold /
// not-ready — with the NAMED reason, BEFORE any browser work. Pure checker
// (src/runtime/requirements.ts): no browser is ever launched (the attach probe
// is an HTTP GET against an already-running Chrome; chrome version is an
// execute-only --version probe). Exit is non-zero when any requested-scope
// package is not-ready (scriptable gates). --json (GOAL 42): the report shape
// the daemon's GET /requirements serves, honoring the `doctor <site>` scope
// (filtered packages + scoped summary — the SAME filtering the human path
// prints, just serialized).

async function cmdRequirements(siteOrEmpty: string, flags: Flags): Promise<void> {
  const { checkRequirements, scopeRequirementsReport } = await import("./runtime/requirements.js");
  const report = await checkRequirements({
    deps: { dataDir: resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data") },
  });
  // GOAL 42: ONE scope helper for both the human table and the --json payload
  // so the machine view can never drift from the printed verdicts.
  const scoped = siteOrEmpty ? scopeRequirementsReport(report, siteOrEmpty) : report;
  if (siteOrEmpty && scoped.packages.length === 0) {
    throw new Error(`unknown site "${siteOrEmpty}" for requirements`);
  }
  if (flags.json) {
    console.log(JSON.stringify(scoped, null, 2));
    const notReady = scoped.packages.filter((p) => p.verdict === "not-ready");
    if (notReady.length > 0) process.exitCode = 1;
    return;
  }
  console.log(`[ui2api] OS-level requirements (doctor) — node ${report.node}`);
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "[ok]  " : c.status === "fail" ? "[FAIL]" : "[skip]";
    console.log(`  ${mark} ${c.id.padEnd(13)} ${c.detail ?? c.reason ?? ""}`);
  }
  console.log("");
  const rows = scoped.packages;
  console.log(`${"site".padEnd(24)} kind            verdict     reasons`);
  for (const p of rows) {
    const reasons = p.reasons.length > 0 ? p.reasons.join("; ") : "driveable now (honestly unverified)";
    console.log(`${p.id.padEnd(24)} ${p.kind.padEnd(14)} ${p.verdict.padEnd(11)} ${reasons}`);
    // GOAL 39: capture-age honesty — the age line for every vault-backed
    // package and the ⚠ stale warn (risk signal only, never an expiry verdict)
    // when the limiting session is older than SESSION_STALE_DAYS.
    if (p.vault.detail) console.log(`  vault: ${p.vault.detail}`);
    if (p.vault.stale && p.vault.reason) console.log(`  ⚠ ${p.vault.reason}`);
  }
  console.log("");
  console.log(
    `summary: ${scoped.summary.ready} ready · ${scoped.summary.working} working · ${scoped.summary["on-hold"]} on-hold · ${scoped.summary["not-ready"]} not-ready`
  );
  const notReady = rows.filter((p) => p.verdict === "not-ready");
  if (notReady.length > 0) {
    console.error(
      `[ui2api] ${notReady.length} package(s) NOT READY (${notReady.map((p) => p.id).join(", ")}) — fix the named reasons, then re-run.`
    );
    process.exitCode = 1;
  }
}

// GOAL 40: the buy-first one-command anonymous self-test. The smoke module
// (src/prompt/smoke.ts) runs the real gates and decides the verdict line; this
// command only prints the outcome + maps it to the exit code — the same data
// dir resolution cmdRequirements uses, the real install seam for the missing
// anonymous package, and a REAL headless ChatDriver round-trip. --json
// (GOAL 42): the machine verdict {ok, site, answer, ms, message,
// installedAnon?, report} — the report the gate computed rides along (the WHY:
// passed-check detail + every package's GOAL-39 vault fields); undefined
// fields are omitted; the exit code stays the gate (smokeExitCode).
async function cmdSmoke(flags: Flags): Promise<void> {
  const { runSmoke, smokeExitCode } = await import("./prompt/smoke.js");
  const outcome = await runSmoke({
    deps: {
      dataDir: resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data"),
      ...(flags.registry ? { registryBaseUrl: flags.registry } : {}),
      ...(flags.out ? { packagesRoot: flags.out } : {}),
    },
  });
  if (flags.json) {
    // JSON.stringify omits undefined-valued keys — answer/ms/installedAnon
    // disappear on paths that don't carry them.
    console.log(
      JSON.stringify(
        {
          ok: outcome.ok,
          site: outcome.site,
          answer: outcome.answer,
          ms: outcome.ms,
          message: outcome.message,
          installedAnon: outcome.installedAnon,
          report: outcome.report,
        },
        null,
        2
      )
    );
    process.exitCode = smokeExitCode(outcome);
    return;
  }
  if (outcome.installedAnon) {
    const res = outcome.installedAnon;
    console.log(
      `smoke: anonymous chat package "${res.siteId}" was missing — installed v${res.version} (${res.trust}) via the registry seam -> ${res.dir}`
    );
  }
  console.log(outcome.message);
  process.exitCode = smokeExitCode(outcome);
}

// Import EVERY site session found in the OS's Chrome profiles into the vault in
// ONE command — "a mother fucking command" (verbatim:1582). Scans all profiles,
// lets the user pick from a checkbox list (interactive, default) or bulk-imports
// every KNOWN host with no prompting (--known, the CI/bulk-demo path). Every
// import is then READ BACK from the vault — snapshot on disk, account listed,
// cookies/localStorage present — never an unverified "ok".
async function cmdProfileAddAll(flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { findAllChromeProfilesOnOs, scanProfilesForSites, renderCheckboxList, importSiteSnapshot } = await import("./runtime/profile-scan.js");
  const { profiles, skipped } = findAllChromeProfilesOnOs();
  if (profiles.length === 0) {
    console.log("[ui2api] no Chrome/Chromium profiles found on this machine.");
    console.log("  Install + sign in to Chrome (or Chromium), then re-run. Everything else stays local.");
    return;
  }
  const index = scanProfilesForSites(profiles);
  console.log(`[ui2api] scanned ${profiles.length} Chrome profile root(s):`);
  for (const p of profiles) console.log(`  - ${p.root} (user: ${p.user})`);
  console.log("");
  if (index.hits.length === 0) {
    console.log("No sites with stored cookie data were found in any profile.");
    return;
  }
  console.log("Sites found (checkbox index):");
  console.log(renderCheckboxList(index.hits));
  if (skipped.length > 0) {
    console.log("");
    console.warn(`Skipped (unreadable/denied): ${skipped.length} path(s) — run as the owning user or check permissions.`);
  }
  console.log("");

  // Choose which hosts to import. --known = every KNOWN hit, no prompting.
  const chosen: (typeof index.hits)[number][] = [];
  if (flags.known) {
    chosen.push(...index.hits.filter((h) => h.known));
    if (chosen.length === 0) {
      console.log(`[ui2api] --known: no KNOWN AI chat hosts found — nothing to import.`);
      return;
    }
    console.log(`[ui2api] --known: importing ${chosen.length} KNOWN host(s) without prompting.`);
  } else {
    const answer = await askLine("import selected hosts (comma indices or 'all')? ");
    if (answer.trim().toLowerCase() === "all") {
      chosen.push(...index.hits);
    } else {
      for (const part of answer.split(",")) {
        const n = Number(part.trim());
        if (Number.isInteger(n) && n >= 1 && n <= index.hits.length) chosen.push(index.hits[n - 1]);
      }
    }
    if (chosen.length === 0) {
      console.log("[ui2api] nothing selected — nothing imported.");
      return;
    }
    console.log(`[ui2api] importing ${chosen.length} selected host(s).`);
  }

  // Identity: --identity-prefix overrides the slug base; otherwise the same
  // default `profile import <host>` uses (detected from the profile's
  // Preferences, falling back to the current user).
  const identity = flags.identityPrefix || flags.identity;

  // host -> slug/identity -> verdict table. One row per host, deduped by slug
  // (a host present in several profiles converges on one vault account).
  interface AddAllRow {
    host: string;
    slug: string;
    identity: string;
    verdict: string;
  }
  const rows = new Map<string, AddAllRow>();
  let attempted = 0;
  let hostSucceeded = 0;
  let hostFailed = 0;

  for (const hit of chosen) {
    let hostOk = false;
    // Import from every profile root the scan located for this host.
    for (const root of hit.profiles) {
      attempted++;
      let verdict: string;
      let slug = "";
      let importedIdentity = identity;
      let imp: Awaited<ReturnType<typeof importSiteSnapshot>>;
      try {
        imp = await importSiteSnapshot({ root, host: hit.host, dataDir, identity });
        importedIdentity = imp.identity;
        slug = slugifyIdentity(importedIdentity);
        // GOAL 49/50: a refused import (anonymous content, or a same-slug
        // identity collision) was REFUSED at the write seam — nothing written,
        // nothing to read back. Its row is the named verdict (from the import
        // warnings when available), never persisting as an account.
        if (!imp.ok || !imp.snapshotPath) {
          const collision = imp.warnings.find((w) => w.startsWith("slug-collision"));
          verdict = collision ? "slug-collision (not overwritten)" : "skipped-no-auth (nothing to save)";
        } else {
          // Verification pass: read the account back from the VAULT — same seams
          // `profile list` uses. Never claim ok for something not on disk.
          const listed = listAccounts(dataDir, hit.host).some((a) => a.slug === slug);
          const snap = loadAccountSnapshot(dataDir, hit.host, slug);
          if (!listed || !snap) {
            verdict = "failed(read-back-missing)";
          } else {
            const cookies = (snap.cookies ?? []).length;
            const ls = (snap.localStorage ?? []).length;
            if (cookies === 0 && imp.stats.cookiesMatched > 0) {
              // The profile HAD cookies for this host but every one was
              // undecryptable (app-bound, portal v20 class) — captured but not
              // usable; say so honestly instead of "imported".
              verdict = "decrypt-limited (portal v20)";
            } else if (cookies > 0 || ls > 0) {
              verdict = "imported";
            } else {
              verdict = "skipped-no-auth";
            }
          }
        }
      } catch (e) {
        verdict = `failed(${e instanceof Error ? e.message.split("\n")[0] : String(e)})`;
        if (!slug) slug = flags.identityPrefix || flags.identity || "?";
      }
      if (verdict !== "failed(read-back-missing)" && !verdict.startsWith("failed(")) hostOk = true;
      rows.set(`${hit.host}|${slug}`, {
        host: hit.host,
        slug,
        identity: importedIdentity ?? "?",
        verdict,
      });
    }
    if (hostOk) hostSucceeded++;
    else if (hit.profiles.length > 0) hostFailed++;
  }

  console.log("");
  console.log("[ui2api] add-all result (host -> slug/identity -> verdict):");
  for (const r of rows.values()) {
    console.log(`  ${r.host} -> ${r.identity} (${r.slug}) -> ${r.verdict}`);
  }

  // Exit non-zero only if ALL selected hosts failed AND at least one was
  // attempted (CI sees a real failure); 0 if any succeeded or all were skipped.
  const allFailed = attempted > 0 && hostFailed === chosen.length && hostSucceeded === 0;
  if (allFailed) {
    console.error(`[ui2api] ERROR: all ${chosen.length} selected host(s) failed to import (${attempted} import attempt(s)).`);
    process.exitCode = 1;
  }
}

// Ask one line on stdin (the repo's plain-readline convention for prompts).
async function askLine(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Probe an account's capability fingerprint (models, tier, restrictions) from
 * the LIVE page and store it next to the account snapshot in the vault.
 *   ui2api profile capabilities gemini.google.com --account merezarezaei@gmail.com
 */
async function cmdProfileCapabilities(host: string, flags: Flags): Promise<void> {
  const dataDir = resolve(flags.dataDir ?? process.env.UI2API_DATA_DIR ?? "data");
  const { listProfiles } = await import("./profile/profile.js");
  const profile = listProfiles().find(
    (p) => p.url.includes(host) || p.id === host || new URL(p.url).host === host
  );
  if (!profile) throw new Error(`no site profile matches "${host}" (known: ${listProfiles().map((p) => p.id).join(", ")})`);
  const siteHost = new URL(profile.url).host;
  const accounts = listAccounts(dataDir, siteHost);
  if (accounts.length === 0) {
    throw new Error(`no identity-keyed accounts for ${siteHost} — capture one first (ui2api profile capture ${profile.url} [--assist])`);
  }
  // Resolve the requested account (email, slug, or the first available).
  const account = accounts.find((a) => a.identity === flags.account || a.slug === flags.account) ?? accounts[0];
  const report = await probeAccountCapabilities(profile, account.identity, dataDir);
  const { capabilitiesPath } = await import("./runtime/session-store.js");
  console.log(`[ui2api] capability fingerprint for ${profile.id} / ${account.identity}:`);
  console.log(`  ${JSON.stringify(report, null, 2)}`);
  console.log(`  saved -> ${capabilitiesPath(dataDir, new URL(profile.url).host, account.slug)}`);
}

/**
 * Probe one account's capability fingerprint against the LIVE site and store
 * it in the vault. Shared by `profile capabilities` and capture-time probing.
 */
async function probeAccountCapabilities(
  profile: import("./profile/profile.js").ChatSiteProfile,
  identity: string,
  dataDir: string
): Promise<import("./runtime/capability-probe.js").CapabilityReport> {
  const siteHost = new URL(profile.url).host;
  const snapshot = loadAccountSnapshot(dataDir, siteHost, identity);
  if (!snapshot) throw new Error(`no snapshot for ${identity} on ${siteHost}`);

  const { probeCapabilities } = await import("./runtime/capability-probe.js");
  const { launchBrowser } = await import("./runtime/browser.js");
  const { injectSnapshot, saveCapabilities } = await import("./runtime/session-store.js");

  const browser = await launchBrowser(3, { headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies((snapshot.cookies ?? []) as never[]);
    await injectSnapshot(context, snapshot);
    const page = await context.newPage();
    await page.goto(profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Give the site a moment to hydrate the shell before reading.
    await page.waitForTimeout(3000 + Math.floor(Math.random() * 1000));

    const report = await probeCapabilities({
      profile,
      page: page as never,
      account: identity,
    });
    const slug = slugifyIdentity(identity);
    saveCapabilities(dataDir, siteHost, slug, report);
    return report;
  } finally {
    await browser.close().catch(() => {});
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
      const registryUrl = process.env.UI2API_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
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
    case "langgen":
      // Optional <host> targets one package; without it, every served package.
      return cmdLangGen(arg || undefined, flags);
    case "install":
      if (flags.catalog) return cmdInstallCatalog(flags);
      if (!arg) throw new Error("usage: ui2api install <host> [--registry URL] | ui2api install --catalog [--registry URL]");
      return cmdInstall(arg, flags);
    case "plugin": {
      if (arg === "serve") return cmdPluginServe(rest[0] ?? "", flags);
      throw new Error("usage: ui2api plugin serve <module.ts> [--base-url URL] [--data-dir DIR]");
    }
    case "profile": {
      if (arg === "capture") {
        if (!rest[0]) throw new Error("usage: ui2api profile capture <url> [--assist] [--login] [--identity email] [--data-dir DIR]");
        return cmdProfileCapture(rest[0], flags);
      }
      if (arg === "ingest") {
        if (!rest[0]) throw new Error("usage: ui2api profile ingest <host> [--profile DIR] [--data-dir DIR]");
        return cmdProfileIngest(rest[0], flags);
      }
      if (arg === "scan") {
        return cmdProfileScan(flags);
      }
      if (arg === "import") {
        if (!rest[0]) throw new Error("usage: ui2api profile import <host> [--profile DIR] [--identity email] [--data-dir DIR]");
        return cmdProfileImport(rest[0], flags);
      }
      if (arg === "add-all") {
        return cmdProfileAddAll(flags);
      }
      if (arg === "list") {
        if (!rest[0]) throw new Error("usage: ui2api profile list <host> [--data-dir DIR]");
        return cmdProfileList(rest[0], flags);
      }
      if (arg === "capabilities") {
        if (!rest[0]) throw new Error("usage: ui2api profile capabilities <host> [--account email] [--data-dir DIR]");
        return cmdProfileCapabilities(rest[0], flags);
      }
      throw new Error("usage: ui2api profile capture <url> [--assist] [--login] | ingest <host> [--profile DIR] | scan | import <host> | add-all [--known|--interactive] [--identity-prefix STR] | list <host> | capabilities <host> [--account email]");
    }
    case "prompt":
      // GOAL 44: <text> is read flag-aware from the whole argv — so
      // `prompt --json "hello"` and `prompt "hello" --json` ask the SAME
      // text (the old raw argv[2] pass-through sent the literal "--json"
      // flag token to the live default site with "hello" dropped in rest,
      // never read). A flag is never sent as text; no text token ⇒ "" →
      // the cmdPrompt usage throw fires (honest).
      return cmdPrompt(promptTextArg(process.argv.slice(2)), flags);
    case "promptd":
      return cmdPromptd(flags);
    case "requirements":
    case "doctor":
      // GOAL 43: <site> is read flag-aware from the WHOLE argv — so
      // `requirements --json gemini` and `requirements gemini --json` scope
      // identically (the old positional-only guard silently dropped a site
      // that came after a flag: full 33-package report + a lying exit 1 from
      // unrelated dormant sites). A leading-dash positional is still never a
      // site (`--json`-as-site guard preserved); no site token ⇒ "" = the
      // full report, and the exit code always matches the printed scope.
      return cmdRequirements(requirementsSiteArg(process.argv.slice(2)), flags);
    case "smoke":
      return cmdSmoke(flags);
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
      console.log("  ui2api install  <host>  [--registry URL] [--out DIR]  (install a site package from the community registry; default = master branch)");
      console.log("  ui2api install  --catalog [--registry URL]  (list the registry catalog: site, version, trust)");
      console.log("  ui2api hub            [--port N] [--data-dir DIR]  (start registry server)");
      console.log("  ui2api hub publish <host> [--mirror] [--registry-repo URL]  (build + PUT to hub; --mirror also pushes to community registry)");
      console.log("  ui2api hub run <host> [--acp] [--port N] [--data-dir DIR] [--engine native|wigolo]  (serve a registered plugin)");
      console.log("  ui2api plugin serve <module.ts> [--base-url URL]  (serve a plugin module as MCP)");
      console.log("  ui2api profile capture <url> [--data-dir DIR] [--login]  (login once, save cookies+localStorage+IndexedDB snapshot)");
      console.log("  ui2api profile ingest <host> [--profile DIR] [--data-dir DIR]  (OFFLINE: read the real Chrome profile DBs — cookies+localStorage — no browser)");
      console.log("  ui2api prompt '<text>' [--site ...]  (drive an AI chat website to answer a prompt — the MVP command)");
      console.log("  ui2api promptd            [--port N] [--pool-min N] [--pool-max N]  (localhost HTTP service: POST /prompt, POST /capability/<site>, GET /sites, GET /registry, GET /accounts?site=, GET /capabilities/<site>, GET /v1/models, POST /v1/chat/completions, GET /status, GET /requirements, GET /health)");
      console.log("  ui2api prompt --sites                (list the configured AI chat websites)");
      console.log("  ui2api requirements [site]           (alias: doctor — OS-level readiness per package: ready/working/on-hold/not-ready with named reasons; exit nonzero on any not-ready) [--json = the same report as a machine-readable object, honoring the <site> scope]");
      console.log("  ui2api smoke                        (ONE command: requirements gate + ensure the anonymous duckduckgo package (installs it via the registry if missing) + ONE real anonymous chat round-trip through the ChatDriver — prints `smoke OK: …` with a real read-off-page answer (exit 0) or the NAMED failure (exit 1)) [--json = {ok, site, answer?, ms?, message, installedAnon?, report}]");
      process.exit(cmd ? 1 : 0);
  }
}

// Run the CLI only when this module IS the entry point. Importing cli.ts from
// a test pulls the pure helpers (requirementsSiteArg) without executing main()
// — process.exit at the end of main() would otherwise kill the test runner.
function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main().catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
  });
}
