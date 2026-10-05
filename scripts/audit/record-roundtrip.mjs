#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE ROUND-TRIP WRITE SEAM — capabilities/roundtrip.json
//
// WHAT THIS IS. The ONLY script permitted to write the round-trip record. It
// derives every machine field mechanically and POSTs to an ALREADY-DEPLOYED
// daemon over that daemon's own public wire (`POST /v1/chat/completions` or
// `POST /capability/<site>`), then reads the class back out of
// `classifyOutcome()` in src/prompt/verification-class.ts.
//
// WHY A SEPARATE SCRIPT AND NOT src/prompt/http.ts: the service under
// measurement is a READ-ONLY surface, and a thing that certifies itself is not
// certified. If http.ts could write its own receipt, a bug in http.ts would be
// able to certify itself, and the read seam in registry.ts would then trust the
// bug. The asymmetry is the point: the measurer is outside the measured.
//
// WHY IT MAY NOT FABRICATE TRAFFIC. Every request goes through the daemon's own
// endpoint, which drives the site's own UI/JS. This script never constructs a
// site-level HTTP request, never opens a browser, and never invents a field it
// did not read off a real response. A field it cannot read is recorded as
// `null`, and a row whose decisive fields are null cannot be MEASURED — the
// read seam (src/prompt/registry.ts `measuredRoundTripFor`) refuses it.
//
// THE NONCE IS THE ANTI-STALE-ECHO CORE. A warm pool reuses pages, so answer
// text left on the page by an earlier prompt reads back as this prompt's
// answer. Each measurement therefore asks for a fresh random token
// (`Reply with exactly: PONG-<32 hex>`) and requires that token to appear in
// the served text. A row whose nonce did not match is recorded as exactly that,
// and can never be class ANSWERS.
//
// USAGE
//   node scripts/audit/record-roundtrip.mjs --site kimi [--capability chat]
//   node scripts/audit/record-roundtrip.mjs --site youtube --capability youtube_search --args '{"query":"…"}'
//   node scripts/audit/record-roundtrip.mjs --site kimi --dry-run    # print, write nothing
//
// EXIT CODES
//   0  a MEASURED row was written (or, with --dry-run, would be)
//   2  nothing was written — see the NAMED reason on stderr
//   3  a malformed invocation
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = process.env.UI2API_BASE_URL || "http://127.0.0.1:9797";
const RECORD_REL = "capabilities/roundtrip.json";
const REQUEST_TIMEOUT_MS = Number(process.env.UI2API_REQUEST_TIMEOUT_MS || 180_000);

