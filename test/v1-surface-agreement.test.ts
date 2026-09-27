import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPromptd } from "../src/prompt/http.js";
import { defaultChatSurface, buildRegistryPackages } from "../src/prompt/registry.js";
import { resolveProfile, type ChatSiteProfile } from "../src/profile/profile.js";
import type { ChatPool } from "../src/prompt/pool.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE /v1 SURFACE AGREEMENT PIN
//
// MEASURED (real promptd over loopback, stub pool, NO browser —
// `npx tsx` against src/, driving startPromptd on 127.0.0.1:0):
//
//   DEFAULT daemon (no --site):
//     GET /v1/models  -> 22 ids
//     all 22 completed through POST /v1/chat/completions  -> 22/22 HTTP 200
//     the 11 installed ids NOT on the list (adapta, araprat, chatglm, …)
//       -> 11/11 HTTP 404 with error.code = "unknown_model"
//       (0 generic 404s, 0 500s)
//     GET /registry -> 33 packages, 22 carrying chat.model
//     models \ registryChat = 0        registryChat \ models = 0     → EQUAL
//
//   ALLOW-LISTED daemon (--site gemini):
//     GET /v1/models  -> 1 id (gemini); it completes -> 1/1 HTTP 200
//     the 32 ids not on the list -> 32/32 HTTP 404 error.code "unknown_model"
//     models \ registryChat = 0        registryChat \ models = 21
//
// THE SECOND BLOCK IS WHY A "the two sets are equal" PIN WOULD BE WRONG.
// Equality is the DEFAULT posture's truth, not the contract: an explicit
// `--site` daemon legitimately serves a strict subset, and 21 of the 22
// registry chat ids are then unserved BY DESIGN (the allow-list, not a
// disagreement between the two gates). Pinning equality would go red on
// `promptd --site gemini`; pinning the reverse containment would go red on
// the same command. A pin that hardcodes one world-state is a snapshot.
//
// So this file pins the RELATION, in both directions, derived from what the
// code actually guarantees — never a hand-typed id list, never a count:
//
//   (a) models \ registryChat must be EMPTY in ANY daemon shape. A model the
//       daemon advertises on /v1/models while /registry declines to stamp it
//       chat is a defect whatever the allow-list says (this is the direction
//       the GOAL 34 truth-gate protects, and it holds universally).
//   (b) registryChat \ models must be a SUBSET of surface \ allowList. Every
//       registry chat id this daemon does not serve must be explained by the
//       daemon's OWN allow-list — never by an unexplained disagreement
//       between the two gates. On a default daemon the allow-list IS the
//       whole surface, so (b) collapses to equality and the strong claim is
//       asserted; on an allow-listed daemon it collapses to a subset.
//   (c) /v1/models and "what /v1/chat/completions will actually serve" are the
//       SAME set — both halves, every id, no sampling. This one IS exact
//       equality in every daemon shape, because both read the same
//       profilesById map; it is the surface's own self-consistency.
//   (d) an unlisted id gets the NAMED refusal: 404 + code "unknown_model" +
//       type "invalid_request_error" + param "model" — explicitly NOT the
//       generic terminal 404 (code "not_found") and NOT a 500.
//   (e) narrowing is real and is only narrowing (anti-vacuity: (a)/(b) must be
//       exercised in BOTH shapes, so neither can pass on empty sets).
//
// WHAT IS DELIBERATELY NOT PINNED: the number 22, and the membership of
// either set. Both move as packages are installed and gated; a pin carrying
// either is the snapshot this file exists to avoid.
// ─────────────────────────────────────────────────────────────────────────────

const STUB_ANSWER = "STUB-ANSWER";

/** A pre-built pool (the documented `opts.pool` test seam): every model that
 *  clears the model gate completes with a fixed answer. No page, no browser. */
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

/** Every request this file makes is bounded: a loopback daemon that wedged
 *  must fail the test, not hang it. */
const DEADLINE_MS = 20_000;

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(DEADLINE_MS) });
  return { status: res.status, body: await res.json() };
}

interface Refusal {
  status: number;
  code: string;
  type: string;
  param: string;
  message: string;
}

async function askModel(base: string, model: string): Promise<{ status: number; body: any }> {
  return await (async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    return { status: res.status, body: await res.json() };
  })();
}

function refusalOf(body: any): Refusal {
  const e = body?.error ?? {};
  return {
    status: 0,
    code: String(e?.code ?? "<none>"),
    type: String(e?.type ?? "<none>"),
    param: String(e?.param ?? "<none>"),
    message: String(e?.message ?? "<none>"),
  };
}

