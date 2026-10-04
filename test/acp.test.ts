import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert";
import { validateActionMap } from "../src/schema.js";
import { generate } from "../src/generator/generate.js";
import type { ActionMap } from "../src/types.js";
import { startAcpServer as harnessServer, startLocalSite, type RpcClient as HarnessClient } from "./helpers/acp-harness.js";

const TIMEOUT_MS = 15000;

function buildActionMap(): ActionMap {
  const map = {
    host: "example-site",
    url: "https://example.com/",
    capturedAt: new Date().toISOString(),
    trusted: false,
    auth: { required: false },
    actions: [
      {
        name: "get_status",
        description: "Return the current status string.",
        execution: "live-js" as const,
        parameters: [] as any[],
        recipe: { kind: "js-function" as const, target: "window.getStatus", argsFrom: {} },
        result: { mode: "return" as const },
        verified: true,
      },
      {
        name: "fetch_report",
        description: "Replay a captured network request for a report.",
        execution: "replay" as const,
        parameters: [
          { name: "id", type: "string" as const, required: true, description: "report id" },
        ],
        recipe: {
          kind: "js-function" as const,
          target: "window.getReport",
          argsFrom: { id: "id" },
          network: { method: "GET", url: "https://example.com/api/report" },
        },
        result: { mode: "dom" as const, extract: "text .report" },
        verified: true,
      },
    ],
  };
  return validateActionMap(map);
}

interface RpcClient {
  send(method: string, params: unknown): Promise<any>;
  close(): void;
}

function startAcpServer(acpPath: string, cwd: string): { child: ChildProcess; client: RpcClient } {
  // GOAL 102: async spawn needs a bounded kill, not a `timeout` option.
  const child = spawn(process.execPath, ["--import", "tsx", acpPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
  killer.unref?.();
  child.on("close", () => clearTimeout(killer));

  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== null && msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });

  child.stderr!.on("data", () => {
    /* ignore server logs on stderr */
  });

  const client: RpcClient = {
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("RPC timeout for " + method));
        }, TIMEOUT_MS);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() {
      child.kill("SIGKILL");
    },
  };

  return { child, client };
}

test("generated ACP server answers initialize and list_tools over stdio JSON-RPC", async (t) => {
  const tmp = mkdtempSync(resolve(tmpdir(), "ui2api-acp-"));
  let client: RpcClient | null = null;
  const cleanup = () => {
    if (client) client.close();
    rmSync(tmp, { recursive: true, force: true });
  };
  t.after(cleanup);

  const map = buildActionMap();
  const serverDir = generate(map, tmp, "acp");
  const acpPath = resolve(serverDir, "acp.ts");

  // cwd is the project root so `tsx` (a devDependency) resolves; the generated
  // server uses absolute paths/SRC_DIR internally, so its own directory is not
  // required as cwd.
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { client: c } = startAcpServer(acpPath, ROOT);
  client = c;

  const init = await c.send("initialize", {});
  assert.ok(init && typeof init === "object", "initialize should return an object");
  assert.ok(init.result ?? init.serverInfo ?? init.protocolVersion, "initialize should carry server identity");
  assert.ok(init.protocolVersion || init.serverInfo, "initialize missing protocolVersion/serverInfo");

  const listed = await c.send("list_tools", {});
  assert.ok(Array.isArray(listed.tools), "list_tools.result.tools should be an array");
  const names = listed.tools.map((x: any) => x.name);
  assert.ok(names.includes("get_status"), "expected get_status in " + names.join(","));
  assert.ok(names.includes("fetch_report"), "expected fetch_report in " + names.join(","));
});

// GOAL 107: the emitted callTool used to return executeRecipe's raw result
// unconditionally, so a FAILED extraction (target element absent -> null) came
// back as a JSON-RPC success whose text was the literal string "null". These
// tests drive call_tool end-to-end through a REAL browser against a hermetic
// local page (no external network).

