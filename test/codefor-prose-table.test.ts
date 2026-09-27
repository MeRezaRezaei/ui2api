/**
 * codeFor()'s prose table — measured, then pinned. WHY this file exists.
 *
 * WHAT codeFor() IS. A PHP static method EMITTED into every generated map by
 * `src/generator/lang-php.ts:167`. Given a daemon refusal MESSAGE and an HTTP
 * status it returns a CODE. It is the last hand-written prose table on a
 * consumer path in this repo — and this file exists because the measurement said
 * it must be PINNED, not deleted and not derived.
 *
 * ── CONTRACT, NOT PROSE (this is the fact everything below rests on) ─────────
 * The code reaches a consumer on THREE surfaces, all public:
 *   $errorCode            (public readonly string)
 *   toArray()['code']     (public array<string,mixed>)
 *   getMessage()          "ui2api <path> failed (HTTP n) [<code>]: <message>"
 * A PHP consumer branches on it:
 *   try { $c->chat(...); } catch (Ui2apiException $e) {
 *     if ($e->errorCode === 'pool_saturated') { usleep(200000); retry(); }
 *   }
 * So the 7 codes are a PUBLISHED CONTRACT, already pinned by string-contains at
 * test/lang-php.test.ts:510. Changing or removing any one of them is a BREAKING
 * change to every generated client, and it is never a "cleanup".
 *
 * ── WHAT IT IS, MEASURED (not assumed) ──────────────────────────────────────
 * The emitted table is 6 regex entries + 1 exact-match branch:
 *   /^pool saturated /      -> pool_saturated       [lang-php.ts:170]
 *   /^pool queue timeout /  -> pool_queue_timeout   [lang-php.ts:171]
 *   /^pool closed /         -> pool_closed          [lang-php.ts:172]
 *   /^request timeout after / -> request_timeout    [lang-php.ts:173]
 *   /^no stored account /   -> no_stored_account    [lang-php.ts:174]
 *   /^unknown site /        -> unknown_site         [lang-php.ts:175]
 *   trim($m) === 'not found' -> not_found          [lang-php.ts:182]
 *   else                     -> http_<status>       [lang-php.ts:185]
 *
 * ── WHY IT IS NOT DERIVABLE (this is the whole decision) ────────────────────
 * 1. It is only reachable for a Shape-1 body `{error: "<string>"}`. For a
 *    Shape-2 body `{error:{code,message}}`, `fromResponse` takes the daemon's
 *    own code and NEVER calls codeFor (lang-php.ts:208-210, 230-232). Measured:
 *    of 17 real refusals the daemon answered, 8 are Shape-1 and 9 are Shape-2.
 * 2. A Shape-1 body carries NO code — by design. `send(res, 404, {error:"not
 *    found"})` (http.ts:940) names the class in ENGLISH and nothing else. There
 *    is no machine field to derive the code from; the naming is a client-side
 *    choice, and the generator emits PHP with no daemon in scope to ask.
 * 3. Deriving it from the daemon's own code list would NOT be
 *    behaviour-identical. The daemon publishes 9 wire codes; the table names 7.
 *    The 2 extra (`not_chat`, `unknown_capability`) plus `internal_error` /
 *    `site_not_dispatched` / `bad_request` all arrive Shape-2 and never consult
 *    the table, so adding them would be dead weight — while the Shape-1 census
 *    (pinned below) would move, which IS a breaking change for any consumer
 *    branching on `http_400`. A derivation cannot be both honest and identical.
 *
 * ── SO IT IS SPLIT, AND BOTH HALVES ARE PINNED ──────────────────────────────
 *   LEGACY SHIM (6 of 7): every one of those codes is a code the DAEMON already
 *     publishes (http.ts poolRefusal:436-441, SHAPE_MESSAGES:961-966, the 504 at
 *     :1036). They exist for a pre-GOAL-143 daemon that sent those messages as
 *     bare strings. On TODAY's daemon they are BYPASSED — the class arrives
 *     Shape-2 carrying the daemon's own code. The property worth protecting is
 *     therefore not "does the pattern still match" (it does) but "if the emitter
 *     ever reworded, this entry would go DEAD and nobody would notice". That is
 *     pinned behaviourally below, from the real emitters.
 *   POLICY (1 of 7): `not found` is an OPERATOR-FACING NAMING CHOICE — "a human
 *     should be able to branch on 404-not-found" — over a refusal the daemon
 *     labels with nothing. Zero derivation is available. Pinned as policy.
 *
 * ── WHAT WOULD MAKE IT WRONG (each is a named failure mode, each is pinned) ─
 *   A. An emitter reword ("pool saturated (" -> something else). The entry goes
 *      silently dead: a client would get `http_503` where it used to get a name.
 *      Pinned by driving the REAL pool and matching the REAL message.
 *   B. A table entry edited/removed. Pinned as a contract (the published list).
 *   C. A NEW Shape-1 refusal appears, or an existing one starts being labelled.
 *      Pinned by a deep-equal census of every Shape-1 class the daemon answers.
 *   D. The table starts overriding a labelled refusal. Pinned by asserting the
 *      wire code wins, using the measured case where the SAME sentence is
 *      `unknown_model` on /v1 and `unknown_site` on /prompt.
 *
 * NO BROWSER IS LAUNCHED anywhere in this file. `startPromptd` never calls
 * `pool.warm()` (http.ts:530 constructs, :546 only starts the reaper), and every
 * pool here is pre-built through the GOAL-87 test seam with a synthetic worker,
 * so no code path can reach `launchBrowser`. The pool refusals are produced by a
 * saturated pre-built ChatPool; the 504 by a driver whose ask() never settles.
 * Real generator output, real PHP execution, real daemon over loopback — no
 * hand-typed fixture stands in for behaviour anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";

import { startPromptd } from "../src/prompt/http.js";
import { ChatPool, type PoolOptions, type PoolWorker } from "../src/prompt/pool.js";
import { generatePhpMap } from "../src/generator/lang-php.js";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";
import { buildRegistryPackages } from "../src/prompt/registry.js";

const PROFILES = [BUILTIN_PROFILES["deepseek"], BUILTIN_PROFILES["gemini"]];

/** A runnable php, or an honest refusal. Never a silent skip. */
function phpGate(): { ok: boolean; reason: string } {
  try {
    const out = execFileSync("php", ["-v"], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, reason: `php executed: ${out.split("\n")[0]?.trim() ?? "php"}` };
  } catch (e) {
    return { ok: false, reason: `environment-gated: no runnable php (${e instanceof Error ? e.message.split("\n")[0] : String(e)})` };
  }
}

