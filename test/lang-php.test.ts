import { generatePhpMap, generatePhpMaps, phpClassName, phpMethodName } from "../src/generator/lang-php.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { test as t } from "node:test";
import { strict as assert } from "node:assert";
import type { RegistryPackage } from "../src/prompt/registry.js";

const pkg: RegistryPackage = {
  id: "deepseek",
  name: "DeepSeek",
  url: "https://chat.deepseek.com",
  description: "DeepSeek chat",
  version: "0.3.0",
  site: "chat.deepseek.com",
  authRequired: true,
  status: "active",
  // Mirrors capabilities/deepseek/metadata.json's REAL `verified` record — the
  // package IS live-verified, so the fixture must not claim `false` and must not
  // invent a proof pointer either. This generator emits nothing from it, so it is
  // present for shape-truth, not to move an assertion.
  verified: {
    since: "2026-09-19",
    evidence: "live chat + coT + web search round-trip via session-locked vault replay, proof PASS deepseek 11462 (2026-09-19)",
    via: "session-locked vault replay (localStorage userToken Bearer + AWS WAF/PoW page path)",
    scope: "chat, deepseek_reasoner + deepseek_web_search composer toggles, conversation list",
  },
  chat: { model: "deepseek", streaming: true },
  tools: [
    {
      name: "deepseek_chat",
      id: "deepseek_chat",
      description: "Chat on DeepSeek's own composer",
      method: "ui-path",
      // The four map-contract fields buildRegistry() derives for EVERY tool
      // (src/prompt/registry.ts:640-655). The fixture carries the same values a
      // real `capabilities/deepseek` package yields:
      //   workType           = method === "js-function" ? … : "ui-path"  -> "ui-path"
      //   reloadAfterSuccess = hardcoded true in the builder
      //   argsDeclared       = the deepseek manifest DOES declare an inputSchema
      //                         for this capability, so the schema below is a
      //                         DECLARED contract, not a GOAL 139 guess
      //   dispatch           = isDispatchable("deepseek") is truthy (the site is
      //                         in the dispatch table), so it is really callable
      workType: "ui-path",
      reloadAfterSuccess: true,
      argsDeclared: true,
      dispatch: "wired",
      // The arg schema is the DERIVED contract, not hand-written: it is
      // `node --import tsx scripts/derive-capability-args.ts --json` output for
      // deepseek_chat ("derived from chat()"), and it is byte-identical to
      // capabilities/deepseek/manifest.json's declaration. Measured:
      //   deepseek_chat | {newChat:bool, prompt:string, timeoutMs:number}
      //                 required:["prompt"]
      // because src/capabilities/deepseek.ts:181/189/190 reads exactly
      // args.prompt, args.newChat, args.timeoutMs.
      //
      // It USED to say `new_chat`, which no runner reads. That was not a
      // harmless typo: the generator's chat call site hardcodes the variable
      // `$newChat` (lang-php.ts:466), while `schemaParamsFor` (lang-php.ts:84)
      // names the PHP parameter after the schema key VERBATIM. A `new_chat`
      // schema therefore produced
      //     public function chat(string $prompt, bool $new_chat = null) {
      //         return $this->client->chat(..., $newChat ?? false);   // <-- $newChat
      //     }                                                          //     UNDECLARED
      // and PHP's `??` folds an undefined variable to `false` with no warning
      // — so the parameter was a SILENT dead no-op: a consumer asking for a
      // fresh conversation kept the old one. That is precisely the failure
      // GOAL 139 killed at the registry; this fixture reintroduced it one layer
      // down, in generated code, and nothing caught it because the generator
      // has no pin on this (see the two GOAL 139 pins at the bottom of this
      // file, which now make the class red on sight).
      //
      // NOTE this is NOT a snake_case PHP translation of `newChat`. There is no
      // such translation anywhere in the generator: both `schemaParamsFor` and
      // `bodyForParams` pass the key through unchanged. The client's
      // `chat(..., bool $newChat = false)` and its wire key `'new_chat' =>`
      // (lang-php.ts:334/340) are a DIFFERENT surface — the OpenAI
      // `/v1/chat/completions` extension field, which really is `new_chat` and
      // is read at src/prompt/openai.ts:150 (`body.new_chat`). Two surfaces,
      // two names, and the Map's job is to bridge them by using the capability
      // name the RUNNER reads.
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "read by the runner as args.prompt" },
          newChat: { type: "boolean", description: "read by the runner as args.newChat" },
          timeoutMs: { type: "number", description: "read by the runner as args.timeoutMs" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "deepseek_web_search",
      id: "deepseek_web_search",
      description: "Toggle the Search switch",
      method: "ui-path",
      // Same derivation as the chat tool above (registry.ts:640-655): ui-path
      // work, hardcoded reload, and `argsDeclared: true` because the deepseek
      // manifest declares an (empty) inputSchema for this capability.
      workType: "ui-path",
      reloadAfterSuccess: true,
      argsDeclared: true,
      dispatch: "wired",
      inputSchema: {
        type: "object",
        properties: { state: { type: "boolean", description: "Desired toggle state" } },
        required: [],
      },
    },
    {
      name: "deepseek_list_conversations",
      id: "deepseek_list_conversations",
      description: "List sidebar conversations",
      method: "ui-path",
      workType: "ui-path",
      reloadAfterSuccess: true,
      argsDeclared: true,
      dispatch: "wired",
      inputSchema: {
        type: "object",
        // Same derivation, same correction. This said `limit`, which NO runner
        // reads: src/capabilities/deepseek.ts:224 reads `args.query`, the
        // derivation says `query`, and capabilities/deepseek/manifest.json
        // declares `query`. Three independent sources, one answer.
        //
        // It mattered more here than a name: a non-chat tool's args go out
        // VERBATIM through `bodyForParams` (lang-php.ts:94), so the generated
        // PHP was POSTing `{"limit": 10}` to
        // /capability/deepseek/deepseek_list_conversations while the runner
        // read `args.query` — the filter was silently always-empty. The
        // GOAL 139 pin below is what found this one.
        properties: { query: { type: "string", description: "read by the runner as args.query" } },
        required: [],
      },
    },
  ],
};

