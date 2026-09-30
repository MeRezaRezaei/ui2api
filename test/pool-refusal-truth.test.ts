import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { request as httpRequest } from "node:http";

import { startPromptd, poolRefusal } from "../src/prompt/http.js";
import { ChatPool, POOL_REFUSAL_CODES, type PoolOptions, type PoolRefusalCode, type PoolWorker } from "../src/prompt/pool.js";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

/**
 * GOAL 145 — the error contract must be a PROMISE THE DAEMON KEEPS.
 *
 * THE DEFECT, MEASURED (not read). `readJson` is awaited INSIDE `handleRequest`,
 * so its `HttpClientError` rejections landed in that handler's own catch, which
 * had no branch for a typed client fault. The consequence, measured over
 * loopback against the real daemon on all four bad-body shapes:
 *
 *   body `[]`            -> 500 internal_error
 *   body `null`          -> 500 internal_error
 *   body `"x"`           -> 500 internal_error
 *   body `{not json`     -> 500 internal_error
 *   body 1e6+1 bytes     -> NO ANSWER (ECONNRESET — req.destroy() killed the
 *                           socket before the 413 could be written)
 *
 * So `invalid_json` (400) and `payload_too_large` (413) were two rows in the
 * shipped error-contract table that no client could ever receive, while the
 * refusal that DID arrive — 500 `internal_error` — claimed the server was at
 * fault for the caller's typo. The outer `handleRequest(...).catch` net already
 * mapped `HttpClientError` correctly and was unreachable for both codes, because
 * the inner catch always got there first.
 *
 * THE DECISION (a contract change, deliberately made, not a cleanup): the codes
 * are EMITTED. The table is the contract — a PHP consumer's
 * `Ui2apiException::$errorCode` is a public readonly field, and the codes are
 * documented as "emitted by the daemon today" — so the daemon was the thing
 * that was wrong. The alternative (delete the two rows) would have been a
 * BREAKING change to every generated client, would have left a caller mistake
 * reported as a server fault, and would have required inventing a replacement
 * code anyway: a refusal in this codebase ships a machine code by design.
 *
 * WHAT THIS FILE IS. The gate that would have caught it, and that generalises:
 * a declared-but-unreachable code is a promise the daemon does not keep. Every
 * code the table declares is driven for real, over loopback, and must ARRIVE.
 * The declared list is PARSED from the shipped table — never hand-typed — so a
 * new row that nothing can produce fails here.
 *
 * NOTE on the two parsers: `test/error-contract.test.ts` pins doc <-> SOURCE
 * (is a documented code emitted by the code?). This file pins source <-> CLIENT
 * (can a client actually RECEIVE it?). Those are different questions and a code
 * passes the first while failing the second — which is exactly how two rows sat
 * in the table for a whole fold. One direction each, on purpose.
 *
 * NO BROWSER IS LAUNCHED anywhere in this file. Every pool is a pre-built
 * ChatPool through the GOAL-87 test seam (`opts.pool`), and `dataDir` is always
 * a real temp dir — never the relative "data", which would resolve into the
 * operator's gitignored vault. Every pool refusal is produced by the REAL pool.
 */
const ROOT = join(import.meta.dirname, "..");
const PROFILES = [BUILTIN_PROFILES["deepseek"], BUILTIN_PROFILES["gemini"]];
const VAULT = mkdtempSync(join(tmpdir(), "u2a-refusal-vault-"));
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

/* ── the DECLARED set, parsed from the shipped table ───────────────────────── */

/** `{code: status}` as the shipped error-contract table states it. */
function declaredContract(): Map<string, number> {
  const doc = readFileSync(join(ROOT, "README.md"), "utf8");
  const out = new Map<string, number>();
  for (const m of doc.matchAll(/^\|\s*(\d{3})\s*\|\s*`([a-z_]+)`\s*\|/gm)) out.set(m[2]!, Number(m[1]));
  return out;
}

/* ── one real daemon answer, read back off the wire ────────────────────────── */

type Wire = { status: number; code: string | null; dead?: string };

