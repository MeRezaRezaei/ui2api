import { strict as assert } from "node:assert";
import { test } from "node:test";

// LIVE production chat-surface probe — the BROWSER-BACKED half of the gate.
//
// WHY THIS FILE IS SEPARATE FROM `prod-live-chat-surface.test.ts`: that file
// probes the request-VALIDATION seam with an empty `messages: []`, which is
// milliseconds-fast because it is refused before any browser launch. It answers
// "is the id in the model table?". This file answers the STRONGER question a
// consumer actually cares about: "if I materialise a provider for every
// advertised id and send it a real prompt, does the service accept it?".
//
// THE BUG THIS ENCODES. `GET /v1/models` advertises 22 ids, but the warm
// browser pool (`src/prompt/pool.ts`) is capped at `max=4` and pre-warms only
// 4 builtin sites (gemini, chatgpt, claude, copilot). `acquire()` spawns a NEW
// page only while `workers.length + spawning < this.max`; at the ceiling a
// request for any OTHER site is parked as a waiter that keeps re-parking on
// wrong-site pages and dies with `pool_queue_timeout` after 240s. So most
// advertised ids are advertised-but-unservable: HTTP 503
// `{"error":{"code":"pool_queue_timeout",...}}`.
//
// WHAT IS AND IS NOT ASSERTED:
//   - ASSERTED: the CONTRACT. Every advertised id is ACCEPTED (never 404
//     `unknown_model`); every response is parseable JSON with a non-HTML
//     content-type and a body that does not start with `<`; never a bare
//     unhandled 500. AND — GOAL 156, cause D — AT LEAST ONE advertised id
//     actually ANSWERS.
//   - NOT ASSERTED: that EVERY site answers correctly. A NAMED failure —
//     `pool_queue_timeout`, `pool_saturated`, `ui2api_driver_error`, a
//     `refusal` string, a restriction/login-gated reason — is a legitimate,
//     honest outcome and is accepted PER MODEL. Some sites are honestly blocked
//     or signed out; demanding a working answer from all of them would demand a
//     lie. The per-id truth is observed, printed, and reported.
//
// GOAL 156, CAUSE D — WHY THE "AT LEAST ONE ANSWERS" GATE EXISTS. The version
// of this file before that goal asserted a COLUMN (is the id accepted? is the
// body JSON?) when the property is BEHAVIOUR (does the service still answer at
// all?). `scripts/audit/model-answers-audit.md` is the proof: a 22-model live
// sweep returned 1 real answer (gemini, HTTP 200, 28940 ms, clean pool), 2 named
// sign-out refusals, and 11 no-response aborts — INCLUDING `duckduckgo`, the
// known-good control that had answered minutes earlier. A total service outage
// passed this gate green for an entire session. So the rule is asymmetric on
// purpose: per-model honest failure is fine, total silence is NOT.
//
// ANTI-VACUITY. Every assertion is driven by data actually read off the
// service: an empty model list FAILS, an unreachable endpoint FAILS, a non-JSON
// or HTML body FAILS. This file can never report a clean pass because it had
// nothing to look at.
//
// IMPORTABILITY. The pure verdict function below is exported and unit-tested
// hermetically by `test/prod-probe-verdict.test.ts`, which must NOT need a live
// daemon. Importing this file would otherwise REGISTER AND RUN its live tests,
// so the live tests are gated on `UI2API_PROBE_NO_LIVE` — the verdict test sets
// it before importing.
//
// NOT HAMMERING THE SERVICE. The pool has 4 slots and a 16-waiter queue, and
// each browser round trip can take minutes. So the probe is strictly SERIAL
// (one in-flight request at a time, no `Promise.all`) with a generous 300s
// per-request timeout, and an overall run is bounded by
// `UI2API_PROD_PROBE_MAX_IDS` plus the command-level `timeout`. Concurrency
// here would manufacture `pool_saturated` noise rather than measure the bug.
//
// ANTI-VACUITY. Every assertion is driven by data actually read off the
// service: an empty model list FAILS, an unreachable endpoint FAILS, a non-JSON
// or HTML body FAILS. This file can never report a clean pass because it had
// nothing to look at.

