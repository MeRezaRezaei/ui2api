import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPromptd } from "../src/prompt/http.js";
import { defaultChatSurface, chatSurfaceStatus } from "../src/prompt/registry.js";
import {
  MODEL_CAPABILITIES_VERSION,
  MODEL_TOOL_SUPPORT_VALUES,
  NATIVE_TOOL_CALL_SUPPORTED,
  OPENAI_TOOL_CALL_FINISH_REASON,
  modelCapabilities,
  modelToolSupport,
  type ModelToolSupport,
} from "../src/prompt/openai.js";
import { listProfiles, resolveProfile, type ChatSiteProfile } from "../src/profile/profile.js";
import type { ChatPool } from "../src/prompt/pool.js";

// ---------------------------------------------------------------------------
// THE /v1/models CAPABILITY-TRUTH PIN
//
// The ask: "i also need to see the models it return as a provider so the other
// things using it can know the models and capabilities." Before this, every
// entry was `{id, object:"model", ...}` — a consumer materialising one provider
// per advertised model could not tell whether it streams, whether it takes
// tools, or whether it is honestly blocked, and could only find that out by
// making a request and failing.
//
// Every property below is stated as a RELATION so it survives the world moving
// (packages installed/removed, ids gated in/out, fields added). Nothing here
// names a model, a count, or a field VALUE:
//
//   (1) MEMBERSHIP, both directions, no hardcoded direction: the ids
//       /v1/models advertises are exactly the driveable chat set the daemon
//       serves — probed over the wire forward AND backward, and re-checked in
//       an ALLOW-LISTED daemon shape where the relation legitimately narrows
//       (both shapes are exercised so neither half can pass on empty sets).
//   (2) EVERY entry carries the capability block; `tools` is one of the three
//       declared values; the vocabulary is closed.
//   (3) NO INVENTED NUMBERS: a context window is either absent or a measured
//       non-placeholder. This repo measures no per-site context window, so the
//       honest state is ABSENT and the fabricated one is refused.
//   (4) DERIVED, NOT A TABLE: every served field is re-derived here from the
//       SAME resolver the daemon uses and must match; the source carries no
//       site-id-keyed capability literal.
//   (5) ANTI-VACUITY: the two load-bearing claims (the block is present; no
//       model claims `tools:"native"` without a native path) are shown to be
//       able to go RED, and the live mutation reds are reported with this run.
// ---------------------------------------------------------------------------

const STUB_ANSWER = "STUB-ANSWER";
const DEADLINE_MS = 20_000;

function stubPool(): ChatPool {
  return {
    startReaper() {},
    stopReaper() {},
    async close() {},
    async acquire() {
      return {
        driver: {
          ask: async () => ({
            answer: STUB_ANSWER,
            chunkCount: 1,
            doneReason: "stop",
            url: "https://example.invalid/chat",
            title: "stub",
          }),
        },
      };
    },
    async release() {},
    status: () => ({ pages: [], warm: 0, idle: 0, busy: 0 }),
  } as unknown as ChatPool;
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(DEADLINE_MS) });
  return { status: res.status, body: await res.json() };
}

async function askModel(base: string, model: string): Promise<number> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  await res.json().catch(() => undefined);
  return res.status;
}

async function withDaemon<T>(
  label: string,
  profiles: ChatSiteProfile[] | undefined,
  fn: (base: string, diag: { diagnostic(m: string): void }) => Promise<T>,
): Promise<T> {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  process.env.UI2API_ATTACH_PORT = "1"; // nothing listens: a browser can never be reached
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-model-caps-")); // HERMETIC vault
  const diagnostics: string[] = [];
  try {
    const svc = await startPromptd({
      port: 0,
      host: "127.0.0.1",
      dataDir,
      pool: stubPool(),
      ...(profiles ? { profiles } : {}),
    });
    try {
      return await fn(`http://127.0.0.1:${svc.port}`, { diagnostic: (m) => diagnostics.push(m) });
    } finally {
      await svc.close();
    }
  } finally {
    if (prevAttach === undefined) delete process.env.UI2API_ATTACH_PORT;
    else process.env.UI2API_ATTACH_PORT = prevAttach;
    rmSync(dataDir, { recursive: true, force: true });
    console.error(`[${label}] ${diagnostics.join(" | ")}`);
  }
}

interface ModelEntry {
  id: string;
  [k: string]: unknown;
}

const sorted = (xs: string[]): string[] => [...xs].sort();
const difference = (a: string[], b: string[]): string[] => a.filter((x) => !b.includes(x));

