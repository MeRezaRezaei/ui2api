#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// THE ROUND-TRIP WRITE SEAM — capabilities/roundtrip.json
//
// WHAT THIS IS. The ONLY script permitted to write the round-trip record. It
// derives every machine field mechanically and POSTs to an ALREADY-DEPLOYED
// daemon over that daemon's own public wire, then reads the class back out of
// `classifyOutcome()` in src/prompt/verification-class.ts.
//
// WHY A SEPARATE SCRIPT AND NOT src/prompt/http.ts: the service under
// measurement is a READ-ONLY surface, and a thing that certifies itself is not
// certified. If http.ts could write its own receipt, a bug in http.ts would be
// able to certify itself, and the read seam in registry.ts would then trust the
// bug. The asymmetry is the point: the measurer is outside the measured.
//
// ── THE WIRE, AND WHY IT IS THIS ONE ────────────────────────────────────────
//
// THE BUG THIS FILE USED TO CARRY. It POSTed
//   /v1/chat/completions  {model: <site>, prompt, stream:false}
// which is NOT a shape that endpoint accepts. MEASURED against the live daemon
// on 127.0.0.1:9797, that request answers
//   HTTP 400 {"error":{"message":"messages must contain at least one non-empty
//                      text part","param":"messages"}}
// in ~11ms — no browser, no site, nothing. The 400 was the HARNESS's own
// malformed request, and the row it produced read
// `class: UNCLASSIFIED, answerChars: 0, probeNonceMatched: false`, which a
// reader cannot distinguish from "gemini did not answer". It DID answer:
//   POST /prompt {site:"gemini", prompt:"Reply with exactly: PONG-<nonce>"}
//   → 200 {ok:true, answer:"Gemini said\n\nPONG-<nonce>", doneReason:"stable",
//          url:"https://gemini.google.com/app/…", title:"…"}
//
// That is the worst failure this file could have: a measurement tool that
// manufactures a false negative about a site that works. So the request shape
// is now DERIVED FROM THE DAEMON'S OWN ROUTES rather than guessed, and both
// working shapes are supported and both are proven:
//
//   --wire prompt (DEFAULT)  POST /prompt              {site, prompt}
//   --wire v1                POST /v1/chat/completions {model, messages:[…]}
//
// `/prompt` is the default because it is the daemon's own primitive and it is
// the ONLY surface that returns the driver's native observation verbatim:
// `doneReason`, `url` and `title` at the TOP level. `/v1` buries the same three
// under `ui2api`, and it also routes the answer through `stripToolCall`, a
// TRANSFORM of the answer text — which for a probe whose entire evidence is a
// literal nonce is a place where a match could be lost to the surface rather
// than to the site. `/v1` stays selectable because it is the CONSUMER-facing
// surface and a record of it is worth having; `--wire v1` reads its
// `ui2api.doneReason/url/title` so the row is still derived, not assumed.
//
// ── WHY A CLIENT-SIDE REJECTION IS NOT A ROUND-TRIP OUTCOME ─────────────────
//
// The defect above was not only a wrong field name. It was a CATEGORY error: a
// refusal that arrived before the daemon ever touched a browser was filed as
// though the SITE had been asked and had failed. Those are different claims
// about different things, and only one of them is a round trip.
//
// MEASURED, every 4xx this daemon emits is a refusal of the REQUEST, decided
// before any browser work:
//   400 unknown_site         (src/prompt/http.ts:1244 — idFrom threw)
//   400 prompt is required   (http.ts:1606 — the body had no usable prompt)
//   400 capability required  (http.ts:1663)
//   401 unauthorized         (http.ts:1219 — the bearer gate)
//   404 site_not_dispatched  (http.ts:1652 — no dispatch table row)
//   404 unknown endpoint     (http.ts:1728 / the /v1 handler)
// and the harness can provoke every one of them on demand (see USAGE). The
// converse also holds and is the reason the line is drawn at 4xx and not at 499:
// a site or runner failure comes back 200 (with ok:false / doneReason) or 502
// (`/capability` sends `result.ok ? 200 : 502`) or 500 (a runner threw), never as
// a 4xx. So:
//
//   4xx  ⇒ HARNESS REQUEST REJECTED. Write NOTHING. Name the daemon's own code.
//   5xx  ⇒ a genuine outcome. Measure it and record its true class.
//   0 / throw ⇒ TRANSPORT REFUSED. Write NOTHING.
//
// A 4xx that produced a row would be an UNCLASSIFIED row indistinguishable from
// a site verdict — the registry lane's "a gate which cannot fire is the defect
// this whole round exists to kill", in its most expensive form.
//
// ── AND WHY AN UNCLASSIFIED CLASS IS ALSO NEVER WRITTEN ─────────────────────
//
// UNCLASSIFIED is not a class: it is the classifier's refusal to file a measured
// response under any member of the vocabulary, and it is deliberately absent
// from VERIFICATION_CLASSES. A row carrying it could not be re-derived into the
// vocabulary by any reader (test/round-trip-record-truth.test.ts asserts every
// row's class is IN that vocabulary). So an UNCLASSIFIED derivation writes
// nothing and exits 2 with the classifier's own reason quoted — the finding is
// reported to the operator instead of being laundered into a row that reads
// like a verdict about a site.
//
// ── MAY NOT FABRICATE TRAFFIC ───────────────────────────────────────────────
// Every request goes through the daemon's own endpoint, which drives the site's
// own UI/JS. This script never constructs a site-level HTTP request, never opens
// a browser, and never invents a field it did not read off a real response. A
// field it cannot read is recorded as `null`, and a row whose decisive fields
// are null cannot be MEASURED — the read seam (src/prompt/registry.ts
// `measuredRoundTripFor`) refuses it.
//
// ── THE NONCE IS THE ANTI-STALE-ECHO CORE ───────────────────────────────────
// A warm pool reuses pages, so answer text left on the page by an earlier
// prompt reads back as this prompt's answer. Each measurement therefore asks
// for a fresh random token (`Reply with exactly: PONG-<32 hex>`) and requires
// that token to appear in the served text. A row whose nonce did not match is
// recorded as exactly that, and can never be class ANSWERS.
//
// ── WHAT IS SAFE TO PUBLISH ─────────────────────────────────────────────────
// capabilities/roundtrip.json ships in the sanitized public mirror, so this file
// never writes prompt text, answer text, an account, a cookie or a vault path —
// only lengths, truncated digests, and the daemon's own page state. The ONE
// piece of site prose a row carries is `observedPage.title`, and it is safe by
// construction rather than by luck: the ONLY text this harness ever asks a site
// to see is the constant nonce probe above, so a site-reported title can echo
// the probe and nothing else. Dropping the title would also make WALL-CHALLENGE
// ("Just a moment…") and SIGN-OUT ("Sign in – Google Accounts") undetectable,
// which is the measurement this record exists to make. The test pins the nonce
// out of every prose field.
//
// USAGE
//   node --import tsx scripts/audit/record-roundtrip.mjs --site kimi
//   node --import tsx scripts/audit/record-roundtrip.mjs --site youtube \
//        --capability youtube_search --args '{"query":"…"}'
//   node --import tsx scripts/audit/record-roundtrip.mjs --site kimi --dry-run
//   node --import tsx scripts/audit/record-roundtrip.mjs --site kimi --wire v1
//
//   `--import tsx` is REQUIRED (there is no dist/ in a source checkout —
//   MEASURED: `ls dist/prompt/verification-class.js` → no such file). Without
//   it this script cannot import the TypeScript classifier and refuses with a
//   reason that says exactly that, rather than the old message that blamed the
//   path resolution.
//
// EXIT CODES
// 0  a MEASURED row was written (class=ANSWERS with a matched nonce, or
//      class=RETURNS-DATA with ok=true and >=1 counted row)
//  5  a row was written recording the site's TRUE non-answer class — a correct
//      measurement of a site that failed, gated or challenged, NOT a pass
//   2  nothing was written — see the NAMED reason on stderr
//   3  a malformed invocation
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = process.env.UI2API_BASE_URL || "http://127.0.0.1:9797";
const RECORD_REL = "capabilities/roundtrip.json";
const REQUEST_TIMEOUT_MS = Number(process.env.UI2API_REQUEST_TIMEOUT_MS || 180_000);

