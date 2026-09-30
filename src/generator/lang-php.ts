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
import {
  bareCapabilityId,
  type RegistryPackage,
  type RegistryTool,
  type RegistryToolInputSchema,
} from "../prompt/registry.js";

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

// The daemon's errors arrive in TWO different wire shapes, and a generated
// client that does not understand both destroys every NAMED refusal the daemon
// went to the trouble of naming:
//
//   OpenAI-shaped   {error: {message, type, code, param}}
//                   src/prompt/openai.ts (unknown_model, not_found,
//                   ui2api_driver_error, the body/messages 400s)
//   string-shaped   {error: "<string>"}
//                   src/prompt/http.ts — the /capability catch and the
//                   `no stored account "<acct>" for "<host>"; available: [...]`
//                   refusal from validateAccount (openai.ts calls it, and the
//                   throw surfaces as a 400 {error: "<string>"}), plus
//                   {error:{code,message}} for the pool/timeout refusals.
//
// The pre-GOAL-90 client did `($res['body']['error'] ?? json_encode(...))` in a
// string concat: the array shape became the literal string "Array" and BOTH the
// code and the real message were lost. This class is the generated normalizer —
// one structure for every shape, never a stringified structure.
function phpExceptionFile(siteId: string): string {
  return `<?php

declare(strict_types=1);

namespace Ui2api\\Map\\${phpClassName(siteId)};

/**
 * A NAMED refusal from the ui2api promptd daemon.
 *
 * Extends \\RuntimeException, so every existing \`catch (\\RuntimeException $e)\`
 * in a consumer keeps working — this only ADDS the structured fields the daemon
 * already sent and the pre-GOAL-90 client silently threw away.
 *
 * Two wire shapes in, one honest structure out:
 *
 *   {error: "<string>"}                        -> code derived from the text
 *   {error: {message, type, code, param}}      -> the daemon's own code kept
 *   (no error key)                             -> http_<status> fallback
 *
 * The message is never the string "Array" (a string-cast of a structure): it is
 * always the daemon's real message, prefixed with the stable code and the HTTP
 * status, so a log line or an exception trace still names the refusal.
 */
final class Ui2apiException extends \\RuntimeException
{
    /**
     * Named errorCode / errorMessage rather than $code: \\Exception already owns
     * an untyped \`protected $code\` (an int), and PHP forbids a child from
     * re-declaring it typed/readonly. getMessage() below is the decorated
     * one-liner (code + real message); toArray() is the full structure.
     */
    public function __construct(
        string $message,
        public readonly string $errorCode,
        public readonly string $errorMessage,
        public readonly int $status,
        public readonly ?string $type = null,
        public readonly ?string $param = null,
        public readonly array $raw = [],
    ) {
        parent::__construct($message);
    }

    /**
     * Stable code for the daemon's named refusals. Mirrors the daemon's own
     * naming (http.ts poolRefusal: pool_saturated / pool_queue_timeout /
     * pool_closed) plus the request/account/site refusals it names. Text we do
     * not recognize is NOT guessed at: it falls back to http_<status>, which is
     * the honest answer when no name was sent.
     *
     * ── THIS TABLE IS A PUBLISHED CONTRACT, AND IT IS HAND-MAINTAINED ON PURPOSE ──
     * The code reaches a consumer on three public surfaces (errorCode,
     * toArray()['code'], and the thrown message), so a consumer can branch on
     * it. Adding, renaming or removing an entry is a BREAKING change to every
     * already-generated client — never a cleanup, and never a side effect of
     * some other edit.
     *
     * WHY IT IS NOT DERIVED (measured, not assumed — see the census in
     * test/codefor-prose-table.test.ts): it is only reached for a Shape-1 body
     * {error:"<string>"}, and a Shape-1 body carries NO machine code at all.
     * send(res, 404, {error:"not found"}) (http.ts:940) names its class in
     * ENGLISH and nothing else, so there is nothing to derive from: naming it
     * is a client-side policy choice, and this generator emits PHP with no
     * daemon in scope to ask. Deriving from the daemon's own code list is not
     * behaviour-identical either — it would add codes that already arrive
     * Shape-2 and never consult this table, while moving the Shape-1 census
     * away from http_<status>, which IS breaking.
     *
     * SO IT IS SPLIT, and both halves are pinned by
     * test/codefor-prose-table.test.ts, which drives the real emitters and
     * executes this emitted file:
     *   - 6 of the 7 are a LEGACY SHIM. Every one of those codes is a code the
     *     daemon already publishes; they exist for a pre-GOAL-143 daemon that
     *     sent the same sentences as bare strings. On today's daemon the class
     *     arrives Shape-2 carrying the daemon's own code, so the table is
     *     BYPASSED — what the pin protects is that a reworded emitter can never
     *     silently turn one of these entries dead.
     *   - "not found" is live POLICY: the one class the table genuinely names,
     *     for a refusal the daemon labels with nothing.
     *
     * WHAT WOULD INVALIDATE THIS TABLE: the daemon re-inheriting a Shape-1
     * (bare-string) body for a class listed here, which would make the shim
     * earn its keep again; a NEW Shape-1 refusal, which the pinned census must
     * be extended to cover deliberately; or a decision to publish a code for an
     * unnamed Shape-1 class, which changes what a consumer branching on
     * http_<status> sees. All three are contract changes, not refactors.
     */
    public static function codeFor(string $message, int $status): string
    {
        $named = [
            '/^pool saturated /' => 'pool_saturated',
            '/^pool queue timeout /' => 'pool_queue_timeout',
            '/^pool closed /' => 'pool_closed',
            '/^request timeout after /' => 'request_timeout',
            '/^no stored account /' => 'no_stored_account',
            // GOAL 162: the daemon's consumer projection of the SAME refusal is
            // 'account "<id>" is not available for <site>; ...'. The row above is
            // KEPT, not replaced: it still classifies a pre-GOAL-162 daemon (or
            // the CLI/plugin emitters, which keep the vault wording for the
            // operator), so deleting it would be a silent breaking change to
            // every generated client that branches on 'no_stored_account'. The
            // code is the same on both sides, so a consumer sees no difference.
            '/^account ".*" is not available for /' => 'no_stored_account',
            '/^unknown site /' => 'unknown_site',
        ];
        foreach ($named as $pattern => $code) {
            if (preg_match($pattern, $message) === 1) {
                return $code;
            }
        }
        if (trim($message) === 'not found') {
            return 'not_found';
        }
        return 'http_' . $status;
    }

    /**
     * The normalizer. Accepts the decoded body, the HTTP status and the raw
     * body text, and always yields a structure carrying code + message + status
     * (+ type/param when the daemon sent them).
     */
    public static function fromResponse(mixed $body, int $status, string $rawBody = '', string $path = ''): self
    {
        $error = is_array($body) ? ($body['error'] ?? null) : null;

        $code = null;
        $message = null;
        $type = null;
        $param = null;

        if (is_string($error)) {
            // Shape 1 — the one non-OpenAI shape: {error: "<string>"}.
            $message = $error;
        } elseif (is_array($error)) {
            // Shape 2 — {error: {message, type, code, param}}. The daemon's own
            // code wins; the patterns in codeFor() only fill a gap.
            if (isset($error['code']) && is_string($error['code']) && $error['code'] !== '') {
                $code = $error['code'];
            }
            if (isset($error['message']) && is_string($error['message'])) {
                $message = $error['message'];
            }
            if (isset($error['type']) && is_string($error['type'])) {
                $type = $error['type'];
            }
            if (isset($error['param']) && is_string($error['param'])) {
                $param = $error['param'];
            }
        }

        if ($message === null || trim($message) === '') {
            // Nothing usable was sent: name what actually arrived. Never cast a
            // structure to a string — that is the "Array" bug this replaces.
            $message = $rawBody !== '' ? $rawBody : (is_string($error) ? $error : json_encode($body, JSON_UNESCAPED_SLASHES));
            if (!is_string($message) || trim($message) === '') {
                $message = 'ui2api daemon returned no error message';
            }
        }
        if ($code === null) {
            $code = self::codeFor($message, $status);
        }

        $prefix = $path !== '' ? 'ui2api ' . $path . ' failed' : 'ui2api request failed';

        return new self(
            $prefix . ' (HTTP ' . $status . ') [' . $code . ']: ' . $message,
            $code,
            $message,
            $status,
            $type,
            $param,
            is_array($body) ? $body : ['raw' => $rawBody],
        );
    }

    /**
     * The normalized refusal: always carries a stable 'code', the daemon's real
     * 'message' (never the string "Array"), the HTTP 'status', and 'type'/
     * 'param' when the daemon sent them.
     *
     * @return array<string,mixed>
     */
    public function toArray(): array
    {
        $out = [
            'code' => $this->errorCode,
            'message' => $this->errorMessage,
            'status' => $this->status,
        ];
        if ($this->type !== null) {
            $out['type'] = $this->type;
        }
        if ($this->param !== null) {
            $out['param'] = $this->param;
        }
        return $out;
    }
}
`;
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
 *
 * Refusals are never flattened: every non-2xx response becomes a
 * Ui2apiException carrying the daemon's own stable code and status, and chat()
 * returns the daemon's sibling 'ui2api' block so a 'restricted' stop can never
 * pass for a normal answer.
 */
final class Ui2apiClient
{
    public function __construct(
        private readonly string $baseUrl = '${PHP_DEFAULTS.baseUrl}',
        private readonly string $token = '${PHP_DEFAULTS.token}',
        private readonly float $timeout = 120.0,
    ) {
    }

    /**
     * Normalize a daemon error response into a NAMED, structured refusal.
     *
     * Handles both wire shapes the daemon sends —
     * \`{error: "<string>"}\` (the account/site/capability refusals) and
     * \`{error: {message, type, code, param}}\` (the OpenAI-shaped refusals) —
     * and never stringifies a structure into "Array".
     */
    public static function normalizeError(mixed $body, int $status, string $rawBody = '', string $path = ''): Ui2apiException
    {
        return Ui2apiException::fromResponse($body, $status, $rawBody, $path);
    }

    /**
     * Chat through the daemon's OpenAI-compatible surface.
     *
     * Returns the assistant message PLUS the daemon's sibling \`ui2api\` block,
     * which carries the honest stop reason (\`doneReason\`) — 'restricted' when a
     * tier/limit wall stopped the round trip (GOAL 54), plus the driver's other
     * done reasons. Without it a consumer cannot tell a real answer from a
     * restriction wall. \`refusal\` keeps the daemon's own value (it is never
     * hardcoded to null); the field stays present either way (back-compat).
     */
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
        $message = $data['choices'][0]['message'] ?? null;
        if (!\\is_array($message)) {
            return $data;
        }
        $refusal = $message['refusal'] ?? null;
        if (($message['content'] ?? null) === null && $refusal === null) {
            return $data;
        }
        // The daemon's real refusal, never a hardcoded null.
        $message['refusal'] = \\is_string($refusal) ? $refusal : null;
        // The honest stop reason, kept in both shapes: the whole sibling block
        // and a flat snake_case alias for PHP/Laravel callers.
        $ui2api = $data['ui2api'] ?? null;
        $message['ui2api'] = \\is_array($ui2api) ? $ui2api : null;
        $message['done_reason'] = \\is_array($ui2api) ? ($ui2api['doneReason'] ?? null) : null;
        return $message;
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
        $path = '/capability/' . $site;
        $res = $this->raw('POST', $path, $payload);
        $this->guard($path, $res);
        $data = $res['body'];
        if (($data['ok'] ?? false) === false) {
            // A 2xx body that still says ok:false — the runner's own honest
            // refusal. Normalized with the REAL status, never a string-cast of
            // $data['error'] (which may be a structure, not a message).
            throw self::normalizeError($data, $res['status'], $res['raw'], $path);
        }
        return $data['result'] ?? $data;
    }

    /** GET the runtime registry contract (installed packages). */
    public function registry(): array
    {
        return $this->request('/registry', null);
    }

    /** @return array{status:int, body:array, raw:string} raw response for advanced use */
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
        $raw = (string) $body;
        $decoded = \\json_decode($raw, true);
        return [
            'status' => $status,
            'body' => \\is_array($decoded) ? $decoded : ['raw' => $raw],
            // Kept for the normalizer: a non-JSON error body (an HTML 502 from a
            // proxy in front of the daemon) must still name itself honestly
            // instead of becoming "Array".
            'raw' => $raw,
        ];
    }

    /** Throw a NAMED, structured refusal for any non-2xx response. */
    private function guard(string $path, array $res): void
    {
        if ($res['status'] < 200 || $res['status'] >= 300) {
            throw self::normalizeError($res['body'], $res['status'], $res['raw'], $path);
        }
    }

    private function request(string $path, ?array $payload): array
    {
        $res = $this->raw('POST', $path, $payload);
        $this->guard($path, $res);
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
  // GOAL 141: this README used to promise methods that were never generated.
  // It emitted `$map->chat(...)`, `$map->listConversations(...)` and
  // `$map->webSearch(...)` UNCONDITIONALLY — PROVEN live: for the youtube
  // package (no chat, no list_conversations, no web_search) it documented all
  // three, so a consumer writing against the docs would call a method that does
  // not exist and get a fatal "Call to undefined method". Documentation that
  // invents an API is the same class of defect as a fabricated verdict, so every
  // example below is now derived from the SAME predicates mapFile() uses.
  const className = phpClassName(siteId);
  const methodOf = (id: string) => phpMethodName(siteId, id);
  const toolByBare = (bare: string) =>
    pkg.tools.find((t) => bareCapabilityId(siteId, t.id) === bare);
  // A chat example exists only when the registry both stamps `chat` AND a
  // chat-shaped tool is present — exactly the condition mapFile() routes on.
  const chatTool = pkg.tools.find((t) => /_chat$/.test(t.id) || t.id === "chat");
  // A chat method exists whenever the package HAS a chat capability, regardless
  // of whether the registry PROMISES it. Those are two different questions:
  // "can this site be driven for a chat" (the tool exists) and "has a measured
  // round trip returned an answer" (the promise). GOAL 159 withholds the
  // promise for 18 of 22 addressable models, and a withheld model still has a
  // real, servable chat method routed through /capability. Dropping its example
  // and printing "This package exposes NO chat model" would be a NEW false
  // claim — the mirror image of the one GOAL 159 killed.
  const chatMethod = chatTool ? methodOf(chatTool.id) : null;
  const chatPromise = pkg.chat;
  const convoTool = toolByBare("list_conversations");
  const searchTool = toolByBare("web_search");
  const chatBlock = chatMethod
    ? `
    # chat (daemon drives the site's own composer in your real session)
    # -> {content: '...', role: 'assistant', refusal: null,
    #     ui2api: {site, doneReason: 'stop'|'restricted'|..., chunkCount}, done_reason: '...'}
    $answer = $map->${chatMethod}('hello', true);
${
  chatPromise
    ? ""
    : `    # NOTE: this site's chat is NOT advertised on /v1/models — the measurement record
    # files it as ${pkg.chatWithheld?.class ?? "withheld"} (${pkg.chatWithheld?.reason ?? "no answerable record"}).
    # The method above still works, via the /capability route.`
}
`
    : `
    # This package exposes NO chat capability at all — no ${siteId}_chat tool — so the
    # daemon serves it only through its other capabilities. Use the list below.