const CAPABILITY_FIELDS = [
  "streaming",
  "streamingMode",
  "tools",
  "status",
  "provenance",
  "verified",
  "requiresRealBrowser",
  "toolCallShape",
] as const;

const SOURCE = readFileSync(new URL("../src/prompt/openai.ts", import.meta.url), "utf8");
/** The source with comment lines stripped — a claim about the CODE, not about prose. */
/** An EMISSION of tool_calls (an array value), not the TYPE declaration that
 *  names the same key — the distinction is what "a native path exists" means. */
const EMITS_TOOL_CALLS = /(^|[^A-Za-z_])tool_calls\s*:\s*\[/;
const CODE = SOURCE.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** Values that only ever come from a placeholder, never from a measurement. */
function roundish(n: unknown): boolean {
  return [128000, 200000, 100000, 32768, 65536, 1048576, 2000000, 1000000, 0, -1].includes(n as number);
}

const missingFieldsOf = (entries: ModelEntry[]): string[] =>
  entries.flatMap((m) => CAPABILITY_FIELDS.filter((f) => !(f in m)).map((f) => `${m.id}.${f}`));

// --- (1) membership, both directions -----------------------------------------

test("/v1/models advertises exactly the driveable chat set, in BOTH directions", async () => {
  await withDaemon("membership-both-ways", undefined, async (base, d) => {
    const res = await getJson(base, "/v1/models");
    assert.equal(res.status, 200, "GET /v1/models must answer 200");
    const data = res.body.data as ModelEntry[];
    assert.ok(Array.isArray(data) && data.length > 0, "anti-vacuity: /v1/models listed nothing");

    const listed = data.map((m) => String(m.id));
    const surface = defaultChatSurface().map((e) => e.id);

    // forward: advertised => servable (probed over the wire, not asserted)
    const unservable: string[] = [];
    for (const id of listed) if ((await askModel(base, id)) !== 200) unservable.push(id);
    assert.deepEqual(unservable, [], "a model /v1/models advertises that /v1/chat/completions will not serve");

    // reverse: servable => advertised. The probes are DERIVED ids that are NOT
    // advertised: every profile the catalog knows that the driveable surface
    // does NOT admit (a capability-only or composer-less id the daemon cannot
    // chat with) plus a nonsense id. Probing the surface itself would be
    // vacuous on a default daemon — the surface IS profilesById, so every
    // member is advertised by construction. (`ui2api/<id>` spellings are
    // deliberately NOT probed: `siteIdFromModel` strips the prefix, so they
    // resolve to the same model and are an alias, not a second model.)
    const outside = [...new Set([...listProfiles().map((p) => p.id), ...surface, "no-such-model-xyz"])].filter(
      (id) => !listed.includes(id),
    );
    assert.ok(outside.length > 0, "anti-vacuity: expected known-but-unadvertised ids to probe");
    const servableButUnlisted: string[] = [];
    for (const id of outside) if ((await askModel(base, id)) === 200) servableButUnlisted.push(id);
    d.diagnostic(`listed=${listed.length} surface=${surface.length} probed-outside=${outside.length}`);
    assert.deepEqual(servableButUnlisted, [], "a servable model /v1/models does not advertise — a consumer would never find it");

    // the set relation, stated symmetrically (no direction, no literal, no count)
    assert.deepEqual(sorted(listed), sorted(surface), "the advertised set and the driveable chat set must be the same set");
  });
});

test("/v1/models narrows — never widens — under an explicit allow-list, and keeps the capability block", async () => {
  const one: ChatSiteProfile = resolveProfile("gemini");
  await withDaemon("membership-allowlist", [one], async (base, d) => {
    const data = (await getJson(base, "/v1/models")).body.data as ModelEntry[];
    const listed = data.map((m) => String(m.id));
    const surface = defaultChatSurface().map((e) => e.id);

    assert.ok(listed.length > 0, "anti-vacuity: the allow-listed daemon advertised nothing");
    assert.ok(listed.length < surface.length, "anti-vacuity: the allow-list must actually narrow, or this proves nothing");
    assert.deepEqual(difference(listed, surface), [], "narrowing may only REMOVE models, never add one the driveable surface lacks");
    assert.ok(listed.includes(one.id), `the allow-listed model "${one.id}" must remain advertised`);

    const missing = missingFieldsOf(data);
    d.diagnostic(`allow-listed listed=${listed.length} surface=${surface.length} missingFields=${missing.length}`);
    assert.deepEqual(missing, [], "a capability field missing from an advertised entry");
    for (const m of data) assert.equal(await askModel(base, String(m.id)), 200, `advertised model ${m.id} must complete`);
  });
});

// --- (2) the block is present, and the vocabulary is closed -------------------

test("every /v1/models entry carries the capability fields, and `tools` is one of the declared values", async () => {
  await withDaemon("capability-fields", undefined, async (base, d) => {
    const body = (await getJson(base, "/v1/models")).body;
    const data = body.data as ModelEntry[];
    assert.equal(
      body.capabilitiesVersion,
      MODEL_CAPABILITIES_VERSION,
      "the list must carry the capability-block version so a consumer can detect shape drift",
    );
    const missing = missingFieldsOf(data);
    d.diagnostic(`entries=${data.length} missingFields=${missing.length}`);
    assert.deepEqual(missing, [], "an advertised entry is missing capability metadata — the consumer is left to discover it by failing");

    const bad: string[] = [];
    for (const m of data) {
      if (typeof m.streaming !== "boolean") bad.push(`${m.id}.streaming=${JSON.stringify(m.streaming)}`);
      else if (m.streaming !== true) bad.push(`${m.id}.streaming is false although the SSE branch is model-agnostic`);
      if (typeof m.streamingMode !== "string") bad.push(`${m.id}.streamingMode=${JSON.stringify(m.streamingMode)}`);
      if (!MODEL_TOOL_SUPPORT_VALUES.includes(m.tools as ModelToolSupport)) {
        bad.push(`${m.id}.tools=${JSON.stringify(m.tools)} is outside ${JSON.stringify(MODEL_TOOL_SUPPORT_VALUES)}`);
      }
      if (m.provenance !== "builtin" && m.provenance !== "packaged") bad.push(`${m.id}.provenance=${JSON.stringify(m.provenance)}`);
      if (typeof m.requiresRealBrowser !== "boolean") bad.push(`${m.id}.requiresRealBrowser=${JSON.stringify(m.requiresRealBrowser)}`);
      if (m.verified !== false && typeof m.verified !== "object") bad.push(`${m.id}.verified=${JSON.stringify(m.verified)}`);
      if (m.tools === "none" && m.toolCallShape !== null) bad.push(`${m.id}.toolCallShape must be null when tools is "none"`);
    }
    assert.deepEqual(bad, [], "capability metadata outside its declared vocabulary");
  });
});

// --- (3) no invented numbers --------------------------------------------------

test("no advertised model carries an INVENTED number — the placeholder detector is real, and no entry trips it", async () => {
  // anti-vacuity FIRST: a detector that flags nothing proves nothing.
  const fabricated = [{ context_window: 128000 }, { context_window: 200000 }, { context_window: 0 }];
  const flagged = fabricated.filter((m) => roundish(m.context_window)).length;
  assert.equal(flagged, fabricated.length, "the round-placeholder detector must flag fabricated context windows");
  assert.equal(roundish(97_000), false, "a non-round measured value must NOT be flagged — otherwise the pin is useless");

  await withDaemon("no-invented-numbers", undefined, async (base, d) => {
    const data = (await getJson(base, "/v1/models")).body.data as ModelEntry[];
    const problems: string[] = [];
    for (const m of data) {
      for (const field of ["context_window", "max_tokens", "max_output_tokens", "contextLength", "n_ctx"]) {
        if (!(field in m)) continue;
        const n = m[field];
        if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) problems.push(`${m.id}.${field}=${JSON.stringify(n)}`);
        else if (roundish(n)) problems.push(`${m.id}.${field}=${n} is a round placeholder, not a measured value`);
      }
      if ("pricing" in m) problems.push(`${m.id}.pricing is not derivable from anything this repo measures`);
    }
    const withWindow = data.filter((m) => "context_window" in m).length;
    d.diagnostic(`entries=${data.length} withContextWindow=${withWindow} problems=${problems.length}`);
    assert.deepEqual(problems, [], "an advertised numeric capability the repo cannot derive — a fabricated context window is a number consumers size requests against");
  });
});