const BASE = process.env.UI2API_PROMPTD_BASE ?? "http://127.0.0.1:9797";
// A real browser round trip is minutes, so this is deliberately generous.
const REQUEST_TIMEOUT_MS = Number(process.env.UI2API_PROD_PROBE_TIMEOUT_MS ?? 300_000);
// Bound the whole run so a wedged service cannot make this file take hours.
const MAX_IDS = Number(process.env.UI2API_PROD_PROBE_MAX_IDS ?? 24);
const REACH_TIMEOUT_MS = Number(process.env.UI2API_PROD_PROBE_REACH_TIMEOUT_MS ?? 20_000);
const PROBE_TEXT = "Reply with exactly: PRODCHECK";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// THE PURE VERDICT FUNCTION (GOAL 156, cause D) — exported and unit-tested
// hermetically in test/prod-probe-verdict.test.ts. It is a PURE function of the
// collected per-id outcomes: no fetch, no clock, no daemon. That is what makes
// it provable — a live probe against 127.0.0.1:9797 cannot demonstrate that the
// gate goes RED when nothing answers, because a dead service is indistinguishable
// from an unrunnable environment. A pure function can be shown to discriminate.
// ---------------------------------------------------------------------------

/** One id's observed outcome, exactly as the live sweep collected it. */
export interface ProbeOutcome {
  id: string;
  status: number;
  body: unknown;
  text: string;
  contentType: string;
}

export interface ProbeVerdict {
  ok: boolean;
  /** ids that produced a real, non-empty assistant message. */
  answered: string[];
  /** ids that failed with a NAMED reason — honest per-model failure. */
  namedFailures: string[];
  /** ids whose outcome is neither: malformed, HTML, or an unnamed error. */
  unclassified: string[];
  total: number;
  /** present only when `ok` is false; the assertion message. */
  reason?: string;
}

/** An OpenAI-shaped assistant message, or undefined if the body carries none. */
function assistantMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const choices = (body as Json).choices;
  if (!Array.isArray(choices)) return undefined;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as Json).message;
    if (!message || typeof message !== "object") continue;
    const content = (message as Json).content;
    if (typeof content === "string" && content.trim().length > 0) return content;
  }
  return undefined;
}

/**
 * COUNTS AS A REAL ANSWER — deliberately conservative, and every clause exists
 * because a looser one is a class of lie this project forbids:
 *   - status must be exactly 200 (a 4xx/5xx is a failure even if it carries text);
 *   - the body must not be an `error` envelope (a named refusal, or an unnamed
 *     one dressed as a 200);
 *   - the response must not be an HTML page (a 200 of an error page is not an
 *     answer);
 *   - there must be a non-empty assistant message actually READ OFF THE PAGE.
 * An empty `content`, an HTML body, and a bare 500 are therefore NOT answers.
 */
export function isRealAnswer(r: ProbeOutcome): boolean {
  if (r.status !== 200) return false;
  if (errorCode(r.body) !== undefined || errorMessage(r.body) !== undefined) return false;
  if (/html/i.test(r.contentType)) return false;
  if (r.text.trimStart().startsWith("<")) return false;
  return assistantMessage(r.body) !== undefined;
}

/** A per-model outcome that is honestly NAMED is legitimate, per the operator's rule. */
function isNamedFailure(r: ProbeOutcome): boolean {
  const named = errorCode(r.body) ?? errorMessage(r.body);
  return r.status >= 400 && typeof named === "string" && named.trim().length > 0;
}

/**
 * THE VERDICT. PASS requires at least ONE real answer. A run in which every id
 * failed — with named reasons, honestly, all of them — is the advertised-but-dead
 * class and is RED. An empty id list is RED too (anti-vacuity: a probe that
 * measured nothing must never pass).
 */
export function probeVerdict(outcomes: readonly ProbeOutcome[]): ProbeVerdict {
  const total = outcomes.length;
  const answered: string[] = [];
  const namedFailures: string[] = [];
  const unclassified: string[] = [];
  for (const r of outcomes) {
    if (isRealAnswer(r)) answered.push(r.id);
    else if (isNamedFailure(r)) namedFailures.push(r.id);
    else unclassified.push(r.id);
  }

  const perId = outcomes
    .map((r) => `  ${outcomeLine(r.id, r)}`)
    .join("\n");

  if (total === 0) {
    return {
      ok: false,
      answered,
      namedFailures,
      unclassified,
      total,
      reason:
        "0 of 0 advertised ids were measured — the probe collected nothing, which must NEVER pass (anti-vacuity). An empty measurement is not a green surface.",
    };
  }

  if (answered.length === 0) {
    const classes = new Set<string>();
    for (const r of outcomes) {
      if (r.status === 0) classes.add("no-response (client abort / nothing came back at all)");
      else if (isNamedFailure(r)) classes.add(`named per-model failure (${errorCode(r.body) ?? errorMessage(r.body)})`);
      else classes.add(`unclassified (http ${r.status})`);
    }
    return {
      ok: false,
      answered,
      namedFailures,
      unclassified,
      total,
      reason:
        `0 of ${total} advertised ids answered — the surface is ADVERTISED-BUT-DEAD. ` +
        `/v1/models advertises ${total} model(s) and not one of them returned a real answer. ` +
        `Honest per-model failure is legitimate, but a run in which NOTHING worked is a total service outage ` +
        `and must be RED — this is the gate that stayed green through a 22-of-22 outage. ` +
        `Observed classes: ${[...classes].join("; ")}. Full per-id outcomes:\n${perId}`,
    };
  }

  return { ok: true, answered, namedFailures, unclassified, total };
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function getJson(
  path: string,
): Promise<{ status: number; body: unknown; contentType: string }> {
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  return {
    status: res.status,
    body: parseMaybeJson(text),
    contentType: res.headers.get("content-type") ?? "",
  };
}

async function postJson(
  path: string,
  payload: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: unknown; text: string; contentType: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: parseMaybeJson(text),
    text,
    contentType: res.headers.get("content-type") ?? "",
  };
}

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