function call(port: number, method: string, path: string, body?: unknown): Promise<Wire> {
  return rawCall(port, method, path, body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
}

/** A body sent VERBATIM. A dead socket is reported as `dead`, never as a status. */
function rawCall(port: number, method: string, path: string, raw?: Buffer): Promise<Wire> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          let parsed: unknown = d;
          try { parsed = d ? JSON.parse(d) : null; } catch { /* keep the raw text */ }
          const err = (parsed as { error?: { code?: string } | string } | null)?.error;
          resolve({ status: r.statusCode ?? 0, code: typeof err === "string" ? null : (err?.code ?? null) });
        });
      },
    );
    // A hung probe must be a NAMED failure, never a silent wait (GOAL 102).
    req.setTimeout(30_000, () => { req.destroy(); resolve({ status: 0, code: null, dead: "probe-timeout" }); });
    req.on("error", (e: Error & { code?: string }) => resolve({ status: 0, code: null, dead: e.code ?? e.message }));
    if (raw) req.write(raw);
    req.end();
  });
}

/* ── real pools, no browser ────────────────────────────────────────────────── */

/** A pre-built pool already AT capacity: acquire() parks or refuses, never spawns. */
function cappedPool(opts: Partial<PoolOptions>, driver: unknown): ChatPool {
  const pool = new ChatPool({ profiles: [], dataDir: VAULT, ...opts } as PoolOptions);
  (pool as unknown as { workers: PoolWorker[] }).workers = [
    { profileId: "deepseek", driver, busy: true } as unknown as PoolWorker,
  ];
  return pool;
}
const noPage = { page: undefined, close: async () => {}, ask: async () => ({}) };
/** A driver whose ask() never settles — the honest way to trip the 504. */
const hangs = {
  page: { context: () => ({ pages: () => [{ evaluate: async () => 1 }], _closed: false }) },
  close: async () => {},
  ask: () => new Promise(() => {}),
};
/** A driver that FAULTS — the honest way to trip a real 500 internal_error. */
const explodes = {
  page: undefined,
  close: async () => {},
  ask: async () => { throw new TypeError("Cannot read properties of undefined (reading 'prompt') — /abs/secret/path"); },
};

type Start = (opts: Record<string, unknown>) => Promise<{ port: number; close: () => Promise<void> }>;

async function withDaemon(start: Start, opts: Record<string, unknown>, fn: (port: number) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-refusal-"));
  const svc = await start({ port: 0, host: "127.0.0.1", dataDir, ...opts });
  try { await fn(svc.port); } finally { await svc.close(); rmSync(dataDir, { recursive: true, force: true }); }
}

const realStart: Start = (opts) => startPromptd(opts as unknown as Parameters<typeof startPromptd>[0]);

/** A daemon started from a COPY of the tree. The copy is a repo root of its own
 *  (the registry and profile loaders derive ROOT from the module path), so the
 *  manifests and package.json must come with it, and bare imports resolve
 *  through a symlink to the real node_modules. `dropRecord` removes
 *  capabilities/model-verification.json, which is the only way to drive the
 *  `model_verification_unreadable` branch honestly. */