const PAGE = `<!doctype html><html><body>
<div class="report">quarterly revenue up 12%</div>
<div class="absent-holder"></div>
</body></html>`;

function buildExtractMap(url: string): ActionMap {
  const map = {
    host: "example-site",
    url,
    capturedAt: new Date().toISOString(),
    trusted: false,
    auth: { required: false },
    actions: [
      {
        name: "read_present",
        description: "Read the text of .report, which exists on the page.",
        execution: "live-js" as const,
        parameters: [] as any[],
        recipe: { kind: "js-function" as const, target: "window.noop", argsFrom: {} },
        result: { mode: "dom" as const, extract: "text .report" },
        verified: true,
      },
      {
        name: "read_missing",
        description: "Read a selector that does not exist on the page.",
        execution: "live-js" as const,
        parameters: [] as any[],
        recipe: { kind: "js-function" as const, target: "window.noop", argsFrom: {} },
        result: { mode: "dom" as const, extract: "text #nope-not-here" },
        verified: true,
      },
    ],
  };
  return validateActionMap(map);
}

test("generated ACP call_tool on a MISSING selector returns is_error with a named reason, not success \"null\"", async (t) => {
  const tmp = mkdtempSync(resolve(tmpdir(), "ui2api-acp-miss-"));
  const site = await startLocalSite(PAGE);
  let client: HarnessClient | null = null;
  t.after(async () => {
    if (client) client.close();
    await site.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const serverDir = generate(buildExtractMap(site.url), tmp, "acp");
  const { client: c } = harnessServer(resolve(serverDir, "acp.ts"));
  client = c;

  const res = await c.send("call_tool", { name: "read_missing", args: {} });
  assert.strictEqual(res.is_error, true, "a failed extraction must be is_error, not a success: " + JSON.stringify(res));
  const text = String(res.content?.[0]?.text ?? "");
  assert.ok(text.length > 0, "the error must carry a reason");
  assert.ok(!/^null$/.test(text), 'must not surface the literal "null": ' + text);
  assert.ok(text.includes("read_missing"), "reason must name the tool: " + text);
  assert.ok(text.includes("#nope-not-here"), "reason must name the selector: " + text);
  assert.ok(/extraction failed|no match/i.test(text), "reason must name the failure: " + text);
});

test("generated ACP call_tool on an EXISTING selector returns a normal success with the real text", async (t) => {
  const tmp = mkdtempSync(resolve(tmpdir(), "ui2api-acp-ok-"));
  const site = await startLocalSite(PAGE);
  let client: HarnessClient | null = null;
  t.after(async () => {
    if (client) client.close();
    await site.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const serverDir = generate(buildExtractMap(site.url), tmp, "acp");
  const { client: c } = harnessServer(resolve(serverDir, "acp.ts"));
  client = c;

  const res = await c.send("call_tool", { name: "read_present", args: {} });
  assert.notStrictEqual(res.is_error, true, "a real extraction must not be an error: " + JSON.stringify(res));
  const text = String(res.content?.[0]?.text ?? "");
  assert.ok(text.includes("quarterly revenue up 12%"), "expected the real page text, got: " + text);
});

// The three tests above drive the GENERATED stdio ACP server (emitted from
// src/generator/acp-template.ts). The JSON-RPC OVER HTTP surface is a different
// program — src/agent/acp.ts, `runServer`, reachable only via `hub run --acp`
// (src/hub/serve.ts) — and it is the one that decides a JSON-RPC *wire shape*.
// So the harness below boots that real HTTP server rather than a generated stdio
// one; driving the generated server here would pin the wrong file's behaviour.
//
// A CHILD PROCESS, deliberately, for two reasons. (1) `runServer` never returns a
// handle on its `http.Server`, so an in-process boot would leave a listener this
// test could not close; the child's `close()` is a bounded SIGKILL, the same
// teardown the stdio helper above already uses. (2) `runServer` installs
// `process.once("SIGINT"/"SIGTERM")` handlers — running it inside the test runner
// would attach handlers to the runner's own process.

const HTTP_DRIVER = (root: string) => `
import { createServer } from "node:http";
import { runServer } from "${root}/src/agent/acp.js";
import type { LoadedPlugin } from "${root}/src/plugin/types.js";

// No tools and no context work: an unknown method must read NOTHING and run
// NOTHING, so every field here is a stub that would be visibly wrong if used.
const context = {
  config: { dataDir: "/tmp/codeg-acp/acp-http-driver-data" },
  logger: { info() {}, warn() {}, error() {} },
  registerTool() {},
  close: async () => {},
} as unknown as LoadedPlugin["context"];
const plugin: LoadedPlugin = { context, tools: new Map(), hooks: undefined };

// Let the OS pick a free port, then release it for runServer to bind.
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((r) => probe.close(() => r()));
await runServer({ plugin, port });
`;

/**
 * Boot the real `src/agent/acp.ts` HTTP server and return a `post` that speaks
 * JSON-RPC over HTTP, resolving with the transport status AND the parsed body —
 * this defect is a difference between those two layers, so a helper that kept
 * only one of them could not see it.
 */
function startAcpHttpServer(dir: string, root: string): {
  child: ChildProcess;
  post(body: unknown): Promise<{ status: number; body: any }>;
  close(): void;
} {
const driverPath = resolve(dir, "acp-http-driver.ts");
    // The driver is written into a temp dir, so it has no repo package.json above
    // it and tsx resolves its format as "cjs" — which then REFUSES the driver's own
    // top-level await ("not supported with the cjs output"), and the refusal
    // arrives as a child-process exit that kills the whole runner mid-suite
    // instead of failing one test. Declaring the module type the driver is
    // actually authored in keeps ESM semantics; cwd alone does not, because the
    // format follows the FILE, not the working directory.
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(driverPath, HTTP_DRIVER(root));

  const child = spawn(process.execPath, ["--import", "tsx", driverPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
  killer.unref?.();
  child.on("close", () => clearTimeout(killer));

  // Readiness is read off the server's OWN startup line (it prints
  // `[ui2api] acp server … on http://<host>:<port>`), so the port is the one
  // actually bound rather than a guess. Bounded, and a failure surfaces stderr.
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  const ready = new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("acp http server never reported a port; stderr:\n" + stderr)), 30_000);
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      const m = stderr.match(/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); res(m[1]); }
    });
    child.on("error", (e) => { clearTimeout(timer); rej(e); });
    child.on("exit", (code) => { clearTimeout(timer); rej(new Error("acp http server exited " + code + "; stderr:\n" + stderr)); });
  });

  const post = async (body: unknown) => {
    const port = await ready;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  return { child, post, close: () => { child.kill("SIGKILL"); } };
}

test("the ACP HTTP router answers an unknown JSON-RPC method with -32601, not a success-shaped result", async (t) => {
  const tmp = mkdtempSync(resolve(tmpdir(), "ui2api-acp-http-"));
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const server = startAcpHttpServer(tmp, ROOT);
  t.after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

  const res = await server.post({ jsonrpc: "2.0", id: 9, method: "no/such/method" });

  assert.strictEqual(res.status, 200, "JSON-RPC errors stay HTTP 200 by convention");
  assert.strictEqual(
    res.body.result,
    undefined,
    "an unknown method must NOT answer in a result envelope (that is the whole defect): " + JSON.stringify(res.body),
  );
  assert.strictEqual(res.body.error?.code, -32601, "JSON-RPC defines -32601 for Method not found");
  assert.match(res.body.error.message, /no\/such\/method/, "the refusal must name the offending method");
  assert.strictEqual(res.body.id, 9, "a client must be able to match the failure to the call that caused it");
});