/** A short human line describing what one id actually did. */
function outcomeLine(id: string, r: { status: number; body: unknown }): string {
  const code = errorCode(r.body);
  const msg = errorMessage(r.body);
  const parts = [`${id} -> http ${r.status}`];
  if (code) parts.push(`code=${code}`);
  if (msg) parts.push(`msg=${String(msg).slice(0, 120)}`);
  return parts.join(" ");
}

async function reachable(): Promise<boolean> {
  try {
    const res = await getJson("/health");
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * The live half is gated so this module can be IMPORTED by the hermetic
 * verdict test without registering (and then failing) live tests that need a
 * running daemon. Default is live: nothing sets this in CI or in `test:unit`.
 */
const LIVE = process.env.UI2API_PROBE_NO_LIVE !== "1";
function liveTest(name: string, fn: () => Promise<void> | void): void {
  if (LIVE) test(name, fn);
}

/** One collected probe outcome. A client abort is recorded as `status: 0`. */
async function probeId(id: string): Promise<ProbeOutcome> {
  try {
    const r = await postJson("/v1/chat/completions", {
      model: id,
      messages: [{ role: "user", content: PROBE_TEXT }],
    });
    return { id, ...r };
  } catch (err) {
    // A timeout/abort IS an outcome, not a crash: it is exactly the
    // "no response at all" row of the audit, and the verdict must see it.
    return {
      id,
      status: 0,
      body: { error: { code: "no_response", message: String((err as Error)?.message ?? err).slice(0, 200) } },
      text: "",
      contentType: "",
    };
  }
}

/**
 * The single SERIAL sweep every live assertion below reads. One sweep, not two
 * duplicated loops: a browser round trip is minutes, and re-measuring the same
 * surface twice can produce two different truths.
 */
let sweepCache: Promise<ProbeOutcome[]> | undefined;
async function sweep(): Promise<ProbeOutcome[]> {
  sweepCache ??= (async () => {
    const { body } = await getJson("/v1/models");
    const ids = modelIds(body);
    assert.ok(ids.length > 0, "advertised list is empty — vacuous pass refused");
    const probe = ids.slice(0, Math.max(1, MAX_IDS));
    const results: ProbeOutcome[] = [];
    for (const id of probe) {
      const r = await probeId(id);
      results.push(r);
      // Per-id detail is always surfaced, pass or fail.
      console.log(`[prod-chat-probe] ${outcomeLine(id, r)}`);
    }
    return results;
  })();
  return sweepCache;
}

liveTest("live chat probe: the service is reachable — an unreachable endpoint must FAIL, never pass vacuously", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
});

liveTest("live chat probe: /v1/models advertises a NON-EMPTY list of string ids", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
  const { status, body, contentType } = await getJson("/v1/models");
  assert.equal(status, 200, `/v1/models must answer 200, got ${status}`);
  assert.equal(
    typeof body,
    "object",
    `/v1/models returned a non-JSON body (HTML error page?): ${String(body).slice(0, 200)}`,
  );
  assert.ok(
    !/html/i.test(contentType),
    `/v1/models answered an HTML content-type (${contentType}) — an error page, not a model list`,
  );
  const ids = modelIds(body);
  assert.ok(
    ids.length > 0,
    "/v1/models advertised ZERO models — an empty list must fail the gate, not pass it",
  );
  const bad = ids.filter((id) => id.trim().length === 0);
  assert.equal(bad.length, 0, `advertised ids must be non-empty strings, got ${bad.length} blank`);
});

