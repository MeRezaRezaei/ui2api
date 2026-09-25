// Per-language map package generator — PHP (Laravel-compatible) target.
//
// Verbatim 2026-09-16 (registry separation, half-open chunk): the registry
// repository holds "what is the function to api for any site"; the core app
// (TypeScript) and any other language (user named Laravel as the example)
// install the SAME per-site map package, so "the api call in the background
// between two services can be therefore a function call in any programming
// language... the functions that a developer can call for a version can be
// simply generated based on the same map".
//
// This module turns one registry package (the same source the daemon's
// GET /registry contract is built from — see src/prompt/registry.ts) into a
// Composer package for PHP/Laravel:
//
//   <out>/composer.json          name: ui2api/<site>-map, PSR-4 autoload
//   <out>/src/Ui2apiClient.php   base HTTP client (promptd daemon, bearer opt)
//   <out>/src/<Site>Map.php      typed class: one method per capability
//                                (same signature as the registry tool schema)
//   <out>/config/ui2api.php      Laravel-style config (mergeable)
//   <out>/README.md              usage from core (TS) and Laravel
//
// The generated functions are thin honest wrappers: they call the daemon's
// /v1/chat/completions (chat) or /capability/<site> (non-chat capabilities);
// the daemon drives the site's own UI/JS in the user's real session. No
// fabricated traffic, no reverse-engineered wire protocol in the client.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RegistryPackage, RegistryTool, RegistryToolInputSchema } from "../prompt/registry.js";

const PHP_DEFAULTS = {
  baseUrl: "http://127.0.0.1:9797",
  token: "",
};

/** Map a JSON schema type to a PHP declaration + doc type. */
function phpTypeFor(prop: { type: string }): { doc: string; decl: string } {
  switch (prop.type) {
    case "boolean":
      return { doc: "bool", decl: "bool" };
    case "number":
    case "integer":
      return { doc: "int|float", decl: "int|float" };
    case "array":
      return { doc: "array", decl: "array" };
    default:
      return { doc: "string", decl: "string" };
  }
}

