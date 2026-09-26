// Test-only harness for driving a GENERATED ACP server over stdio JSON-RPC
// (see src/generator/acp-template.ts). Shared by test/acp.test.ts and
// test/acp-call-tool.test.ts. No production code lives here.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RpcClient {
  send(method: string, params: unknown): Promise<any>;
  close(): void;
}

export const RPC_TIMEOUT_MS = 60_000;

export function startAcpServer(
  acpPath: string,
  cwd: string = PROJECT_ROOT,
): { child: ChildProcess; client: RpcClient } {
  const child = spawn(process.execPath, ["--import", "tsx", acpPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const killer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 180_000);
  killer.unref?.();
  child.on("close", () => clearTimeout(killer));

  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
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
    /* ignore */
  });

  const client: RpcClient = {
    send(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error("RPC timeout for " + method));
        }, RPC_TIMEOUT_MS);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            res(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            rej(e);
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

// A hermetic local page so a real browser round-trip needs no external network.
// `body` is the HTML the driver will actually load.
export async function startLocalSite(body: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("no local port");
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// GOAL 107: the emitted callTool guards its "nothing was extracted" branch
// between these two markers so a test can excise exactly that region and
// reproduce the OLD unconditional-return server (the mutation pin).
export const MISS_CHECK_BEGIN = "/* GOAL_107_MISS_CHECK_BEGIN */";
export const MISS_CHECK_END = "/* GOAL_107_MISS_CHECK_END */";

export function readEmitted(acpPath: string): string {
  return readFileSync(acpPath, "utf8");
}

/** Remove the guarded region -> the pre-GOAL-107 unconditional-return server. */
export function stripMissCheck(source: string): string {
  const b = source.indexOf(MISS_CHECK_BEGIN);
  const e = source.indexOf(MISS_CHECK_END);
  if (b < 0 || e < 0 || e < b) throw new Error("emitted callTool is missing the GOAL_107 miss-check markers");
  return source.slice(0, b) + source.slice(e + MISS_CHECK_END.length);
}

export function writeVariant(acpPath: string, source: string, name: string): string {
  // Same directory, so the relative ./action-map.json lookup still resolves.
  const p = resolve(acpPath, "..", name);
  writeFileSync(p, source);
  return p;
}