async function withDaemonFromCopy(
  start: Start,
  opts: { dropRecord: boolean },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "u2a-refusal-copy-"));
  try {
    cpSync(join(ROOT, "src"), join(tmp, "src"), { recursive: true });
    cpSync(join(ROOT, "capabilities"), join(tmp, "capabilities"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(tmp, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), join(tmp, "node_modules"), "dir");
    if (opts.dropRecord) rmSync(join(tmp, "capabilities", "model-verification.json"), { force: true });
    const mod = (await import(pathToFileURL(join(tmp, "src", "prompt", "http.js")).href)) as {
      startPromptd: (o: Record<string, unknown>) => Promise<{ port: number; close: () => Promise<void> }>;
    };
    // The reader's LAST resort is `process.cwd()/capabilities/...`, so a copy
    // that keeps the real cwd would silently find the REAL record and the
    // "unreadable" probe would measure a healthy daemon. Chdir into the copy.
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const svc = await mod.startPromptd({ port: 0, host: "127.0.0.1", dataDir: mkdtempSync(join(tmpdir(), "u2a-refusal-vault-")) });
      try { await fn(svc.port); } finally { await svc.close(); }
    } finally {
      process.chdir(cwd);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ── the probes: one per DECLARED code, each driving a real daemon ─────────── */

/**
 * Every declared code gets a probe that can only produce THAT code. A probe
 * records `{code, status}` for a class it really drove; the checker then asks,
 * for each declared row, whether some probe arrived carrying exactly that code
 * at exactly that status. A probe that cannot be reached, or a declared code
 * with no probe, is a gap — never a skip.
 */
type Probe = { expect: string; how: string; got: Wire };
const OVER_LIMIT = 1_500_000; // comfortably past the documented 1 MB cap
const UNDER_LIMIT = 900_000;  // comfortably under it — a bound, not a blanket

async function runEveryProbe(start: Start): Promise<Probe[]> {
  const probes: Probe[] = [];
  const rec = (expect: string, how: string, got: Wire) => { probes.push({ expect, how, got }); };

  // The ordinary daemon: every refusal that needs no pool work.
  await withDaemon(start, { profiles: PROFILES }, async (port) => {
    // THE TWO CODES THAT WERE DEAD. Four bad-body shapes, one oversized body.
    rec("invalid_json", "POST /prompt with `[]`", await rawCall(port, "POST", "/prompt", Buffer.from("[]")));
    rec("invalid_json", "POST /prompt with `null`", await rawCall(port, "POST", "/prompt", Buffer.from("null")));
    rec("invalid_json", "POST /prompt with `\"x\"`", await rawCall(port, "POST", "/prompt", Buffer.from('"x"')));
    rec("invalid_json", "POST /prompt with `{not json`", await rawCall(port, "POST", "/prompt", Buffer.from("{not json")));
    rec("payload_too_large", `POST /prompt with ${OVER_LIMIT} bytes`, await rawCall(port, "POST", "/prompt", Buffer.alloc(OVER_LIMIT, 0x20)));
    // The bound is a BOUND: a large body UNDER the cap must not be refused as
    // too large (it is refused for a different, correct reason — no prompt).
    rec("invalid_json", "NEVER emitted: an under-limit body", await rawCall(port, "POST", "/prompt", Buffer.from(JSON.stringify({ filler: "x".repeat(UNDER_LIMIT), prompt: "" }))));

    rec("not_found", "GET /v1/no-such-endpoint (the /v1 terminal 404)", await call(port, "GET", "/v1/no-such-endpoint"));
    // GOAL 156 added these two rows to the table. A DECLARED code with no probe
    // is a gap this gate reports by design — so a new row is not done until it
    // can be DRIVEN. Both are ordinary /v1 refusals on this same daemon:
    // `model_not_found` is the single-id GET (src/prompt/openai.ts:827+), and
    // `unsupported_content_part` is the non-text content part the flattener
    // refuses rather than silently drops (openai.ts:760). A VALID model is used
    // on the second so the 404-the-model guard cannot answer first — the point
    // is the content part, not the model.
    rec("model_not_found", "GET /v1/models/<an id the daemon does not serve>", await call(port, "GET", "/v1/models/no-such-model-id"));
    rec("unsupported_content_part", "POST /v1/chat/completions with an image_url content part", await call(port, "POST", "/v1/chat/completions", { model: "deepseek", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/x.png" } }] }] }));
    rec("unknown_model", "POST /v1/chat/completions with a bogus model", await call(port, "POST", "/v1/chat/completions", { model: "no-such-model", messages: [{ role: "user", content: "hi" }] }));
    rec("unknown_capability", "POST /capability/deepseek with a bogus capability", await call(port, "POST", "/capability/deepseek", { capability: "no-such-capability" }));
    rec("no_stored_account", "POST /capability/deepseek with an account not in the vault", await call(port, "POST", "/capability/deepseek", { capability: "deepseek_chat", account: "ghost-account" }));
    // GOAL 159: a REAL site the measurement record does not call answering is
    // `model_withheld`, deliberately NOT `unknown_model` — the model exists, the
    // measurement says it could not answer. deepseek is one of the 11 SIGN-OUT
    // rows, and this daemon allow-lists it, so the single-id GET reaches the
    // withholding branch with a profile present.
    rec("model_withheld", "GET /v1/models/<a served site the record does not call answering>", await call(port, "GET", "/v1/models/deepseek"));
  });

  // `model_verification_unreadable` can only be produced by a daemon whose
  // measurement record is missing or unparseable — which no probe against the
  // real tree can arrange, because the record is right there and correct. So
  // this one is driven from a COPY of the tree with the record removed: the
  // record is an INPUT, and a code that fires on a bad input needs the bad
  // input to be reachable. Copying is the same mechanism the mutation proof
  // below already uses, so it is not a new mechanism in this file.
  await withDaemonFromCopy(start, { dropRecord: true }, async (port) => {
    rec("model_verification_unreadable", "GET /v1/models on a daemon whose measurement record is missing", await call(port, "GET", "/v1/models"));
  });

  // site_not_dispatched needs a DEFAULT daemon: with an explicit allow-list the
  // GOAL 111 guard answers first, so this probe must not narrow the surface.
  await withDaemon(start, { profiles: undefined }, async (port) => {
    rec("site_not_dispatched", "POST /capability/<not-a-site> on a default daemon", await call(port, "POST", "/capability/definitely-not-a-site", { capability: "x" }));
  });

  // A REAL internal fault — never a caller mistake dressed as one.
  await withDaemon(start, { pool: cappedPool({ max: 4, maxWaiters: 4, waiterTimeoutMs: 60_000 }, explodes) }, async (port) => {
    rec("internal_error", "POST /prompt with a driver that throws", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "hi" }));
  });

  // The three pool classes, each produced by the REAL pool.
  await withDaemon(start, { pool: cappedPool({ max: 1, maxWaiters: 0, waiterTimeoutMs: 60_000 }, noPage) }, async (port) => {
    rec("pool_saturated", "a pool at capacity with maxWaiters=0", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "hi" }));
  });
  await withDaemon(start, { pool: cappedPool({ max: 1, maxWaiters: 1, waiterTimeoutMs: 150 }, noPage) }, async (port) => {
    rec("pool_queue_timeout", "a queued waiter past its 150ms deadline", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "hi" }));
  });
  {
    // pool_closed settles the queue DURING shutdown, so by the time it lands the
    // daemon is gone: there is no socket left to answer on. The honest proof is
    // at the CLASS level — the real pool's real message, through the daemon's
    // own labeller — and `poolRefusalTruth` below pins that separately. Here
    // the code is recorded as reachable only if the label really is pool_closed.
    const pool = cappedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 60_000 }, noPage);
    const parked = pool.acquire("deepseek");
    void pool.close();
    const message = await parked.then(() => "", (e: Error) => e.message);
    const labelled = poolRefusal(message);
    probes.push({
      expect: "pool_closed",
      how: "the real pool's shutdown refusal, through the daemon's own labeller (no wire by construction)",
      got: { status: 503, code: labelled?.code ?? null },
    });
  }
  await withDaemon(start, { requestTimeoutMs: 200, pool: cappedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 60_000 }, hangs) }, async (port) => {
    rec("request_timeout", "a driver whose ask() never settles, past the 200ms deadline", await call(port, "POST", "/prompt", { site: "deepseek", prompt: "hi" }));
  });

  return probes;
}

