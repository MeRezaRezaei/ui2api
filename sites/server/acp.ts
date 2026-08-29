import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserSession } from "/home/me/Documents/projects/ui2api/src/runtime/browser-session.ts";
import type { ActionMap, Action } from "/home/me/Documents/projects/ui2api/src/types.ts";

const mapPath = fileURLToPath(new URL("./action-map.json", import.meta.url));
const map = JSON.parse(readFileSync(mapPath, "utf8")) as ActionMap;
const session = new BrowserSession(map);

function sanitize(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return s.length > 8000 ? s.slice(0, 8000) + "\u2026" : s;
  } catch (e) {
    return String(v);
  }
}

function inputSchema(action: Action): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of action.parameters) {
    let t: string = "string";
    if (p.type === "number") t = "number";
    else if (p.type === "boolean") t = "boolean";
    else if (p.type === "object") t = "object";
    const schema: Record<string, unknown> = { type: t };
    if (p.description) schema.description = p.description;
    props[p.name] = schema;
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties: props, required };
}

function listTools(): unknown {
  return {
    tools: map.actions.map((a) => ({
      name: a.name,
      description: a.description,
      input_schema: inputSchema(a),
    })),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const action = map.actions.find((a) => a.name === name);
  if (!action) return { is_error: true, content: [{ type: "text", text: "unknown tool: " + name }] };
  const res = await session.executeRecipe(action as Action, args || {});
  return { content: [{ type: "text", text: sanitize(res) }] };
}

async function handle(msg: any): Promise<unknown> {
  const method = String(msg.method || "").toLowerCase();
  switch (method) {
    case "initialize":
      return { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ui2api-" + map.host, version: "0.1.0" } };
    case "list_tools":
    case "tools/list":
      return listTools();
    case "call_tool":
    case "tools/call": {
      const name = msg.params?.name ?? msg.params?.tool;
      const args = msg.params?.args ?? msg.params?.arguments ?? {};
      return callTool(name, args);
    }
    default:
      return { is_error: true, content: [{ type: "text", text: "unknown method: " + msg.method }] };
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg)
      .then((result) => {
        const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result });
        process.stdout.write(out + "\n");
      })
      .catch((e) => {
        const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, error: { message: String(e) } });
        process.stdout.write(out + "\n");
      });
  }
});

console.error("[ui2api] acp server for " + map.host + " ready, " + map.actions.length + " tools (browser starts on first call_tool)");
