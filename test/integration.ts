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
import {
  classifyIntegrationFailure,
  makeVerdict,
  verdictPath,
  writeVerdict,
} from "./helpers/browser-verdict.js";

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

    // Form-submit action (js-function target) should be present.
    const formAction = map.actions.find((a) => /^(query_go|go|query)$/.test(a.name));
    assert.ok(formAction, "form submit action missing");

    console.log("INTEGRATION OK — send_prompt:", text, "| search(replay):", stext);

    // RECORD THE PASS. A verdict that only ever records the skip is a
    // one-sided record: its absence is then ambiguous between "it passed" and
    // "nobody wrote it", which is precisely the ambiguity this file exists to
    // remove. The gate asserts this file exists AND was written by THIS job, so
    // a stale verdict left in a workspace can never vouch for a later run.
    writeVerdict(ROOT, makeVerdict("passed", "integration completed; the browser-backed half ran to its last assertion"));

    await client.close();
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  // A MISSING SYSTEM LIBRARY is an environment fault, not a property of this
  // application, and it must not be reported as a code failure.
  //
  // MEASURED on pipelines 1056 and 1061: the CI container's apt cannot verify
  // any Debian signature ("The repository ... is not signed" for all three
  // bookworm repos), so `playwright install-deps` never installs anything, and
  // Chromium dies with
  //
  //     error while loading shared libraries: libnspr4.so: cannot open shared
  //     object file: No such file or directory
  //
  // The fault is NOT transient and NOT the network: the same apt works on the
  // host (only an unrelated clickhouse repo fails there), so the runner's
  // node:24-bookworm image carries a keyring that cannot verify the current
  // Debian archive. That is a runner-supply problem to fix at the runner, and it
  // is reported rather than papered over.
  //
  // The distinction drawn here is narrow and deliberate. A browser that cannot
  // LOAD is an environment problem; a browser that loads and then misbehaves is
  // a real regression and still fails.
  //
  // GOAL 150 — WHAT CHANGED, AND WHY IT IS NOT A LOOSENING. The old test here
  // was `blob =~ /error while loading shared libraries|cannot open shared object
  // file/` and nothing else. That pattern matches a missing shared object of ANY
  // name, so every one of them was silently downgraded to a green exit 0 — which
  // means a REAL regression (this project gaining a native dependency whose
  // `.so` is not installed) would have hidden behind this skip, permanently and
  // invisibly. Matching the loader's diagnostic is therefore only ADMISSIBLE
  // evidence; the decision now also asks WHICH library.
  //
  // The classifier (`./helpers/browser-verdict.ts`) skips ONLY when every
  // library the loader named is one `playwright install-deps` is responsible
  // for. Anything else — a soname this repository introduced, or a diagnostic
  // that names no library at all — is a hard failure with the name printed. The
  // measured `libnspr4` fault is on that list (it is a real chromium OS
  // dependency, and it ships with libplc4/libplds4), so the recurring mirror
  // fault keeps its skip and this pipeline does not go permanently red on
  // somebody else's keyring. The failure mode that IS left red is the one that
  // means "look at me": an unrecognised library.
  //
  // And the skip is no longer only a log line. It writes a machine-readable
  // verdict that `test/gate-wiring.test.ts` reads, stamped with this job's id,
  // so "the browser half did not run" is an assertable fact rather than one
  // line in a ~3,500-line log that `deploy` unblocks straight past.
  const chain = (e as { message?: string; log?: string[] })?.message ?? "";
  const log = ((e as { log?: string[] })?.log ?? []).join("\n");
  const blob = `${chain}\n${log}`;
  const verdict = classifyIntegrationFailure(blob);

  if (verdict.outcome === "skipped") {
    writeVerdict(ROOT, makeVerdict("skipped", verdict.reason, verdict.missingLibraries, verdict.classification));
    console.error(
      "INTEGRATION SKIPPED — the browser could not be loaded because a system library is missing " +
        "(NOT a code failure). Every other assertion in this suite still ran in CI's unit lane; " +
        "the browser-dependent half is unverified on this runner until its apt keyring is fixed.",
    );
    console.error("  missing library/libraries:", verdict.missingLibraries.join(", "));
    console.error("  verdict written:", verdictPath(ROOT), "(read by test/gate-wiring.test.ts)");
    process.exit(0);
  }
  writeVerdict(ROOT, makeVerdict("failed", verdict.reason, verdict.missingLibraries));
  console.error("TEST FAILED:", e);
  process.exit(1);
});