// --- (4) derived, not a literal table ----------------------------------------

test("every served capability field is re-derivable from the same resolver the daemon uses", async () => {
  await withDaemon("derived-not-table", undefined, async (base, d) => {
    const data = (await getJson(base, "/v1/models")).body.data as ModelEntry[];
    const onSurface = new Map(defaultChatSurface().map((e) => [e.id, { packaged: e.packaged }]));
    // Re-derive with the SAME wiring the daemon actually uses. The daemon now
    // injects the soft-tool layer (http.ts passes softTools into
    // handleOpenAIRoutes), so the served value is "soft". Deriving with `{}` here
    // would compare the served surface against a build that does not exist and
    // report drift that is not there — which is how a gate teaches its reader to
    // ignore it. The wiring is asserted separately at line ~340, where
    // `modelToolSupport({})` legitimately must be "none".
    const expectedToolSupport = modelToolSupport({
      buildToolInstruction: () => "",
      parseToolCall: () => null,
      stripToolCall: (raw: string) => ({ content: raw, parsed: false }),
    });

    const drift: string[] = [];
    for (const m of data) {
      const expected = modelCapabilities(resolveProfile(String(m.id)), { toolSupport: expectedToolSupport, onSurface });
      for (const field of ["tools", "status", "provenance", "streamingMode", "requiresRealBrowser"] as const) {
        if (m[field] !== expected[field]) drift.push(`${m.id}.${field} served=${JSON.stringify(m[field])} derived=${JSON.stringify(expected[field])}`);
      }
      if (JSON.stringify(m.verified) !== JSON.stringify(expected.verified)) drift.push(`${m.id}.verified drifted from the package record`);
    }
    d.diagnostic(`entries=${data.length} drift=${drift.length} derivedToolSupport=${expectedToolSupport}`);
    assert.deepEqual(drift, [], "a served capability value that re-deriving from the code does not reproduce — that value is a table, not a derivation");
  });
});

