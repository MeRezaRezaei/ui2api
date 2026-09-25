import { generatePhpMap, generatePhpMaps, phpClassName, phpMethodName } from "../src/generator/lang-php.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe as d } from "node:test";
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

d("phpMethodName camelCases bare capability ids", () => {
  assert.equal(phpMethodName("deepseek", "deepseek_chat"), "chat");
  assert.equal(phpMethodName("deepseek", "deepseek_list_conversations"), "listConversations");
  assert.equal(phpMethodName("deepseek", "deepseek_web_search"), "webSearch");
  assert.equal(phpMethodName("tencent-aistudio", "tencent-aistudio_chat"), "chat");
});

d("phpClassName pascalCases site ids", () => {
  assert.equal(phpClassName("deepseek"), "Deepseek");
  assert.equal(phpClassName("tencent-aistudio"), "TencentAistudio");
});

d("generatePhpMap emits a valid composer package with one method per capability", () => {
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

d("generatePhpMaps emits per-site dirs and honors a site filter", () => {
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

d("generated php lints when php is available", () => {
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
d("GOAL 52: the generated Ui2apiClient forwards an optional $account to both surfaces", () => {
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
