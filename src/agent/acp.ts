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
  /**
   * Bearer token gating this surface. Unset = the daemon's own unset posture
   * (`localhost-only`: no token required, and the loopback bind is the only
   * thing keeping it local). See `resolveAcpToken`.
   */
  token?: string;
}

/**
 * THE definition site for the ACP surface's bearer-token knob, mirroring the
 * daemon's `TOKEN_ENV` (`src/prompt/posture.ts`) rather than inventing a second
 * auth scheme: this repo has already solved "an HTTP surface that must not be
 * reachable without a credential" twice, and a third shape would be a third set
 * of semantics to keep in step.
 */
export const ACP_TOKEN_ENV = "UI2API_ACP_TOKEN";

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
 * GOAL 123 follow-on: THE AUTH GATE. This surface EXECUTES tools — `tools/call`
 * drives a real Chrome through the operator's own logged-in session, so a caller
 * that reaches this port holds a logged-in browser on every site a package names.
 * The bind gate limits reach to THIS machine, but "this machine" includes every
 * local process, every reverse proxy and every tunnel, and on a shared box every
 * other user — so loopback is a perimeter, not a credential.
 *
 * MIRRORED FROM THE DAEMON, deliberately. `src/prompt/http.ts` reads its token
 * the same way (`opts.token ?? process.env[TOKEN_ENV] ?? ""`) and gates with the
 * same single test (`if (token && authorization !== \`Bearer ${token}\`)`), and
 * its unset posture is `auth: "token" | "localhost-only"` — i.e. **unset means no
 * token is demanded**, and the loopback bind is what confines the surface. That
 * is deliberately NOT tightened here: an operator who exports the knob and gets
 * 401s on every existing consumer has configured a broken daemon, not a safer
 * one, and a gate that cannot be switched on is a gate that gets switched off.
 *
 * The hub's shape (`src/hub/api.ts`, `if (!okToken) return 401`) is NOT mirrored
 * here, and the difference is deliberate: the hub demands a token even when
 * unset, because its unset token makes EVERY publish fail. Matching that here
 * would mean an unset knob that bricks `tools/call` outright.
 *
 * The token VALUE is never logged, echoed, or placed in an error message: the
 * refusal names the env var and nothing else, so a refusal body is safe to put
 * in a client log or a bug report.
 */
export function resolveAcpToken(opts?: string): string {
  return opts ?? process.env[ACP_TOKEN_ENV] ?? "";
}

/**
 * JSON-RPC error codes this server emits, so a refusal is a real refusal.
 * Declared ABOVE the request handler because the credential gate is the first
 * thing in it: a code constant used before its own declaration is a temporal
 * dead zone waiting for the one reader who imports this module in a way that
 * reorders evaluation.
 *
 * `RPC_UNAUTHORIZED` is the JSON-RPC server-error band (-32000..-32099), which is
 * where "this server understood you and refuses on policy" belongs. The
 * pre-defined codes below are all *request* faults, and answering a missing
 * credential with one of those would tell the client it had sent a malformed
 * call — the opposite of what happened.
 */
const RPC_INVALID_REQUEST = -32600;
const RPC_INVALID_PARAMS = -32602;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_UNAUTHORIZED = -32001;

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

/**
 * The one place a bind is decided, for EVERY caller. MEASURED 2026-10-04, and
 * this is a correction of a reported defect rather than a fix of one: the claim
 * was that `serveInstanceAcp` passing no `bindHost` left `UI2API_ACP_BIND` inert
 * on the `hub run <host> --acp` path. It does not. The env fallback lives INSIDE
 * this resolver (`requested ?? process.env[ACP_BIND_ENV]`), so a caller that
 * passes nothing still resolves the knob — measured, with `bindHost` undefined:
 * `UI2API_ACP_BIND=0.0.0.0` -> `0.0.0.0`, `UI2API_ACP_BIND=10.0.0.5` ->
 * `10.0.0.5`, unset -> `127.0.0.1`. `runServer` also has exactly ONE caller in
 * the tree (`src/hub/serve.ts` `serveInstanceAcp`, from `cmdHubRun --acp`); the
 * generated ACP servers speak stdio and never reach this function. So there was
 * no second path whose resolution could disagree, and no `serve.ts` change was
 * required to make them agree — inventing one would have been a cosmetic edit
 * dressed as a fix.
 *
 * WHAT WAS REAL, AND IS NOW CLOSED. The measurement did surface a genuine
 * silent-no-op next door, in the combination the original refusal text itself
 * named: `UI2API_ACP_BIND=0.0.0.0` with no token was ACCEPTED, which is exactly
 * "a wider bind … with no credential to stop them". The two knobs were
 * orthogonal when they must not be: each was individually opt-in, and together
 * they opened a network-reachable tool-execution port with nothing to stop
 * anyone. So a widened bind now REQUIRES a credential. This is a tightening, and
 * deliberately so: the bind knob's whole purpose is to reach this port from
 * somewhere other than this machine, and a machine-local process is the one
 * caller a loopback bind already admits.
 *
 * ONE THROW, TWO REASONS, ON PURPOSE. The refusal literal's opening clause is the
 * anchor `test/skills-refusal-truth.test.ts` derives and requires every skill
 * that names `UI2API_ACP_BIND` to quote verbatim, so it is byte-identical to
 * before. The condition-specific half is a CONTINUATION of that one statement
 * rather than a second `throw`, which is the shape that derivation explicitly
 * exempts from being a seam of its own — a second throw statement here would
 * have demanded a second literal from skill files this change may not edit.
 */
