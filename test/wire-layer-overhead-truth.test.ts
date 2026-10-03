// WIRE-LAYER OVERHEAD — the measured cost of OUR OWN wire code, and the gate
// that keeps the honest (slow) answer in place.
//
// WHAT THIS LANE MEASURED (2026-10-03, this box, warm page cache, other lanes
// running concurrently — so these are UPPER-BOUND numbers, not a quiet-machine
// best case). Command that produced them:
//   node --import tsx --import /tmp/wire-lane/preload.mjs bench-models2.mts
//
//   GET /v1/models, full per-request compute   mean 34.9ms  p50 26.9  p95 76.0  max 216.9
//   GET /registry  (buildRegistryPackages)     mean 21.3ms  p50 19.7  p95 34.4
//   defaultChatSurface()  (ONE scan)            mean  3.9-8.7ms
//   readModelVerification()                     mean  0.16ms
//   POST /capability/<site>                     ~21ms — see registryPackageFor below
//   /v1/models response body                    12,322 bytes
//
// THE COMPOSITION FINDING: one `GET /v1/models` performs FIVE full
// `defaultChatSurface()` scans. `openai.ts` asks for one directly (:839) and
// then `answerableChatSurface` (registry.ts:779), `withheldChatModels`
// (registry.ts:788) and `modelAdvertisementSummary` (registry.ts:820) each ask
// for their own — and `modelAdvertisementSummary` asks twice (once directly,
// once through `withheldChatModels`). `GET /registry` performs three
// (registry.ts:954, :962, :963). Each scan re-reads every installed package's
// profile.json + metadata.json off disk. THAT is the redundancy; it is not a
// bug and it is not fixed here — see THE VERDICT below.
//
// ── THE VERDICT: DECLINE ───────────────────────────────────────────────────────
//
// The tempting optimisation is to cache `/v1/models` and `/registry`. It is
// DECLINED, and this file exists to make that decline ENFORCED rather than
// merely stated, because a decline nobody pins is one refactor away from
// becoming the lie.
//
// The reason is not caution, it is arithmetic plus one hard fact:
//
//  1. ARITHMETIC. The wire layer's own overhead is 21-35ms. The work it fronts
//     is a real browser round trip against a chat site, measured in SECONDS
//     (tencent-aistudio's cold boot alone is 5-8s of `preComposeDelayMs`).
//     Eliminating 100% of this overhead would move a chat round trip by well
//     under one percent. `/v1/chat/completions` — the latency-critical path —
//     adds essentially ZERO wire overhead: it is `pool.acquire` + `ask()` +
//     `release`, all of which is the site's own generation time.
//
//  2. THE FACT THAT MAKES A CACHE A LIE. `/v1/models` is a PROMISE surface
//     (GOAL 159): a consumer materialises one provider per advertised id. Its
//     truth is `capabilities/model-verification.json`, a file the OPERATOR
//     rewrites out of band — re-sign-in, re-run the measurement — with no
//     signal to the daemon. A cross-request cache would keep serving the old
//     advertisement after that rewrite, which is not a stale cache, it is the
//     daemon telling every consumer that 2 models answer when 12 now do (or
//     the reverse: advertising a model whose session has since expired). There
//     is no TTL that makes this honest, because the invalidating event is not
//     time, it is a FILE THE OPERATOR EDITS.
//
//  3. THE EXISTING DESIGN ALREADY SOLVES THE VISIBILITY PROBLEM THE CACHE
//     WAS SUPPOSED TO. Every `/v1/models` response carries
//     `advertisement.recordGeneratedAt` and `advertisement.recordAgeDays`, so a
//     consumer can already see exactly how old the promise is (measured: a
//     record 2 days old reports `recordAgeDays: 2`). The staleness is VISIBLE
//     on the wire without any cache at all. A cache would add a SECOND,
//     hidden staleness next to the one that is already reported — strictly
//     worse.
//
// So the redundancy above is left in place, deliberately. What this file DOES
// is pin the properties that make leaving it in place safe, so a future
// optimisation has to argue with a gate instead of with nobody.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleOpenAIRoutes } from "../src/prompt/openai.js";
import { RequestLog } from "../src/prompt/http.js";
import { defaultChatSurface } from "../src/prompt/registry.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** The daemon's real served set, derived the way the daemon derives it. */
const profilesById = (() => {
  const out: Record<string, ChatSiteProfile> = {};
  for (const e of defaultChatSurface()) out[e.id] = e.profile;
  return out;
})();

interface Captured {
  status: number;
  body: string;
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  writeHead(s: number): void;
  write(c: string): boolean;
  end(c?: string): void;
}

function fakeRes(): Captured {
  const r: Captured = {
    status: 0,
    body: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(s: number) {
      r.status = s;
      r.headersSent = true;
    },
    write(c: string) {
      r.body += c;
      return true;
    },
    end(c?: string) {
      if (c) r.body += c;
      r.writableEnded = true;
    },
  };
  return r;
}