// ── the classifier, imported from the module that OWNS the rule ─────────────
// A harness that classified its own results would be the hand-typing defect in
// a new place, so this imports the shipped rule rather than re-deriving it.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
async function loadClassifier() {
  // REPO is already the repository ROOT (HERE is scripts/audit), so these are
  // joined against REPO directly. An earlier version resolved them against
  // `REPO/scripts/audit` as well, which produced `scripts/src/prompt/...` — a
  // path that does not exist, so the classifier NEVER loaded.
  const tried = [];
  for (const cand of ["src/prompt/verification-class.ts", "dist/prompt/verification-class.js"]) {
    const abs = resolve(REPO, cand);
    try {
      const mod = await import(abs);
      if (typeof mod.classifyOutcome === "function") return { mod, via: cand };
    } catch (e) {
      tried.push(`${cand}: ${(e && e.message) || String(e)}`);
    }
  }
  return { mod: null, via: null, tried };
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
const wire = flag("wire") || "prompt";
const argsJson = flag("args");

if (has("help")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 48).join("\n"));
  process.exit(0);
}

if (!site || !/^[a-z0-9-]+$/.test(site)) {
  console.error("record-roundtrip: refusing to run — no valid --site <id> was given (this script never guesses a site)");
  process.exit(3);
}