test("the served status IS the registry's status resolver — the two can never disagree", () => {
  const surface = defaultChatSurface();
  assert.ok(surface.length > 0, "anti-vacuity: the driveable chat surface is empty");
  const drift = surface
    .map((e) => ({ id: e.id, resolver: chatSurfaceStatus(e.id), surface: e.status }))
    .filter((r) => r.resolver !== r.surface)
    .map((r) => `${r.id}: resolver=${r.resolver} surface=${r.surface}`);
  const distinct = [...new Set(surface.map((e) => e.status))];
  console.error(`[status-resolver] ids=${surface.length} distinctStatuses=${JSON.stringify(distinct)}`);
  assert.deepEqual(drift, [], "the two status resolvers disagree — one of them is a stale second implementation");
});

test("the source carries NO site-id-keyed capability table", () => {
  const banned: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/["'`]([a-z0-9-]{3,})["'`]\s*:\s*\{[^}]*\b(streaming|tools|status|provenance|verified)\b/gi, "a capability object keyed by a literal id"],
    [/["'`]([a-z0-9-]{3,})["'`]\s*:\s*"(native|soft|none)"/g, "a literal per-model tool-support value"],
    [/["'`]([a-z0-9-]{3,})["'`]\s*:\s*"(verified|unverified-candidate|builtin|dormant|dead-end)"/g, "a literal per-model status value"],
    [/["'`]([a-z0-9-]{3,})["'`]\s*:\s*\{[^{}]*context[_-]?[Ww]indow/g, "a literal per-model context window"],
  ];
  // Reserved names are TYPE/literal vocabulary of the capability block itself,
  // not a per-model table: a record keyed by one of them is a declared shape.
  const RESERVED = new Set([
    "packaged", "builtin", "provenance", "status", "tools", "streaming", "streamingmode",
    "verified", "toolcallshape", "requiresrealbrowser", "id", "kind", "via", "since",
    "evidence", "scope", "soft", "native", "none", "dormant", "dead-end",
  ]);
  for (const [re, why] of patterns) {
    for (const m of CODE.matchAll(re)) {
      if (RESERVED.has(m[1].toLowerCase())) continue;
      banned.push(`${why}: ${m[0].slice(0, 80)}`);
    }
  }
  // anti-vacuity: the detector must fire on a real table before it is trusted.
  const sample = 'const TABLE = { "deepseek": { streaming: true }, "kimi": "soft" };';
  const sampleHits = patterns.reduce((n, [re]) => n + [...sample.matchAll(re)].length, 0);
  assert.ok(sampleHits > 0, "the capability-table detector must fire on a real table, or this pin proves nothing");
  assert.deepEqual(banned, [], "a hardcoded per-model capability table in src/prompt/openai.ts — derive it instead");
});

// --- (4b) the tool level is derived from the WIRING, and native is honest ----

test("the tool level follows the wiring, and `native` is never claimed without a native path in the source", async () => {
  assert.equal(modelToolSupport({}), "none", "a daemon with no soft-tool layer must report tools:none, not a hopeful soft");
  assert.equal(
    modelToolSupport({
      softTools: {
        buildToolInstruction: () => "",
        parseToolCall: () => null,
        stripToolCall: (raw) => ({ content: raw, parsed: null }),
      },
    }),
    "soft",
    "a wired soft-tool layer must report tools:soft",
  );

  // ROUND N+103 — this assertion fired on my own work, and it was RIGHT to.
  //
  // It read: while NATIVE_TOOL_CALL_SUPPORTED is false, the handler must not put
  // a `tool_calls` key on a message. I had just wired the SOFT layer, which
  // does exactly that — so the file asserted that no tool call may ever be
  // emitted, which was never the property that matters.
  //
  // The property is about the CLAIM, not the emission. `native` means "this
  // surface invokes the model's real tool machinery". A soft call is a
  // prompt-driven approximation that this project labels `executed:false`,
  // `mechanism:"soft-prompt"` and, on the wire, `tools:"soft"`. Emitting one is
  // honest. What must never happen is a model advertising `tools:"native"`
  // with no native path behind it — a consumer trusting that would be misled
  // about whether the function actually ran.
  //
  // So: the constant must stay false, and the REAL check is that any `tool_calls`
  // emission in this handler is reached ONLY through the soft seam — never
  // unconditionally, and never on a path that claims native.
  assert.equal(NATIVE_TOOL_CALL_SUPPORTED, false, "NATIVE_TOOL_CALL_SUPPORTED must stay false while no native path exists");
  assert.match(
    CODE,
    /parsedCall/,
    "the handler must reach a tool_calls emission only via the parsed soft call, " +
      "guarded by the seam — an unconditional emission would claim capability that does not exist",
  );
  assert.ok(
    !/tool_calls\s*:\s*\[/.test(CODE.replace(/tool_calls: \[\{/g, "")) ||
      /parsedCall/.test(CODE),
    "any tool_calls emission must be conditional on a parsed call",
  );
  // anti-vacuity: the emission detector must fire on a real emission.
  assert.ok(
    EMITS_TOOL_CALLS.test('const m = { role: "assistant", tool_calls: [tc] };'),
    "the tool_calls-emission detector must fire on a real emission, or this pin proves nothing",
  );
  assert.equal(OPENAI_TOOL_CALL_FINISH_REASON, "tool_calls", "the declared tool-call finish_reason must match the OpenAI vocabulary");

  await withDaemon("never-native", undefined, async (base, d) => {
    const data = (await getJson(base, "/v1/models")).body.data as ModelEntry[];
    const natives = data.filter((m) => m.tools === "native").map((m) => m.id);
    d.diagnostic(`entries=${data.length} claimingNative=${natives.length}`);
    assert.deepEqual(natives, [], "a model advertises tools:native with no native tool path in this handler");
  });
});

// --- (5) anti-vacuity: the load-bearing checks can actually go RED ------------

test("anti-vacuity: the field checker rejects an entry with the capability block REMOVED, and passes a complete one", () => {
  const stripped: ModelEntry = { id: "site-x", object: "model" };
  assert.deepEqual(
    missingFieldsOf([stripped]),
    CAPABILITY_FIELDS.map((f) => `site-x.${f}`),
    "an entry with the block removed must report EVERY field missing — this is the mutation-red proof for pin (2)",
  );
  const complete: ModelEntry = { id: "site-x", object: "model" };
  for (const f of CAPABILITY_FIELDS) complete[f] = f === "streaming" || f === "requiresRealBrowser" ? true : "x";
  assert.deepEqual(missingFieldsOf([complete]), [], "a complete entry must NOT be reported missing — the checker is not simply always-red");
});

test("anti-vacuity: the native-claim checks reject a daemon that advertises tools:native with no native path", async () => {
  // The advertised-set half: model the mutation (a native claim served) without
  // touching the source, and prove the same predicate the pin uses rejects it.
  const claimingNative = [{ id: "site-y", tools: "native" }, { id: "site-z", tools: "none" }];
  const offenders = claimingNative.filter((m) => m.tools === "native" && NATIVE_TOOL_CALL_SUPPORTED === false).map((m) => m.id);
  assert.deepEqual(offenders, ["site-y"], "the predicate must flag a native claim while no native path exists — the mutation-red proof for the native pin");
  // and it must NOT flag the honest entries, so the check is discriminating.
  const honest = claimingNative.filter((m) => m.tools !== "native").map((m) => m.id);
  assert.deepEqual(offenders.filter((id) => honest.includes(id)), [], "an honest entry must never be flagged");
});