// ── the classifier, imported from the module that OWNS the rule ─────────────
// A harness that classified its own results would be the hand-typing defect in
// a new place, so this imports the shipped rule rather than re-deriving it. When
// run against a BUILT tree it reads dist/; against src it reads the TS through
// whatever loader the caller used. Both are the same rule.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
async function loadClassifier() {
  // REPO is already the repository ROOT (HERE is scripts/audit), so these are
  // joined against REPO directly. An earlier version resolved them against
  // `REPO/scripts/audit` as well, which produced `scripts/src/prompt/...` — a
  // path that does not exist, so the classifier NEVER loaded and the harness
  // refused for a reason that had nothing to do with the daemon. A gate that
  // cannot tell "the service is down" from "I built the path wrong" is a gate
  // that reports the wrong thing, so both shapes are tried.
  for (const cand of ["src/prompt/verification-class.ts", "dist/prompt/verification-class.js"]) {
    try {
      const mod = await import(resolve(REPO, cand));
      if (typeof mod.classifyOutcome === "function") return mod;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const site = flag("site");
const capability = flag("capability") || "chat";
const base = flag("base") || DEFAULT_BASE;
const dryRun = has("dry-run");
const argsJson = flag("args");

if (has("help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 30).join("\n"));
  process.exit(0);
}

if (!site || !/^[a-z0-9-]+$/.test(site)) {
  console.error("record-roundtrip: refusing to run — no valid --site <id> was given (this script never guesses a site)");
  process.exit(3);
}

const classifier = await loadClassifier();
if (!classifier || typeof classifier.classifyOutcome !== "function") {
  console.error(
    "record-roundtrip: refusing to write — could not load classifyOutcome() from src/prompt/verification-class.ts " +
      "(or dist/). A row's class may never be typed by this script, so without the shipped rule it writes nothing.",
  );
  process.exit(2);
}

function repoRecordPath() {
  return resolve(REPO, RECORD_REL);
}

// ── the daemon must actually be there, or nothing is written ─────────────────
async function readStatus(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${url}/status`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`GET ${url}/status answered HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let status;
try {
  status = await readStatus(base);
} catch (e) {
  console.error(
    `record-roundtrip: refusing to write — no deployed daemon reachable at ${base} (${e.message}). ` +
      `This script measures a RUNNING service over its own wire; with no daemon there is nothing to measure, and ` +
      `writing a row anyway would be fabricating a round trip. Start it with \`npx tsx src/cli.ts promptd\` and re-run.`,
  );
  process.exit(2);
}

// ── the probe: a fresh nonce per measurement ────────────────────────────────
const nonce = randomBytes(16).toString("hex");
const probePrompt = `Reply with exactly: PONG-${nonce}`;

const isChat = capability === "chat";
const url = isChat ? `${base}/v1/chat/completions` : `${base}/capability/${site}`;
const body = isChat
  ? { model: site, prompt: probePrompt, stream: false }
  : { capability, args: argsJson ? JSON.parse(argsJson) : {} };

const startedAt = Date.now();
let httpStatus = 0;
let payload = null;
let transportError = null;
{
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    httpStatus = res.status;
    payload = await res.json().catch(() => null);
  } catch (e) {
    transportError = e.message;
  } finally {
    clearTimeout(t);
  }
}
const elapsedMs = Date.now() - startedAt;

// ── derive every field from what the service actually said ───────────────────
// NOTHING here is typed. A value the response did not carry becomes `null`,
// which is what makes the row non-MEASURED rather than quietly plausible.
const answerText =
  (payload && typeof payload.answer === "string" && payload.answer) ||
  (payload && typeof payload.text === "string" && payload.text) ||
  (payload && typeof payload.message === "string" && payload.message) ||
  "";
const message = transportError ?? (payload && typeof payload.message === "string" ? payload.message : "") ?? "";
const poolAtRequest = status && status.pool && typeof status.pool === "object" ? status.pool : null;
const idle = poolAtRequest ? Number(poolAtRequest.busy) === 0 && Number(poolAtRequest.queued) === 0 : false;

// THE DECISIVE FIELD. For a chat surface this is the nonce; a capability surface
// returns a JSON result, not a chat answer, so a nonce proves nothing there and
// the row records that honestly rather than borrowing the chat rule.
const probeNonceMatched = isChat
  ? answerText.includes(`PONG-${nonce}`)
  : null;

const classification = classifier.classifyOutcome({
  httpStatus,
  message,
  answerText: probeNonceMatched === true ? answerText : "",
  noResponse: transportError !== null,
  poolAtRequest: poolAtRequest ? { busy: poolAtRequest.busy, total: poolAtRequest.total, queued: poolAtRequest.queued } : undefined,
  page: status && typeof status.page === "object" ? status.page : undefined,
});

const { createHash } = await import("node:crypto");
const answerSha256_16 = createHash("sha256").update(answerText).digest("hex").slice(0, 16);

const row = {
  site,
  capability,
  class: classification.cls,
  provenance: "harness",
  method: `${isChat ? "POST /v1/chat/completions" : `POST /capability/${site}`} (nonce probe, pool sampled from GET /status before the request)`,
  measuredAt: new Date().toISOString(),
  httpStatus,
  answerChars: [...answerText].length,
  answerSha256_16,
  probeNonceMatched,
  doneReason: isChat ? (probeNonceMatched === true ? "stable" : null) : null,
  elapsedMs,
  observedPage: null,
  poolAtRequest: poolAtRequest ? { busy: poolAtRequest.busy, total: poolAtRequest.total, queued: poolAtRequest.queued } : null,
  daemonCommit: typeof status.commit === "string" ? status.commit : null,
  evidence: `class derived by classifyOutcome(): ${classification.reason}`,
  prereq: idle ? "none beyond a live vault session for the site" : "NOT IDLE — the pool was busy/queued when the request started, so this row measures the queue, not the site",
  notes:
    capability !== "chat"
      ? `capability surface: this row is machine-checkable in SHAPE only (HTTP status + result shape), not in answer content — a capability returns JSON, so no nonce proves anything. ${probeNonceMatched === null ? "probeNonceMatched is null for exactly that reason." : ""}`
      : undefined,
};

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, wroteNothing: true, row }, null, 2));
  process.exit(row.probeNonceMatched === true && row.class === "ANSWERS" ? 0 : 2);
}

if (row.probeNonceMatched === true && row.class !== "ANSWERS") {
  console.error(
    `record-roundtrip: refusing to write — the nonce matched but classifyOutcome() derived ${row.class}, not ANSWERS ` +
      `(${classification.reason}). Writing a row whose own fields contradict its own class is the defect this script exists to prevent.`,
  );
  process.exit(2);
}

// ── atomic write ────────────────────────────────────────────────────────────
const path = repoRecordPath();
let record;
try {
  record = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`record-roundtrip: refusing to write — cannot read the existing ${RECORD_REL} (${e.message})`);
  process.exit(2);
}
if (record.schema !== "ui2api/roundtrip/1") {
  console.error(`record-roundtrip: refusing to write — ${RECORD_REL} declares schema ${JSON.stringify(record.schema)}`);
  process.exit(2);
}
// Replace this site+capability, never append a duplicate.
record.rows = (record.rows || []).filter((r) => !(r.site === site && r.capability === capability));
record.rows.push(row);
record.generatedAt = new Date().toISOString();

const tmp = `${path}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o644 });
renameSync(tmp, path); // atomic on the same filesystem: never a half-written record
console.error(`record-roundtrip: wrote ${RECORD_REL} :: ${site}/${capability} class=${row.class} nonce=${row.probeNonceMatched}`);
process.exit(0);