/* ── the generated PHP: real generator output, really executed ─────────────── */

const OUT = mkdtempSync(join(tmpdir(), "codefor-pin-"));
process.on("exit", () => rmSync(OUT, { recursive: true, force: true }));

const pkg = buildRegistryPackages().find((p) => p.id === "deepseek");
if (!pkg) throw new Error("the deepseek package must exist for this pin — the registry is the surface under test");
const PHP_DIR = generatePhpMap(pkg, resolve(OUT, "deepseek"));
const EXC_FILE = resolve(PHP_DIR, "src", "Ui2apiException.php");
const EXC_SRC = readFileSync(EXC_FILE, "utf8");

/**
 * The prose table, parsed out of the EMITTED php — never hand-copied, so a
 * change to the generator is a change to what is measured. The captured pattern
 * KEEPS its `^`: the anchoring is part of the contract (test 1), so the parse
 * must not quietly drop it and let a later comparison pass on a substring.
 */
const TABLE: { pattern: string; code: string }[] = [
  ...EXC_SRC.matchAll(/'\/(\^[^']*)\/'\s*=>\s*'([a-z_]+)'/g),
].map((m) => ({ pattern: m[1]!, code: m[2]! }));

type Seen = { code: string; message: string; status: number; array: Record<string, unknown>; getMessage: string };

