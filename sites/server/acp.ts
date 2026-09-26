import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserSession } from "/home/me/Documents/projects/ui2api/src/runtime/browser-session.ts";
import type { ActionMap, Action } from "/home/me/Documents/projects/ui2api/src/types.ts";

const mapPath = fileURLToPath(new URL("./action-map.json", import.meta.url));
const map = JSON.parse(readFileSync(mapPath, "utf8")) as ActionMap;
const SITES_ROOT = "/home/me/Documents/projects/ui2api/sites";
// GOAL 52: UI2API_ACCOUNT (a vault slug/identity) picks WHICH stored account
// drives this generated server; UI2API_DATA_DIR points at the vault root.
const session = new BrowserSession(map, SITES_ROOT, {
  account: process.env.UI2API_ACCOUNT || undefined,
  dataDir: process.env.UI2API_DATA_DIR || undefined,
});

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

// GOAL 107: a DOM-extract action reports a MISS as a plain JS `null` —
// BrowserSession.executeRecipe returns null when querySelector found no element
// (or the requested attribute was absent). For those actions a null result can
// only mean "nothing was extracted", so we can name the exact miss. Mirrors the
// parseExtract grammar in browser-session.ts.
function extractTarget(action: Action): { sel: string; kind: string; arg: string | null } | null {
  if (action.result?.mode !== "dom" || !action.result.extract) return null;
  const m = action.result.extract.trim().match(/^(text|attr|json)\s+(\S+)(?:\s+(\S+))?$/);
  if (!m) return null;
  if (m[1] === "attr" && m[3] === undefined) return null;
  return { kind: m[1], sel: m[2], arg: m[3] ?? null };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const action = map.actions.find((a) => a.name === name);
  if (!action) return { is_error: true, content: [{ type: "text", text: "unknown tool: " + name }] };
  const res = await session.executeRecipe(action as Action, args || {});
  /* GOAL_107_MISS_CHECK_BEGIN */
  // Never report a failed extraction as a success carrying the string "null":
  // that is indistinguishable from a real answer to the consumer. A null from a
  // js-function action is a genuine value the site's own code returned, so only
  // a DOM-extract action's null is treated as a miss.
  const miss = extractTarget(action as Action);
  if (res === null && miss) {
    const what =
      miss.kind === "attr"
        ? "attribute " + JSON.stringify(miss.arg) + " of selector " + JSON.stringify(miss.sel)
        : "selector " + JSON.stringify(miss.sel);
    return {
      is_error: true,
      content: [
        {
          type: "text",
          text:
            name + ": extraction failed — no match for " + what + " on " + map.url +
            " (the element does not exist on the live page, so nothing was read)",
        },
      ],
    };
  }
  /* GOAL_107_MISS_CHECK_END */
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
