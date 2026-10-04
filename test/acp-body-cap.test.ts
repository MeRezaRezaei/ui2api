// GOAL 236 — the ACP JSON-RPC OVER HTTP surface read its body with no byte cap
// and no pause (`req.on("data", (chunk) => (body += chunk))`), so any caller that
// reached the port streamed an arbitrarily large POST and the string grew until
// the process ran out of memory. This is the surface that EXECUTES tools
// (`tools/call` forwards into `plugin.tools` and drives a real Chrome through the
// operator's logged-in session), so it was the highest-value target on the box.
//
// WHAT IS PINNED, AND WHY EACH HALF IS NEEDED:
//   1. an oversized body is refused with the repo's own 413 `payload_too_large`
//      class and is NEVER parsed — proved by EXECUTION, not by the status code
//      alone: the oversized body here is a VALID `tools/call` for a real tool
//      that records its own invocation, so an uncapped reader would not merely
//      answer 200, it would RUN the tool. The recorder file is the postcondition.
//   2. a normal-sized call still works end to end (no over-blocking: a cap that
//      refuses everything is not a cap).
//   3. the AUTH GATE still comes first: with a token set, an oversized body
//      without the credential is answered 401, not 413. The cap sits exactly at
//      the read, never in front of the credential gate, so an unauthenticated
//      caller cannot even learn the limit.
//
// The real `src/agent/acp.ts` HTTP server is booted, in a CHILD PROCESS, the
// same way test/acp.test.ts boots it: `runServer` returns no handle on its
// `http.Server` and installs `process.once("SIGINT"/"SIGTERM")` handlers, so an
// in-process boot would leave a listener this file could not close and would
// attach handlers to the runner itself. No browser is launched: the tool is a
// stub that only writes a file, so this proves the gate with no Chrome.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert";
import { ACP_MAX_BODY_BYTES } from "../src/agent/acp.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Comfortably over the cap, and still a syntactically valid JSON-RPC call. */
const OVER_LIMIT_BYTES = Math.ceil(ACP_MAX_BODY_BYTES * 1.5);

// A driver that boots the REAL `runServer` with ONE tool which records every
// invocation into a file. `dataDir`/`recorder` arrive as argv so the test reads
// the same absolute path the child writes.
const HTTP_DRIVER = `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { runServer } from "${ROOT}/src/agent/acp.js";
import type { LoadedPlugin } from "${ROOT}/src/plugin/types.js";

const recorder = process.argv[2]!;

const context = {
  config: { dataDir: "/tmp/codeg-acp/acp-body-cap-data" },
  logger: { info() {}, warn() {}, error() {} },
  registerTool() {},
  close: async () => {},
} as unknown as LoadedPlugin["context"];

const plugin: LoadedPlugin = {
  manifest: undefined,
  context,
  hooks: undefined,
  tools: new Map([
    ["record_call", {
      def: { name: "record_call", description: "Record that a tool actually ran.", inputSchema: { type: "object" } },
      // The postcondition: if this file exists, the body WAS parsed and the tool
      // DID execute. No browser, no page — a file write is the whole probe.
      handler: async (args) => {
        appendFileSync(recorder, JSON.stringify(args) + "\\n");
        return "recorded";
      },
    }],
  ]),
};

const probe = createServer();
await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((r) => probe.close(() => r()));
await runServer({ plugin, port, token: process.argv[3] || undefined });
`;