function runPhp(bodies: { body: unknown; status: number }[]): Seen[] {
  const driver = resolve(OUT, `driver-${bodies.length}-${bodies.map((b) => b.status).join("_")}.php`);
  writeFileSync(
    driver,
    `<?php
require ${JSON.stringify(EXC_FILE)};
$in = json_decode(file_get_contents("php://stdin"), true);
$out = [];
foreach ($in as $c) {
  $e = Ui2api\\Map\\Deepseek\\Ui2apiException::fromResponse($c["body"], $c["status"], "", "/probe");
  $out[] = ["code" => $e->errorCode, "message" => $e->errorMessage, "status" => $e->status,
            "array" => $e->toArray(), "getMessage" => $e->getMessage()];
}
echo json_encode($out);`
  );
  const out = execFileSync("php", [driver], {
    input: JSON.stringify(bodies),
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(out) as Seen[];
}

/* ── the real daemon, over loopback (no browser anywhere) ──────────────────── */

function call(port: number, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((res, rej) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    if (token) headers["authorization"] = `Bearer ${token}`;
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => {
        let parsed: unknown = b;
        try { parsed = JSON.parse(b); } catch { /* a non-JSON body stays raw, honestly */ }
        res({ status: r.statusCode ?? 0, body: parsed });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error("probe timed out")));
    req.on("error", rej);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A request whose body is written VERBATIM — the only way to send the malformed
 *  bodies `readJson` refuses. `call()` above JSON-encodes, which would repair
 *  them into a valid object and measure nothing. */
function rawCall(port: number, method: string, path: string, raw: Buffer, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((res, rej) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(raw.length),
    };
    if (token) headers["authorization"] = `Bearer ${token}`;
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => {
        let parsed: unknown = b;
        try { parsed = JSON.parse(b); } catch { /* a non-JSON body stays raw, honestly */ }
        res({ status: r.statusCode ?? 0, body: parsed });
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error("probe timed out")));
    req.on("error", rej);
    req.end(raw);
  });
}

const VAULT = mkdtempSync(join(tmpdir(), "u2a-codefor-pool-"));

/** A pre-built pool already AT capacity: acquire() parks or refuses, never spawns. */
function cappedPool(opts: Partial<PoolOptions>, driver: unknown): ChatPool {
  // A real temp dir, NOT the relative "data": the relative path resolves against cwd into the
  // gitignored operator vault, so it is only inert while `profiles: []` keeps the pool from ever
  // reading a session — add one profile and a test silently depends on the machine it runs on.
  const pool = new ChatPool({ profiles: [], dataDir: VAULT, ...opts } as PoolOptions);
  (pool as unknown as { workers: PoolWorker[] }).workers = [
    { profileId: "deepseek", driver, busy: true } as unknown as PoolWorker,
  ];
  return pool;
}
const noPage = { page: undefined, close: async () => {}, ask: async () => ({}) };
/** A driver whose ask() never settles — the honest way to trip the 504. */
const hangs = { page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) }, close: async () => {}, ask: () => new Promise(() => {}) };

/** One real refusal the daemon really answered, read back off the wire. */
type Refusal = {
  /** stable id */
  key: string;
  /** 1 = `{error:"<string>"}` (no code on the wire), 2 = `{error:{code,…}}` */
  shape: 1 | 2;
  /** the machine code the daemon actually put on the wire (null for Shape-1) */
  wireCode: string | null;
  status: number;
  body: unknown;
  /** the source line that emits this refusal, for a named report */
  emittedAt: string;
};

