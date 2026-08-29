import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert";
import { validateActionMap } from "../src/schema.js";
import { generate } from "../src/generator/generate.js";
import type { ActionMap } from "../src/types.js";

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
  const child = spawn(process.execPath, ["--import", "tsx", acpPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

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
