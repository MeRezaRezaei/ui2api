// ABSTRACTION GATE — the operator's own decisive test for this project:
//
//     "can an EXTERNAL AI agent drive these chat sites through an
//      OpenAI-compatible socket with ZERO knowledge of ui2api internals?"
//
// The project's mission is "full feature ... so we can connect other ai agents
// to these sites". That test had NO GATE. What existed was
// `test/generated-doc-truth.test.ts:173` — a PORTABILITY pin (generated code
// must not embed machine paths). It cannot see an abstraction leak: a generated
// client that faithfully reproduced the vault-account concept would pass it
// happily, because the problem is not a path, it is a CONCEPT.
//
// WHAT IS MEASURED HERE — behaviour, not text.
//
// A concept is a LEAK if a consumer of an OpenAI-compatible API could not
// guess it. That is a property of what the daemon DOES when asked, so the gate
// boots a real in-process daemon (stubbed pool — NO browser, NO network, NO
// Chrome, NO origin) and asks it, as an outside consumer would, using only
// values the daemon ITSELF published a moment earlier.
//
// NOTHING HERE IS A TYPED LIST. Three separate places would rot silently and
// rot the way this repo has been bitten before, so each is derived from code:
//
//   1. THE ROUTE SET      — reused from `./served-routes-truth.test.js`, which
//                           already derives the served routes from the source's
//                           own route table. Reused, not reimplemented: two
//                           copies of one extractor rot independently and then
//                           one of them is wrong in a way nothing notices
//                           (the precedent gate-wiring.test.ts sets).
//   2. THE SITE SET       — read live off GET /v1/models, i.e. from the daemon's
//                           OWN OpenAI surface. Not from BUILTIN_PROFILES, not
//                           from a constant: a site the daemon will not serve is
//                           not a site the gate has opinions about.
//   3. THE CONCEPT SET    — the internal-concept vocabulary is extracted from
//                           the CODE that reads request parameters (every
//                           `searchParams.get(...)` / `body.<name>` read across
//                           the two route files), MINUS the public vocabulary
//                           derived from the OpenAI-compatible surface itself.
//                           A concept nobody's code names cannot leak, and a
//                           concept the OpenAI surface names is not a leak by
//                           definition — so the difference is exactly the set
//                           under test, and it moves when the code moves.
//
// FAIL-LOUD, NOT SILENT. The bug class this file is named for is a static
// derivation that quietly returns nothing (an `indexOf` -> -1 -> whole-file
// slice, a regex that stops matching) and is then vacuously GREEN. So every
// derivation here asserts its own non-vacuity: if the route extractor drops,
// if /v1/models publishes no models, if the concept extractor finds fewer
// internal params than the code demonstrably reads, the gate FAILS with the
// reason — it never passes by reading nothing.
//
// WHAT IT DOES NOT CLAIM: nothing here proves any site WORKS. It is hermetic —
// no browser, no origin, no answer. It proves only that a consumer can NAME
// what it wants without knowing an internal. Read it as "the vocabulary is
// clean", never as "the product works".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { servedRoutes, SERVED_ROUTES } from "./served-routes-truth.test.js";
import { startPromptd } from "../src/prompt/http.js";
import { CAPABILITY_DISPATCH, dispatchableSiteIds } from "../src/prompt/capability-dispatch.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HTTP_SRC = readFileSync(join(ROOT, "src/prompt/http.ts"), "utf8");
const OPENAI_SRC = readFileSync(join(ROOT, "src/prompt/openai.ts"), "utf8");

// ---------------------------------------------------------------- derived ---

/** Route GUARDS as (method, path) pairs, read out of the source — with the
 *  method carried alongside, because a GET probe of a POST-only route 404s for
 *  a reason that has nothing to do with the property under test, and a gate that
 *  cannot tell those apart goes red on correct code (which is how a gate
 *  teaches people to ignore it).
 *
 *  MEASURED: the shared `servedRoutes` extractor in ./served-routes-truth is
 *  BLIND to two real shapes — `req.url?.startsWith("/capabilities")` (its regex
 *  requires `.startsWith` immediately after the identifier, so the optional
 *  chain `?.` defeats it) and `path === "/v1/models"` in openai.ts (it only
 *  matches `url`/`pathname`). It reads 12 routes where the daemon serves 15.
 *  This extractor matches the shapes the code ACTUALLY uses, and the
 *  non-vacuity pin below cross-checks the two so a regression in either is loud.
 *  Reported as a finding for a file this change does not own. */