const CAPTURED = new Map<string, Refusal>();
const put = (key: string, r: { status: number; body: unknown }, at: string) => {
  const err = (r.body as { error?: { code?: string } | string } | null)?.error;
  const shape: 1 | 2 = typeof err === "string" ? 1 : 2;
  CAPTURED.set(key, { key, shape, wireCode: shape === 2 ? ((err as { code?: string }).code ?? null) : null, status: r.status, body: r.body, emittedAt: at });
};

async function withDaemon(opts: Record<string, unknown>, fn: (port: number) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-cf-"));
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, profiles: PROFILES, ...opts } as Parameters<typeof startPromptd>[0]);
  try { await fn(svc.port); } finally { await svc.close(); rmSync(dataDir, { recursive: true, force: true }); }
}

// ── one token-gated daemon: the whole default refusal surface ────────────────
await withDaemon({ token: "codefor-pin-token" }, async (port) => {
  const T = "codefor-pin-token";
  const cap = async (k: string, at: string, r: { status: number; body: unknown }) => put(k, r, at);
  await cap("unauthorized", "http.ts:579", await call(port, "GET", "/status", undefined, "wrong-token"));
  await cap("not_in_allowlist", "http.ts:604", await call(port, "POST", "/capability/youtube", { capability: "youtube_search" }, T));
  await cap("capability_required", "http.ts:614", await call(port, "POST", "/capability/deepseek", {}, T));
  await cap("site_required", "http.ts:683", await call(port, "GET", "/accounts", undefined, T));
  await cap("no_capability_package", "http.ts:716", await call(port, "GET", "/capabilities?site=definitely-not-a-package", undefined, T));
  await cap("site_and_account_required", "http.ts:744", await call(port, "GET", "/capabilities?site=deepseek", undefined, T));
  await cap("prompt_required", "http.ts:832", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "   " }, T));
  await cap("not_found", "http.ts:940", await call(port, "GET", "/no-such-route", undefined, T));
  await cap("unknown_site", "http.ts:462 -> SHAPE_MESSAGES", await call(port, "POST", "/prompt", { site: "no-such-site", prompt: "hi" }, T));
  await cap("no_stored_account", "http.ts:486 -> SHAPE_MESSAGES", await call(port, "POST", "/capability/deepseek", { capability: "deepseek_chat", account: "ghost-account" }, T));
  await cap("not_chat", "http.ts:460 -> SHAPE_MESSAGES", await call(port, "POST", "/prompt", { site: "youtube", prompt: "hi" }, T));
  await cap("unknown_capability", "http.ts:965 -> SHAPE_MESSAGES", await call(port, "POST", "/capability/deepseek", { capability: "no-such-capability" }, T));
  await cap("unknown_model", "openai.ts:136", await call(port, "POST", "/v1/chat/completions", { model: "no-such-model", messages: [{ role: "user", content: "hi" }] }, T));
  await cap("v1_not_found", "openai.ts:233", await call(port, "GET", "/v1/no-such-endpoint", undefined, T));
  // The malformed-body class, sent VERBATIM. `readJson` refuses all four shapes;
  // see the MEASURED DEFECT test at the bottom for what actually reaches a client.
  await cap("malformed_body_array", "http.ts:401", await rawCall(port, "POST", "/prompt", Buffer.from("[]"), T));
  await cap("internal_error", "http.ts:989", await rawCall(port, "POST", "/prompt", Buffer.from("{not json"), T));
});

// ── three pool-shaped daemons, each tripping one real pool refusal ───────────
await withDaemon({ pool: cappedPool({ max: 1, maxWaiters: 0, waiterTimeoutMs: 60_000 }, noPage) }, async (port) => {
  put("pool_saturated", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "hi" }), "pool.ts:347 -> http.ts poolRefusal:437");
});
await withDaemon({ pool: cappedPool({ max: 1, maxWaiters: 1, waiterTimeoutMs: 150 }, noPage) }, async (port) => {
  put("pool_queue_timeout", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "hi" }), "pool.ts:370 -> http.ts poolRefusal:438");
});
await withDaemon({ requestTimeoutMs: 200, pool: cappedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 60_000 }, hangs) }, async (port) => {
  put("request_timeout", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "hi" }), "http.ts:1036");
});
// pool_closed: the daemon is GONE by the time this settles — it IS the shutdown,
// so there is no wire to read. The MESSAGE is real (from the real pool), which is
// all the prose table ever keyed on.
{
  const pool = cappedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 60_000 }, noPage);
  const parked = pool.acquire("deepseek");
  void pool.close();
  const message = await parked.then(() => "", (e: Error) => e.message);
  put("pool_closed", { status: 503, body: { error: message } }, "pool.ts:746 settleAllWaiters — unreachable at answer time by construction");
}

