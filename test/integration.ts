import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyse } from "../src/analyzer/explore.js";
import { generate } from "../src/generator/generate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(ROOT, "fixture");

function startFixtureServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url!.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const p = resolve(FIXTURE, req.url === "/" ? "index.html" : (req.url || "index.html").slice(1));
      if (existsSync(p)) {
        res.writeHead(200);
        res.end(readFileSync(p));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

async function main(): Promise<void> {
  const tmp = resolve(ROOT, ".test-sites");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const { server, url } = await startFixtureServer();
  try {
    // 1. Analyze the fixture SPA.
    const map = await analyse(url, { root: "App", outDir: tmp });
    assert.ok(map.actions.length >= 3, "expected >=3 actions, got " + map.actions.length);
    const send = map.actions.find((a) => a.name === "send_prompt");
    assert.ok(send, "send_prompt action missing");
    assert.deepStrictEqual(
      send.parameters.map((p) => p.name).sort(),
      ["model", "prompt"]
    );

    // DOM-discovered action (no window.<root> needed): the Search button fires a
    // network call, so it should be captured as a replayable tool.
    const search = map.actions.find((a) => a.name === "search");
    assert.ok(search, "DOM-discovered 'search' action missing (analyzer should find button-driven actions)");
    assert.strictEqual(search.execution, "replay", "search should be a replay action");

    for (const a of map.actions) assert.match(a.name, /^[a-z][a-z0-9_]*$/);

    // 2. Generate the per-site MCP server.
    const serverDir = generate(map, tmp);
    const serverFile = resolve(serverDir, "index.ts");
    assert.ok(existsSync(serverFile), "generated server missing");

    // 3. Serve the REAL generated MCP server and drive it over stdio.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverFile],
      cwd: ROOT,
      env: process.env as Record<string, string>,
    });
    const client = new Client({ name: "ui2api-test", version: "0.1.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.ok(names.includes("send_prompt"), "send_prompt tool missing: " + names.join(","));

    const result = await client.callTool({
      name: "send_prompt",
      arguments: { prompt: "hello", model: "default" },
    });
    const text = (result.content as any[]).map((c) => c.text).join("");
    assert.ok(
      text.includes("Echo[default]: hello"),
      "unexpected tool result: " + text
    );

    // DOM-discovered tool should replay its captured network call end-to-end.
    const sres = await client.callTool({ name: "search", arguments: {} });
    const stext = (sres.content as any[]).map((c) => c.text).join("");
    assert.ok(stext.includes("{}"), "search tool replay unexpected: " + stext);

    console.log("INTEGRATION OK — send_prompt:", text, "| search(replay):", stext);

    await client.close();
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