function startAcpHttpServer(dir: string, recorder: string, token?: string): {
  child: ChildProcess;
  postRaw(raw: string, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  close(): void;
} {
  const driverPath = resolve(dir, "acp-body-cap-driver.ts");
  // The driver is written into a temp dir with no repo package.json above it, so
  // tsx would resolve it as "cjs" and REFUSE its top-level await. Declaring the
  // module type it is authored in keeps ESM semantics.
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(driverPath, HTTP_DRIVER);

  const args = ["--import", "tsx", driverPath, recorder];
  if (token) args.push(token);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
  killer.unref?.();
  child.on("close", () => clearTimeout(killer));

  // Readiness is read off the server's OWN startup line, so the port used is the
  // one actually bound rather than a guess. Bounded; a failure surfaces stderr.
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

  const postRaw = async (raw: string, headers: Record<string, string> = {}) => {
    const port = await ready;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw,
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  return { child, postRaw, close: () => { child.kill("SIGKILL"); } };
}

function harness(t: any, token?: string) {
  const tmp = mkdtempSync(resolve(tmpdir(), "ui2api-acp-body-cap-"));
  const recorder = resolve(tmp, "tool-invocations.log");
  const server = startAcpHttpServer(tmp, recorder, token);
  t.after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });
  return { server, recorder };
}

const smallCall = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_call", args: { n: 1 } } });
// A VALID JSON-RPC call whose padding pushes it over the cap: an uncapped reader
// would parse it and run the tool, which is what the recorder file would prove.
const oversizedCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "record_call", args: { n: 2, padding: "x".repeat(OVER_LIMIT_BYTES) } },
});

test("GOAL 236: an oversized ACP body is refused 413 payload_too_large and is NEVER parsed or executed", async (t) => {
  const { server, recorder } = harness(t);

  const res = await server.postRaw(oversizedCall);

  assert.ok(
    Buffer.byteLength(oversizedCall) > ACP_MAX_BODY_BYTES,
    "the test's own premise: the body must really be over the cap",
  );
  assert.strictEqual(res.status, 413, "an oversized body is a 413, never a 200 result envelope: " + JSON.stringify(res.body));
  assert.strictEqual(res.body.result, undefined, "no result envelope: " + JSON.stringify(res.body));
  assert.strictEqual(res.body.id, null, "no id is knowable from a body the server refused to read");
  assert.strictEqual(
    res.body.error?.code,
    -32002,
    "the refusal is the JSON-RPC server-error band, a named code, not a malformed-call code",
  );
  assert.match(
    res.body.error.message,
    /^payload_too_large: request body exceeds \d+ bytes/,
    "the message must carry the repo's published code NAME and the byte count: " + res.body.error?.message,
  );
  assert.ok(
    !existsSync(recorder),
    "the tool MUST NOT have run: an oversized body that is parsed and executed is the whole defect",
  );
});

test("GOAL 236: a normal-sized ACP call still works end to end (the cap does not over-block)", async (t) => {
  const { server, recorder } = harness(t);

  const listed = await server.postRaw(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  assert.strictEqual(listed.status, 200, "a small tools/list must not be refused: " + JSON.stringify(listed.body));
  assert.strictEqual(listed.body.result.tools[0]?.name, "record_call", "the real tool list is served");
  assert.strictEqual(listed.body.id, 3, "a client can match the reply to its call");

  const called = await server.postRaw(smallCall);
  assert.strictEqual(called.status, 200, "a small tools/call must not be refused: " + JSON.stringify(called.body));
  assert.strictEqual(called.body.result.content[0]?.text, "recorded", "the tool really ran");
  assert.ok(existsSync(recorder), "the postcondition that proves execution is not blocked by the cap");
});

test("GOAL 236: the credential gate stays AHEAD of the cap — an unauthenticated oversized body is 401, never 413", async (t) => {
  const { server, recorder } = harness(t, "secret-token");

  const res = await server.postRaw(oversizedCall);

  assert.strictEqual(
    res.status,
    401,
    "the auth gate is first (src/agent/acp.ts:198, before the read): a cap in front of it would let an " +
      "unauthenticated caller learn the limit — " + JSON.stringify(res.body),
  );
  assert.match(res.body.error.message, /^unauthorized:/, "the refusal is the auth one, not the size one");
  assert.ok(!existsSync(recorder), "nothing was read, parsed or executed");
});