/** The six regex-backed codes, each with the class that really emits it. */
const SHIM_KEYS = ["pool_saturated", "pool_queue_timeout", "pool_closed", "request_timeout", "no_stored_account", "unknown_site"] as const;
/** The seventh: the exact-match branch — the ONE code with a live Shape-1 class. */
const POLICY_KEYS = ["not_found"] as const;

/** The daemon's own refusal prose for a class, whatever shape it arrived in. */
function realMessage(key: string): string {
  const r = CAPTURED.get(key);
  if (!r) throw new Error(`no real refusal was captured for ${key}`);
  const err = (r.body as { error?: { message?: string } | string }).error;
  return typeof err === "string" ? err : ((err as { message?: string }).message ?? "");
}

/* ──────────────────────────────────────────────────────────────────────────── */

test("codeFor: the emitted table is 6 regex entries + 1 exact-match branch, every entry ^-anchored (its published shape)", () => {
  assert.equal(
    TABLE.length,
    6,
    `the emitted prose table changed size: ${JSON.stringify(TABLE)} — every change here is a CONTRACT change, not a refactor`,
  );
  assert.deepEqual(
    TABLE.map((t) => t.code),
    ["pool_saturated", "pool_queue_timeout", "pool_closed", "request_timeout", "no_stored_account", "unknown_site"],
    "the table's entries or their ORDER moved — read the diff; a reordering changes which pattern a message matches first",
  );
  assert.ok(EXC_SRC.includes("trim($message) === 'not found'"), "the exact-match 'not found' policy branch is gone");
  assert.ok(EXC_SRC.includes("return 'http_' . $status;"), "the honest http_<status> fallback is gone");
  // Every entry is anchored, so a code can never be recovered from a message
  // that merely CONTAINS the phrase — the GOAL 143 lesson, kept on this side too.
  for (const t of TABLE) {
    assert.ok(t.pattern.startsWith("^"), `entry ${t.code} is not ^-anchored: /${t.pattern}/`);
  }
});

test("codeFor: the drift gate — every code still classifies the REAL message its class really emits", () => {
  const gate = phpGate();
  if (!gate.ok) { console.error(`[codeFor] runtime pin ${gate.reason}`); return; }

  // THE CHAIN, end to end, from the real emitters: the real pool / the real
  // idFrom / the real 404, the real emitted message, into the real generated
  // php. A reword on ANY side turns this red — which is the entire point.
  const keys = [...SHIM_KEYS, ...POLICY_KEYS];
  for (const k of keys) assert.ok(CAPTURED.has(k), `no real refusal was captured behind the table entry ${k}`);

  const seen = runPhp(keys.map((k) => ({ body: { error: realMessage(k) }, status: CAPTURED.get(k)!.status })));

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!, got = seen[i]!, entry = TABLE.find((t) => t.code === k);
    const message = realMessage(k);
    // Failure mode A: the entry and the words its class really emits no longer
    // agree — EITHER an emitter was reworded, OR this table entry was. Both
    // leave the entry DEAD: the code would silently become http_<status>.
    const ownPattern = entry ? entry.pattern : "^not found$";
    assert.ok(
      new RegExp(ownPattern).test(message),
      `${k}: the REAL message the daemon emits (${CAPTURED.get(k)!.emittedAt}) does not match its own entry /${ownPattern}/ — ` +
        `the emitter was reworded, or this table entry was, and one of the two is now DEAD: ${JSON.stringify(message)}`,
    );
    // Failure mode B (a table edit): the code the class must carry.
    assert.equal(
      got.code,
      k,
      `codeFor() mapped the REAL ${k} message to ${got.code} — the table drifted from the contract. Message was: ${JSON.stringify(got.message)}`,
    );
    // The code is a CONTRACT on THREE public surfaces, not just a return value.
    assert.equal(got.array["code"], k, `${k}: toArray()['code'] must carry the same contract code`);
    assert.ok(String(got.getMessage).includes(`[${k}]`), `${k}: the thrown message must name the code — got ${String(got.getMessage)}`);
  }
  console.error(`[codeFor] runtime pin ${gate.reason}`);
});

