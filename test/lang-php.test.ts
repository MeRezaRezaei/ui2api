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
  chat: { model: "deepseek", streaming: true },
  tools: [
    {
      name: "deepseek_chat",
      id: "deepseek_chat",
      description: "Chat on DeepSeek's own composer",
      method: "ui-path",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt to send" },
          new_chat: { type: "boolean", description: "Start a fresh conversation" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "deepseek_web_search",
      id: "deepseek_web_search",
      description: "Toggle the Search switch",
      method: "ui-path",
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
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max entries" } },
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
    assert.ok(mapSrc.includes("bool $new_chat = null"), "chat param 2");
    assert.ok(mapSrc.includes("public function webSearch(bool $state = null"), "toggle signature");
    assert.ok(mapSrc.includes("public function listConversations(int|float $limit = null"), "read signature");
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
    execFileSync("php", ["-v"], { stdio: "ignore" });
  } catch {
    phpAvailable = false;
  }
  if (!phpAvailable) return; // environment lacks php; nothing to lint
  const out = mkTmp();
  try {
    const dir = generatePhpMap(pkg, resolve(out, "deepseek"));
    for (const f of ["Ui2apiClient.php", "DeepseekMap.php"]) {
      execFileSync("php", ["-l", resolve(dir, "src", f)], { stdio: "pipe" });
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
    const out = execFileSync("php", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