if (wire !== "prompt" && wire !== "v1") {
  console.error(
    `record-roundtrip: refusing to run — --wire must be "prompt" (POST /prompt {site,prompt}) or ` +
      `"v1" (POST /v1/chat/completions {model,messages}). Got ${JSON.stringify(wire)}. ` +
      `Neither shape is guessed: both are read off the daemon's own routes.`,
  );
  process.exit(3);
}

let parsedArgs = {};
if (argsJson !== undefined) {
  try {
    parsedArgs = JSON.parse(argsJson);
  } catch (e) {
    console.error(`record-roundtrip: refusing to run — --args is not valid JSON (${e.message})`);
    process.exit(3);
  }
  if (parsedArgs === null || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
    console.error("record-roundtrip: refusing to run — --args must be a JSON OBJECT, the shape the daemon reads at body.args");
    process.exit(3);
  }
}

const { mod: classifier, via: classifierVia, tried: classifierTried } = await loadClassifier();
if (!classifier) {
  // NAMED, and it names the actual fix. The old text ("could not load
  // classifyOutcome()") described a symptom the reader cannot act on and read
  // like a broken repo; the measured cause is that a source checkout has no
  // dist/ and this file is TypeScript, so it needs the tsx loader.
  console.error(
    "record-roundtrip: refusing to write — could not import classifyOutcome() from " +
      `src/prompt/verification-class.ts (or dist/). A row's class may never be typed by this script, so without the shipped rule it writes nothing.\n` +
      `  tried: ${classifierTried.join(" | ")}\n` +
      `  MEASURED cause: this repository has no dist/ in a source checkout, so the only candidate is TypeScript and it needs the tsx loader.\n` +
      `  FIX: run it as \`node --import tsx scripts/audit/record-roundtrip.mjs --site <id>\` (or build first with \`npm run build\`).`,
  );
  process.exit(2);
}

function repoRecordPath() {
  return resolve(REPO, RECORD_REL);
}

// ── the daemon must actually be there, or nothing is measured ───────────────
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
const url = isChat
  ? wire === "v1"
    ? `${base}/v1/chat/completions`
    : `${base}/prompt`
  : `${base}/capability/${site}`;

// THE REQUEST SHAPE, READ OFF THE DAEMON'S OWN ROUTE.
//   /prompt              http.ts:1603  reads body.prompt and body.site
//   /v1/chat/completions openai.ts:989 reads body.messages (NOT body.prompt)
// The old shape sent `prompt` to the /v1 route, which is why it 400'd.
const body = isChat
  ? wire === "v1"
    ? { model: site, messages: [{ role: "user", content: probePrompt }], stream: false }
    : { site, prompt: probePrompt }
  : { capability, args: parsedArgs };

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

// ── the daemon's OWN message, in every shape it emits ───────────────────────
// MEASURED, the refusal vocabulary is not one shape: `/prompt` and `/capability`
// answer {error:"…"} (a bare string), {error:{code,message}} (an object), a bare
// {reason_code}, or {reason:"…"}, and the /v1 handler answers
// {error:{message,type,code,param}}. The old code read only `payload.message`,
// so on a 400 it fed the classifier an EMPTY string — MEASURED in the pre-fix
// row: `evidence: "…HTTP 400 matched no named condition; message: "`. Every
// message-keyed class (SIGN-OUT, NO_COMPOSER, the named no-answer refusal) was
// therefore unreachable from this harness for the same reason the page was:
// the thing the classifier needs was never actually read off the response.
function daemonMessage(p) {
  if (!p || typeof p !== "object") return "";
  const parts = [];
  const err = p.error;
  if (typeof err === "string" && err.trim()) parts.push(err.trim());
  else if (err && typeof err === "object") {
    if (typeof err.message === "string" && err.message.trim()) parts.push(err.message.trim());
    if (typeof err.code === "string" && err.code.trim()) parts.push(`code=${err.code.trim()}`);
  }
  if (typeof p.reason === "string" && p.reason.trim()) parts.push(p.reason.trim());
  if (typeof p.message === "string" && p.message.trim()) parts.push(p.message.trim());
  if (typeof p.reason_code === "string" && p.reason_code.trim()) parts.push(`reason_code=${p.reason_code.trim()}`);
  return parts.join(" — ");
}

/** The daemon's own NAMED code, so a refusal is reported in the vocabulary the
 *  daemon speaks rather than in this script's prose. */
function daemonCode(p) {
  if (!p || typeof p !== "object") return null;
  const err = p.error;
  if (err && typeof err === "object" && typeof err.code === "string" && err.code.trim()) return err.code.trim();
  if (typeof p.reason_code === "string" && p.reason_code.trim()) return p.reason_code.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return null;
}