test("codeFor: the daemon's wire code ALWAYS wins — the table can never override a labelled refusal", () => {
  const gate = phpGate();
  if (!gate.ok) { console.error(`[codeFor] runtime pin ${gate.reason}`); return; }

  const labelled = [...CAPTURED.values()].filter((c) => c.wireCode !== null);
  assert.ok(labelled.length >= 8, `expected the whole labelled refusal surface, found ${labelled.length}: ${labelled.map((c) => c.key).join(", ")}`);

  const seen = runPhp(labelled.map((c) => ({ body: c.body, status: c.status })));
  for (let i = 0; i < labelled.length; i++) {
    const c = labelled[i]!, got = seen[i]!;
    assert.equal(got.code, c.wireCode, `${c.key}: the Shape-2 path must carry the daemon's own code through untouched (${c.emittedAt})`);
  }

  // The sharpest case, MEASURED: the SAME sentence gets a DIFFERENT code
  // depending on which surface sent it, and the WIRE — not the prose table —
  // decides. An unknown id is `unknown_site` on /prompt (http.ts SHAPE_MESSAGES)
  // but `unknown_model` on /v1 (openai.ts:136), while the table maps that one
  // message to `unknown_site`. If the table could ever win, the /v1 refusal
  // would be mislabelled — this assertion is what stops that regression.
  const onV1 = CAPTURED.get("unknown_model")!;
  const onPrompt = CAPTURED.get("unknown_site")!;
  assert.equal(onV1.wireCode, "unknown_model", "the /v1 surface names an unknown id unknown_model");
  assert.equal(onPrompt.wireCode, "unknown_site", "the /prompt surface names an unknown site unknown_site");
  assert.notEqual(onV1.wireCode, onPrompt.wireCode, "the two surfaces must disagree — that is what proves the table is not consulted");
  assert.ok(
    realMessage("unknown_model").startsWith("unknown site ") && realMessage("unknown_site").startsWith("unknown site "),
    `both refusals really do share the message prose the table keys on: ${JSON.stringify([realMessage("unknown_model"), realMessage("unknown_site")])}`,
  );
  console.error(`[codeFor] runtime pin ${gate.reason}`);
});

