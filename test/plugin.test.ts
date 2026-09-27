import { strict as assert } from "node:assert";
import { after, describe, it, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext } from "../src/plugin/context.js";
import { loadPluginFromMap, loadPluginModule } from "../src/plugin/loader.js";
import { servePlugin } from "../src/plugin/serve.js";
import { validateActionMap } from "../src/schema.js";
import type { ActionMap } from "../src/types.js";

// HERMETIC data dir for every context built in this file.
//
// `ContextDeps.dataDir` is OPTIONAL and `createContext` resolves it as
// `deps.dataDir ?? defaultSitesDir()` (src/plugin/context.ts:40), where
// `defaultSitesDir()` is `resolve(process.cwd(), "sites")` — the DEVELOPER'S
// REAL vault on this box. A fixture that omits it therefore reads (and, through
// `ctx.session.save`, WRITES) the operator's own sessions — the same class as the
// `deps.missingSharedLibraries` omission that reddened pipeline 199. The idiom
// here is the one test/js-primitives.test.ts already uses: the fixture states the
// dir in BOTH positions, so neither the HubConfig nor the ContextDeps position
// can fall back to `process.cwd()`.
const DATA_DIR = mkdtempSync(join(tmpdir(), "u2api-plugin-"));
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const CONTEXT_ARGS = [
  { dataDir: DATA_DIR },
  { baseUrl: "https://a.test", dataDir: DATA_DIR },
] as const;

describe("createContext", () => {
  it("exposes only the allow-listed surface", () => {
    const ctx = createContext(CONTEXT_ARGS[0], CONTEXT_ARGS[1]) as any;
    for (const k of ["config", "logger", "registerTool", "analyse", "replay", "call", "session", "http", "dom"])
      assert.ok(ctx[k] !== undefined, `missing ${k}`);
    for (const f of ["launchBrowser", "BrowserSession", "generate", "validateActionMap"])
      assert.equal(ctx[f], undefined, `leaked ${f}`);
  });
});

const MAP: ActionMap = {
  host: "a.test", url: "https://a.test/", capturedAt: new Date().toISOString(), auth: { required: false },
  actions: [
    { name: "do_replay", description: "replay", execution: "replay", parameters: [], verified: false, recipe: { kind: "js-function", target: "App.x", argsFrom: {}, network: { method: "GET", url: "https://a.test/x" } }, result: { mode: "return" } },
    { name: "do_dom", description: "click", execution: "replay", parameters: [], verified: false, recipe: { kind: "dom-interaction", target: "#btn", argsFrom: {} }, result: { mode: "return" } },
  ],
};
describe("loader", () => {
  it("loads an action-map as a plugin with one tool per action", () => {
    const loaded = loadPluginFromMap(validateActionMap(MAP), { dataDir: DATA_DIR }, "https://a.test");
    assert.equal(loaded.tools.size, 2);
    assert.ok(loaded.tools.has("do_replay") && loaded.tools.has("do_dom"));
  });
  it("loads a hand-written plugin module and runs its tool", async () => {
    const loaded = await loadPluginModule(new URL("./fixtures/sample-plugin.ts", import.meta.url).pathname, { dataDir: DATA_DIR }, "https://a.test");
    const out = await loaded.tools.get("echo")!.handler({ hi: 1 }, {} as any) as any;
    assert.equal(out.echo.hi, 1); assert.equal(out.dataDir, DATA_DIR);
  });
  it("replay is SSRF-guarded without launching a browser", async () => {
    const loaded = loadPluginFromMap(validateActionMap(MAP), { dataDir: DATA_DIR }, "https://a.test");
    await assert.rejects(() => loaded.tools.get("do_replay")!.handler({}, {} as any));
    const ctx = (await import("../src/plugin/context.js")).createContext(CONTEXT_ARGS[0], CONTEXT_ARGS[1]) as any;
    await assert.rejects(() => ctx.replay({ url: "https://evil.test/x" }), /SSRF guard/);
  });
});

// ─── hermeticity pin: the context's data dir is the FIXTURE's, not cwd() ────
//
// This is the assertion the two `createContext` call sites above could not make.
// `ctx.session.save/load` are the only `dataDir` consumers reachable WITHOUT a
// browser (src/plugin/context.ts:127-128 — `sessionPath(dataDir, host)`), so
// they are the real observable: a save must land inside the fixture temp dir, and
// the `process.cwd()/sites` fallback must stay untouched. With `deps.dataDir`
// omitted, the same save lands in the developer's real repo sites/ dir instead.
test("createContext: the session dir is the FIXTURE's dataDir — the process.cwd()/sites fallback is never used", async () => {
  const host = "hermetic-probe.invalid";
  mkdirSync(join(DATA_DIR, host, ".session"), { recursive: true });
  const ctx = createContext(CONTEXT_ARGS[0], CONTEXT_ARGS[1]);
  const cookies = [{ name: "probe", value: "1" }];

  await ctx.session.save(host, cookies);
  const onDisk = join(DATA_DIR, host, ".session", "cookies.json");
  assert.ok(existsSync(onDisk), `session.save must write inside the fixture dataDir (${DATA_DIR}), not the real vault`);
  assert.deepEqual(JSON.parse(readFileSync(onDisk, "utf8")), cookies, "the written session is the one we saved");
  assert.deepEqual(await ctx.session.load(host), cookies, "session.load must read the same fixture path back");

  // The canary host must NOT exist under the real cwd()-relative sites root.
  assert.equal(
    existsSync(resolve(process.cwd(), "sites", host)),
    false,
    `nothing may be written to the real ${resolve(process.cwd(), "sites")} — that is the defaultSitesDir() fallback leaking in`,
  );
});

describe("servePlugin", () => {
  it("registers each loaded tool on the MCP server", async () => {
    const loaded = await loadPluginModule(new URL("./fixtures/sample-plugin.ts", import.meta.url).pathname, { dataDir: DATA_DIR }, "https://a.test");
    const server = await servePlugin(loaded, { transport: "stdio", trust: true });
    assert.ok(loaded.tools.has("echo"));
    await server.close();
  });
});