// ── HARNESS-LEVEL TRIAGE, BEFORE ANY SITE CLASSIFICATION ────────────────────
// The three outcomes this file distinguishes, in the order they are decided.
// Only the third is a round trip.
const TRIAGE = {
  TRANSPORT_REFUSED: "transport-refused",
  REQUEST_REJECTED: "harness-request-rejected",
  SERVICE_FAULTED: "service-faulted",
  MEASURED: "measured",
};

let triage = TRIAGE.MEASURED;
let triageReason = "";

// The codes the daemon emits when ITS OWN last-resort net caught a throw
// (src/prompt/http.ts:1839 `internal_error`, and the runner catch's
// `runner_error` at :1700). Both are redaction placeholders — the real message
// is deliberately withheld from the client — so a client cannot tell a site
// that failed to answer from the daemon crashing while asking.
//
// MEASURED on the live daemon: deepseek and kimi each answer
// `HTTP 500 {code:"internal_error", message:"internal error"}` after ~60s, at an
// IDLE pool, reproducibly, and identically when the request is issued by hand
// with curl straight at POST /prompt — so it is not this harness. That is a
// real fault, but it is a fault in the thing being MEASURED, not a verdict
// about the SITE: recording it as one would repeat, one layer up, the exact
// defect the pre-fix harness had (a condition that arrived looking like a site
// outcome and was filed as one). It is reported, and nothing is written.
const DAEMON_FAULT_CODES = new Set(["internal_error", "runner_error"]);

if (transportError !== null) {
  triage = TRIAGE.TRANSPORT_REFUSED;
  triageReason = `the request to ${url} never produced an HTTP response (${transportError}) — the daemon was not reached, so no site was asked anything`;
} else if (httpStatus >= 400 && httpStatus < 500) {
  triage = TRIAGE.REQUEST_REJECTED;
  const code = daemonCode(payload);
  triageReason =
    `HTTP ${httpStatus} from ${url} after ${elapsedMs}ms, decided by the daemon BEFORE any browser work ` +
    `(daemon code: ${code || "<none>"}; daemon message: ${daemonMessage(payload) || "<empty>"}). ` +
    `This is the harness's own request being refused, so it is NOT a round trip and it is NOT a verdict about ${site}. ` +
    `A 4xx here is one of: unknown_site, prompt/capability required, unauthorized, site_not_dispatched, unknown endpoint.`;
} else if (DAEMON_FAULT_CODES.has(daemonCode(payload) ?? "")) {
  triage = TRIAGE.SERVICE_FAULTED;
  triageReason =
    `HTTP ${httpStatus} from ${url} after ${elapsedMs}ms carrying the daemon's own fault code ` +
    `\`${daemonCode(payload)}\` (a redaction placeholder — the real message is withheld from clients by ` +
    `design). This is a fault in the daemon under measurement, NOT a verdict about ${site}: the daemon threw, so it is ` +
    `unknown whether the site was reached at all. Recording it against the site would repeat the pre-fix defect one layer ` +
    `up. Re-measure with UI2API_DEBUG=1 on the daemon to get the internal cause.`;
}