test("codeFor: the Shape-1 census — which refusal classes carry a name and which honestly fall to http_<status>", () => {
  const gate = phpGate();
  if (!gate.ok) { console.error(`[codeFor] runtime pin ${gate.reason}`); return; }

  // Every Shape-1 refusal the daemon really answered, above. This is the
  // rot-prone surface: a Shape-1 body carries no code, so the TABLE is the only
  // thing that can name it — and for a class the table does not name, the
  // client's honest answer is `http_<status>` (the docblock's stated intent).
  const shape1 = [...CAPTURED.values()].filter((c) => c.shape === 1);
  assert.ok(shape1.length >= 9, `expected the whole Shape-1 surface, found ${shape1.length}: ${shape1.map((c) => c.key).join(", ")}`);

  const seen = runPhp(shape1.map((c) => ({ body: c.body, status: c.status })));
  const census: Record<string, string> = {};
  for (let i = 0; i < shape1.length; i++) census[shape1[i]!.key] = seen[i]!.code;

  // THE MEASURED STATE OF THE WORLD, from a real daemon. Named: `not_found`
  // (http.ts:940, live) and `pool_closed` (the shutdown, which by construction
  // can never be answered over the wire — reconstructed from the real pool).
  // Unnamed: every other Shape-1 refusal, which falls to http_<status> BY
  // DESIGN. Adding a name here is a BREAKING change for a consumer branching on
  // http_<status> — it must be a deliberate decision that edits this census,
  // never a side effect.
  assert.deepEqual(
    census,
    {
      unauthorized: "http_401",
      not_in_allowlist: "http_400",
      capability_required: "http_400",
      site_required: "http_400",
      no_capability_package: "http_400",
      site_and_account_required: "http_400",
      prompt_required: "http_400",
      not_found: "not_found",
      pool_closed: "pool_closed",
    },
    `the Shape-1 census moved: ${JSON.stringify(census, null, 1)} — a NEW Shape-1 refusal, a reworded message, or a new table entry all land here. Read the diff before accepting it.`,
  );
  console.error(`[codeFor] runtime pin ${gate.reason}`);
});

test("codeFor: the 7 published codes are a CONTRACT, unchanged, and the table is the only path to a name", () => {
  const gate = phpGate();
  if (!gate.ok) { console.error(`[codeFor] runtime pin ${gate.reason}`); return; }

  // The stable published list — the same 7 test/lang-php.test.ts:510 pins by
  // string-contains, asserted here BEHAVIOURALLY against the emitted source:
  // each must reach the emitted table, not just appear in a comment.
  const PUBLISHED = ["pool_saturated", "pool_queue_timeout", "pool_closed", "request_timeout", "no_stored_account", "unknown_site", "not_found"];
  const reachable = new Set(TABLE.map((t) => t.code));
  reachable.add("not_found"); // the exact-match branch
  assert.deepEqual(
    [...reachable].sort(),
    [...PUBLISHED].sort(),
    "the published code list changed — that is a BREAKING contract change to every generated client, not a cleanup",
  );
  for (const code of PUBLISHED) {
    assert.ok(EXC_SRC.includes(`'${code}'`), `the generated client no longer even mentions the published code ${code}`);
  }
  // And the honest fallback is what carries everything the table does NOT name:
  // no code outside the published list may ever be synthesised.
  const synthesised = new Set(
    [...EXC_SRC.matchAll(/=>\s*'([a-z_]+)'/g)].map((m) => m[1]!),
  );
  assert.deepEqual(
    [...synthesised].sort(),
    PUBLISHED.filter((c) => c !== "not_found").sort(),
    "the table synthesises a code outside the published list — a consumer cannot have been written for it",
  );
  console.error(`[codeFor] runtime pin ${gate.reason}`);
});

