#!/usr/bin/env node
// READ-ONLY measurement of the advertised /v1/models set against the DEPLOYED
// service. One real request per model, at most one retry, real timeout.
// READ-ONLY on the vault: this only POSTs a chat request and GETs /status.
// Never fabricates: a timeout is recorded AS a timeout.
//
// Usage: node scripts/audit/measure-models.mjs <model> [<model> ...]
// Env: MEASURE_MODELS_BASE (default http://127.0.0.1:9797), REQ_TIMEOUT_MS (default 150000).
// Script-local names, NOT the UI2API_ runtime namespace: no row exists (or
// should exist) in the AGENTS.md knob table for them, and
// test/ci-contract-knob-cites.test.ts fails a UI2API_* name read in scripts/
// that has no row.

const BASE = process.env.MEASURE_MODELS_BASE || "http://127.0.0.1:9797";
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 150000);

async function poolState() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(`${BASE}/status`, { signal: c.signal });
    clearTimeout(t);
    const p = (await r.json()).pool || {};
    return { busy: p.busy, total: p.total, queued: p.queued, perSite: p.perSite };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

function classify(status, body) {
  if (status === 404) return "NOT SERVED";
  if (status >= 500) return "ERROR";
  const text = JSON.stringify(body || {});
  if (/requires sign-in|sign in|not logged|login|unauthenticated|no stored account|log in/i.test(text))
    return "SIGN-OUT";
  if (/no answer appeared|timeout|timed out|ETIMEDOUT|slow timeout|pool_queue_timeout|pool_saturated/i.test(text))
    return "TIMEOUT";
  if (status >= 400) return "ERROR";
  return "ANSWERS";
}

async function probe(model) {
  const started = Date.now();
  const before = await poolState();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  let rec = { model, attempt: 1, ok: false, status: 0, ms: 0, message: "", cls: "ERROR", poolBefore: before };
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: PONG" }] }),
      signal: ac.signal,
    });
    const text = await r.text();
    rec.status = r.status;
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON body is itself evidence */ }
    const content =
      body?.choices?.[0]?.message?.content ??
      body?.error?.message ??
      (text || "").slice(0, 300);
    rec.message = String(content).replace(/\s+/g, " ").trim().slice(0, 300);
    rec.cls = body?.choices?.[0]?.message?.content
      ? "ANSWERS"
      : classify(r.status, body ?? text);
    rec.ok = true;
  } catch (e) {
    const msg = String((e && e.message) || e);
    rec.cls = /abort/i.test(msg) ? "TIMEOUT" : "ERROR";
    rec.message = /abort/i.test(msg) ? `no response within ${REQ_TIMEOUT_MS}ms (client abort)` : msg.slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
  rec.ms = Date.now() - started;
  rec.poolAfter = await poolState();
  return rec;
}

const models = process.argv.slice(2);
if (!models.length) {
  console.error("usage: measure-models.mjs <model> [...]");
  process.exit(2);
}
const out = [];
for (const m of models) {
  let rec = await probe(m);
  // AT MOST ONE retry, and only for a non-ANSWERS result.
  if (rec.cls !== "ANSWERS") {
    const again = await probe(m);
    again.attempt = 2;
    again.retriedFrom = rec.cls + ": " + rec.message;
    rec = again;
  }
  out.push(rec);
  console.error(
    `[${rec.cls}] ${rec.model} attempt=${rec.attempt} http=${rec.status} ${rec.ms}ms ` +
    `pool ${rec.poolBefore.busy}/${rec.poolBefore.total}->${rec.poolAfter.busy}/${rec.poolAfter.total} :: ${rec.message}`
  );
}
console.log(JSON.stringify({ base: BASE, reqTimeoutMs: REQ_TIMEOUT_MS, results: out }, null, 2));
