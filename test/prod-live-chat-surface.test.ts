import { strict as assert } from "node:assert";
import { test } from "node:test";

// LIVE production chat-surface gate.
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
//
// ANTI-VACUITY: every assertion below is driven by data actually read off the
// service. An empty model list, an unreachable endpoint, a non-JSON body, or
// an HTML error page all FAIL loudly. This file can never report a clean pass
// because it had nothing to look at.

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

async function reachable(): Promise<boolean> {
  try {
    await getJson("/health");
    return true;
  } catch {
    return false;
  }
}

test("live chat surface: the service is reachable and answers JSON (never an HTML error page)", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — the gate must fail, never pass vacuously`);

  const { status, body } = await getJson("/v1/models");
  assert.equal(status, 200, `/v1/models must answer 200, got ${status}`);
  assert.equal(
    typeof body,
    "object",
    `/v1/models returned a non-JSON body (HTML error page?): ${String(body).slice(0, 200)}`,
  );
});

test("live chat surface: /v1/models advertises a non-empty model list", async () => {
  const { body } = await getJson("/v1/models");
  const ids = modelIds(body);
  assert.ok(
    ids.length > 0,
    "/v1/models advertised ZERO models — an empty list must fail the gate, not pass it",
  );
});

test("live chat surface: the advertised count equals the registry's chat.model count", async () => {
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

test("live chat surface: every advertised id is ACCEPTED by /v1/chat/completions (no 404 unknown_model)", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
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

test("live chat surface: every advertised id answers JSON with a named outcome, never a bare 500 or an HTML page", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
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

test("live chat surface: an UNKNOWN id is refused with the named unknown_model code (the gate's own premise holds)", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
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