export function resolveAcpBindHost(requested?: string, token?: string): string {
  const want = requested ?? process.env[ACP_BIND_ENV];
  if (!want) return ACP_BIND_HOST;
  if (isLoopback(want)) return want;
  const optedIn = process.env[ACP_BIND_ENV] === want;
  const credentialed = Boolean(resolveAcpToken(token));
  if (!optedIn || !credentialed) {
    throw new Error(
      `refusing to bind the ACP server to ${want}: ` +
        (optedIn
          ? `${ACP_BIND_ENV} names it, so the bind itself is what you asked for — but no credential is ` +
            `set, and this port executes tools: a wider bind with nothing to stop a caller hands anyone ` +
            `who can reach it a real browser driven with your own logged-in session. Set ${ACP_TOKEN_ENV} ` +
            `to the token clients will send in \`authorization: Bearer …\`; leaving it unset is safe only ` +
            `while the bind stays on ${ACP_BIND_HOST}, which every process on this machine can reach but ` +
            `nothing else can. The alternative to both is to keep ${ACP_BIND_HOST} and reach it through ` +
            `a tunnel.`
          : `it defaults to ${ACP_BIND_HOST} because this port executes tools — a wider bind hands anyone ` +
            `who can reach it a real browser driven with your own logged-in session (and, with no ` +
            `credential set, nothing to stop them). Set ${ACP_BIND_ENV}=${want} to opt in deliberately ` +
            `(and ${ACP_TOKEN_ENV}, which a widened bind now requires), or keep ${ACP_BIND_HOST} and ` +
            `reach it through a tunnel.`)
    );
  }
  return want;
}

// Minimal Agent Client Protocol (ACP) JSON-RPC server over HTTP. It exposes a
// loaded plugin's tools via `initialize`, `list_tools` / `tools/list`, and
// `call_tool` / `tools/call`. The plugin only ever sees its allow-listed
// context — this server just forwards tool calls into `plugin.tools`.
export async function runServer(opts: AcpOptions): Promise<void> {
  const { plugin, port } = opts;
  const token = resolveAcpToken(opts.token);
  // The SAME resolved token, not a re-read of the env: one resolver decides both
  // the bind and the credential, so the widened-bind gate cannot disagree with
  // the request gate about whether a credential exists.
  const host = resolveAcpBindHost(opts.bindHost, token); // throws BEFORE the socket exists
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // THE CREDENTIAL GATE, and it is FIRST — ahead of the route check, the
    // method check, the body read and the tool router, so a refused request has
    // executed nothing at all (no page opened, no tool dispatched, no recipe
    // replayed). The daemon gates at the same point in its own handler
    // (`src/prompt/http.ts`, ahead of capability dispatch) for the same reason.
    // An auth gate placed after routing would still answer a scanner with a
    // route-shaped 404, which is a map of this surface handed out for free.
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      return sendRpc(res, 401, null, {
        code: RPC_UNAUTHORIZED,
        message:
          `unauthorized: this surface executes tools through your own logged-in session, so a caller ` +
          `with no credential must not reach it. Send an \`authorization: Bearer <your token>\` header on ` +
          `the POST. No tool ran and nothing was read. Set ${ACP_TOKEN_ENV} to the token you send. ` +
          `Leaving it unset is a posture, not a default to fix: this server then demands no token and ` +
          `relies on being bound to ${ACP_BIND_HOST}, reachable only from processes on this machine — so if ` +
          `you widened the bind, the credential is what you are missing. The alternative to a wider bind ` +
          `is to keep it on ${ACP_BIND_HOST} and reach it through a tunnel.`,
      });
    }
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