/**
 * THE GATE. For every code the shipped contract declares, was it actually
 * delivered — with the declared status — by a probe that drove a real daemon?
 * Returns one line per gap: unreachable, wrong status, or declared with no
 * probe at all. An empty list is the promise kept.
 */
export function reachabilityGaps(declared: Map<string, number>, probes: Probe[]): string[] {
  const gaps: string[] = [];
  const covered = new Set<string>();
  for (const p of probes) {
    covered.add(p.expect);
    // The under-limit CONTROL, judged first and by its own rule: a large body
    // under the cap must not be refused as too large. A Shape-1 refusal here is
    // the correct answer ("prompt is required" carries no code), so the
    // "no code at all" rule below must not fire on it.
    if (p.how.startsWith("NEVER emitted")) {
      if (p.got.dead) gaps.push(`UNDER-LIMIT CONTROL: the under-limit body died on the wire (${p.got.dead}) — a body the cap accepts must be read, not dropped`);
      else if (p.got.code === "payload_too_large") gaps.push(`an UNDER-limit body was refused as payload_too_large — the cap is not a bound any more`);
      continue;
    }
    if (p.got.dead) {
      // A probe that died on the wire proves nothing about the code it aimed at,
      // and that is the whole defect for an oversized body: the refusal existed
      // and the client still got ECONNRESET.
      gaps.push(`${p.expect}: NO ANSWER — the client got ${p.got.dead} on "${p.how}", so the declared code is unreachable by classification`);
      continue;
    }
    if (p.got.code === null) {
      gaps.push(`${p.expect}: the daemon answered ${p.got.status} with NO code at all on "${p.how}"`);
      continue;
    }
    if (p.got.code !== p.expect) gaps.push(`${p.expect}: "${p.how}" answered ${p.got.code} (${p.got.status}) instead — the class is unlabelled`);
  }
  for (const [code, status] of declared) {
    if (!covered.has(code)) gaps.push(`${code} (${status}): DECLARED in the error contract and no probe here can produce it — the table promises a class the gate cannot see arrive`);
  }
  return gaps;
}