// A non-measured triage writes NOTHING. This is the whole point: the pre-fix
// harness turned its own HTTP 400 into a row reading
// `class: UNCLASSIFIED, probeNonceMatched: false`, which no reader could tell
// from a site that was asked and did not answer.
if (triage !== TRIAGE.MEASURED) {
  console.error(`record-roundtrip: refusing to write — ${triageReason}`);
  console.error(
    JSON.stringify(
      {
        wroteNothing: true,
        triage,
        triageReason,
        site,
        capability,
        wire,
        httpStatus,
        elapsedMs,
        daemonCode: daemonCode(payload),
        daemonMessage: daemonMessage(payload),
        url,
        requestShape: wire === "v1" ? "{model, messages:[{role,content}], stream:false}" : isChat ? "{site, prompt}" : "{capability, args}",
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

// ── derive every field from what the service actually said ───────────────────
// NOTHING here is typed. A value the response did not carry becomes `null`,
// which is what makes the row non-MEASURED rather than quietly plausible.

// The answer text, per surface. /prompt answers {ok, answer, doneReason, url,
// title}; /v1 answers an OpenAI envelope with the same three under `ui2api`.
const ui2api = payload && typeof payload.ui2api === "object" && payload.ui2api !== null ? payload.ui2api : null;
const answerText = (() => {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.answer === "string" && payload.answer) return payload.answer;
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice && choice.message && typeof choice.message.content === "string" ? choice.message.content : null;
  if (content) return content;
  if (typeof payload.text === "string" && payload.text) return payload.text;
  return "";
})();

const message = transportError ?? daemonMessage(payload);

const poolAtRequest = status && status.pool && typeof status.pool === "object" ? status.pool : null;
const idle = poolAtRequest ? Number(poolAtRequest.busy) === 0 && Number(poolAtRequest.queued) === 0 : false;

// observedPage — the page the DAEMON reported after it drove the site. This
// was `null` on every row and `page: status.page` into the classifier was
// `undefined`, because MEASURED `GET /status` carries no `page` key at all
// (its top-level keys are bootWarm, liveness, ok, pool, posture). Both of
// those made WALL-CHALLENGE, SIGN-OUT and COMPOSER-DRIFT UNREACHABLE from this
// harness — three of the nine classes, including the one this project's own
// doctrine says is the only unrecoverable failure. It is read off the response
// now, which is where the daemon actually reports it.
const rawTitle = (typeof payload?.title === "string" && payload.title) || (typeof ui2api?.title === "string" && ui2api.title) || "";
const rawUrl = (typeof payload?.url === "string" && payload.url) || (typeof ui2api?.url === "string" && ui2api.url) || "";
const observedPage = rawTitle.trim() && rawUrl.trim() ? { title: rawTitle, url: rawUrl } : null;

// doneReason — READ, never synthesised. The old code wrote the literal
// "stable" whenever the nonce matched, which is a machine field this harness
// invented rather than one the daemon reported; a driver that returned
// `timeout` with a stale-looking answer would have been recorded as `stable`.
const rawDoneReason =
  (typeof payload?.doneReason === "string" && payload.doneReason) ||
  (typeof ui2api?.doneReason === "string" && ui2api.doneReason) ||
  null;

// THE DECISIVE FIELD. For a chat surface this is the nonce; a capability surface
// returns a JSON result, not a chat answer, so a nonce proves nothing there and
// the row records that honestly rather than borrowing the chat rule.
const probeNonceMatched = isChat ? answerText.includes(`PONG-${nonce}`) : null;

// The SHAPE of a capability result — never its content. Sorted top-level key
// names, the dotted path of the collection the rows were counted in, the
// runner's OWN declared count and the number of records actually counted in
// that collection. Together they make a capability row reviewable without
// publishing a single row of the site's data.
//
// THE COUNT IS FOUND, NOT GUESSED. The runner declares its own result size in
// `count` / `total` next to the collection it produced (`data.count` beside
// `data.results`), so the declared half is read off a named field of the
// response rather than inferred, and the rows half is a real count of the
// collection that sits beside it. `classifyOutcome` requires the two to AGREE
// before RETURNS-DATA is derivable, so neither half alone can buy the class.
//
// MEASURED, why the old shape was not enough: it took the first top-level array
// only. `araprat_search` answers `{capability, ok, method, latencyMs, data:
// {query, count, results:[…]}, note, wireNote}` — there is NO top-level array at
// all, so `firstArrayKey` was null and `firstArrayLength` null on the one
// capability surface this repo has a live receipt for. The shape was
// structurally incapable of describing a real result.
const ROW_COUNT_KEYS = ["count", "total", "totalCount", "resultCount"];
const MAX_SHAPE_DEPTH = 3;
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
/** Depth-first walk (bounded) yielding [dottedPath, value] for plain objects. */
function walkObjects(root, prefix = "", depth = 0) {
  if (depth > MAX_SHAPE_DEPTH || !isPlainObject(root)) return [];
  const out = [];
  for (const [k, v] of Object.entries(root)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push([p, v], ...walkObjects(v, p, depth + 1));
  }
  return out;
}
/** The collection beside the runner's declared count, preferring one of records. */
function collectionBeside(node) {
  const arrays = Object.entries(node).filter(([, v]) => Array.isArray(v));
  if (arrays.length === 0) return null;
  return arrays.find(([, v]) => v.some((x) => isPlainObject(x))) ?? arrays[0];
}
function declaredCountIn(node) {
  for (const k of ROW_COUNT_KEYS) {
    const v = node[k];
    if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return { key: k, value: v };
  }
  return null;
}
const isPopulatedRecord = (v) =>
  isPlainObject(v) &&
  Object.keys(v).length > 0 &&
  Object.values(v).filter((x) => x !== null && x !== undefined && x !== "" && !(Array.isArray(x) && x.length === 0)).length > 0;
const nonEmptyValueCount = (v) =>
  Object.values(v).filter((x) => x !== null && x !== undefined && x !== "" && !(Array.isArray(x) && x.length === 0)).length;
const resultShape = (() => {
  if (isChat || !isPlainObject(payload)) return null;
  const topLevelKeys = Object.keys(payload).sort();
  // `declaredZeroCount` is the EMPTY-RESULT ANCHOR and it is recorded
  // INDEPENDENTLY of the collection search: a runner that declares a count of
  // zero anywhere has answered "my result is empty", and the classifier's
  // single-record arm is gated on this flag so no populated sibling key can
  // talk its way past that answer.
  const declaredZeroCount = walkObjects(payload).some(([, node]) => {
    const d = declaredCountIn(node);
    return d !== null && d.value === 0;
  });
  const shape = { topLevelKeys, rowsPath: null, count: null, rows: null, recordPath: null, recordKeys: null, nonEmptyValues: null, declaredZeroCount };
  // ARM 1: the runner's declared count is the anchor — find it, then take the
  // collection that sits beside it. That is the runner's own account of its own
  // result, and it is a named field of the response rather than an inference.
  for (const [path, node] of walkObjects(payload)) {
    const declared = declaredCountIn(node);
    if (!declared) continue;
    const coll = collectionBeside(node);
    if (!coll) continue;
    shape.rowsPath = path ? `${path}.${coll[0]}` : coll[0];
    shape.count = declared.value;
    shape.rows = coll[1].length;
    return shape;
  }
  // No declared count anywhere: fall back to the first collection of records,
  // but leave `count` null rather than inventing one. A row whose declared half
  // is missing cannot derive RETURNS-DATA's list arm (the two must agree), so an
  // undeclared runner is reported as a finding instead of being passed off as a
  // counted result — and the walk CONTINUES to the record arm below rather than
  // returning, because a result can carry BOTH an undeclared secondary
  // collection and a populated primary record.
  //
  // MEASURED, and this is why it continues: `araprat_video_detail` answers
  // `data:{id, url, title, description, related:[…11 records…], relatedCount:11}`.
  // The first collection of records is `related`, whose sibling count is named
  // `relatedCount` — a count of a SECONDARY collection, not of the result — so
  // arm 1 is correctly unreachable and an early return left `recordPath` null,
  // which derived UNCLASSIFIED for a real, populated, live video record.
  if (shape.rowsPath === null) {
    for (const [path, node] of walkObjects(payload)) {
      const coll = collectionBeside(node);
      if (coll && coll[1].some((x) => isPlainObject(x))) {
        shape.rowsPath = path ? `${path}.${coll[0]}` : coll[0];
        shape.rows = coll[1].length;
        break;
      }
    }
  }
  if (shape.rowsPath === null) {
    for (const [k, v] of Object.entries(payload)) {
      if (Array.isArray(v)) {
        shape.rowsPath = k;
        shape.rows = v.length;
        break;
      }
    }
  }
  // ARM 2 material, computed INDEPENDENTLY of the collection search above: the
  // single POPULATED RECORD a detail-shaped result returns. Every runner in this
  // repo nests its result under `data`, so that key is taken first, then any
  // other populated object one level down.
  // The root payload's OWN keys are candidates too, not just the objects the
  // walk descends into. MEASURED: `araprat_video_detail`'s record IS
  // `payload.data` — a sibling of nothing above it, so a walk that only looked
  // for records NESTED inside a walked object never saw it and left
  // `recordPath` null.
  const candidateHosts = [["", payload], ...walkObjects(payload)];
  for (const [path, node] of candidateHosts) {
    const candidates = Object.entries(node)
      .filter(([k]) => k === "data" || !shape.rowsPath || !shape.rowsPath.startsWith(k))
      .sort((a, b) => (a[0] === "data" ? -1 : b[0] === "data" ? 1 : a[0].localeCompare(b[0])));
    for (const [k, v] of candidates) {
      if (!isPopulatedRecord(v)) continue;
      const p = path ? `${path}.${k}` : k;
      shape.recordPath = p;
      shape.recordKeys = Object.keys(v).sort();
      shape.nonEmptyValues = nonEmptyValueCount(v);
      return shape;
    }
  }
  return shape;
})();

// THE SERVICE'S OWN REFUSAL SWITCH: `result.ok`, read off the response. This is
// the gate in front of RETURNS-DATA — a capability that answered `{ok:false}`
// with a NAMED refusal (loginGated, a challenge, a restriction wall) reached the
// wire and returned nothing, and `classifyOutcome` refuses the data class
// without this being `true`.
const capabilityOk = isChat ? null : payload && typeof payload.ok === "boolean" ? payload.ok : null;

const classification = classifier.classifyOutcome({
  httpStatus,
  message,
  answerText: probeNonceMatched === true ? answerText : "",
  noResponse: httpStatus === 0,
  poolAtRequest: poolAtRequest ? { busy: poolAtRequest.busy, total: poolAtRequest.total, queued: poolAtRequest.queued } : undefined,
  page: observedPage ?? undefined,
  capabilityOk,
  resultShape,
});

const answerSha256_16 = createHash("sha256").update(answerText).digest("hex").slice(0, 16);

const row = {
  site,
  capability,
  class: classification.cls,
  provenance: "harness",
  // The method must describe what was ACTUALLY sent, so the words differ by
  // surface: the chat arm sent a per-measurement nonce probe, and the capability
  // arm sent the capability's own args. The pre-fix row said "nonce probe" on a
  // capability row that never sent one — a method string that lies about the
  // measurement is the same defect as a class that lies about it.
  method: isChat
    ? `${wire === "v1" ? "POST /v1/chat/completions" : "POST /prompt"} (nonce probe, pool sampled from GET /status before the request)`
    : `POST /capability/${site} {capability,args} (NO nonce — a capability returns JSON; freshness rests on the runner's own ok verdict, the counted rows and the idle pool, and pool was sampled from GET /status before the request)`,
  measuredAt: new Date().toISOString(),
  httpStatus,
  answerChars: [...answerText].length,
  answerSha256_16,
  probeNonceMatched,
  doneReason: rawDoneReason,
  elapsedMs,
  observedPage,
  poolAtRequest: poolAtRequest ? { busy: poolAtRequest.busy, total: poolAtRequest.total, queued: poolAtRequest.queued } : null,
  // MEASURED: `GET /status` reports the build under liveness.build.commit, NOT
  // at a top-level `commit` — so the old read produced `null` on every row, and
  // test/round-trip-record-truth.test.ts REQUIRES a commit on every measured
  // row. A gate that requires a field the writer can never fill is a gate that
  // can never pass: no row could ever have counted as MEASURED.
  daemonCommit:
    (typeof status?.liveness?.build?.commit === "string" && status.liveness.build.commit) ||
    (typeof status?.commit === "string" && status.commit) ||
    null,
  resultShape,
  // The runner's own verdict, for a capability surface. `null` on a chat row
  // because a chat surface has no `ok` field — it is not invented for one.
  capabilityOk,
  evidence: `class derived by classifyOutcome() via ${classifierVia}: ${classification.reason}`,
  prereq: idle
    ? "none beyond a live vault session for the site"
    : "NOT IDLE — the pool was busy/queued when the request started, so this row measures the queue, not the site",
  notes:
    capability !== "chat"
      ? "capability surface: this row is machine-checkable in SHAPE only (HTTP status, the runner's own ok verdict, and resultShape) — a capability returns JSON, so no nonce proves anything and probeNonceMatched is null for exactly that reason. RETURNS-DATA claims the surface returned DATA over the wire, not what the data says"
      : observedPage
        ? `observedPage is the title and url the DAEMON reported after driving the site; only the constant nonce probe was ever sent to the site, so no private text can ride in it`
        : "the daemon reported no page for this request, so observedPage is null and the page-keyed classes (WALL-CHALLENGE, SIGN-OUT, COMPOSER-DRIFT) could not have been derived for this row",
};

// A row is a ROUND TRIP when its class is one of the two that mean "the service
// did its job": ANSWERS (a chat surface returned a nonce-matched answer) and
// RETURNS-DATA (a capability surface returned a well-formed result with at least
// one record). Everything else this writes is a correct measurement of a site
// that failed, and exits 5 so a caller can tell the two apart.
const MEASURED_CLASSES = new Set(["ANSWERS", "RETURNS-DATA"]);
const isMeasuredClass = (cls) => MEASURED_CLASSES.has(cls);

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        wroteNothing: true,
        triage,
        wire,
        requestUrl: url,
        requestShape: wire === "v1" ? "{model, messages:[{role,content}], stream:false}" : isChat ? "{site, prompt}" : "{capability, args}",
        row,
      },
      null,
      2,
    ),
  );
  process.exit(isChat ? (row.probeNonceMatched === true && row.class === "ANSWERS" ? 0 : 5) : isMeasuredClass(row.class) ? 0 : 5);
}

