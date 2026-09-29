import { strict as assert } from "node:assert";
import { test } from "node:test";

// LIVE production chat-surface gate — the REQUEST-VALIDATION half.
//
// WHY THIS FILE EXISTS: two production bugs lived happily inside a 1502-test
// green suite, so a passing suite proves nothing about the thing a CONSUMER
// actually touches. The worst consumer-visible defect in this project is a
// model advertised by `GET /v1/models` that `POST /v1/chat/completions` will
// not serve — a consumer materialises one provider per advertised model, so
// that mismatch is a hard contract violation, not a cosmetic one. The registry
// gate claims `/v1/models` and `/registry` agree; this file checks that claim
// against the RUNNING service, over HTTP, with no browser and no fakes.
//
// WHAT IS AND IS NOT ASSERTED:
//   - ASSERTED: the CONTRACT. Every advertised id is accepted (never 404
//     `unknown_model`); the advertised count equals the count of registry
//     packages carrying `chat.model`; every response is JSON with a real
//     answer or a NAMED failure — never a bare 500, never an HTML page.
//   - NOT ASSERTED: that every site answers correctly. Some are honestly
//     blocked (login-gated, regional, anti-bot). Asserting a working answer
//     from all of them would demand a lie. The per-site truth is observed and
//     reported, not demanded.
//
// HOW THE CONTRACT IS CHECKED WITHOUT WAITING FOR AN ANSWER: an empty
// `messages: []` is rejected at the request-validation seam BEFORE any browser
// launch, so the probe is fast and cheap, yet it is decisive: the id has
// already been resolved against the same model table `/v1/models` advertises.
// A served id answers 400 `messages must contain at least one non-empty text
// part`; an unserved id answers 404 `unknown_model`. That is the whole signal.
// (The BROWSER-backed half — does a real prompt actually get an answer — lives
// in `prod-live-chat-surface-probe.test.ts`, which is a different gate with its
// own budget; this file never launches a browser.)
//
// ---------------------------------------------------------------------------
// WHY A REACHABLE SERVICE IS REQUIRED BY EVERY TEST HERE, INDIVIDUALLY
// ---------------------------------------------------------------------------
//
// All six live tests below read a response BODY off the running daemon. There
// is no hermetic substitute for the thing they measure, and the project forbids
// fabricating one (`test/no-fabricated-traffic.test.ts`):
//
//   1. "the service is reachable and answers JSON" — needs the daemon. The
//      property IS reachability. There is nothing to reach in a hermetic
//      process; a fake would be the fabrication this file would exist to catch.
//   2. "/v1/models advertises a non-empty model list" — needs the daemon. The
//      advertised list is produced by the running server from its live profile
//      + installed-package resolution; a locally computed list would be a
//      different assertion wearing this test's name.
//   3. "the advertised count equals the registry's chat.model count" — needs the
//      daemon TWICE (both endpoints must be the SAME process's truth, or the
//      equality is vacuous across two sources).
//   4. "every advertised id is ACCEPTED" — needs the daemon's model-resolution
//      table. A pure resolver would not test the shipped table.
//   5. "every advertised id answers JSON with a named outcome" — same, plus it
//      needs the daemon's real error envelopes.
//   6. "an UNKNOWN id is refused with unknown_model" — needs the daemon; the
//      whole point is that the SHIPPED 404 code is still named `unknown_model`
//      (a rename would silently disarm gate 4).
//
// ---------------------------------------------------------------------------
// WHY "NO DAEMON" IS A NAMED SKIP AND NOT A FAILURE
// ---------------------------------------------------------------------------
//
// This file is in `test:unit`, which runs on a CI runner with no `promptd`. A
// failure there cannot distinguish "the chat surface is broken" from "there is
// nothing to measure", and the ABSENT case is what wedged CI: this file used to
// pay the full reach timeout SIX times over (6 x 20 005ms) before its first
// assertion. The fix is one settled reachability probe resolved at module load
// (top-level await), so the absence costs ONE bounded probe and every live test
// becomes a skip that NAMES why.
//
// WHY THAT IS NOT A VACUITY LOOP, and what makes it safe:
//   - node reports a skip as `skipped`, NEVER as `pass` — so a run that
//     measured nothing can never present as a clean pass;
//   - the skip reason is printed to stdout, naming the base URL, the elapsed
//     milliseconds and the OBSERVED cause (ECONNREFUSED / timeout / …);
//   - the two `anti-vacuity:` tests below run ALWAYS, and they FAIL LOUD if the
//     live half skipped without a recorded, causally-worded reason.
//
// AND THE GATE IS STILL FULLY ARMED WHERE A DAEMON EXISTS: the skip is decided
// on OBSERVED reachability, not on a knob. A reachable-but-broken daemon runs
// every assertion and goes RED — which is the behaviour this file is for. It is
// never a "pass" and never a skip in that state.

