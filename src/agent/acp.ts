import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LoadedPlugin } from "../plugin/types.js";

export interface AcpOptions {
  plugin: LoadedPlugin;
  port: number;
}

// Minimal Agent Client Protocol (ACP) JSON-RPC server over HTTP. It exposes a
// loaded plugin's tools via `initialize`, `list_tools` / `tools/list`, and
// `call_tool` / `tools/call`. The plugin only ever sees its allow-listed
// context — this server just forwards tool calls into `plugin.tools`.
export async function runServer(opts: AcpOptions): Promise<void> {
  const { plugin, port } = opts;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      try {
        const msg = body ? JSON.parse(body) : {};
        const result = await handle(msg, plugin);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { message: String(e) } }));
      }
    });
  });
  server.listen(port, () => {
    console.error(`[ui2api] acp server for ${plugin.manifest?.name ?? "plugin"} on :${port}`);
  });
}

async function handle(msg: any, plugin: LoadedPlugin): Promise<unknown> {
  const method = String(msg.method || "").toLowerCase();
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: plugin.manifest?.name ?? "ui2api", version: plugin.manifest?.version ?? "0.1.0" },
      };
    case "list_tools":
    case "tools/list": {
      const tools = [...plugin.tools.values()].map((t) => ({
        name: t.def.name,
        description: t.def.description,
        input_schema: t.def.inputSchema,
      }));
      return { tools };
    }
    case "call_tool":
    case "tools/call": {
      const name = msg.params?.name ?? msg.params?.tool;
      const args = msg.params?.args ?? msg.params?.arguments ?? {};
      const entry = plugin.tools.get(name);
      if (!entry) return { is_error: true, content: [{ type: "text", text: "unknown tool: " + name }] };
      const out = await entry.handler(args, plugin.context);
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return { content: [{ type: "text", text }] };
    }
    default:
      return { is_error: true, content: [{ type: "text", text: "unknown method: " + msg.method }] };
  }
}