if (row.probeNonceMatched === true && row.class !== "ANSWERS") {
  console.error(
    `record-roundtrip: refusing to write — the nonce matched but classifyOutcome() derived ${row.class}, not ANSWERS ` +
      `(${classification.reason}). Writing a row whose own fields contradict its own class is the defect this script exists to prevent.`,
  );
  process.exit(2);
}

// UNCLASSIFIED is the classifier's refusal, not a class: it is deliberately not
// in VERIFICATION_CLASSES, so no reader could re-derive it into the vocabulary.
// Writing it would put a row in the published record that reads like a verdict
// about a site while asserting nothing — the exact laundering the triage above
// exists to prevent, one layer up.
if (row.class === "UNCLASSIFIED") {
  console.error(
    `record-roundtrip: refusing to write — classifyOutcome() derived UNCLASSIFIED, which is NOT a class ` +
      `(it is absent from VERIFICATION_CLASSES, so no reader could re-derive it into the vocabulary). The measurement is reported here instead: ${classification.reason}\n` +
      `  HTTP ${row.httpStatus}, answerChars ${row.answerChars}, doneReason ${String(row.doneReason)}, elapsedMs ${row.elapsedMs}, pool ${JSON.stringify(row.poolAtRequest)}`,
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

// ── the gap list is MAINTAINED HERE, not typed by a human ───────────────────
// `knownGaps.sites` names the sites that publish a round-trip claim with no
// MEASURED row behind it, and the gate asserts that named set EQUALS the gap it
// derives (test/round-trip-record-truth.test.ts, "in both directions") — so a
// gap appearing AND a gap being quietly closed are both build failures.
//
// That equality is only maintainable if MEASURING is what closes a gap. It was
// not: the list was hand-maintained, so the first real measurement of gemini
// and duckduckgo turned the gate RED with `named: [7 sites] / derived: [5
// sites]` — a correct gate reporting that closing a gap was a manual step
// nobody had done. So the write seam that measures now recomputes the list from
// the rows it just wrote.
//
// The MEASURED predicate below is the SAME one the read seam applies
// (src/prompt/registry.ts `measuredRoundTripFor`) and the same one the gate
// derives from, restated here rather than imported, because this file runs
// standalone against a deployed daemon and importing the resolver would drag
// the whole registry into the measurement path. It is deliberately the strict
// conjunction, in TWO arms:
//
//   CHAT      provenance=harness AND a MATCHED nonce AND ANSWERS AND a 2xx AND
//             answerChars>0 AND doneReason=stable AND inside the staleness window.
//   CAPABILITY provenance=harness AND RETURNS-DATA AND a 2xx AND the runner's own
//             ok=true AND resultShape whose declared count and counted rows AGREE
//             AND rows>=1 AND inside the staleness window.
//
// A row missing any clause of its arm leaves its site in the gap, which is the
// honest direction to fail in. The capability arm is what makes a capability
// surface MEASURED-able at all: before it, every `ok:true` result with real rows
// derived UNCLASSIFIED and the record could only ever carry chat rows, so 26 of
// the 33 packages were permanently unmeasurable no matter how many times the
// harness ran.
const windowDays = Number(record.stalenessWindowDays) || 30;
const inWindow = (r) => {
  if (typeof r.measuredAt !== "string") return false;
  const age = (Date.now() - Date.parse(r.measuredAt)) / 86_400_000;
  return Number.isFinite(age) && age >= 0 && age <= windowDays;
};
const is2xx = (r) => {
  const st = Number(r.httpStatus);
  return st >= 200 && st < 300;
};
const isMeasuredRow = (r) => {
  if (!r || typeof r !== "object") return false;
  if (r.provenance !== "harness") return false;
  if (!is2xx(r)) return false;
  if (!inWindow(r)) return false;
  if (r.class === "ANSWERS") {
    if (r.probeNonceMatched !== true) return false;
    if (!(Number(r.answerChars) > 0)) return false;
    if (r.doneReason !== "stable") return false;
    return true;
  }
  if (r.class === "RETURNS-DATA") {
    if (r.capabilityOk !== true) return false;
    const s = r.resultShape;
    if (!s || typeof s !== "object") return false;
    if (typeof s.rowsPath !== "string" || !s.rowsPath.trim()) return false;
    if (!Array.isArray(s.topLevelKeys) || s.topLevelKeys.length === 0) return false;
    const declared = Number(s.count);
    const counted = Number(s.rows);
    if (!Number.isInteger(declared) || !Number.isInteger(counted)) return false;
    if (declared !== counted) return false;
    if (counted < 1) return false;
    return true;
  }
  return false;
};
const measuredSiteIds = new Set(record.rows.filter(isMeasuredRow).map((r) => r.site));

if (record.knownGaps && Array.isArray(record.knownGaps.sites)) {
  const before = record.knownGaps.sites.length;
  record.knownGaps.sites = record.knownGaps.sites.filter((id) => !measuredSiteIds.has(id));
  const closed = before - record.knownGaps.sites.length;
  if (closed > 0) {
    console.error(
      `record-roundtrip: closed ${closed} gap(s) by measuring — the list is recomputed from the rows, ` +
        `never typed. Remaining gaps: ${record.knownGaps.sites.length ? record.knownGaps.sites.join(", ") : "(none)"}`,
    );
  }
}

const tmp = `${path}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o644 });
renameSync(tmp, path); // atomic on the same filesystem: never a half-written record
console.error(
  `record-roundtrip: wrote ${RECORD_REL} :: ${site}/${capability} class=${row.class} nonce=${row.probeNonceMatched} ` +
    `http=${row.httpStatus} chars=${row.answerChars} doneReason=${String(row.doneReason)}`,
);
// 0 = a real round trip. 5 = a row recording the site's TRUE failure class: a
// correct measurement, not a pass, and a caller must be able to tell them apart.
process.exit(isChat ? (row.class === "ANSWERS" ? 0 : 5) : isMeasuredClass(row.class) ? 0 : 5);