export function servedRouteGuards(src: string): Array<{ method: "GET" | "POST"; path: string }> {
  const out = new Map<string, { method: "GET" | "POST"; path: string }>();
  const add = (method: "GET" | "POST", path: string) => {
    const key = `${method} ${path}`;
    if (!out.has(key)) out.set(key, { method, path });
  };
  const urlName = "(?:req\\.url\\??|url|path|pathname)";
  for (const m of src.matchAll(
    new RegExp(`req\\.method\\s*===\\s*"(GET|POST)"[\\s\\S]{0,200}?${urlName}\\s*===\\s*"(\\/[a-zA-Z0-9/_-]*)"`, "g"),
  )) {
    add(m[1] as "GET" | "POST", m[2]!);
  }
  for (const m of src.matchAll(
    new RegExp(`${urlName}\\s*===\\s*"(\\/[a-zA-Z0-9/_-]*)"[\\s\\S]{0,200}?req\\.method\\s*===\\s*"(GET|POST)"`, "g"),
  )) {
    add(m[2] as "GET" | "POST", m[1]!);
  }
  for (const m of src.matchAll(
    new RegExp(`req\\.method\\s*===\\s*"(GET|POST)"[\\s\\S]{0,200}?${urlName}\\s*\\??\\.startsWith\\("(\\/[a-zA-Z0-9/_-]*)"\\)`, "g"),
  )) {
    add(m[1] as "GET" | "POST", m[2]!);
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** The request-input names the daemon reads, across BOTH route files. Nothing
 *  here classifies them — see `standardOpenAiRequest` for why. */
export function requestParamsFrom(...srcs: string[]): Set<string> {
  const out = new Set<string>();
  for (const src of srcs) {
    for (const m of src.matchAll(/searchParams\.get\("([a-zA-Z_][a-zA-Z0-9_]*)"\)/g)) out.add(m[1]!);
    for (const m of src.matchAll(/\bbody\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) out.add(m[1]!);
    for (const m of src.matchAll(/\bbody\["([a-zA-Z_][a-zA-Z0-9_]*)"\]/g)) out.add(m[1]!);
  }
  return out;
}

/** A body carrying ONLY the OpenAI chat-completions request fields — the one
 *  vocabulary a consumer of an OpenAI-compatible API can be assumed to know
 *  without reading a line of ui2api. It is a fact about the OPENAI SPEC (fixed,
 *  external, versioned), not about this codebase, which is why it is stated
 *  here rather than derived: there is nothing in the repo to derive it from, and
 *  a derivation of it would be a derivation of this project's own conventions
 *  dressed as an external standard — which is the mistake that would let
 *  `account` pass, since openai.ts reads `body.account` too.
 *
 *  The important consequence, and the reason the whole gate is shaped this way:
 *  a concept being INTERNAL is not statically derivable (the daemon reads
 *  `body.account`, and that is not what makes it internal — no OpenAI client
 *  would guess it). So the gate never classifies concepts. It asks the daemon
 *  BEHAVIOURALLY: a request carrying nothing but standard fields must never be
 *  refused for demanding something the caller never sent. */
export function standardOpenAiRequest(): Record<string, unknown> {
  // Only fields /v1 actually READS are included. `temperature` / `max_tokens`
  // are deliberately absent: openai.ts honours them only by REJECTING them
  // (`ignoredParametersOf`, openai.ts:645-650), so putting them in would make
  // this test measure a field the daemon refuses — a different property, and
  // one already pinned by openai-full-contract-truth.
  return { model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }], stream: false };
}

// ------------------------------------------------------- the live daemon ---

/** A pool that REFUSES to hand out a browser. If any gate assertion below ever
 *  needed a real answer, the daemon would hit this and the request would fail
 *  loudly — so a green run is also the proof that this gate is hermetic. */
function hermeticPool() {
  const breach: string[] = [];
  const boom = (what: string) => async () => {
    breach.push(what);
    throw new Error(`hermetic-gate: a browser was requested (${what})`);
  };
  const p: Record<string, unknown> = {
    acquire: boom("pool.acquire"),
    release: async () => {},
    sharedBrowser: boom("pool.sharedBrowser"),
    status: () => ({ workers: [], total: 0, max: 1 }),
    close: async () => {},
    startReaper: () => {},
    stopReaper: () => {},
  };
  return { p, breach };
}

type Reply = { status: number; text: string; json: any };

async function withConsumer<T>(
  fn: (ask: (method: "GET" | "POST", path: string, body?: unknown) => Promise<Reply>, breach: string[]) => Promise<T>,
): Promise<T> {
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-abstraction-"));
  const { p, breach } = hermeticPool();
  // An EMPTY data dir on purpose: the vault holds nothing, so any route that
  // needs an identity has to say so honestly rather than find a real one.
  const server = (await startPromptd({ port: 0, dataDir, pool: p } as never)) as {
    port?: number;
    address?: { port?: number };
    close?: () => void;
  };
  const port = server.port ?? server.address?.port;
  assert.ok(port, "the gate needs a bound port; startPromptd returned none");
  const ask = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, text, json };
  };
  try {
    return await fn(ask, breach);
  } finally {
    server.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ pins ---

describe("ABSTRACTION GATE: a consumer needs zero knowledge of ui2api internals", () => {
  test("the derivations are NON-VACUOUS — a gate that reads nothing fails, never passes", () => {
    // Both route files, because the daemon splits its surface across them:
    // src/prompt/http.ts serves the legacy + reflection routes and DELEGATES
    // /v1/* to src/prompt/openai.ts, which owns the actual /v1 handlers. A
    // derivation that read only http.ts would be blind to the OpenAI surface —
    // the very surface this gate exists to protect.
    const both = `${HTTP_SRC}\n${OPENAI_SRC}`;
    const routes = servedRoutes(both);
    const guards = servedRouteGuards(both);
    const guardPaths = new Set(guards.map((g) => g.path.replace(/\/$/, "") || "/"));
    // A floor catches a COLLAPSE (the extractor returning nothing). It is kept
    // well under the measured guard count (13 — `/` and `/requests/` are folded
    // into `/health` and `/requests` by their own `||` guards) so it is a
    // collapse detector, not a remembered snapshot that goes stale silently.
    // The load-bearing non-vacuity check is the cross-check just below it.
    assert.ok(
      guards.length >= 10,
      `the route-guard extractor read only ${guards.length} guards from the two route files. ` +
        `A silent drop here would make every pin below vacuously GREEN (the indexOf -> -1 ` +
        `bug class). Refusing to pass rather than measure nothing.`,
    );
    for (const required of ["/v1/models", "/v1/chat/completions", "/capabilities", "/capability", "/accounts"]) {
      assert.ok(
        guardPaths.has(required),
        `the route-guard extractor no longer sees ${required} — its target moved or the ` +
          `extraction went blind. Refusing to pass rather than measure nothing.`,
      );
    }
    // THE load-bearing non-vacuity check, and it is a CROSS-CHECK between two
    // independent derivations rather than a constant:
    //   * `servedRoutes` is the repo's own extractor, whose own gate
    //     (served-routes-truth.test.ts) pins the DECLARED served set;
    //   * `servedRouteGuards` reads the same source with the method attached
    //     and with the shapes `servedRoutes` is measurably blind to.
    // Every declared route must be found by the guard extractor too, or the
    // daemon serves something the guard derivation cannot see. That is a
    // derived expectation: it moves when either file moves, and it cannot be
    // satisfied by a stale number.
    const unguarded = SERVED_ROUTES.filter((r) => !guardPaths.has(r.replace(/\/$/, "") || "/"));
    assert.deepEqual(
      unguarded,
      [],
      `these routes are declared served and documented, but the guard extractor cannot ` +
        `find them in the source — one of the two derivations is blind: ${unguarded.join(", ")}`,
    );
    // The two extractors are independent readings of the same source. Where the
    // guard extractor finds a route the path extractor missed, the gap is a
    // real blind spot in `servedRoutes` (there are three: the `url?.startsWith`
    // shapes and openai's `path ===`). Pinning the gap keeps the blind spot
    // DISCLOSED instead of quietly re-narrowing if either extractor is edited.
    const gap = guards.map((g) => g.path).filter((p) => !routes.includes(p));
    assert.ok(
      gap.length >= 1,
      "the guard extractor found no route the path extractor missed — one of the two " +
        "has gone blind, and this cross-check can no longer see it",
    );
    // The request-input vocabulary the daemon reads, over BOTH route files. This
    // is asserted for ALIVENESS, never for a classification: the point is that
    // the derivation still sees the inputs, so the behavioural pin below is
    // measuring a live vocabulary rather than a hardcoded one.
    const params = requestParamsFrom(HTTP_SRC, OPENAI_SRC);
    assert.ok(
      params.has("account"),
      "the request-input extractor stopped finding `account` in the route sources — " +
        "the extraction is blind, not that the leak is gone",
    );
    assert.ok(
      params.size >= 5,
      `the request-input extractor found only ${params.size} inputs across the two route ` +
        `files; a near-empty reading means the extraction went blind`,
    );
  });

  test("THE PROPERTY, stated once: a request of ONLY standard OpenAI fields is never refused for demanding an input the caller never sent", async () => {
    // This is the general form of leak #1, and it is the reason the gate needs
    // no concept list. A consumer of an OpenAI-compatible API can be assumed to
    // know exactly one vocabulary — the spec's request fields. If a route
    // refuses such a request with an error instructing the caller to supply
    // something the spec has no field for, that route is demanding an internal
    // concept, whatever the concept is called. Naming it would require a
    // hand-maintained list, and a hand-maintained list is a snapshot.
    const body = standardOpenAiRequest();
    const nonStandard = Object.keys(body).filter((k) => !requestParamsFrom(OPENAI_SRC).has(k));
    assert.deepEqual(
      nonStandard,
      [],
      `the standard OpenAI request body must use only fields /v1 itself reads; ` +
        `${nonStandard.join(", ")} would make this test measure a field the daemon ignores`,
    );

    const guards = servedRouteGuards(`${HTTP_SRC}\n${OPENAI_SRC}`).filter(
      (g) => !g.path.startsWith("/capability/") && g.path !== "/",
    );
    await withConsumer(async (ask, breach) => {
      for (const { method, path } of guards) {
        if (method !== "POST") continue;
        const r = await ask("POST", path, body);
        const demands =
          /\baccount\b|\bvault\b|\bslug\b|\bsnapshot\b|\bprofile\b|\bselector\b|\brecipe\b/i.exec(r.text);
        assert.equal(
          demands,
          null,
          `POST ${path} refused a request carrying ONLY standard OpenAI fields, and the ` +
            `refusal demands the internal concept "${demands?.[0]}" — a consumer of an ` +
            `OpenAI-compatible API has no field for it. Body: ${r.text.slice(0, 200)}`,
        );
      }
      assert.deepEqual(breach, [], "no route may need a browser to answer a validation question");
    });
  });

  test("LEAK #1 (pinned CLOSED): browsing the capability surface needs NO vault identity", async () => {
    await withConsumer(async (ask, breach) => {
      // The site set is the daemon's OWN OpenAI surface — not a typed constant.
      const models = await ask("GET", "/v1/models");
      assert.equal(models.status, 200, `/v1/models must answer: ${models.text.slice(0, 200)}`);
      const ids: string[] = (models.json?.data ?? []).map((m: any) => m.id).filter(Boolean);
      assert.ok(ids.length >= 1, `/v1/models published no model ids: ${models.text.slice(0, 200)}`);

      // THE MEASUREMENT. A consumer that has just read /v1/models knows a model
      // id and nothing else — no vault, no slug, no email. It must be able to
      // ask "what can this site do?" from that id alone.
      for (const id of ids) {
        const browse = await ask("GET", `/capabilities?site=${encodeURIComponent(id)}`);
        assert.notEqual(
          browse.status,
          400,
          `GET /capabilities?site=${id} was REFUSED (400) for a consumer that supplied ` +
            `nothing but an id the daemon itself published on /v1/models. Requiring a ` +
            `vault identity to BROWSE is the internal-concept leak. Body: ${browse.text.slice(0, 200)}`,
        );
        assert.equal(
          browse.status,
          200,
          `GET /capabilities?site=${id} must ANSWER for an id from /v1/models: ${browse.text.slice(0, 200)}`,
        );
        // And the answer must be honest about not being a per-account read.
        assert.equal(
          browse.json?.probed,
          false,
          `the account-less browse answer for ${id} must not claim a fingerprint was read`,
        );
        assert.ok(
          Array.isArray(browse.json?.capabilities),
          `the browse answer for ${id} must carry the declared capability list`,
        );
      }
      assert.deepEqual(breach, [], "browsing must never have asked for a browser");
    });
  });

  test("LEAK #1 (narrowing check): the fix WIDENS the surface, it does not remove it", async () => {
    await withConsumer(async (ask) => {
      // The account-scoped read is the operation that genuinely needs an
      // identity. It must STILL require one, still be named, and must NOT
      // silently fall back to some other account's fingerprint. A gate satisfied
      // by deleting the guarded surface would be worse than no gate.
      const noAccount = await ask("GET", "/capabilities?site=gemini");
      assert.equal(noAccount.status, 200, "the account-less browse must answer");

      const bogusAccount = await ask("GET", "/capabilities?site=gemini&account=definitely-not-a-real-account");
      assert.equal(bogusAccount.status, 400, "an unresolvable account must still be refused, not silently substituted");
      assert.equal(
        bogusAccount.json?.error?.code,
        "no_stored_account",
        "the refusal must be a NAMED code a client can branch on, not prose",
      );

      // A missing `site` is a missing CONSUMER input — a named 400 is the
      // correct shape there (the brief's own line: naming the missing input is
      // fine; refusing to LIST is the leak).
      const noSite = await ask("GET", "/capabilities");
      assert.equal(noSite.status, 400);
      assert.match(noSite.text, /site/, "a missing site must be refused by naming the input the caller omitted");
      assert.doesNotMatch(
        noSite.text,
        /account/i,
        "the missing-site refusal must not also demand the internal `account` concept",
      );
    });
  });

  test("LEAK #2 (pinned as a BOUNDED SET): a capability name is drawn from the declared set, never free text", async () => {
    // VERDICT (measured, not assumed): the free-text `capability` field is an
    // intentional extension point whose safety rests on a manifest-declared
    // BOUNDED set, not a free-text passthrough into the DOM layer:
    //   * every dispatchable site has an installed package (measured: 33/33), so
    //     the pre-route guard can always enumerate the legal names;
    //   * an unknown name is refused BEFORE the runner, with the named code
    //     `unknown_capability` and the available set in the message;
    //   * a runner's own `default:` arm is a second, independent refusal
    //     (`src/capabilities/youtube.ts:241`).
    // So the gate pins the BOUNDEDNESS, and pins the two halves of it: the
    // dispatch table is not empty (non-vacuity), and an undeclared name is
    // refused by name rather than accepted.
    const sites = dispatchableSiteIds();
    assert.ok(sites.length >= 1, "the dispatch table exported no sites — the bounded-set pin would be vacuous");
    assert.deepEqual(
      Object.keys(CAPABILITY_DISPATCH).sort(),
      sites,
      "dispatchableSiteIds() must agree with the dispatch table it derives from",
    );

    await withConsumer(async (ask, breach) => {
      // Walk EVERY dispatchable site, not a sample: the original defect class in
      // this repo was a per-site copy-paste, which a sample hides.
      for (const site of sites) {
        const undeclared = await ask("POST", `/capability/${site}`, {
          capability: "definitely_not_a_declared_capability",
        });
        assert.equal(
          undeclared.status,
          400,
          `${site}: an undeclared capability must be refused, got ${undeclared.status}: ${undeclared.text.slice(0, 160)}`,
        );
        assert.equal(
          undeclared.json?.error?.code,
          "unknown_capability",
          `${site}: the refusal must carry the NAMED code "unknown_capability" so a ` +
            `consumer can branch on it — an undeclared name must never be silently accepted`,
        );
        assert.match(
          undeclared.text,
          /available:/,
          `${site}: the refusal must publish the declared set, or the name is a name ` +
            `a consumer could never have guessed`,
        );
      }
      assert.deepEqual(breach, [], "a refused capability must never reach a runner (no browser)");
    });
  });

  test("EVERY derived consumer route is actually served — the route set is not a claim", async () => {
    // Closes the loop on derivation (1): the extractor says these routes exist;
    // this says the daemon really answers them. A route that answers "unknown
    // endpoint" while the extractor still lists it means the extraction is
    // reading a comment, not a route — which is precisely the silent-drift
    // case. Probed with the METHOD the source declares, so a POST-only route is
    // not failed for answering a GET.
    const guards = servedRouteGuards(`${HTTP_SRC}\n${OPENAI_SRC}`).filter(
      // /prompt and /capability/<site> are exercised with real bodies by the
      // pins above; here an empty body would only measure their input checks.
      (g) => !g.path.startsWith("/capability/") && g.path !== "/" && g.path !== "/prompt",
    );
    await withConsumer(async (ask, breach) => {
      for (const { method, path } of guards) {
        const r = await ask(method, path, method === "POST" ? {} : undefined);
        assert.doesNotMatch(
          r.text,
          /unknown endpoint/i,
          `${method} ${path} is listed by the route-guard extractor but the daemon calls it ` +
            `an unknown endpoint — the extraction is reading something that is not a served route`,
        );
      }
      assert.deepEqual(breach, [], "route enumeration must never have asked for a browser");
    });
  });

});