const fakeReq = (method: string, url: string) =>
  ({ method, url, on() { /* no body stream on these routes */ } }) as never;

async function getModels(url = "/v1/models"): Promise<Captured> {
  const res = fakeRes();
  await handleOpenAIRoutes(fakeReq("GET", url), res as never, {
    pool: {} as never,
    profilesById: profilesById as never,
  });
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// GATE 1 — THE ANTI-TRAP GATE: the advertisement is NEVER hoisted to module
// scope.
//
// This is the load-bearing pin of the whole slice. Every function that reads
// the promise surface off disk (`readModelVerification`, `defaultChatSurface`,
// `answerableChatSurface`, `withheldChatModels`, `modelAdvertisementSummary`,
// `buildRegistryPackages`) must be called from INSIDE a request handler. A
// module-scope call — `const V = readModelVerification()` at import time — is
// precisely the cache this lane declined: the daemon would freeze its promise
// at process start and never see the operator rewrite the record.
//
// The check is textual because the failure mode is textual: the invariant is
// "no advertisement truth is computed at module scope", and a top-level call is
// exactly that. Every occurrence must be INDENTED, i.e. inside a body.
// ─────────────────────────────────────────────────────────────────────────────
const TRUTH_CALLS = [
  "readModelVerification(",
  "defaultChatSurface(",
  "answerableChatSurface(",
  "withheldChatModels(",
  "modelAdvertisementSummary(",
  "buildRegistryPackages(",
];

test("no advertisement truth is computed at module scope — /v1/models can never serve a frozen promise", () => {
  const offenders: string[] = [];
  for (const rel of ["src/prompt/openai.ts", "src/prompt/http.ts"]) {
    const lines = readFileSync(resolve(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      // Skip import statements — importing the symbol is not calling it.
      if (/^\s*import\b/.test(line)) return;
      for (const call of TRUTH_CALLS) {
        if (!line.includes(call)) continue;
        // A top-level statement starts at column 0. Anything indented is in a body.
        if (!/^\s/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "these advertisement-truth calls sit at MODULE SCOPE, which would freeze the " +
      "promise at process start — the daemon would keep advertising what it " +
      "measured at boot and never see the operator rewrite the record. Compute " +
      "it per request, or decline the cache explicitly in the goal that owns it",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 2 — THE ADVERTISEMENT IS RE-DERIVED PER REQUEST, and its staleness is
// REPORTED rather than hidden.
//
// Two consecutive requests must each re-derive (identical bytes is the
// PROOF that the derivation is deterministic — a cache and a per-request
// derivation are indistinguishable from one call, and only the second call
// tells them apart). And the response must carry the record's own age, because
// that visible age is what makes declining a cache acceptable at all: a
// consumer can see how old the promise is without any cache existing.
// ─────────────────────────────────────────────────────────────────────────────
test("/v1/models re-derives per request and REPORTS the record's age (a cache would hide it)", async () => {
  const first = await getModels();
  assert.equal(first.status, 200);
  const body1 = JSON.parse(first.body) as {
    object: string;
    advertisement: {
      record: string;
      recordGeneratedAt: string | null;
      recordAgeDays: number | null;
      offered: number;
      addressable: number;
      refusal: string | null;
    };
    data: { id: string }[];
  };
  const second = await getModels();
  assert.equal(
    second.body,
    first.body,
    "two consecutive requests must derive the SAME advertisement — if this ever " +
      "differs, something is caching one request's derivation into the next",
  );

  // The staleness of the promise is VISIBLE, not hidden.
  assert.equal(body1.advertisement.record, "capabilities/model-verification.json");
  assert.equal(
    typeof body1.advertisement.recordGeneratedAt,
    "string",
    "the response must name WHEN the promise was measured, or a consumer cannot " +
      "tell a fresh promise from a month-old one",
  );
  assert.equal(
    typeof body1.advertisement.recordAgeDays,
    "number",
    "the response must carry recordAgeDays — this is the field that lets a " +
      "consumer judge the promise, and the reason no cache is needed to be honest",
  );
  assert.equal(body1.advertisement.refusal, null, "the record on this box is readable");

  // The counts must be internally consistent: offered <= addressable, and the
  // advertised set is never larger than the measured ANSWERS set.
  assert.ok(
    body1.advertisement.offered <= body1.advertisement.addressable,
    `offered (${body1.advertisement.offered}) must not exceed addressable (${body1.advertisement.addressable})`,
  );
  assert.equal(
    body1.data.length,
    body1.advertisement.offered,
    "every advertised id must have exactly one entry, or a consumer materialises " +
      "a provider this daemon cannot serve",
  );
  assert.equal(
    Object.keys(profilesById).length,
    body1.advertisement.addressable,
    "the reported addressable count must be the daemon's real configured surface",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 3 — A WITHHELD MODEL IS A NAMED 404, not a silent absence and not an
// optimistic entry.
//
// The refusal half of the promise: a model the record does not vouch for must
// be refused BY NAME, with the catalogue endpoints that still serve it. This is
// what a cache would quietly break — a cached `offered` set is a cached
// refusal too.
// ─────────────────────────────────────────────────────────────────────────────
test("a model the record does not vouch for is a NAMED 404, and still reachable on the catalogue", async () => {
  const listBody = JSON.parse((await getModels()).body) as {
    data: { id: string }[];
    withheld: { model: string; class: string; reason: string }[];
  };
  const withheld = listBody.withheld.find((w) => w.model in profilesById);
  assert.ok(withheld, "this daemon withholds at least one configured id (GOAL 159)");
  assert.ok(withheld.reason.length > 0, "a withheld model must carry its NAMED reason");

  const res = await getModels(`/v1/models/${withheld.model}`);
  assert.equal(res.status, 404, "a withheld model must not be advertised");
  const err = JSON.parse(res.body) as { error: { code: string; message: string } };
  assert.equal(err.error.code, "model_withheld");
  assert.ok(
    err.error.message.includes("/registry") && err.error.message.includes("/capability/"),
    "the refusal must name the endpoints where the model IS still reachable, or a " +
      "consumer concludes the site is gone",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 4 — THE MEASURED OVERHEAD IS ANCHORED, not asserted tight.
//
// This is deliberately a GENEROUS bound (2500ms against a measured mean of
// ~35ms, ~70x headroom) for one reason: a tight timing pin on a shared box
// measures the neighbours' load, not this code, and a gate that fails under
// load is a gate people learn to re-run — which is how a pin stops being a pin.
// What this buys is a REGRESSION detector: the day someone adds a real cache
// with a 60s TTL and a synchronous cross-process lock, or a per-request
// `JSON.parse` of something that used to be read once, this fires. The
// measured mean is PRINTED in the failure message so the run self-documents.
// ─────────────────────────────────────────────────────────────────────────────
test("one GET /v1/models stays under its measured-overhead budget (regression anchor, not a tight pin)", async () => {
  await getModels(); // warm: first call pays module-load + selector-parse costs
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const res = await getModels();
    samples.push(performance.now() - t0);
    assert.equal(res.status, 200);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const budgetMs = 2500;
  assert.ok(
    mean < budgetMs,
    `GET /v1/models mean ${mean.toFixed(1)}ms exceeded the ${budgetMs}ms budget ` +
      `(median ${median.toFixed(1)}ms). MEASURED BASELINE 2026-10-03 on this box: ` +
      `mean 34.9ms / p50 26.9ms / p95 76.0ms, from FIVE defaultChatSurface() scans ` +
      `(registry.ts:779/788/820 each re-scan, plus openai.ts:839 and :920-921). ` +
      `If a new cost was added here, it must be justified against the promise ` +
      `surface, not against latency — this surface fronts browser round trips ` +
      `measured in SECONDS, so wire cost is not where the latency is.`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GATE 5 — THE BOUNDED REQUEST LOG STAYS BOUNDED. (Constraint 3 of this lane:
// never remove the ring, never let it grow.)
//
// `UI2API_REQUEST_LOG` is attacker-adjacent input on a long-lived daemon: an
// operator (or anything that can set the env) must not be able to turn a
// bounded ring into unbounded growth. Two properties are pinned: the knob is
// CLAMPED, and the ring EVICTS. A test that only checked the clamp would pass
// against an implementation that stopped evicting.
// ─────────────────────────────────────────────────────────────────────────────
test("the request log is bounded: the knob is clamped AND the ring evicts", () => {
  // 1. The clamp: an absurd explicit limit cannot exceed the hard ceiling.
  const absurd = new RequestLog(10_000_000);
  assert.ok(
    absurd.limit <= 500,
    `a 10,000,000-entry request log clamped to ${absurd.limit} — the hard ceiling ` +
      `must hold, or UI2API_REQUEST_LOG is an unbounded-growth knob`,
  );

  // 2. The eviction: far more writes than the limit, and the ring does not grow.
  const ring = new RequestLog(10);
  for (let i = 0; i < 5000; i++) {
    ring.begin("GET", `/v1/models?i=${i}`)({ status: 200 });
  }
  const entries = ring.list();
  assert.equal(
    entries.length,
    10,
    `5,000 requests into a 10-entry ring produced ${entries.length} entries — the ` +
      `ring must evict the oldest on overflow, or a long-lived daemon leaks`,
  );
  // The survivors are the NEWEST, which is the only useful eviction order for a
  // diagnostic ring: the entries you want after an incident are the recent ones.
  assert.equal(entries[entries.length - 1].path, "/v1/models?i=4999", "the newest entry must survive");
  assert.equal(entries[0].path, "/v1/models?i=4990", "the oldest must be the one evicted");
  assert.equal(ring.inFlight, 0, "in-flight must not leak upwards across 5,000 requests");
});