import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LoadedPlugin } from "../plugin/types.js";

export interface AcpOptions {
  plugin: LoadedPlugin;
  port: number;
  /**
   * Interface to bind. Unset = loopback (the safe default). A wider bind is
   * refused unless `UI2API_ACP_BIND` names the same host — see
   * `resolveAcpBindHost`.
   */
  bindHost?: string;
}

/**
 * GOAL 123: the ACP surface called `server.listen(port)` with NO host, so it
 * bound EVERY interface (measured `LISTEN *:8788`). Unlike the hub — whose wider
 * bind only exposes a READ inventory (GOAL 122) — this surface exposes tool
 * EXECUTION: `tools/call` drives a real browser through the operator's own
 * logged-in session, on any site a package names. A hardened hub door next to an
 * open tool-execution door has MOVED the risk, not removed it, so this surface
 * gets the same loopback-by-default shape and the same deliberate opt-in.
 */
export const ACP_BIND_HOST = "127.0.0.1";

/** The opt-in knob. Unset = loopback only, and a wider bind is refused. */
export const ACP_BIND_ENV = "UI2API_ACP_BIND";

function isLoopback(host: string): boolean {
  return host === ACP_BIND_HOST || host === "localhost" || host === "::1";
}

/**
 * One JSON-RPC wire shape for every reply: `{ jsonrpc, id, result }` on
 * success, `{ jsonrpc, id, error: { code, message } }` on failure. `id` is
 * ALWAYS the caller's id when the request parsed — a client must be able to
 * match a failure to the call that caused it.
 */
function sendRpc(
  res: ServerResponse,
  status: number,
  id: unknown,
  payload: { result?: unknown } | { code?: number; message: string }
): void {
  res.writeHead(status, { "content-type": "application/json" });
  // An error payload is `{ code?, message }`; a success payload is `{ result }`.
  // The two never share a key, so the discriminator is exact.
  if ("message" in payload) {
    res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: payload.code ?? RPC_INVALID_REQUEST, message: payload.message } }));
    return;
  }
  res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: payload.result }));
}

export function resolveAcpBindHost(requested?: string): string {
  const want = requested ?? process.env[ACP_BIND_ENV];
  if (!want) return ACP_BIND_HOST;
  if (isLoopback(want)) return want;
  if (process.env[ACP_BIND_ENV] === want) return want; // explicit opt-in
  throw new Error(
    `refusing to bind the ACP server to ${want}: it defaults to ${ACP_BIND_HOST} because this port ` +
      `executes tools — a wider bind hands anyone who can reach it a real browser driven with your ` +
      `own logged-in session (and, with no auth on this surface, no credential to stop them). ` +
      `Set ${ACP_BIND_ENV}=${want} to opt in deliberately, or keep ${ACP_BIND_HOST} and reach it ` +
      `through a tunnel.`
  );
}