/** Run a callback against a live default-or-allow-listed daemon. */
async function withDaemon<T>(
  label: string,
  profiles: ChatSiteProfile[] | undefined,
  fn: (base: string, t: { diagnostic(msg: string): void }) => Promise<T>,
): Promise<T> {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  process.env.UI2API_ATTACH_PORT = "1"; // nothing listens: a browser can never be reached
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-v1-agreement-"));
  const diagnostics: string[] = [];
  try {
    const svc = await startPromptd({
      port: 0,
      host: "127.0.0.1",
      dataDir, // HERMETIC vault — never the operator's real data/
      pool: stubPool(),
      ...(profiles ? { profiles } : {}),
    });
    try {
      return await fn(`http://127.0.0.1:${svc.port}`, {
        diagnostic: (m: string) => diagnostics.push(m),
      });
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

/** The three sets this file relates, each measured over the wire / from the
 *  same modules the daemon itself uses. */
interface Measured {
  modelIds: string[];
  registryChatIds: string[];
  surfaceIds: string[];
  allowListIds: string[];
}

async function measure(base: string, allowListIds: string[]): Promise<Measured> {
  const models = await getJson(base, "/v1/models");
  assert.equal(models.status, 200, "GET /v1/models must answer 200");
  const registry = await getJson(base, "/registry");
  assert.equal(registry.status, 200, "GET /registry must answer 200");
  return {
    modelIds: (models.body.data as Array<{ id: string }>).map((m) => m.id),
    registryChatIds: (registry.body.packages as Array<{ id: string; chat?: { model?: string } }>)
      .filter((p) => p.chat && p.chat.model)
      .map((p) => String(p.chat!.model))
      .sort(),
    surfaceIds: defaultChatSurface().map((e) => e.id),
    allowListIds,
  };
}

const sorted = (xs: string[]): string[] => [...xs].sort();
const difference = (a: string[], b: string[]): string[] => a.filter((x) => !b.includes(x));

// ── (c) /v1/models IS the servable set, in both directions ──────────────────

test("/v1: every id GET /v1/models lists actually completes through POST /v1/chat/completions", async (t) => {
  await withDaemon("models-servable", undefined, async (base, d) => {
    const m = await measure(base, []);
    assert.ok(m.modelIds.length > 0, "anti-vacuity: /v1/models must list at least one model");
    const notServed: string[] = [];
    for (const id of m.modelIds) {
      const r = await askModel(base, id);
      if (r.status !== 200) notServed.push(`${id} -> HTTP ${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 120)}`);
    }
    d.diagnostic(`/v1/models listed ${m.modelIds.length}, all completed: ${m.modelIds.length - notServed.length}`);
    assert.deepEqual(notServed, [], "every advertised model must actually complete (an advertised model the daemon cannot serve is the red line)");
  });
});

test("/v1: /v1/models and the servable set are EQUAL in both directions — nothing listed that cannot be served, nothing servable that is not listed", async (t) => {
  await withDaemon("models-both-ways", undefined, async (base, d) => {
    const m = await measure(base, []);
    const listed = new Set(m.modelIds);

    // forward: listed ⇒ servable
    const listedButUnservable: string[] = [];
    for (const id of m.modelIds) {
      const r = await askModel(base, id);
      if (r.status !== 200) listedButUnservable.push(id);
    }
    assert.deepEqual(listedButUnservable, [], "an id on /v1/models that /v1/chat/completions will not serve");

    // reverse: servable ⇒ listed. The half that matters probes ids OUTSIDE the
    // advertised set — every installed package the daemon did not list, plus a
    // nonsense id — and requires that NONE of them is servable. (Probing the
    // driveable surface instead would be vacuous on a default daemon: the
    // surface IS profilesById, so every member is listed by construction and
    // the loop can never find a difference.)
    const outside = [...buildRegistryPackages().map((p) => p.id), "no-such-model-xyz"].filter(
      (id) => !listed.has(id),
    );
    assert.ok(outside.length > 0, "anti-vacuity: expected ids outside the advertised set to probe");
    const servableButUnlisted: string[] = [];
    for (const id of outside) {
      const r = await askModel(base, id);
      if (r.status === 200) servableButUnlisted.push(id);
    }
    d.diagnostic(
      `listed=${m.modelIds.length} probed-outside=${outside.length} forward-diffs=${listedButUnservable.length} reverse-diffs=${servableButUnlisted.length}`,
    );
    assert.deepEqual(servableButUnlisted, [], "an id /v1/chat/completions serves that /v1/models does not advertise (a consumer would never find it)");
  });
});

// ── (d) the NAMED refusal ────────────────────────────────────────────────────

test("/v1: an id NOT on /v1/models gets the named unknown_model refusal — not a generic 404, not a 500", async (t) => {
  await withDaemon("unknown-model", undefined, async (base, d) => {
    const m = await measure(base, []);
    const listed = new Set(m.modelIds);
    // The unlisted ids are CHOSEN FROM THE MEASURED TREE (every installed
    // package the daemon did not list), not hand-typed, so the pin keeps
    // working as packages come and go.
    const installedIds = buildRegistryPackages().map((p) => p.id).filter((id) => !listed.has(id));
    assert.ok(installedIds.length > 0, "anti-vacuity: expected installed packages that are not chat models");
    const probes = [...installedIds, "no-such-model-xyz", "ui2api/no-such-model-xyz", "ui2api-no-such-model-xyz"];

    const bad: string[] = [];
    for (const id of probes) {
      const r = await askModel(base, id);
      const ref = refusalOf(r.body);
      if (
        r.status !== 404 ||
        ref.code !== "unknown_model" ||
        ref.type !== "invalid_request_error" ||
        ref.param !== "model"
      ) {
        bad.push(`${id}: HTTP ${r.status} code=${ref.code} type=${ref.type} param=${ref.param}`);
      }
    }
    d.diagnostic(`probed ${probes.length} unlisted ids, non-conforming refusals: ${bad.length}`);
    assert.deepEqual(
      bad,
      [],
      "an unknown model must be the NAMED refusal (404 + code unknown_model + type invalid_request_error + param model)",
    );
    // …and the generic terminal 404 must never be what an unknown model gets.
    const one = refusalOf((await askModel(base, "no-such-model-xyz")).body);
    assert.notEqual(one.code, "not_found", "the generic unknown-endpoint 404 must not answer a model refusal");
    assert.ok(one.message.length > 0, "the refusal names the model and the alternatives");
  });
});

// ── (a)+(b)+(e) the /registry <-> /v1 relation, in BOTH daemon shapes ───────

test("/registry chat.model and /v1/models agree in the direction the code guarantees — registry never under-claims a served model, and an unserved registry chat model is always explained by the allow-list", async (t) => {
  await withDaemon("registry-vs-v1-default", undefined, async (base, d) => {
    const m = await measure(base, []);
    const registryChat = new Set(m.registryChatIds);

    // (a) universal: nothing /v1/models advertises may be missing chat.model.
    const modelsWithoutChat = difference(m.modelIds, [...registryChat]);
    assert.deepEqual(
      modelsWithoutChat,
      [],
      "/v1/models advertises a model /registry does not stamp chat — an advertised model the registry says is not servable as chat",
    );

    // (b) the reverse, as a RELATION: every registry chat model this daemon
    // does not serve must be explained by the daemon's own allow-list. A
    // default daemon's allow-list IS the whole driveable surface, so this
    // reduces to set equality — the strong claim, asserted without naming a
    // single id or a count.
    const explainedBy = difference(m.surfaceIds, m.allowListIds);
    const unexplained = difference(difference(m.registryChatIds, m.modelIds), explainedBy);
    d.diagnostic(
      `default: models=${m.modelIds.length} registryChat=${m.registryChatIds.length} surface=${m.surfaceIds.length} ` +
        `under-claimed=${modelsWithoutChat.length} unserved-registry-chat=${difference(m.registryChatIds, m.modelIds).length} unexplained=${unexplained.length}`,
    );
    assert.deepEqual(
      unexplained,
      [],
      "a registry chat.model the daemon cannot serve, NOT explained by the allow-list — the two gates disagree",
    );
    // On a default daemon nothing is narrowed away, so the relation must in
    // fact be exact equality. Asserted as a derived consequence, not a count.
    assert.deepEqual(
      sorted(m.registryChatIds),
      sorted(m.modelIds),
      "a default daemon (no allow-list) must serve EXACTLY the registry chat set — in both directions",
    );
  });
});

test("/registry chat.model and /v1/models agree for an ALLOW-LISTED daemon too — narrowing shrinks /v1/models and nothing else", async (t) => {
  const one: ChatSiteProfile = resolveProfile("gemini");
  await withDaemon("registry-vs-v1-allowlist", [one], async (base, d) => {
    const m = await measure(base, [one.id]);
    const registryChat = new Set(m.registryChatIds);

    // (a) holds in this shape too: the served model is stamped chat.
    const modelsWithoutChat = difference(m.modelIds, [...registryChat]);
    assert.deepEqual(modelsWithoutChat, [], "even an allow-listed daemon's /v1/models must be a subset of the registry chat set");

    // the allow-listed id is really served (the narrowing is not a total blackout)
    const served = await askModel(base, one.id);
    assert.equal(served.status, 200, `the allow-listed model "${one.id}" must complete`);

    // (b) the unserved registry chat models are exactly the ones the allow-list
    // removed — measured, not asserted as a literal subset claim.
    const explainedBy = difference(m.surfaceIds, m.allowListIds);
    const unservedRegistryChat = difference(m.registryChatIds, m.modelIds);
    const unexplained = difference(unservedRegistryChat, explainedBy);
    d.diagnostic(
      `allow-listed: models=${m.modelIds.length} registryChat=${m.registryChatIds.length} ` +
        `unserved-registry-chat=${unservedRegistryChat.length} explained-by-allowlist=${explainedBy.length} unexplained=${unexplained.length}`,
    );
    assert.deepEqual(unexplained, [], "an unserved registry chat.model that the allow-list does NOT explain — the two gates disagree");
    // (e) anti-vacuity + the "only narrowing" half: the allow-listed set is a
    // STRICT subset of the default set, and strictly smaller.
    assert.ok(m.modelIds.length < m.surfaceIds.length, "an allow-listed daemon must serve strictly fewer models than the default surface");
    assert.deepEqual(difference(m.modelIds, m.surfaceIds), [], "narrowing may only REMOVE models, never add one the driveable surface does not have");
    assert.ok(unservedRegistryChat.length > 0, "anti-vacuity: the allow-list must actually leave registry chat models unserved, or this pin proves nothing");
  });
});