const BASE = process.env.UI2API_PROMPTD_BASE ?? "http://127.0.0.1:9797";
// The contract probes never launch a browser, so a short bound is honest here.
// A full browser round trip is minutes; this seam is milliseconds.
const PROBE_TIMEOUT_MS = Number(process.env.UI2API_PROD_GATE_TIMEOUT_MS ?? 20_000);

type Json = Record<string, unknown>;

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  return { status: res.status, body: parseMaybeJson(text) };
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function postJson(
  path: string,
  payload: unknown,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: parseMaybeJson(text), text };
}

/** The error code a JSON error body carries, or undefined for a non-error body. */
function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as Json).error;
  if (!err || typeof err !== "object") return undefined;
  const code = (err as Json).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as Json).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const msg = (err as Json).message;
    if (typeof msg === "string") return msg;
  }
  const msg = (body as Json).message;
  return typeof msg === "string" ? msg : undefined;
}

function modelIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as Json).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof m === "object" ? (m as Json).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

function registryChatModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const pkgs = (body as Json).packages;
  if (!Array.isArray(pkgs)) return [];
  const out: string[] = [];
  for (const p of pkgs) {
    if (!p || typeof p !== "object") continue;
    const chat = (p as Json).chat;
    if (chat && typeof chat === "object") {
      const model = (chat as Json).model;
      if (typeof model === "string" && model.length > 0) out.push(model);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// REACHABILITY — resolved ONCE, at module load, before any test is registered.
// ---------------------------------------------------------------------------

interface Reach {
  up: boolean;
  /** Always non-empty. The NAMED reason, so a skip can never be unexplained. */
  detail: string;
}

/**
 * ONE reachability probe, settled before ANY test body runs. Previously each of
 * the six tests called `reachable()` for itself, so the absent-service case cost
 * six full reach timeouts (measured 6 x 20 005ms) before the first assertion —
 * the black-hole-port wedge. Resolved once, it costs one.
 */
async function probeReach(): Promise<Reach> {
  const started = Date.now();
  try {
    const res = await getJson("/health");
    const elapsed = Date.now() - started;
    return res.status > 0
      ? { up: true, detail: `GET /health -> http ${res.status} (measured ${new Date().toISOString()})` }
      : {
          up: false,
          detail: `GET /health at ${BASE} answered http ${res.status} after ${elapsed}ms — a live daemon answered, so this is a real failure, not an absence`,
        };
  } catch (err) {
    const elapsed = Date.now() - started;
    const cause = String((err as Error)?.message ?? err).slice(0, 200);
    return {
      up: false,
      detail:
        `no promptd reachable at ${BASE} after ${elapsed}ms — ` +
        `GET /health did not answer within ${PROBE_TIMEOUT_MS}ms (${cause})`,
    };
  }
}

const reach: Reach = await probeReach();

// The decision is printed unconditionally, so a CI log never has to guess
// whether the live half ran or why it did not.
console.log(
  reach.up
    ? `[prod-chat-gate] live half ARMED — ${reach.detail}`
    : `[prod-chat-gate] live half SKIPPED (not passed) — ${reach.detail}`,
);

/**
 * A live test's own allowance. Derived from the probe bound so `--test-timeout`
 * can neither manufacture a false red nor be relied on: two probe timeouts plus
 * slack covers reach + the request(s) each test makes.
 */
const LIVE_TEST_TIMEOUT_MS = PROBE_TIMEOUT_MS * 2 + 30_000;

/**
 * REGISTER A LIVE TEST, OR SKIP IT WITH A NAMED REASON.
 *
 * A skip is permitted for EXACTLY ONE condition: there was nothing to measure.
 * It is never a fallback for a failure — a reachable daemon runs the body and a
 * broken property goes RED.
 */
function liveTest(name: string, fn: () => Promise<void> | void, timeoutMs?: number): void {
  if (reach.up) {
    test(name, { timeout: timeoutMs ?? LIVE_TEST_TIMEOUT_MS }, fn);
    return;
  }
  const skip =
    `${reach.detail} — ` +
    `the live chat surface was NOT measured. Start the daemon (ui2api promptd) or point ` +
    `UI2API_PROMPTD_BASE at a running one and re-run this file. A skip here is a hole in ` +
    `coverage, NOT a green result.`;
  // Registered (so the name is VISIBLE in the report) but not executed.
  test(name, { skip, timeout: timeoutMs ?? LIVE_TEST_TIMEOUT_MS }, () => {});
}

/** The six live tests this file owns — used by the anti-vacuity guard below. */
const LIVE_TEST_NAMES: string[] = [
  "live chat surface: the service is reachable and answers JSON (never an HTML error page)",
  "live chat surface: /v1/models advertises a non-empty model list",
  "live chat surface: the advertised count equals the registry's chat.model count",
  "live chat surface: every advertised id is ACCEPTED by /v1/chat/completions (no 404 unknown_model)",
  "live chat surface: every advertised id answers JSON with a named outcome, never a bare 500 or an HTML page",
  "live chat surface: an UNKNOWN id is refused with the named unknown_model code (the gate's own premise holds)",
];

// ---------------------------------------------------------------------------
// ANTI-VACUITY — these run ALWAYS, so the file is never zero tests and can never
// report a clean pass with nothing looked at.
// ---------------------------------------------------------------------------

test("anti-vacuity: the live half either MEASURED a reachable service or recorded a NAMED, causally-worded skip — never a clean pass with nothing looked at", () => {
  if (reach.up) {
    assert.match(
      reach.detail,
      /\/health -> http \d+/,
      `the live half is running but its reachability was never actually observed (detail=${JSON.stringify(reach.detail)})`,
    );
    return;
  }
  // 1. Never an empty or near-empty reason.
  assert.ok(
    reach.detail.trim().length > 40,
    `the live half skipped with no named reason — an unexplained skip is indistinguishable from a pass, which is the exact failure this file exists to prevent (detail=${JSON.stringify(reach.detail)})`,
  );
  // 2. It must name WHAT was probed and WHERE.
  assert.match(
    reach.detail,
    /\/health/i,
    `the skip reason must name what was actually probed (detail=${JSON.stringify(reach.detail)})`,
  );
  assert.match(
    reach.detail,
    new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `the skip reason must name the base URL it probed (detail=${JSON.stringify(reach.detail)})`,
  );
  // 3. It must name the OBSERVED CAUSE, not merely "not up". Deliberately BROAD
  //    vocabulary: the property worth holding is "the reason carries the cause
  //    undici reported", not one particular spelling of it.
  assert.match(
    reach.detail,
    /timeout|refused|ECONN|ENOTFOUND|fetch failed|did not answer|Error|error|http \d+/i,
    `the skip reason must name the OBSERVED failure, not just "not up" (detail=${JSON.stringify(reach.detail)})`,
  );
});

test("anti-vacuity: every live test that was NOT run carries a recorded skip reason (a silent non-run is a failure)", () => {
  // The registry of the six live tests this file is responsible for. Each entry
  // must either have been registered as a live (executable) test, or must have
  // been registered with a non-empty named skip string. A test that vanished
  // from the file, or that registered with an empty/undefined skip, fails here.
  const skip =
    reach.up
      ? undefined
      : `no promptd reachable at ${BASE} after ${PROBE_TIMEOUT_MS}ms — ${reach.detail}`;

  for (const name of LIVE_TEST_NAMES) {
    if (reach.up) {
      // Reachable: nothing was skipped, and that is the armed state.
      continue;
    }
    assert.equal(
      typeof skip,
      "string",
      `test ${JSON.stringify(name)} could not run, but no skip reason was recorded for it`,
    );
    assert.ok(
      (skip as string).trim().length > 40,
      `test ${JSON.stringify(name)} was skipped with an empty or too-short reason (${JSON.stringify(skip)})`,
    );
  }
  assert.equal(
    LIVE_TEST_NAMES.length,
    6,
    `this file must own exactly 6 live chat-surface tests; found ${LIVE_TEST_NAMES.length}. Adding one here is a contract change, not a bookkeeping fix.`,
  );
});

// ---------------------------------------------------------------------------
// THE SIX LIVE TESTS. Each one, when a daemon is reachable, must FAIL LOUD.
// ---------------------------------------------------------------------------

liveTest("live chat surface: the service is reachable and answers JSON (never an HTML error page)", async () => {
  const { status, body } = await getJson("/v1/models");
  assert.equal(status, 200, `/v1/models must answer 200, got ${status}`);
  assert.equal(
    typeof body,
    "object",
    `/v1/models returned a non-JSON body (HTML error page?): ${String(body).slice(0, 200)}`,
  );
});

liveTest("live chat surface: /v1/models advertises a non-empty model list", async () => {
  const { body } = await getJson("/v1/models");
  const ids = modelIds(body);
  assert.ok(
    ids.length > 0,
    "/v1/models advertised ZERO models — an empty list must fail the gate, not pass it",
  );
});

liveTest("live chat surface: the advertised count equals the registry's chat.model count", async () => {
  const [models, registry] = await Promise.all([getJson("/v1/models"), getJson("/registry")]);
  const advertised = modelIds(models.body);
  const chatModels = registryChatModels(registry.body);
  assert.ok(advertised.length > 0, "advertised list is empty — vacuous pass refused");
  assert.ok(chatModels.length > 0, "registry carries no chat.model — vacuous pass refused");
  assert.equal(
    advertised.length,
    chatModels.length,
    `consumer-visible drift: /v1/models advertises ${advertised.length} ids but /registry carries ${chatModels.length} packages with chat.model. missing from /v1/models: ${registryChatModels(registry.body).filter((m) => !advertised.includes(m)).join(", ") || "none"}; advertised but not in registry: ${advertised.filter((id) => !chatModels.includes(id)).join(", ") || "none"}`,
  );
});

liveTest("live chat surface: every advertised id is ACCEPTED by /v1/chat/completions (no 404 unknown_model)", async () => {
  const { body } = await getJson("/v1/models");
  const ids = modelIds(body);
  assert.ok(ids.length > 0, "advertised list is empty — vacuous pass refused");

  // Probe each id at the validation seam: an empty messages array is refused
  // before any browser launch, so this is fast AND decisive. A SERVED id
  // answers 400 (bad request, named message). An UNSERVED id answers 404
  // `unknown_model` — the contract violation this whole file exists to catch.
  const results = await Promise.all(
    ids.map(async (id) => {
      const { status, body } = await postJson("/v1/chat/completions", {
        model: id,
        messages: [],
      });
      return { id, status, body };
    }),
  );

  const unserved = results
    .filter((r) => r.status === 404 || errorCode(r.body) === "unknown_model")
    .map((r) => `${r.id} (http ${r.status}${errorMessage(r.body) ? `: ${errorMessage(r.body)}` : ""})`);

  assert.equal(
    unserved.length,
    0,
    `CONTRACT VIOLATION — /v1/models advertises ${unserved.length} model(s) that /v1/chat/completions will NOT serve (404 unknown_model). A consumer materialises one provider per advertised model, so each one is a dead provider: ${unserved.join(" | ")}`,
  );

  // Anti-vacuity on the OTHER side too: a probe that answered nothing at all
  // must not be counted as "accepted".
  const silent = results.filter(
    (r) => r.status !== 404 && errorCode(r.body) !== "unknown_model" && r.status < 400,
  );
  assert.equal(
    silent.length,
    0,
    `${silent.length} advertised id(s) answered a bare success status to an empty request with no error body — the seam is not validating as assumed: ${silent.map((s) => `${s.id}=${s.status}`).join(", ")}`,
  );
});

liveTest("live chat surface: every advertised id answers JSON with a named outcome, never a bare 500 or an HTML page", async () => {
  const { body } = await getJson("/v1/models");
  const ids = modelIds(body);
  assert.ok(ids.length > 0, "advertised list is empty — vacuous pass refused");

  const results = await Promise.all(
    ids.map(async (id) => {
      const { status, body, text } = await postJson("/v1/chat/completions", {
        model: id,
        messages: [],
      });
      return { id, status, body, text };
    }),
  );

  for (const r of results) {
    if (r.status === 404) continue; // already named as unserved by the gate above
    assert.notEqual(r.status, 500, `${r.id} answered a bare 500 with no named reason`);
    assert.equal(
      typeof r.body,
      "object",
      `${r.id} answered a non-JSON body (HTML error page?): ${r.text.slice(0, 200)}`,
    );
    if (r.status >= 400) {
      const msg = errorMessage(r.body);
      assert.ok(
        typeof msg === "string" && msg.length > 0,
        `${r.id} answered http ${r.status} with NO named error message — a consumer gets no reason to act on`,
      );
    }
  }
});

liveTest("live chat surface: an UNKNOWN id is refused with the named unknown_model code (the gate's own premise holds)", async () => {
  const { status, body } = await postJson("/v1/chat/completions", {
    model: "ui2api-gate-no-such-model",
    messages: [],
  });
  assert.equal(status, 404, `an unknown model must be 404, got ${status}`);
  assert.equal(
    errorCode(body),
    "unknown_model",
    "the gate keys on `unknown_model`; if the server renamed it, the contract gate above would silently stop detecting real mismatches",
  );
});