`;
  const otherLines: string[] = [];
  if (convoTool) otherLines.push(`    $map->${methodOf(convoTool.id)}(20);          # reads the live sidebar`);
  if (searchTool) otherLines.push(`    $map->${methodOf(searchTool.id)}(true);      # flips the composer's Search toggle`);
  const otherBlock = otherLines.length
    ? `\n    # other capabilities\n${otherLines.join("\n")}\n`
    : "";
  // `done_reason` is a CHAT concept, so its example only ships with a chat
  // method; for a chatless package the refusal handling is still documented via
  // the generic client call that always exists.
  const refusalExample = chatMethod
    ? `        $answer = $map->${chatMethod}('hello', true);`
    : `        $answer = $client->capability('${siteId}', '${pkg.tools[0]?.id ?? "CAPABILITY"}', []);`;
  return `# ui2api/${siteId}-map

${pkg.description}

Generated per-site map package for the **ui2api** daemon — install the same
map in the core app (TypeScript) and in any other language (e.g. Laravel) so
the daemon API is a plain function call everywhere:

    $ composer require ui2api/${siteId}-map
    $ client = new Ui2api\\Map\\${className}\\Ui2apiClient('http://127.0.0.1:9797');
    $ map = new Ui2api\\Map\\${className}\\${className}Map($client);
${chatBlock}${otherBlock}
Named refusals (the daemon's own code and message, never a stringified array):

    use Ui2api\\Map\\${className}\\Ui2apiException;

    try {
${refusalExample}
        if ($answer['done_reason'] === 'restricted') {
            // a tier/limit wall stopped the round trip — NOT an answer
        }
    } catch (Ui2apiException $e) {        // extends \\RuntimeException
        $e->code;    // request_timeout | pool_saturated | pool_queue_timeout
                     // | pool_closed | not_found | unknown_model
                     // | no_stored_account | ... | http_<status> (honest fallback)
        $e->status;  // 400 | 404 | 502 | 503 | 504
        $e->message; // the daemon's REAL message (never "Array")
        $e->toArray();
    }

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
  writeFileSync(resolve(dir, "src", "Ui2apiException.php"), phpExceptionFile(pkg.id));
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