// Minimal Agent Client Protocol (ACP) JSON-RPC server over HTTP. It exposes a
// loaded plugin's tools via `initialize`, `list_tools` / `tools/list`, and
// `call_tool` / `tools/call`. The plugin only ever sees its allow-listed
// context — this server just forwards tool calls into `plugin.tools`.
export async function runServer(opts: AcpOptions): Promise<void> {
  const { plugin, port } = opts;
  const host = resolveAcpBindHost(opts.bindHost); // throws BEFORE the socket exists
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // GOAL 123: route discipline. This used to dispatch ANY method on ANY path
    // with ANY body into the tool router, so the tool-execution port answered a
    // `GET /` from any scanner on the LAN with a JSON-RPC body. Only the two
    // documented JSON-RPC endpoints exist — `/` (the address the CLI prints)
    // and `/acp` (the explicit alias) — and only POST carries a JSON-RPC call.
    const url = new URL(req.url ?? "/", "http://acp.invalid");
    const onEndpoint = url.pathname === "/" || url.pathname === "/acp";
    if (!onEndpoint) {
      return sendRpc(res, 404, null, {
        message:
          `no route ${req.method ?? "?"} ${url.pathname}: the ACP JSON-RPC surface answers POST on ` +
          `/ (or /acp) only — POST a single JSON-RPC object such as ` +
          `{"jsonrpc":"2.0","id":1,"method":"tools/list"} there.`,
      });
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return sendRpc(res, 405, null, {
        message:
          `${req.method ?? "?"} is not a JSON-RPC transport: this surface is POST-only (a JSON-RPC ` +
          `call has a body and a method name). Use \`curl -X POST http://${host}:${port}/\`, or ` +
          `reach it with an MCP client that speaks JSON-RPC over HTTP POST.`,
      });
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let msg: any = {};
      try {
        // A body is REQUIRED here (pre-fix, an empty body became `{}` and was
        // dispatched as an unknown-method result rather than a refusal).
        msg = body.trim() ? JSON.parse(body) : null;
      } catch (e) {
        // No id is knowable from an unparseable body — `null` here is honest,
        // not the pre-fix habit of nulling EVERY error.
        return sendRpc(res, 400, null, { message: `invalid JSON-RPC body: ${String(e)}` });
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        return sendRpc(res, 400, null, {
          message: "a JSON-RPC request must be a single object with a `method` (a batch array is not served by this surface).",
        });
      }
      try {
        const result = await handle(msg, plugin);
        sendRpc(res, 200, msg.id ?? null, { result });
      } catch (e) {
        // GOAL 123: the pre-fix error body hard-coded `id: null`, so a client
        // could not match a failure to the request that caused it and had to
        // guess. Echo the id the caller sent. HTTP stays 200 for a JSON-RPC
        // level error (the JSON-RPC-over-HTTP convention: the STATUS reports the
        // transport, the BODY reports the failure) — the 4xx above is reserved
        // for transport failures, where there is no JSON-RPC request to speak of.
        sendRpc(res, 200, msg.id ?? null, {
          code: e instanceof RpcError ? e.code : RPC_METHOD_NOT_FOUND,
          message: String(e instanceof Error ? e.message : e),
        });
      }
    });
  });
  server.listen(port, host, () => {
    console.error(`[ui2api] acp server for ${plugin.manifest?.name ?? "plugin"} on http://${host}:${port}`);
  });

  // GOAL 123: the browser leak. `plugin.context` lazily launches a real browser
  // on the first `tools/call` and NOTHING here ever closed it — so every ACP
  // server's browser outlived the server itself (measured: a Chrome survived
  // killing its own ACP server and had to be killed by hand). `close()` is the
  // documented seam on the context ("Callers that create a context must close()
  // it or the Chromium process leaks", src/plugin/context.ts), so this is where
  // it belongs: one idempotent closer wired to every way the server can end.
  let closed = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closed) return;
    closed = true;
    console.error(`[ui2api] acp server closing (${reason}) — releasing the browser this server launched`);
    try {
      await plugin.context.close();
    } catch (e) {
      console.error(`[ui2api] acp close failed (the browser may survive this run): ${String(e)}`);
    }
  };
  server.once("close", () => void shutdown("server closed"));
  const onSignal = (sig: NodeJS.Signals) => {
    void shutdown(sig).then(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

/**
 * ACP protocol versions this surface can SPEAK, newest last. Negotiation is
 * real in the sense that it is checked: a client that asks for something not on
 * this list is told so, rather than being handed a version string this server
 * never implemented (the pre-fix code answered "2025-03-26" unconditionally, so
 * a client asking for a 2026 draft was told it was speaking 2025-03-26 with the
 * same `capabilities` and no warning — a negotiated lie, not a negotiation).
 *
 * Keep this in step with the generated consumer server
 * (`src/generator/acp-template.ts`), which speaks the same single version.
 */
export const ACP_PROTOCOL_VERSIONS = ["2025-03-26"] as const;
export const ACP_PROTOCOL_VERSION = ACP_PROTOCOL_VERSIONS[ACP_PROTOCOL_VERSIONS.length - 1];

/** JSON-RPC error codes this server emits, so a refusal is a real refusal. */
const RPC_INVALID_REQUEST = -32600;
const RPC_INVALID_PARAMS = -32602;
const RPC_METHOD_NOT_FOUND = -32601;

/** An error carrying a JSON-RPC `code`, so the wire body is a real error. */
class RpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

async function handle(msg: any, plugin: LoadedPlugin): Promise<unknown> {
  const method = String(msg.method || "").toLowerCase();
  switch (method) {
    case "initialize": {
      // A client that names no version gets the newest one this server speaks
      // (that is the ACP handshake: the server picks a version both sides can
      // speak). A client that names one gets it back only if we actually speak
      // it — otherwise a named refusal naming what we DO speak.
      const asked = msg.params?.protocolVersion;
      if (asked !== undefined && asked !== null && asked !== "") {
        if (typeof asked !== "string" || !ACP_PROTOCOL_VERSIONS.includes(asked as never)) {
          throw new RpcError(
            `unsupported ACP protocolVersion ${JSON.stringify(asked)}: this server speaks ` +
              `${ACP_PROTOCOL_VERSIONS.join(", ")} — send one of those in initialize, or ` +
              `narrow the client to it. (Nothing else was negotiated and no tool ran.)`,
            RPC_INVALID_PARAMS
          );
        }
        return {
          protocolVersion: asked,
          capabilities: { tools: {} },
          serverInfo: { name: plugin.manifest?.name ?? "ui2api", version: plugin.manifest?.version ?? "0.1.0" },
        };
      }
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: plugin.manifest?.name ?? "ui2api", version: plugin.manifest?.version ?? "0.1.0" },
      };
    }
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
      // GOAL 107: a "nothing found" result is an ERROR, not a success carrying
      // the literal string "null". A consumer must be able to tell an absent
      // element from a real value.
      if (out === null || out === undefined) {
        return {
          is_error: true,
          content: [{ type: "text", text: `${name}: execution produced no result (the target does not exist or returned nothing — nothing was read)` }],
        };
      }
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return { content: [{ type: "text", text }] };
    }
    default:
      return { is_error: true, content: [{ type: "text", text: "unknown method: " + msg.method }] };
  }
}