/** Method name for a capability: camelCase of the bare capability id. */
export function phpMethodName(siteId: string, capabilityId: string): string {
  const bare = capabilityId.startsWith(`${siteId}_`)
    ? capabilityId.slice(siteId.length + 1)
    : capabilityId.replace(new RegExp(`^${siteId.replace(/-/g, "_")}_`), "");
  const parts = bare.split(/_+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("")
    .replace(/[^A-Za-z0-9_]/g, "_");
}

/** PascalCase class name for a site's map class. */
export function phpClassName(siteId: string): string {
  return siteId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function schemaParamsFor(siteId: string, tool: RegistryTool): string {
  const schema: RegistryToolInputSchema = tool.inputSchema;
  const params = Object.entries(schema.properties ?? {});
  if (params.length === 0) return "";
  const required = new Set(schema.required ?? []);
  return params
    .map(([key, prop]) => {
      const { doc, decl } = phpTypeFor(prop);
      const name = key.replace(/[^A-Za-z0-9_]/g, "_");
      const defaultSuffix = required.has(key) ? "" : ` = null`;
      return `${doc} $${name}${defaultSuffix} /* ${(prop.description ?? "").replace(/\*\//g, "* /")} */`;
    })
    .join(", ");
}

function bodyForParams(schema: RegistryToolInputSchema): string {
  const params = Object.keys(schema.properties ?? {});
  if (params.length === 0) return "[]";
  const entries = params.map((k) => `            '${k}' => $${k.replace(/[^A-Za-z0-9_]/g, "_")},`);
  return `[\n${entries.join("\n")}\n        ]`;
}

function clientFile(siteId: string): string {
  return `<?php

declare(strict_types=1);

namespace Ui2api\\Map\\${phpClassName(siteId)};

/**
 * Base client for the ui2api promptd daemon.
 *
 * The daemon (npx ui2api promptd, default http://127.0.0.1:9797) drives the
 * site in the user's real logged-in browser session — same cookies, same
 * origin, the site's own JS. This client only makes two calls:
 *
 *   POST /v1/chat/completions      (chat — OpenAI-compatible envelope)
 *   POST /capability/<site>        (every other capability)
 *
 * It never fabricates traffic and knows nothing about the site's internals:
 * the daemon reads the answer off the page and returns it.
 *
 * Both chat() and capability() accept an optional $account (a vault slug or
 * identity from GET /accounts?site=, GOAL 52) — one user, several accounts,
 * pick which one drives the request.
 */
final class Ui2apiClient
{
    public function __construct(
        private readonly string $baseUrl = '${PHP_DEFAULTS.baseUrl}',
        private readonly string $token = '${PHP_DEFAULTS.token}',
        private readonly float $timeout = 120.0,
    ) {
    }

    /** Chat through the daemon's OpenAI-compatible surface. */
    public function chat(string $model, array $messages, bool $stream = false, bool $newChat = false, ?string $account = null): array
    {
        $payload = [
            'model' => $model,
            'messages' => $messages,
            'stream' => $stream,
            'new_chat' => $newChat,
        ];
        if ($account !== null) {
            $payload['account'] = $account;
        }
        $data = $this->request('/v1/chat/completions', $payload);
        if (($data['choices'][0]['message']['content'] ?? null) !== null) {
            return $data['choices'][0]['message'];
        }
        return $data;
    }

    /** Run one non-chat capability (web_search, list_conversations, ...). */
    public function capability(string $site, string $capability, array $args = [], ?string $account = null): mixed
    {
        $payload = [
            'capability' => $capability,
            'args' => $args,
        ];
        if ($account !== null) {
            $payload['account'] = $account;
        }
        $data = $this->request('/capability/' . $site, $payload);
        if (($data['ok'] ?? false) === false) {
            throw new \\RuntimeException($data['error'] ?? 'ui2api capability failed');
        }
        return $data['result'] ?? $data;
    }

    /** GET the runtime registry contract (installed packages). */
    public function registry(): array
    {
        return $this->request('/registry', null);
    }

    /** @return array{status:int, body:array} raw response for advanced use */
    public function raw(string $method, string $path, ?array $payload = null): array
    {
        $ch = \\curl_init($this->baseUrl . $path);
        $headers = ['Content-Type: application/json'];
        if ($this->token !== '') {
            $headers[] = 'Authorization: Bearer ' . $this->token;
        }
        $options = [
            \\CURLOPT_RETURNTRANSFER => true,
            \\CURLOPT_TIMEOUT => (int) \\ceil($this->timeout),
            \\CURLOPT_HTTPHEADER => $headers,
            \\CURLOPT_FAILONERROR => false,
        ];
        if ($method === 'POST') {
            $options[\\CURLOPT_POST] = true;
            if ($payload !== null) {
                $options[\\CURLOPT_POSTFIELDS] = \\json_encode($payload, \\JSON_UNESCAPED_SLASHES);
            }
        }
        \\curl_setopt_array($ch, $options);
        $body = \\curl_exec($ch);
        $status = (int) \\curl_getinfo($ch, \\CURLINFO_RESPONSE_CODE);
        $err = \\curl_error($ch);
        \\curl_close($ch);
        if ($body === false) {
            throw new \\RuntimeException('ui2api daemon unreachable: ' . $err);
        }
        $decoded = \\json_decode((string) $body, true);
        return ['status' => $status, 'body' => \\is_array($decoded) ? $decoded : ['raw' => (string) $body]];
    }

    private function request(string $path, ?array $payload): array
    {
        $res = $this->raw('POST', $path, $payload);
        if ($res['status'] < 200 || $res['status'] >= 300) {
            throw new \\RuntimeException(
                'ui2api ' . $path . ' failed (HTTP ' . $res['status'] . '): '
                . ($res['body']['error'] ?? \\json_encode($res['body']))
            );
        }
        return $res['body'];
    }
}
`;
}

function mapFile(siteId: string, pkg: RegistryPackage): string {
  const className = phpClassName(siteId);
  const methods = pkg.tools
    .map((tool) => {
      const method = phpMethodName(siteId, tool.id);
      const params = schemaParamsFor(siteId, tool);
      const body = bodyForParams(tool.inputSchema);
      const isChat = /_chat$/.test(tool.id) || tool.id === "chat";
      // A chat-shaped tool only gets the /v1 chat call when the registry stamps
      // `chat` on this package (GOAL 34: chat.model exists ONLY on the servable
      // chat surface). Packages refused that claim (capability-only, url-less,
      // dormant/dead-end) fall back to the honest /capability/<site> route,
      // which is the path their runner actually serves (login-gated ok:false
      // where the site is not signed in) — never an `'undefined'` model to /v1.
      const call = isChat && pkg.chat
        ? `$this->client->chat('${pkg.chat.model}', [['role' => 'user', 'content' => $prompt]], false, $newChat ?? false)`
        : `$this->client->capability('${siteId}', '${tool.id}', ${body})`;
      return `    /**
     * ${(tool.description ?? "").replace(/\*\//g, "* /").replace(/\n/g, "\n     * ")}
     *
     * Registry tool: ${tool.name} — ${tool.method}
     */
    public function ${method}(${params}): mixed
    {
        return ${call};
    }`;
    })
    .join("\n\n");
  return `<?php

declare(strict_types=1);

namespace Ui2api\\Map\\${className};

/**
 * ${pkg.name} — generated per-site map package (ui2api registry).
 *
 * One method per capability, same signature as the registry tool schema.
 * Install this package in the core app (TypeScript) and in any other
 * language (e.g. Laravel) so "the api call in the background between two
 * services [is] a function call in any programming language".
 *
 * @see Ui2apiClient
 */
final class ${className}Map
{
    public function __construct(
        private readonly Ui2apiClient $client,
    ) {
    }
${methods}
}
`;
}

function composerFile(siteId: string, pkg: RegistryPackage): string {
  const name = `ui2api/${siteId}-map`;
  const className = phpClassName(siteId);
  return JSON.stringify(
    {
      name,
      description: `${pkg.name} — per-site map package for the ui2api daemon (authorized use only)`,
      type: "library",
      license: "MIT",
      version: pkg.version || "0.1.0",
      require: {
        php: ">=8.1",
        "ext-curl": "*",
        "ext-json": "*",
      },
      autoload: {
        "psr-4": {
          [`Ui2api\\Map\\${className}\\`]: "src/",
        },
      },
      extra: {
        ui2api: {
          site: siteId,
          url: pkg.url,
          // null when the registry stamps no chat claim on this package (GOAL 34).
          chatModel: pkg.chat?.model ?? null,
        },
      },
    },
    null,
    2
  );
}

function configFile(siteId: string, pkg: RegistryPackage): string {
  return `<?php

declare(strict_types=1);

// Laravel-style config for the ui2api ${siteId} map package.
// Publish with: php artisan vendor:publish --tag=ui2api-${siteId}
return [
    // Base URL of the ui2api promptd daemon (npx ui2api promptd).
    'base_url' => env('UI2API_BASE_URL', '${PHP_DEFAULTS.baseUrl}'),

    // Optional bearer token if the daemon runs with UI2API_PROMPTD_TOKEN.
    'token' => env('UI2API_TOKEN', '${PHP_DEFAULTS.token}'),

    // Timeout (seconds) for one daemon round trip (chat answers stream live).
    'timeout' => env('UI2API_TIMEOUT', 120.0),

    // Chat model id advertised by the registry for this site (null when the
    // registry stamps no chat claim — capability-only packages, GOAL 34).
    'chat_model' => ${pkg.chat ? `'${pkg.chat.model}'` : "null"},
];
`;
}

function readmeFile(siteId: string, pkg: RegistryPackage): string {
  return `# ui2api/${siteId}-map

${pkg.description}

Generated per-site map package for the **ui2api** daemon — install the same
map in the core app (TypeScript) and in any other language (e.g. Laravel) so
the daemon API is a plain function call everywhere:

    $ composer require ui2api/${siteId}-map
    $ client = new Ui2api\\Map\\${phpClassName(siteId)}\\Ui2apiClient('http://127.0.0.1:9797');
    $ map = new Ui2api\\Map\\${phpClassName(siteId)}\\${phpClassName(siteId)}Map($client);

    # chat (daemon drives the site's own composer in your real session)
    $map->chat('hello', true);            # -> {content: '...', role: 'user'}

    # other capabilities
    $map->listConversations(20);          # reads the live sidebar
    $map->webSearch(true);                # flips the composer's Search toggle

Capabilities:
${pkg.tools
  .map((t) => `- \`${phpMethodName(siteId, t.id)}()\` — ${t.description?.split("\n")[0] ?? t.name}`)
  .join("\n")}

Authorized-use only: drive only sites you are authorized to use. See
https://github.com/MeRezaRezaei/ui2api-registry (registry) and
docs/STEALTH.md (posture) in the ui2api repo.
`;
}

/** Emit the PHP/Laravel map package for one registry package; returns out dir. */
export function generatePhpMap(pkg: RegistryPackage, outDir: string): string {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, "src"), { recursive: true });
  mkdirSync(resolve(dir, "config"), { recursive: true });
  writeFileSync(resolve(dir, "composer.json"), composerFile(pkg.id, pkg));
  writeFileSync(resolve(dir, "src", "Ui2apiClient.php"), clientFile(pkg.id));
  writeFileSync(resolve(dir, "src", `${phpClassName(pkg.id)}Map.php`), mapFile(pkg.id, pkg));
  writeFileSync(resolve(dir, "config", "ui2api.php"), configFile(pkg.id, pkg));
  writeFileSync(resolve(dir, "README.md"), readmeFile(pkg.id, pkg));
  return dir;
}

/** Generate map packages for every served site (or one site) into outDir/<site>. */
export function generatePhpMaps(packages: RegistryPackage[], outDir: string, siteId?: string): string[] {
  const targets = siteId ? packages.filter((p) => p.id === siteId) : packages;
  return targets.map((p) => generatePhpMap(p, resolve(outDir, p.id)));
}