/* ── 1. the gate itself ────────────────────────────────────────────────────── */

test("every code the error contract DECLARES is REACHABLE — driven over loopback against the real daemon", async () => {
  const declared = declaredContract();
  // Non-vacuity, both sides: a gate that parsed nothing proves nothing.
  assert.ok(declared.size >= 10, `expected the shipped table to declare >=10 codes, found ${declared.size}: ${[...declared.keys()]}`);

  const probes = await runEveryProbe(realStart);
  assert.ok(probes.length >= 13, `expected the whole declared surface to be driven, got ${probes.length} probes`);

  const gaps = reachabilityGaps(declared, probes);
  assert.deepEqual(
    gaps,
    [],
    `the error contract promises codes the daemon does not deliver: ${gaps.join(" | ")} — either emit the code, or stop declaring it`,
  );

  // The two codes this gate exists for, named explicitly so a regression reads
  // as itself and not as a generic diff. The GOAL-156 pair rides along: they are
  // named RECIVABLE too, so a probe that quietly stopped arriving fails HERE
  // loudly rather than only as a bare "no probe" line — the silent-skip class
  // this repo has been bitten by before.
  for (const [code, status] of [["invalid_json", 400], ["payload_too_large", 413], ["model_not_found", 404], ["unsupported_content_part", 400]] as const) {
    const hit = probes.find((p) => p.expect === code && !p.how.startsWith("NEVER emitted") && p.got.code === code && p.got.status === status);
    assert.ok(hit, `${code} must be RECEIVABLE at ${status} by a real client — the probe that drives it did not arrive carrying it: ${JSON.stringify(probes.filter((p) => p.expect === code))}`);
  }
});

/* ── 2. the pool labels DERIVE from the pool's own prefixes (Finding 2) ────── */