// STRICTLY SERIAL. The warm pool holds 4 slots behind a 16-waiter queue;
// firing these concurrently would manufacture pool_saturated noise instead
// of measuring the real per-id outcome.
liveTest("live chat probe: every advertised id is ACCEPTED by /v1/chat/completions (no 404 unknown_model)", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
  const results = await sweep();

  const unserved = results
    .filter((r) => r.status === 404 || errorCode(r.body) === "unknown_model")
    .map((r) => `${r.id} (http ${r.status}${errorMessage(r.body) ? `: ${errorMessage(r.body)}` : ""})`);

  assert.equal(
    unserved.length,
    0,
    `CONTRACT VIOLATION — /v1/models advertises ${unserved.length} model(s) that /v1/chat/completions will NOT serve (404 unknown_model). A consumer materialises one provider per advertised model, so each one is a dead provider. Full per-id outcomes:\n${results
      .map((r) => `  ${outcomeLine(r.id, r)}`)
      .join("\n")}\nunserved: ${unserved.join(" | ")}`,
  );
});

liveTest("live chat probe: every response is JSON, never HTML, and never a bare unhandled 500", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
  const results = await sweep();

  // A client abort (status 0) is not an HTML page and not a bare 500; it is the
  // "no response at all" row, and the zero-answers gate below is what reds on it.
  const answered = results.filter((r) => r.status > 0);
  const html = answered.filter(
    (r) => r.text.trimStart().startsWith("<") || /html/i.test(r.contentType),
  );
  assert.equal(
    html.length,
    0,
    `${html.length} response(s) were an HTML page, not the API: ${html
      .map((h) => `${h.id}: ${h.text.slice(0, 120)}`)
      .join(" | ")}`,
  );

  for (const r of answered) {
    if (r.status === 404) continue; // already named as unserved by the gate above
    assert.equal(
      typeof r.body,
      "object",
      `${r.id} answered a non-JSON body (HTML error page?): ${r.text.slice(0, 200)}`,
    );
    // A named failure is legitimate. A bare 500 with no name is not.
    if (r.status >= 500) {
      const named = errorCode(r.body) ?? errorMessage(r.body);
      assert.ok(
        typeof named === "string" && named.length > 0,
        `${r.id} answered a BARE http ${r.status} with no named reason — a consumer gets nothing to act on: ${r.text.slice(0, 200)}`,
      );
    }
    if (r.status >= 400) {
      const named = errorCode(r.body) ?? errorMessage(r.body);
      assert.ok(
        typeof named === "string" && named.length > 0,
        `${r.id} answered http ${r.status} with NO named error — the honest-failure contract requires a name (e.g. pool_queue_timeout, pool_saturated, ui2api_driver_error, refusal, restriction/login-gated): ${r.text.slice(0, 200)}`,
      );
    }
  }
});

// GOAL 156, CAUSE D. The assertion that was missing, and the one whose absence
// let a 22-of-22 outage run green: the tests above all measure a COLUMN (is the
// id accepted? is the body JSON? is the error NAMED?), and a column can be
// perfectly healthy while the SERVICE answers nothing at all.
liveTest("live chat probe: AT LEAST ONE advertised id really ANSWERS (a run where nothing answered is RED, not green)", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
  const results = await sweep();
  const verdict = probeVerdict(results);

  // Per-model truth is always printed, whatever the verdict.
  console.log(
    `[prod-chat-probe] verdict: ${verdict.ok ? "PASS" : "FAIL"} — ${verdict.answered.length}/${verdict.total} answered; ` +
      `named per-model failures: ${verdict.namedFailures.join(", ") || "none"}; unclassified: ${verdict.unclassified.join(", ") || "none"}`,
  );

  assert.ok(
    verdict.ok,
    verdict.reason ??
      `0 of ${verdict.total} advertised ids answered — the surface is advertised-but-dead, which is a RED run, not an honest per-model failure.`,
  );
});

liveTest("live chat probe: an UNKNOWN id is refused 404 unknown_model (the gate's own premise holds)", async () => {
  const up = await reachable();
  assert.ok(up, `no live service at ${BASE} — refusing to report a clean pass`);
  const { status, body } = await postJson(
    "/v1/chat/completions",
    { model: "zzz-not-served", messages: [{ role: "user", content: PROBE_TEXT }] },
    REACH_TIMEOUT_MS,
  );
  assert.equal(status, 404, `an unknown model must be 404, got ${status}`);
  assert.equal(
    errorCode(body),
    "unknown_model",
    "the gate keys on `unknown_model`; if the server renamed it, the 404 assertion above would silently stop detecting real mismatches",
  );
});