test("codeFor: the pool chain is intact — pool.ts emits, poolRefusal labels, the wire carries, the table mirrors", () => {
  // The three pool classes are the ONLY place where a hand-written prose table
  // on the DAEMON side (http.ts poolRefusal:436-441) re-decides what codeFor()
  // mirrors. If pool.ts reworded a message, poolRefusal would stop matching and
  // the class would degrade from a named 503 to a bare 500 internal_error —
  // losing the name for every client, generated or not. Pinned behaviourally,
  // from the real pool: this is the pin that a source-grep cannot make.
  const POOL_CHAIN = [
    { key: "pool_saturated", status: 503, emittedAt: "pool.ts:347" },
    { key: "pool_queue_timeout", status: 503, emittedAt: "pool.ts:370" },
  ] as const;
  for (const link of POOL_CHAIN) {
    const r = CAPTURED.get(link.key)!;
    assert.ok(r, `${link.key} was never captured`);
    assert.equal(r.status, link.status, `${link.key}: a ${link.key} must answer ${link.status}, got ${r.status} — the pool refusal class degraded`);
    assert.equal(r.wireCode, link.key, `${link.key}: poolRefusal stopped naming the class the real pool emits (${link.emittedAt}) — a reword there costs every client its code`);
    const entry = TABLE.find((t) => t.code === link.key)!;
    assert.ok(
      new RegExp(entry.pattern).test(realMessage(link.key)),
      `${link.key}: the table entry /^${entry.pattern.slice(1)}/ no longer matches the real message ${JSON.stringify(realMessage(link.key))} — dead entry`,
    );
  }
  // The 504 is not a pool refusal (poolRefusal returns null for it) — it is
  // emitted by the deadline itself, and it too must be labelled and mirrored.
  const rt = CAPTURED.get("request_timeout")!;
  assert.equal(rt.status, 504, `request_timeout must answer 504, got ${rt.status}`);
  assert.equal(rt.wireCode, "request_timeout", "the deadline must carry request_timeout on the wire");
  assert.ok(
    new RegExp(TABLE.find((t) => t.code === "request_timeout")!.pattern).test(realMessage("request_timeout")),
    `the request_timeout entry no longer matches the real deadline message ${JSON.stringify(realMessage("request_timeout"))}`,
  );
  // The two classes that are NOT pool refusals must never be labelled as one:
  // a request-shape 400 arriving here instead would be a silently swallowed
  // guidance message — the MEASURED BUG http.ts:950-960 documents.
  for (const key of ["unknown_site", "no_stored_account"]) {
    const r = CAPTURED.get(key)!;
    assert.equal(r.status, 400, `${key}: a request-shape refusal is a correctable 400, got ${r.status}`);
    assert.ok(!realMessage(key).startsWith("pool "), `${key} was misread as a pool refusal`);
  }
});

test("codeFor: MEASURED DEFECT, pinned so it stays visible — two daemon codes never reach a client", () => {
  // `invalid_json` (http.ts:401) and `payload_too_large` (http.ts:391) are
  // declared HttpClientError codes, and the outer catch at http.ts:1007 does map
  // them. But `readJson` is awaited INSIDE `handleRequest`, whose own catch
  // (http.ts:941) has no HttpClientError branch — so a bad body is reclassified
  // as a bare 500 `internal_error` and the named code is unreachable; an
  // oversized body `req.destroy()`s the socket, so the client gets no answer at
  // all. MEASURED, not read: both bad-body paths are driven above — the `[]`
  // that readJson rejects with HttpClientError(400,"invalid_json"), and the
  // `{not json` it rejects with a bare Error (http.ts:407). Neither reaches a
  // client as itself; that is the whole finding.
  //
  // This is NOT fixed here: changing which code a refusal carries is a BREAKING
  // change to the daemon's own error contract, and it is not codeFor()'s table.
  // It is pinned so the fact cannot rot into folklore — and so that whoever
  // fixes it gets a RED here telling them to reconcile rather than silence.
  for (const key of ["internal_error", "malformed_body_array"]) {
    const r = CAPTURED.get(key)!;
    assert.equal(r.status, 500, `${key}: a malformed body must currently answer 500 internal_error, got ${r.status}`);
    assert.equal(
      r.wireCode,
      "internal_error",
      `${key}: the malformed-body class no longer answers internal_error — read this comment: if the daemon now labels ` +
        `it invalid_json, that is a FIX; reconcile the census above and decide deliberately whether codeFor()'s table ` +
        `must then name it (a breaking change to the published contract, not a silent one)`,
    );
  }
  // Neither dead code may be silently added to the table to "cover" them: both
  // would be unreachable entries, which is worse than an honest http_500.
  for (const dead of ["invalid_json", "payload_too_large"]) {
    assert.ok(!TABLE.some((t) => t.code === dead), `table entry ${dead} covers a code the daemon never sends — an unreachable entry is rot, not coverage`);
  }
});