test("poolRefusal labels derive from the pool's OWN message prefixes — no hand-kept copy to rot", async () => {
  // The measured rot this kills: `poolRefusal` used to carry a hand-written COPY
  // of the three prefixes. A reword in pool.ts would have left the copy
  // matching nothing and turned a named 503 into a bare 500 internal_error for
  // every client — with no test able to see it, which is the failure
  // test/codefor-prose-table.test.ts pins for the OTHER prose table.
  const httpSrc = readFileSync(join(ROOT, "src", "prompt", "http.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const body = httpSrc.slice(httpSrc.indexOf("function poolRefusal"));
  assert.ok(body.length > 0, "poolRefusal must exist in http.ts — this pin cannot see it otherwise");

  // (1) NO prefix literal may appear in http.ts. The only way it can match the
  // pool's prose is by coming from the pool's own constant.
  for (const [code, prefix] of Object.entries(POOL_REFUSAL_CODES)) {
    assert.ok(
      !httpSrc.includes(JSON.stringify(prefix).slice(1, -1)),
      `http.ts holds its own copy of the "${code}" prefix (${JSON.stringify(prefix)}) — a reword in pool.ts would silently stop matching; import POOL_REFUSAL_CODES instead`,
    );
    assert.ok(
      body.includes(`POOL_REFUSAL_CODES.${code}`),
      `poolRefusal no longer labels "${code}" from POOL_REFUSAL_CODES.${code} — the label must follow the emitter`,
    );
  }

  // (2) Behaviourally, from the REAL pool: the message the pool really throws
  // for each class carries the exported prefix AND is labelled that class. A
  // reword of the prose can now only change both sides together.
  const saturatedPool = cappedPool({ max: 1, maxWaiters: 0, waiterTimeoutMs: 60_000 }, noPage);
  await assert.rejects(saturatedPool.acquire("deepseek"), (e: Error) => {
    assert.ok(e.message.startsWith(POOL_REFUSAL_CODES.pool_saturated), `the real saturation message no longer carries the exported prefix: ${JSON.stringify(e.message)}`);
    assert.deepEqual(poolRefusal(e.message), { code: "pool_saturated" });
    return true;
  });

  const timeoutPool = cappedPool({ max: 1, maxWaiters: 1, waiterTimeoutMs: 150 }, noPage);
  await assert.rejects(timeoutPool.acquire("deepseek"), (e: Error) => {
    assert.ok(e.message.startsWith(POOL_REFUSAL_CODES.pool_queue_timeout), `the real queue-timeout message no longer carries the exported prefix: ${JSON.stringify(e.message)}`);
    assert.deepEqual(poolRefusal(e.message), { code: "pool_queue_timeout" });
    return true;
  });

  const closedPool = cappedPool({ max: 1, maxWaiters: 4, waiterTimeoutMs: 60_000 }, noPage);
  const parked = closedPool.acquire("deepseek");
  void closedPool.close();
  const shutdown = await parked.then(() => "", (e: Error) => e.message);
  assert.ok(shutdown.startsWith(POOL_REFUSAL_CODES.pool_closed), `the real shutdown message no longer carries the exported prefix: ${JSON.stringify(shutdown)}`);
  assert.deepEqual(poolRefusal(shutdown), { code: "pool_closed" });

  // (3) The label covers exactly the declared pool classes, and nothing else:
  // an unrelated message must stay unlabelled rather than fall into a code.
  assert.deepEqual(
    Object.keys(POOL_REFUSAL_CODES).sort(),
    ["pool_closed", "pool_queue_timeout", "pool_saturated"],
    "the pool refusal classes changed — a new one needs a prefix here or its class loses its name",
  );
  assert.equal(poolRefusal("unknown site \"x\""), null, "an unrelated refusal must never be labelled as a pool refusal");
});

/* ── 3. the mutation proof — the gate CAN fail ────────────────────────────── */

/**
 * The pre-fix shape, reconstructed as a REAL daemon, in a COPY of the tree.
 * The shared worktree is never edited: four agents work in it at once, and a
 * mutation window in `src/prompt/http.ts` would be their failure, not mine.
 * The copy carries the pre-fix shape of all three defects:
 *   1. the catch has no `HttpClientError` branch (the swallow), and
 *   2. readJson destroys the socket before answering (the dead 413), and
 *   3. a body that is not JSON at all is a bare Error (the 4th 500).
 */
const PREFIX_FIX = `        req.pause();
        req.removeAllListeners("data");
        reject(new HttpClientError(413, "payload_too_large"`;
const PREFIX_BUG = `        req.destroy();
        reject(new HttpClientError(413, "payload_too_large"`;
const BRANCH_FIX = /if \(e instanceof HttpClientError\) \{[\s\S]*?\n        return;\n      \}\n/;
const BARE_JSON_FIX = `reject(new HttpClientError(400, "invalid_json", "request body is not valid JSON"));`;
const BARE_JSON_BUG = `reject(new Error("invalid JSON body"));`;

test("MUTATION: with the swallowing catch and the socket destroy back, the gate goes RED on exactly the two codes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "u2a-refusal-mut-"));
  try {
    cpSync(join(ROOT, "src"), join(tmp, "src"), { recursive: true });
    // The copied tree is a REPO ROOT of its own (`REPO_ROOT` is derived from the
    // module path), so the registry and profile loaders need the manifests too.
    // Measured, not assumed: without them the copied daemon found no installed
    // package, the `unknown_capability` pre-dispatch guard never fired, and the
    // probe measured a DIFFERENT daemon than the one above — which is how a
    // mutation proof can quietly go vacuous.
    cpSync(join(ROOT, "capabilities"), join(tmp, "capabilities"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(tmp, "package.json"));
    // …and it resolves bare imports through the real node_modules.
    symlinkSync(join(ROOT, "node_modules"), join(tmp, "node_modules"), "dir");

    const file = join(tmp, "src", "prompt", "http.ts");
    const original = readFileSync(file, "utf8");
    let mutated = original;
    // (1) restore the swallow: the typed-client-error branch is gone.
    mutated = mutated.replace(BRANCH_FIX, "");
    assert.notEqual(mutated, original, "the mutation must actually remove the HttpClientError branch — the source moved, so the proof is no longer the shape it claims");
    // (2) restore the dead socket: destroy before the answer, not after it.
    const afterSocket = mutated.replace(PREFIX_FIX, PREFIX_BUG);
    assert.notEqual(afterSocket, mutated, "the mutation must restore req.destroy() before the answer — the oversize path moved");
    mutated = afterSocket;
    // (3) restore the fourth 500: a body that is not JSON at all.
    const afterJson = mutated.replace(BARE_JSON_FIX, BARE_JSON_BUG);
    assert.notEqual(afterJson, mutated, "the mutation must restore the bare-Error JSON failure");
    mutated = afterJson;
    writeFileSync(file, mutated);

    // The MUTATED daemon, loaded as a real module, driven by the SAME probes
    // and judged by the SAME gate as the fixed one above.
    const mod = (await import(pathToFileURL(join(tmp, "src", "prompt", "http.js")).href)) as {
      startPromptd: (o: Record<string, unknown>) => Promise<{ port: number; close: () => Promise<void> }>;
    };
    assert.equal(typeof mod.startPromptd, "function", "the mutated daemon must load — a failed import would make this test vacuous");

    const declared = declaredContract();
    const probes = await runEveryProbe(mod.startPromptd as Start);
    const gaps = reachabilityGaps(declared, probes);
    // The measurement is reported, not just asserted: this number IS the proof,
    // and a reader should be able to see it without re-deriving it.
    console.error(`[refusal-truth] the PRE-FIX daemon leaves ${gaps.length} declared codes undelivered: ${JSON.stringify(gaps)}`);

    assert.notDeepEqual(gaps, [], "the pre-fix daemon must FAIL this gate — a mutation that stays green pins nothing");
    // …and it must fail on the two codes, and on nothing else: the other ten
    // declared classes were always reachable, so they must stay green here. A
    // gap list that grows is a different regression, not this one.
    // Every gap line leads with the code it concerns, so this classification is
    // structural rather than a string a reword could fool. It is a SET: four bad
    // body shapes are four observations of the SAME unreachable class.
    const deadCodes = [...new Set(gaps.filter((g) => g.startsWith("invalid_json") || g.startsWith("payload_too_large")).map((g) => g.split(":")[0]!))].sort();
    assert.deepEqual(
      deadCodes,
      ["invalid_json", "payload_too_large"],
      `the mutation must make exactly the two dead codes unreachable, got: ${JSON.stringify(gaps)}`,
    );
    assert.equal(
      gaps.length,
      5,
      `expected exactly the four bad-body shapes plus the oversized body to go unreachable, got ${gaps.length}: ${JSON.stringify(gaps, null, 1)}`,
    );
    // And the pre-fix daemon really is the 500-instead-of-400 the finding named.
    const badBody = probes.find((p) => p.how.includes("`[]`"))!;
    assert.equal(badBody.got.status, 500, "precondition: the mutated daemon really answers 500 for a bad body");
    assert.equal(badBody.got.code, "internal_error", "precondition: and it really answers internal_error, not invalid_json");
    const oversize = probes.find((p) => p.how.includes(`${OVER_LIMIT} bytes`))!;
    assert.equal(oversize.got.dead, "ECONNRESET", `precondition: the mutated daemon really destroys the socket, got ${JSON.stringify(oversize.got)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