function mkTmp(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ui2api-langphp-"));
  return dir;
}

t("phpMethodName camelCases bare capability ids", () => {
  assert.equal(phpMethodName("deepseek", "deepseek_chat"), "chat");
  assert.equal(phpMethodName("deepseek", "deepseek_list_conversations"), "listConversations");
  assert.equal(phpMethodName("deepseek", "deepseek_web_search"), "webSearch");
  assert.equal(phpMethodName("tencent-aistudio", "tencent-aistudio_chat"), "chat");
});

t("phpClassName pascalCases site ids", () => {
  assert.equal(phpClassName("deepseek"), "Deepseek");
  assert.equal(phpClassName("tencent-aistudio"), "TencentAistudio");
});

t("generatePhpMap emits a valid composer package with one method per capability", () => {
  const out = mkTmp();
  try {
    const dir = generatePhpMap(pkg, resolve(out, "deepseek"));
    assert.ok(existsSync(resolve(dir, "composer.json")));
    assert.ok(existsSync(resolve(dir, "src", "Ui2apiClient.php")));
    assert.ok(existsSync(resolve(dir, "src", "DeepseekMap.php")));
    assert.ok(existsSync(resolve(dir, "config", "ui2api.php")));
    assert.ok(existsSync(resolve(dir, "README.md")));
    const composer = JSON.parse(readFileSync(resolve(dir, "composer.json"), "utf8"));
    assert.equal(composer.name, "ui2api/deepseek-map");
    assert.ok(composer.autoload["psr-4"]["Ui2api\\Map\\Deepseek\\"] === "src/", "psr-4 namespace");
    const mapSrc = readFileSync(resolve(dir, "src", "DeepseekMap.php"), "utf8");
    assert.ok(mapSrc.includes("public function chat(string $prompt"), "chat param 1");
    // CONTENT CHANGE (deliberate, not a rename to taste): this used to pin
    // `bool $new_chat = null`. It is now `bool $newChat = null` because the
    // schema arg the runner reads is `newChat`, and the generator emits the PHP
    // parameter name verbatim from that key. The old pin CERTIFIED the dead
    // parameter: with `$new_chat` declared, the body's hardcoded `$newChat ??`
    // referenced a variable that did not exist and PHP folded it to `false`.
    // Nothing is weakened — the assertion still requires a typed, defaulted
    // `bool` parameter, and it now requires it to be the one the call site uses
    // (the "no undeclared variable" pin below enforces that second half).
    assert.ok(mapSrc.includes("bool $newChat = null"), "chat param 2 — the name the chat call site actually reads");
    // The derived contract carries timeoutMs too (deepseek.ts:190), so the
    // generated Map exposes it rather than dropping a real arg on the floor.
    assert.ok(mapSrc.includes("int|float $timeoutMs = null"), "chat param 3 — timeoutMs is a real runner read");
    assert.ok(mapSrc.includes("public function webSearch(bool $state = null"), "toggle signature");
    // CONTENT CHANGE (same class, same justification): was
    // `public function listConversations(int|float $limit = null`. Now
    // `string $query = null`, because `limit` was an arg no runner reads
    // (deepseek.ts:224 reads args.query) and it was being POSTED verbatim. The
    // assertion is not weakened — it still pins a typed, defaulted parameter,
    // and the new name is the one that actually reaches the runner.
    assert.ok(mapSrc.includes("public function listConversations(string $query = null"), "read signature");
    // Chat routes through the OpenAI surface; toggles/reads route through /capability.
    assert.ok(mapSrc.includes("$this->client->chat('deepseek'"));
    assert.ok(mapSrc.includes("$this->client->capability('deepseek', 'deepseek_web_search'"));
    const clientSrc = readFileSync(resolve(dir, "src", "Ui2apiClient.php"), "utf8");
    assert.ok(clientSrc.includes("/v1/chat/completions"), "client targets OpenAI surface");
    assert.ok(clientSrc.includes("/capability/"), "client targets capability surface");
    const config = readFileSync(resolve(dir, "config", "ui2api.php"), "utf8");
    assert.ok(config.includes("UI2API_BASE_URL"), "laravel-style env config");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

t("generatePhpMaps emits per-site dirs and honors a site filter", () => {
  const out = mkTmp();
  try {
    const dirs = generatePhpMaps([pkg], out);
    assert.equal(dirs.length, 1);
    assert.ok(existsSync(resolve(dirs[0], "composer.json")));
    const filtered = generatePhpMaps([pkg], out, "nope");
    assert.deepEqual(filtered, []);
    const hit = generatePhpMaps([pkg], out, "deepseek");
    assert.equal(hit.length, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

t("generated php lints when php is available", () => {
  let phpAvailable = true;
  try {
    execFileSync("php", ["-v"], { stdio: "ignore" , timeout: 120000 });
  } catch {
    phpAvailable = false;
  }
  if (!phpAvailable) return; // environment lacks php; nothing to lint
  const out = mkTmp();
  try {
    const dir = generatePhpMap(pkg, resolve(out, "deepseek"));
    for (const f of ["Ui2apiClient.php", "DeepseekMap.php"]) {
      execFileSync("php", ["-l", resolve(dir, "src", f)], { stdio: "pipe" , timeout: 120000 });
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
t("GOAL 52: the generated Ui2apiClient forwards an optional $account to both surfaces", () => {
  const out = mkTmp();
  try {
    const dir = generatePhpMap(pkg, resolve(out, "deepseek"));
    const clientSrc = readFileSync(resolve(dir, "src", "Ui2apiClient.php"), "utf8");
    // chat(): optional trailing $account, forwarded into the /v1 payload.
    assert.ok(
      clientSrc.includes(
        "public function chat(string $model, array $messages, bool $stream = false, bool $newChat = false, ?string $account = null): array"
      ),
      "chat() signature carries the optional account (GOAL 52)"
    );
    assert.ok(
      clientSrc.includes("if ($account !== null) {\n            $payload['account'] = $account;\n        }"),
      "chat() forwards account only when set (never sends empty-string account)"
    );
    // capability(): same optional trailing $account for /capability/<site>.
    assert.ok(
      clientSrc.includes(
        "public function capability(string $site, string $capability, array $args = [], ?string $account = null): mixed"
      ),
      "capability() signature carries the optional account (GOAL 52)"
    );
    // The map's per-tool call sites keep working — the generated Map methods
    // call chat()/capability() positionally; adding the trailing param is
    // backward compatible (check the map source still calls both).
    const mapSrc = readFileSync(resolve(dir, "src", "DeepseekMap.php"), "utf8");
    assert.ok(mapSrc.includes("$this->client->chat('deepseek'"));
    assert.ok(mapSrc.includes("$this->client->capability('deepseek', 'deepseek_web_search'"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// GOAL 90 — the generated PHP client mis-read the daemon's error responses.
//
// Before: the client did `($res['body']['error'] ?? json_encode(...))` inside a
// string concat. The daemon returns `error` as an OBJECT in two shapes
// ({error:{code,message}} and {error:{message,type,code,param}}) and as a plain
// STRING in one ({error:"<string>"} — the no-stored-account / unknown-site
// refusal). PHP string-cast the array: the thrown message ended in the literal
// word "Array", losing BOTH the code and the real message. And chat() returned
// only choices[0].message, dropping the sibling `ui2api` block that carries the
// honest doneReason, so a `restricted` tier-wall stop passed for a real answer.
//
// These pins EXECUTE the generated PHP against a real HTTP server on 127.0.0.1
// that replays the daemon's real wire shapes. The pre-GOAL-90 suite only ran
// `php -l`, so no generated PHP line ever ran and none of this was caught.

/** The daemon's REAL error/response shapes, as its code emits them. */
const DAEMON_SHAPES: Record<string, {
  status: number;
  body: Record<string, unknown>;
  code: string;
  message: string;
  type?: string;
  param?: string;
  doneReason?: string;
  refusal?: string | null;
}> = {
  // OpenAI-shaped: src/prompt/openai.ts unknown_model
  unknown_model: {
    status: 404,
    body: { error: { message: 'unknown site "nope"; ui2api serves configured chat profiles only', type: "invalid_request_error", code: "unknown_model", param: "model" } },
    code: "unknown_model",
    message: 'unknown site "nope"; ui2api serves configured chat profiles only',
    type: "invalid_request_error",
    param: "model",
  },
  // {error:{code,message}} — src/prompt/http.ts poolRefusal (503)
  pool_saturated: {
    status: 503,
    body: { error: { code: "pool_saturated", message: "pool saturated (queue full): 8 waiting, 4 busy" } },
    code: "pool_saturated",
    message: "pool saturated (queue full): 8 waiting, 4 busy",
  },
  // {error:{code,message}} — the daemon's own 504 deadline
  request_timeout: {
    status: 504,
    body: { error: { code: "request_timeout", message: "request timeout after 900000ms on POST /v1/chat/completions" } },
    code: "request_timeout",
    message: "request timeout after 900000ms on POST /v1/chat/completions",
  },
  // {error:"<string>"} — the ONE non-OpenAI shape: validateAccount's
  // `no stored account "<acct>" for "<host>"; available: [...]` 400.
  no_account: {
    status: 400,
    body: { error: 'no stored account "ghost" for "chat.deepseek.com"; available: [default, work]' },
    code: "no_stored_account",
    message: 'no stored account "ghost" for "chat.deepseek.com"; available: [default, work]',
  },
  not_found: {
    status: 404,
    body: { error: "not found" },
    code: "not_found",
    message: "not found",
  },
  // A 5xx with NO error key at all — the honest http_<status> fallback, and the
  // raw body verbatim (never a string-cast structure, never "Array").
  no_error_key: {
    status: 500,
    body: { detail: "proxy exploded" },
    code: "http_500",
    message: '{"detail":"proxy exploded"}',
  },
  // 200 answers: the honest stop reason (GOAL 54 `restricted`) and a real refusal.
  restricted: {
    status: 200,
    body: {
      id: "x", object: "chat.completion", created: 1, model: "deepseek",
      choices: [{ index: 0, message: { role: "assistant", content: "", refusal: null }, finish_reason: "stop" }],
      ui2api: { site: "deepseek", chunkCount: 0, doneReason: "restricted" },
    },
    code: "stop",
    message: "",
    doneReason: "restricted",
    refusal: null,
  },
  refusal: {
    status: 200,
    body: {
      id: "y", object: "chat.completion", created: 1, model: "deepseek",
      choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I can't help with that." }, finish_reason: "stop" }],
      ui2api: { site: "deepseek", doneReason: "stop" },
    },
    code: "stop",
    message: "",
    doneReason: "stop",
    refusal: "I can't help with that.",
  },
};

/** Probe for a usable php. Never a silent skip: the reason is reported. */
function phpGate(): { ok: boolean; version: string; reason: string } {
  try {
    const out = execFileSync("php", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] , timeout: 120000 });
    return { ok: true, version: out.split("\n")[0]?.trim() ?? "php", reason: "php present — the generated client is EXECUTED, not just linted" };
  } catch (e) {
    return { ok: false, version: "none", reason: `environment-gated: no runnable php (${e instanceof Error ? e.message.split("\n")[0] : String(e)}) — falling back to structural pins over the generated source` };
  }
}

t("GOAL 90: the generated client EXECUTES and names every daemon refusal (both wire shapes)", async () => {
  const gate = phpGate();
  const out = mkTmp();
  const { createServer } = await import("node:http");
  const { writeFileSync } = await import("node:fs");
  const { execFile } = await import("node:child_process");

  // Always assert the emitted package SHAPE (never vacuous, php or not).
  const dir = generatePhpMap(pkg, resolve(out, "deepseek"));
  assert.ok(existsSync(resolve(dir, "src", "Ui2apiException.php")), "the normalizer ships as a PSR-4 class file");

  if (!gate.ok) {
    console.error(`[GOAL 90] runtime pin ${gate.reason}`);
    rmSync(out, { recursive: true, force: true });
    return;
  }

  // A real daemon stand-in on 127.0.0.1 replaying the shapes above.
  const server = createServer((req, r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const model = (JSON.parse(b || "{}") as { model?: string }).model ?? "";
      const shape = DAEMON_SHAPES[model];
      r.writeHead(shape ? shape.status : 500, { "Content-Type": "application/json" });
      r.end(JSON.stringify(shape ? shape.body : { error: "unpinned shape" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const cases = Object.keys(DAEMON_SHAPES);
  // A driver that turns PHP diagnostics into failures: the pre-GOAL-90 code
  // raised "Array to string conversion" on the object shape, so a clean run
  // proves no structure was ever string-cast.
  const driver = resolve(dir, "driver.php");
  writeFileSync(
    driver,
    `<?php
declare(strict_types=1);
error_reporting(E_ALL);
set_error_handler(function (int $no, string $str) { throw new ErrorException($str, 0, $no); });
require __DIR__ . '/src/Ui2apiException.php';
require __DIR__ . '/src/Ui2apiClient.php';
$client = new Ui2api\\Map\\Deepseek\\Ui2apiClient('http://127.0.0.1:${port}');
$out = [];
foreach (${JSON.stringify(cases)} as $model) {
    try {
        $out[$model] = ['threw' => false, 'result' => $client->chat($model, [['role' => 'user', 'content' => 'hi']], false, false)];
    } catch (Ui2api\\Map\\Deepseek\\Ui2apiException $e) {
        $out[$model] = ['threw' => true, 'class' => $e::class, 'isRuntime' => $e instanceof RuntimeException, 'message' => $e->getMessage(), 'errorCode' => $e->errorCode, 'errorMessage' => $e->errorMessage, 'status' => $e->status, 'type' => $e->type, 'param' => $e->param, 'normalized' => $e->toArray()];
    } catch (Throwable $e) {
        $out[$model] = ['threw' => true, 'class' => $e::class, 'unexpected' => $e->getMessage()];
    }
}
echo json_encode($out);
`
  );

  const stdout = await new Promise<string>((res, rej) => {
    execFile("php", [driver], { encoding: "utf8", timeout: 60000 }, (e, so, se) => (e ? rej(new Error(`php driver failed: ${e.message}\n${se}`)) : res(so)));
  }).finally(() => {
    server.close();
  });
  rmSync(out, { recursive: true, force: true });

  const got = JSON.parse(stdout) as Record<string, Record<string, unknown>>;

  for (const name of cases) {
    const shape = DAEMON_SHAPES[name]!;
    const seen = got[name]!;
    assert.equal(seen["unexpected"], undefined, `${name}: no unexpected throwable (${String(seen["class"])}: ${String(seen["unexpected"] ?? "")})`);
    if (shape.status < 300) {
      assert.equal(seen["threw"], false, `${name}: a 2xx answer must NOT throw`);
      const result = seen["result"] as Record<string, unknown>;
      // (2) the honest stop reason survives translation.
      const block = result["ui2api"] as Record<string, unknown> | null;
      assert.ok(block !== null && typeof block === "object", `${name}: the daemon's ui2api sibling block is surfaced`);
      assert.equal(block["doneReason"], shape.doneReason, `${name}: the block carries the daemon's own doneReason`);
      assert.equal(block["site"], "deepseek", `${name}: the block carries the daemon's site`);
      assert.equal(result["done_reason"], shape.doneReason, `${name}: doneReason surfaces flat as done_reason`);
      // (2) the daemon's real refusal, not a hardcoded null.
      assert.equal(result["refusal"], shape.refusal, `${name}: refusal carries the daemon's own value`);
      assert.ok("refusal" in result, `${name}: refusal stays present (back-compat)`);
      continue;
    }
    assert.equal(seen["threw"], true, `${name}: a ${shape.status} must throw`);
    assert.equal(seen["class"], "Ui2api\\Map\\Deepseek\\Ui2apiException", `${name}: the structured normalizer threw`);
    assert.equal(seen["isRuntime"], true, `${name}: still catchable as \\RuntimeException (back-compat)`);
    // The whole point: the real code and the real message survive.
    assert.equal(seen["errorCode"], shape.code, `${name}: the daemon's named code survives`);
    assert.equal(seen["status"], shape.status, `${name}: the real HTTP status is reported`);
    assert.equal(seen["errorMessage"], shape.message, `${name}: the daemon's REAL message survives (never "Array")`);
    const msg = String(seen["message"]);
    assert.ok(msg.includes(shape.code), `${name}: thrown message names the code — got: ${msg}`);
    assert.ok(msg.includes(shape.message), `${name}: thrown message carries the real message — got: ${msg}`);
    assert.ok(!msg.includes("Array"), `${name}: thrown message is never the string "Array" — got: ${msg}`);
    // The normalized STRUCTURE always has the same three keys.
    const norm = seen["normalized"] as Record<string, unknown>;
    assert.equal(norm["code"], shape.code, `${name}: toArray().code`);
    assert.equal(norm["message"], shape.message, `${name}: toArray().message is the real message`);
    assert.equal(norm["status"], shape.status, `${name}: toArray().status`);
    if (shape.type !== undefined) assert.equal(seen["type"], shape.type, `${name}: type carried when present`);
    if (shape.param !== undefined) assert.equal(seen["param"], shape.param, `${name}: param carried when present`);
  }
});

t("GOAL 90: structural pins over the generated source (never a vacuous pass)", () => {
  const gate = phpGate();
  const out = mkTmp();
  try {
    const dir = generatePhpMap(pkg, resolve(out, "deepseek"));
    const client = readFileSync(resolve(dir, "src", "Ui2apiClient.php"), "utf8");
    const exc = readFileSync(resolve(dir, "src", "Ui2apiException.php"), "utf8");
    const readme = readFileSync(resolve(dir, "README.md"), "utf8");

    // The normalizer is reachable and takes (body, status, rawBody[, path]).
    assert.ok(client.includes("public static function normalizeError(mixed $body, int $status, string $rawBody = '', string $path = '')"), "client exposes the normalizer helper");
    assert.ok(exc.includes("public static function fromResponse(mixed $body, int $status, string $rawBody = '', string $path = ''): self"), "normalizer implementation");
    // BOTH wire shapes are branched on explicitly.
    assert.ok(exc.includes("if (is_string($error))"), "shape 1: {error:\"<string>\"} is handled");
    assert.ok(exc.includes("} elseif (is_array($error)) {"), "shape 2: {error:{message,type,code,param}} is handled");
    // The pre-GOAL-90 bug pattern is gone from the client.
    assert.ok(!client.includes("$res['body']['error'] ??"), "the string-concat of body['error'] is gone");
    assert.ok(!client.includes("new \\RuntimeException($data['error']"), "capability() no longer string-casts error");
    assert.ok(client.includes("throw self::normalizeError("), "every non-2xx goes through the normalizer");
    // Every named refusal the daemon can send has a stable code.
    for (const code of ["pool_saturated", "pool_queue_timeout", "pool_closed", "request_timeout", "no_stored_account", "unknown_site", "not_found"]) {
      assert.ok(exc.includes(`'${code}'`), `named code ${code} is mapped`);
    }
    assert.ok(exc.includes("return 'http_' . $status;"), "the honest http_<status> fallback exists");
    // The honest block is surfaced by chat().
    assert.ok(client.includes("$message['ui2api'] ="), "chat() returns the ui2api sibling block");
    assert.ok(client.includes("$message['done_reason'] ="), "chat() returns doneReason flat");
    assert.ok(client.includes("$message['refusal'] ="), "chat() carries the daemon's own refusal");
    // raw() keeps the raw body so a non-JSON error names itself honestly.
    assert.ok(client.includes("'raw' => $raw,"), "raw() preserves the raw body for the normalizer");
    // (4) the emitted README/example must not drift from the new client.
    assert.ok(readme.includes("Ui2apiException"), "README documents the named-refusal exception");
    assert.ok(readme.includes("done_reason"), "README shows the honest done_reason");
    assert.ok(readme.includes("no_stored_account"), "README names the real refusal codes");
    assert.ok(!readme.includes("role: 'user'"), "README no longer claims the assistant message is role 'user'");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  console.error(`[GOAL 90] ${gate.reason}`);
});

// ---------------------------------------------------------------------------
// GOAL 139 (generator layer) — the FIXTURE is a hand-written RegistryPackage,
// and a hand-written contract is exactly the thing GOAL 139 set out to kill.
//
// `test/registry-args-drift.test.ts` closes the drift hole for the REAL
// packages: it re-derives every `capabilities/<site>/manifest.json` schema from
// the runner and fails on a mismatch. But a test fixture is not a package — it
// lives in a .ts file, no gate read it, and so it kept `new_chat` after GOAL 139
// fixed the manifest, then generated PHP whose declared parameter was never
// used. The gate was not wrong; the fixture was simply outside it.
//
// These two pins close that hole for THIS file, and neither re-implements the
// derivation (the repo rule: a second copy of the extractor would be free to
// drift from the first). Both read the RUNNER and the GENERATED OUTPUT, so they
// hold for any fixture edit — including one that adds a tool nobody reads.

// (1) Every arg the fixture advertises is a name the runner actually reads.
//     `args.<name>` must occur in src/capabilities/<site>.ts.
//     This is deliberately the runner SOURCE and not
//     `scripts/derive-capability-args.ts` output: the extractor reads one
//     method's own body, so a runner that DELEGATES (deepseek's webSearch ->
//     flipToggle, where `args.state` is read at deepseek.ts:314) comes back as
//     `{}` from the script but is genuinely reachable. Grepping the runner file
//     follows the delegation, so this pin cannot call a live arg unreachable —
//     and it still fails hard on `new_chat`, which appears nowhere.
t("GOAL 139: every arg this fixture advertises is a name the runner really reads (args.<name>)", () => {
  const runnerPath = resolve(import.meta.dirname, "..", "src", "capabilities", `${pkg.id}.ts`);
  assert.ok(existsSync(runnerPath), `the runner under test exists (${runnerPath}) — no pin against a file that is not there`);
  const runner = readFileSync(runnerPath, "utf8");
  let checked = 0;
  for (const tool of pkg.tools) {
    for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
      checked++;
      assert.ok(
        runner.includes(`args.${key}`),
        `${pkg.id}/${tool.id}: the fixture advertises arg "${key}", but the runner never reads args.${key} — ` +
          `a consumer sending it gets it silently ignored (the GOAL 139 new_chat failure)`
      );
    }
  }
  // Never vacuous: a fixture that stopped declaring args would pass by saying
  // nothing, so the number of checked names is itself asserted.
  assert.ok(checked >= 5, `the pin actually checked args (got ${checked}) — a vacuous pass is a lie`);
});

// (2) The generated Map must never reference a variable it did not declare.
//     This is the language-level consequence of (1) and it needs no knowledge of
//     any particular arg: PHP folds `$undefined ?? false` to `false` with no
//     warning and no error, so a mismatched call site does not fail loudly —
//     it silently drops the caller's argument. That is precisely how
//     `new_chat` survived every other gate here: `php -l` is happy, the client
//     executes, and the request still goes out — just without the flag.
t("GOAL 139: no generated Map method references an undeclared variable (dead params fail LOUD here)", () => {
  const out = mkTmp();
  try {
    const dir = generatePhpMap(pkg, resolve(out, "deepseek"));
    const mapSrc = readFileSync(resolve(dir, "src", "DeepseekMap.php"), "utf8");
    // Doc comments are stripped first: a description containing `$foo` is prose,
    // not a variable reference.
    const code = mapSrc.replace(/\/\*[\s\S]*?\*\//g, "");
    const methods = [...code.matchAll(/public function (\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n    \}/g)];
    assert.ok(methods.length === pkg.tools.length + 1, `every capability produced a method (got ${methods.length}, tools ${pkg.tools.length} + __construct)`);
    for (const [, name, rawParams, body] of methods) {
      const declared = new Set([...rawParams.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!));
      const used = new Set(
        [...body.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!).filter((v) => v !== "this")
      );
      for (const v of used) {
        assert.ok(
          declared.has(v),
          `${name}() references $${v}, which it does not declare — PHP would silently fold ` +
            `$${v} ?? … to a default, so the caller's argument is dropped with no error`
        );
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
