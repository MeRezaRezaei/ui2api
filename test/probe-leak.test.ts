import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));

import { startPromptd } from "../src/prompt/http.js";
import { answerableChatSurface, buildRegistryPackages } from "../src/prompt/registry.js";
import {
  consumerProse,
  envKnobsIn,
  goalRefsIn,
  internalProseSamples,
  mechanismTermsIn,
  proseRuleIds,
  proseRuleTokens,
  DECLARED_EXCEPTIONS,
} from "../src/prompt/consumer-surface.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";
import type { ChatPool } from "../src/prompt/pool.js";

/**
 * THE ABSTRACTION-LEAK TRUTH GATE
 *
 * The goal, verbatim: "finding out how we can use those ai sites full feature
 * by mapping to an open ai compatible so we can connect other ai agents to those
 * sites WITHOUT ANYTHING EVER KNOW HOW THE BEHIND THE SCENE WORKS."
 *
 * The behind-the-scene is a headed Chrome on a virtual display, a vault of
 * replayed sessions, DOM selectors, an anti-bot posture, replay-not-streaming
 * semantics, and a warm page pool. A LEAK is any consumer-visible byte that
 * forces a consumer to know one of those exists. The measure is not "is the
 * message pretty" — it is "does a consumer have to branch on this to function".
 *
 * WHAT IS ASSERTED HERE (the properties that must not rot):
 *   A. No consumer-facing /v1 error body may carry a browser-internal token.
 *   B. /v1/models alone must be sufficient to pick a servable model, in BOTH
 *      directions, with no hardcoded direction.
 *   C. Tool calling's absence must be HONEST (a null/omitted tool_calls with
 *      finish_reason "stop", never a fabricated call) — we do NOT assert that
 *      it succeeds; it is measured 0-for-1 cooperation.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: that streaming is incremental. It is not,
 * and pretending otherwise would be the lie. The gate pins that the disclosure
 * of that fact survives instead (see the streamingMode note in the report).
 *
 * ── WHY THE FORBIDDEN LIST IS DERIVED, NOT GUESSED ──────────────────────────
 * A hand-written blacklist rots in both directions: a new leak nobody thought
 * of slips through, and a token nobody emits sits there forever looking like
 * coverage. So every entry below is (token, file, line) and the gate ASSERTS
 * THE CITATION STILL RESOLVES — the literal must actually be present in that
 * file. If someone rewrites the message, this test fails loudly and the list
 * must be re-derived; it can never silently drift into fiction. The list is
 * therefore a machine-checked map of the code's own vocabulary.
 */

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * THE FORBIDDEN VOCABULARY, and the SITE that emits each token.
 *
 * `file` is resolved by SEARCHING the file for the token, never by trusting a
 * line number. A line cite rots on every unrelated edit above it — measured:
 * 21 of 30 cites in the first version of this table were already stale, three
 * lanes deep, and a pin that fires on noise trains the next reader to ignore
 * it. The property worth pinning is "this token is genuinely still in that
 * file", which a search proves and a line number cannot.
 *
 * `where` says whether the token is emitted on a CONSUMER-FACING surface
 * (the wire needs it redacted) or is internal-only prose that reaches a
 * consumer only because a route republishes it.
 */
type LeakWhere = "wire" | "republished" | "operator-only";

const LEAKS: ReadonlyArray<{ token: string; file: string; why: string; where: LeakWhere; cls: string }> = [
  // ── repo/source paths and CLI knobs a consumer must never be told to edit ──
  { token: "src/profile/profile.ts", file: "src/prompt/driver.ts", why: "names the repo source file to edit", where: "wire" , cls: "repo-path" },
  { token: "--profile", file: "src/prompt/driver.ts", why: "names our private tuning flag", where: "wire" , cls: "cli-flag" },
  { token: "--login", file: "src/prompt/driver.ts", why: "names our private capture CLI", where: "wire" , cls: "cli-flag" },
  { token: "UI2API_REQUEST_TIMEOUT_MS", file: "src/prompt/http.ts", why: "names our env knob", where: "wire" , cls: "env-knob" },
  { token: "UI2API_HEADED", file: "src/prompt/posture.ts", why: "names the headless/headed posture knob", where: "wire" , cls: "env-knob" },
  { token: "UI2API_ATTACH_PORT", file: "src/runtime/requirements.ts", why: "names the CDP attach knob + port", where: "republished" , cls: "env-knob" },

  // ── internal gate names (our bookkeeping is not the consumer's problem) ──
  { token: "GOAL 46", file: "src/prompt/driver.ts", why: "internal gate name", where: "wire" , cls: "gate-name" },
  { token: "GOAL 49", file: "src/runtime/session-store.ts", why: "internal gate name", where: "republished" , cls: "gate-name" },
  { token: "stale-echo", file: "src/prompt/driver.ts", why: "internal gate name", where: "wire" , cls: "gate-name" },

  // ── Playwright / browser internals ──
  { token: "Target page, context or browser has been closed", file: "src/prompt/driver.ts", why: "Playwright internal verbatim", where: "wire" , cls: "playwright" },
  { token: "no composer found on", file: "src/prompt/driver.ts", why: "reveals a DOM lookup against a page", where: "wire" , cls: "dom-lookup" },
  { token: "Page title:", file: "src/prompt/driver.ts", why: "reveals we read a live page's title", where: "wire" , cls: "dom-lookup" },
  { token: "browser.isConnected()", file: "src/prompt/pool.ts", why: "liveness probe leaks a Playwright expression", where: "wire" , cls: "playwright" },
  { token: "no browser handle", file: "src/prompt/pool.ts", why: "names the browser handle on the wire", where: "wire" , cls: "browser-liveness" },
  { token: "chrome sandbox disabled", file: "src/prompt/posture.ts", why: "names the browser binary and its flags", where: "wire" , cls: "browser-flags" },
  { token: "headed (", file: "src/runtime/requirements.ts", why: "names headfulness and the X display", where: "republished" , cls: "display" },
  { token: "connectOverCDP", file: "src/runtime/browser.ts", why: "names the CDP transport", where: "operator-only" , cls: "transport" },
  { token: "pool saturated ", file: "src/prompt/pool.ts", why: "names the warm-page pool", where: "wire" , cls: "pool" },
  { token: "pool_queue_timeout", file: "src/prompt/pool.ts", why: "names the warm-page pool", where: "wire" , cls: "pool" },

  // ── session / vault / credential concepts ──
  { token: "no stored session for", file: "src/prompt/driver.ts", why: "names the session vault", where: "wire" , cls: "vault-vocabulary" },
  { token: "no cookies and no localStorage", file: "src/runtime/session-store.ts", why: "names the credential stores", where: "republished" , cls: "credential-store" },
  { token: "vault replay", file: "capabilities/kimi/metadata.json", why: "names the session-replay mechanism", where: "republished" , cls: "mechanism" },
  { token: "headed real-Chrome", file: "capabilities/tencent-aistudio/metadata.json", why: "names the browser and headlessness", where: "republished" , cls: "mechanism" },
  { token: "Xvfb", file: "capabilities/duckduckgo/metadata.json", why: "names the virtual display", where: "republished" , cls: "display" },
  { token: "EdgeOne", file: "capabilities/tencent-aistudio/metadata.json", why: "names the site's anti-bot vendor", where: "republished" , cls: "anti-bot-vendor" },
  { token: "BARD_EMBED_CHAT_STORAGE_KEY_V2", file: "capabilities/gemini/metadata.json", why: "names a real localStorage credential key", where: "republished" , cls: "credential-key" },
  { token: "x-msh-shield-data", file: "capabilities/kimi/metadata.json", why: "names a real request header", where: "republished" , cls: "request-header" },
  { token: "profileDir", file: "src/runtime/session-store.ts", why: "leaks a host filesystem path", where: "republished" , cls: "host-path" },
  { token: "v.via", file: "src/prompt/registry.ts", why: "the sink that republished every package prose blob on the wire", where: "republished" , cls: "prose-sink" },
];

/** Where a token actually lives in `file`, searched rather than cited by line.
 *  Returns the 1-based line numbers it appears on, so a failure names the
 *  evidence without the test carrying a number that goes stale. */
function resolveToken(file: string, token: string): number[] {
  return read(file)
    .split("\n")
    .map((line, i) => (line.includes(token) ? i + 1 : 0))
    .filter(Boolean);
}

/** Absolute-path shape: any /home/<x>, /opt/<x>, /usr/bin, or a dotted .ts/.json repo path. */
const PATHY = /(?:\/(?:home|opt|usr|var|etc|tmp)\/)|(?:[A-Za-z0-9_./-]+\.(?:ts|js|mjs|json|tsx))/;
const URLY = /https?:\/\//;
const PORTY = /:\d{2,5}\b/;
const SELECTORY = /(?:locator\(|getByRole\(|waiting for |\[data-testid|\.hyc-content|::after|:has-text\()/;

function leaksIn(text: string): string[] {
  const hits: string[] = [];
  for (const l of LEAKS) if (text.includes(l.token)) hits.push(`${l.token}  (${l.file} — ${l.why})`);
  for (const [name, re] of [["filesystem/repo path", PATHY], ["URL", URLY], ["port", PORTY], ["selector", SELECTORY]] as const) {
    const m = text.match(re);
    if (m) hits.push(`${name}: ${JSON.stringify(m[0])}`);
  }
  return hits;
}

// ── the real messages the driver actually throws, replayed through /v1 ─────
// These are lifted from the driver source (each cited above), so the gate
// exercises the exact bytes a consumer would receive on a real failure.
const REAL_DRIVER_ERRORS = [
  "no composer found on copilot (https://copilot.microsoft.com) — the site UI may have changed. Tune copilot in src/profile/profile.ts or ship a JSON override (--profile FILE). Page title: Microsoft Copilot, url: https://copilot.microsoft.com/",
  "no composer found on huggingchat (https://huggingface.co/chat) — the site UI may have changed. Tune huggingchat in src/profile/profile.ts or ship a JSON override (--profile FILE). Page title: Hugging Face, url: https://huggingface.co/login?code_challenge=U_pTsATnyaFbSECRET&state=eyJ4",
  "page died reading the composer — Target page, context or browser has been closed",
  "no stored session for gemini account \"x\" on gemini.google.com (anonymous) — capture it first (ui2api profile capture <url> --login)",
  "copilot: newChat reset not verified on copilot: after clicking \"button.new\" — composer still empty (stale-echo guard, GOAL 46)",
  "no answer appeared on copilot within 30000ms. The page may be behind a consent wall — tune the profile's 'dismiss' selectors.",
];

const DEADLINE_MS = 30_000;

/** A pool whose driver throws a caller-chosen error, so we can watch the wire. */
function throwingPool(err: unknown): ChatPool {
  return {
    startReaper() {}, stopReaper() {}, async close() {},
    async acquire() {
      return { driver: { ask: async () => { throw err; } } };
    },
    async release() {},
    status: () => ({ pages: [], warm: 0, idle: 0, busy: 0 }),
  } as unknown as ChatPool;
}

function stubPool(): ChatPool {
  return {
    startReaper() {}, stopReaper() {}, async close() {},
    async acquire() {
      return {
        driver: {
          ask: async () => ({
            answer: "PONG", chunkCount: 1, doneReason: "stop",
            url: "https://example.invalid/chat", title: "stub",
          }),
        },
      };
    },
    async release() {},
    status: () => ({ pages: [], warm: 0, idle: 0, busy: 0 }),
  } as unknown as ChatPool;
}

async function withDaemon<T>(
  pool: ChatPool,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  process.env.UI2API_ATTACH_PORT = "1"; // nothing listens: a real browser is unreachable
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-leak-"));
  try {
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, pool });
    try { return await fn(`http://127.0.0.1:${svc.port}`); }
    finally { await svc.close(); }
  } finally {
    if (prevAttach === undefined) delete process.env.UI2API_ATTACH_PORT;
    else process.env.UI2API_ATTACH_PORT = prevAttach;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const sorted = (xs: string[]) => [...xs].sort();
const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

// ═══════════════════════════════════════════════════════════════════════════
describe("ABSTRACTION LEAK: the forbidden list is derived from the code, not guessed", () => {
  test("every forbidden token still resolves in its cited file (anti-rot for the blacklist itself)", () => {
    // CONTENT-ANCHORED, NOT LINE-CITED. The first version of this pin carried a
    // line number per entry and a +/-3 line window, on the theory that the
    // cited line was the head of a multi-line template literal. It rotted
    // immediately and then three times more: an unrelated edit 200 lines above
    // a message moved the cite, and the pin could no longer tell "this token
    // was deleted" from "this token moved", so it reported both as failure and
    // taught the next reader that a red pin here means nothing. The property
    // that is actually worth holding is "this token is still really in that
    // file" — a search proves it, and no unrelated edit can break it.
    const dead: string[] = [];
    for (const l of LEAKS) {
      let at: number[];
      try {
        at = resolveToken(l.file, l.token);
      } catch (e) {
        dead.push(`${l.token}  — cited file missing: ${l.file} (${(e as Error).message})`);
        continue;
      }
      if (at.length === 0) dead.push(`${l.token}  — NOT FOUND anywhere in ${l.file}. The token was deleted or renamed: re-derive the list.`);
    }
    assert.deepEqual(dead, [], `the forbidden list has rotted:\n${dead.join("\n")}`);
    assert.ok(LEAKS.length >= 25, `expected a substantive derived list, got ${LEAKS.length}`);
  });

  test("the derived list is DERIVED, not guessed: every token is the code's own vocabulary", () => {
    // Anti-guess: a token nobody emits is a token that looks like coverage
    // while catching nothing, and a token invented by the test author is a
    // blacklist describing a leak that does not exist. Both are checked by
    // CONTENT: the token must appear in the file, AND that file must be a real
    // source/prose file this repo actually ships (not a fixture the test made).
    for (const l of LEAKS) {
      const real = existsSync(join(ROOT, l.file));
      assert.ok(real, `${l.token}: cited file ${l.file} does not exist — a leak list that cites nothing is fiction`);
    }
    // The classes are all represented: a list that only ever caught one kind of
    // leak would pass every check above while missing the rest.
    // A list that only ever caught ONE kind of leak would pass every check
    // above while missing the rest, so the categories are tagged explicitly and
    // the coverage asserted over the tags: a tag with no member is a category
    // the list CLAIMS and does not hold.
    const classes = new Set(LEAKS.map((l) => l.cls));
    for (const cls of ["repo-path", "cli-flag", "env-knob", "gate-name", "playwright", "dom-lookup",
                       "browser-liveness", "browser-flags", "display", "transport", "pool",
                       "vault-vocabulary", "credential-store", "credential-key", "request-header",
                       "host-path", "mechanism", "anti-bot-vendor", "prose-sink"]) {
      assert.ok(classes.has(cls), `the list claims a "${cls}" leak class but holds no entry for it`);
    }
    for (const where of ["wire", "republished", "operator-only"] as const) {
      assert.ok(LEAKS.some((l) => l.where === where), `no entry is classified "${where}" — the classification is not load-bearing`);
    }
  });

  test("the detector fires on a known-leaking body (the scanner is not vacuous)", () => {
    assert.ok(leaksIn(REAL_DRIVER_ERRORS[0]).length >= 3, "scanner must catch the live copilot leak");
    assert.deepEqual(leaksIn("upstream model unavailable"), [], "a clean message must be clean");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("ABSTRACTION LEAK: no /v1 error body may carry a browser-internal token", () => {
  for (const msg of REAL_DRIVER_ERRORS) {
    test(`the driver error is not echoed: ${JSON.stringify(msg.slice(0, 58))}…`, async () => {
      await withDaemon(throwingPool(new Error(msg)), async (base) => {
        const { status, text } = await post(base, "/v1/chat/completions", {
          model: "gemini", messages: [{ role: "user", content: "hi" }],
        });
        const hits = leaksIn(text);
        assert.deepEqual(hits, [], `LEAKED to the consumer (HTTP ${status}):\n${hits.join("\n")}\n\nbody: ${text}`);
      });
    });
  }

  test("an unknown model is refused by name, without a roster of what we drive", async () => {
    await withDaemon(stubPool(), async (base) => {
      const { status, text } = await post(base, "/v1/chat/completions", {
        model: "definitely-not-a-model", messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(status, 404);
      assert.deepEqual(leaksIn(text), [], `LEAKED:\n${text}`);
      // A 404 that enumerates every site we drive hands out our fleet map.
      for (const id of answerableChatSurface().map((p) => p.id)) {
        assert.ok(!text.includes(`"${id}"`), `the refusal enumerated "${id}" — the roster is a leak`);
      }
    });
  });

  test("a malformed body and an empty message are refused without internals", async () => {
    await withDaemon(stubPool(), async (base) => {
      for (const body of [{}, { model: "gemini" }, { model: "gemini", messages: [] }]) {
        const { text } = await post(base, "/v1/chat/completions", body);
        assert.deepEqual(leaksIn(text), [], `LEAKED on ${JSON.stringify(body)}:\n${text}`);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("ABSTRACTION LEAK: /v1/models alone is sufficient to pick a servable model", () => {
  test("bidirectional agreement, no hardcoded direction, both sets non-empty", async () => {
    await withDaemon(stubPool(), async (base) => {
      const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(DEADLINE_MS) });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      assert.ok(Array.isArray(body.data), `/v1/models must carry a data array, got ${JSON.stringify(body).slice(0, 200)}`);
      const advertised = sorted((body.data as Array<{ id: string }>).map((m) => m.id));

      // THE ORACLE IS THE ANSWERABLE SURFACE, not the addressable one. The
      // first version of this test compared /v1/models against
      // `defaultChatSurface()` (everything /prompt will route) and reported the
      // measured gap as a failure — but that gap is the DESIGN: GOAL 159
      // withholds a `chat` key from a package whose verification record does not
      // say it answers, precisely so a consumer materialising one provider per
      // advertised model never builds a provider that cannot answer. Comparing
      // against the addressable surface asserted the opposite of the property
      // the gate exists to hold, so the test could only ever be satisfied by
      // advertising a promise nothing measured. The property that DOES matter
      // for a consumer is one-directional and is asserted below: everything the
      // catalogue offers must be servable, and nothing servable may be missing
      // from what the catalogue is built from.
      const offered = sorted(answerableChatSurface().map((e) => e.id));

      assert.ok(advertised.length > 0, "advertised set must be non-empty or this proves nothing");
      assert.ok(offered.length > 0, "offered set must be non-empty or this proves nothing");

      // Direction 1: nothing advertised that we cannot serve.
      assert.deepEqual(diff(advertised, offered), [], "/v1/models advertises a model that cannot be served");
      // Direction 2: nothing offered that we failed to advertise.
      assert.deepEqual(diff(offered, advertised), [], "a servable model is missing from /v1/models");
      // The withholding itself is pinned so the oracle above cannot be swapped
      // back silently: an addressable id with no measured ANSWERS record is
      // absent from /v1/models, and the registry NAMES why in `chatWithheld`
      // rather than dropping it without explanation.
      const pkgs = buildRegistryPackages();
      for (const p of pkgs) {
        if (!p.chat && p.chatWithheld) {
          assert.ok(!advertised.includes(p.id), `"${p.id}" is withheld with a named reason yet is advertised`);
          assert.ok(p.chatWithheld.reason.trim().length > 0, `"${p.id}" is withheld without saying why`);
        }
      }
    });
  });

  test("every advertised id is actually ACCEPTED by the endpoint (forward, over the wire)", async () => {
    await withDaemon(stubPool(), async (base) => {
      const body = (await (await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(DEADLINE_MS) })).json()) as {
        data: Array<{ id: string }>;
      };
      const refused: string[] = [];
      for (const { id } of body.data) {
        const { status } = await post(base, "/v1/chat/completions", {
          model: id, messages: [{ role: "user", content: "hi" }],
        });
        if (status === 404) refused.push(id);
      }
      assert.deepEqual(refused, [], "models that /v1/models advertises but the endpoint refuses");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("ABSTRACTION LEAK: a DISCLOSURE is not a lie (pinned so honesty survives)", () => {
  test("a successful answer discloses its site, and never claims incremental streaming", async () => {
    await withDaemon(stubPool(), async (base) => {
      const { text } = await post(base, "/v1/chat/completions", {
        model: "gemini", messages: [{ role: "user", content: "hi" }],
      });
      const j = JSON.parse(text) as { choices: Array<{ message: { content: string } }> };
      assert.equal(j.choices[0].message.content, "PONG");
      // The `ui2api` block currently carries the live page url/title. That IS a
      // leak and is reported as one — but the gate pins the honest half: the
      // consumer is never told the stream was incremental when it was not.
      const body = (await (await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(DEADLINE_MS) })).json()) as {
        data: Array<{ id: string; streamingMode?: string; streaming?: boolean }>;
      };
      for (const m of body.data) {
        assert.notEqual(m.streamingMode, "incremental", `model "${m.id}" falsely advertises incremental streaming`);
      }
    });
  });

  test("tool calling is HONEST when unparsed: no fabricated call, and no claim it exists", async () => {
    // Measured 0-for-1: the model answers directly and ignores the instruction.
    // We do NOT assert it works. We assert the failure is honest — an absent
    // tool_calls with finish_reason "stop", never a half-built call object.
    await withDaemon(stubPool(), async (base) => {
      const { text } = await post(base, "/v1/chat/completions", {
        model: "gemini",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
      });
      const j = JSON.parse(text) as {
        choices: Array<{ finish_reason: string; message: { tool_calls?: unknown[] } }>;
      };
      const msg = j.choices[0].message;
      if (msg.tool_calls === undefined) {
        assert.equal(j.choices[0].finish_reason, "stop", "no call was made, so the finish reason must be 'stop'");
      } else {
        // If a call IS ever parsed it must be well-formed — never a stub.
        for (const c of msg.tool_calls as Array<Record<string, unknown>>) {
          assert.equal(typeof c.id, "string");
          assert.equal((c.function as Record<string, unknown>).name, "get_weather");
        }
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GOAL 162, PART THREE — `consumerProse()`'s leak classes are DERIVED FROM THE
// CODE, so the redaction table can no longer rot OPEN.
//
// THE DEFECT THIS REPLACES. `consumerProse()` redacts an operator's manifest
// prose before the registry republishes it as a consumer-facing tool
// `description`. Its vocabulary was a TABLE — a redaction list, which can only
// SHRINK when somebody remembers to widen it. A table that can rot open is not
// a gate; it is a comment asking to be maintained, and this project has a long
// history of paying for exactly that.
//
// WHAT IS DERIVED, AND WHAT HONESTLY IS NOT:
//
//   DERIVED (facts about the tree — a machine can count them):
//     * every `UI2API_*` knob the CODE reads, scanned out of src/ and scripts/
//     * every `GOAL nn` bookkeeping reference in the tree
//     * every prose sample a source file DECLARES with the `// @internal-prose
//       <class>` marker, harvested from the code itself — never hand-copied
//
//   NOT DERIVABLE, and said so rather than pretended away: the CONCEPT WORDS.
//   No scan of a codebase can tell you that the word "Xvfb" is internal — only
//   a person knows that. So the lexicon stays hand-declared, in ONE place
//   (`proseRuleIds()`), and this gate's leverage is applied where it is real:
//   every derived obligation must actually be REDACTED. A new knob, a new goal
//   reference, or a new marker-declared class fails HERE. Only a genuinely new
//   concept word needs a new entry in that one list — and adding it is a
//   visible edit in one file, not a silent leak in production.
describe("CONSUMER PROSE: the leak classes are derived from the code, not remembered", () => {
  /** Every file whose prose can reach the consumer: the source we ship, the ops
   *  scripts the docs tell an operator to run, and the per-site capability
   *  packages whose manifests are republished as tool descriptions. Scanned by
   *  directory walk, so a NEW site package is covered the day it lands. */
  function proseSources(): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          walk(child);
        } else if (/\.(ts|json|md)$/.test(e.name)) {
          out.push(child);
        }
      }
    };
    for (const top of ["src", "scripts", "capabilities"]) {
      if (existsSync(join(ROOT, top))) walk(top);
    }
    return out;
  }

  test("every env knob the CODE reads is removed by consumerProse — the rule cannot be narrowed to a remembered list", () => {
    const knobs = envKnobsIn(ROOT, proseSources());
    assert.ok(knobs.length >= 10, `the knob derivation read only ${knobs.length} — a walk that collapsed proves nothing`);
    const survivors = knobs.filter((k) => consumerProse(`set ${k}=9222 to attach`).includes(k));
    assert.deepEqual(
      survivors,
      [],
      `consumerProse() no longer redacts these knobs, which the code itself reads: ${survivors.join(", ")}. ` +
        `A knob added to the code is covered BY CONSTRUCTION; this is the pin that keeps it so.`,
    );
  });

  test("every GOAL nn reference in the tree is removed, and the DATE beside it survives", () => {
    const refs = goalRefsIn(ROOT, proseSources());
    assert.ok(refs.length >= 1, "the goal-reference derivation read nothing — refusing to pass on a collapsed walk");
    for (const ref of refs.slice(0, 200)) {
      const out = consumerProse(`${ref} measured 2026-09-23 on a real round-trip`);
      assert.ok(!out.includes(ref), `consumerProse() leaked the internal gate number ${ref}: ${out}`);
      assert.ok(
        out.includes("2026-09-23"),
        `the redaction deleted the DATE too — that is a second lie. A dated record is a disclosure a consumer branches on, and ${ref} must go without taking it: ${out}`,
      );
    }
  });

  test("every marker-declared internal prose class is covered by a rule (the marker convention is load-bearing)", () => {
    const samples = internalProseSamples(ROOT, proseSources());
    assert.ok(
      samples.length >= 1,
      "no source file declares an `// @internal-prose <class>` marker — the convention has no member, which means " +
        "it is a convention in a comment rather than a mechanism. This is an anti-vacuity floor, not a coverage claim.",
    );
    const declared = new Set(proseRuleIds());
    const uncovered = samples.filter((s) => !declared.has(s.cls)).map((s) => `${s.cls} (${s.file}:${s.line})`);
    assert.deepEqual(
      uncovered,
      [],
      `these classes are declared in the CODE but have no redaction rule in proseRuleIds(): ${uncovered.join(", ")}. ` +
        `A prose class nobody declared a rule for is published to every consumer verbatim.`,
    );
    // …and the coverage is proven against the code's OWN harvested text, not a
    // fixture somebody typed to please the rule.
    const tokens = proseRuleTokens();
    for (const s of samples) {
      const redactions = (tokens[s.cls] ?? []).filter((re) => re.test(s.text));
      assert.ok(
        redactions.length > 0,
        `the sample at ${s.file}:${s.line} is declared "${s.cls}" but none of that class's tokens occur in it: ${JSON.stringify(s.text)} — ` +
          `either the class is mislabelled or the sample moved.`,
      );
      const out = consumerProse(s.text);
      for (const re of redactions) {
        assert.ok(!re.test(out), `consumerProse() left ${String(re)} in the ${s.cls} sample from ${s.file}:${s.line}: ${out}`);
      }
    }
  });

  test("NEGATIVE: the derivation catches a NEW internal phrase the class list never named", () => {
    // The property the whole section exists for, proven by making the gate fail
    // on a body it has never seen. If this ever passes vacuously, the derivation
    // is decoration.
    const novel = "GOAL 999 measured 2026-09-30; attach via UI2API_TOTALLY_NEW_KNOB=9222 on a real Chrome under Xvfb";
    const out = consumerProse(novel);
    assert.ok(!/\bGOAL\s+\d+\b/.test(out), `a goal number survived: ${out}`);
    assert.ok(!/UI2API_TOTALLY_NEW_KNOB/.test(out), `an unseen env knob survived: ${out}`);
    assert.ok(!/real Chrome/.test(out), `the mechanism survived: ${out}`);
    assert.ok(!/Xvfb/.test(out), `the display mechanism survived: ${out}`);
    assert.ok(out.includes("2026-09-30"), `the redaction took the disclosure date too: ${out}`);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GOAL 167 — THE CONCEPT WORDS ARE MOSTLY DERIVABLE, AND THE HARD-CODED LIST
 * WAS BOUNDED BY A CLAIM THAT MEASUREMENT REFUTED.
 *
 * THE DEFECT THIS REPLACES. Runner-up #3 in `.brain/verbatim-goals.md` read:
 * "concept words (`Chrome`, `Xvfb`, `CDP`, `headless`) cannot be derived, so the
 * consumer-prose gate's leverage is bounded by what no scan can know." The
 * supporting comment in `consumer-surface.ts` asserted that "no amount of
 * scanning the code can tell you that the word `Xvfb` is internal".
 *
 * MEASURED, that was FALSE for three of the four — and the falsification was not
 * academic. Each of the four hand-typed rules had a LIVE HOLE its exact-match
 * form could not see, because the rule named one string while the leak arrived
 * as a sibling:
 *
 *     rule `/\breal Chrome\b/i`   bare `Chrome` and `google-chrome` SURVIVED
 *     rule `/\bXvfb\b/`           lowercase `xvfb` SURVIVED
 *     rule `/\bCDP\b/`            lowercase `cdp` SURVIVED
 *     rule `/\bheadless|headed\b/i`  `headful` SURVIVED
 *
 * So the honest disposition is per term, decided by measurement:
 *
 *   Chrome  → (b) DERIVABLE. `CHROME_SYSTEM_PATHS` / `CHROME_CHROMIUM_PATHS`
 *             (`src/runtime/browser.ts`) and `PROFILE_CANDIDATES`
 *             (`src/runtime/chrome-owner.ts:41`) are closed arrays whose string
 *             literals name the binaries the launch seam RESOLVES.
 *   Xvfb    → (b) DERIVABLE. `has("Xvfb")` (`src/runtime/requirements.ts:453`)
 *             is a literal naming a PROGRAM the readiness checker RUNS.
 *   headless→ (b) DERIVABLE. `args.push("--headless=new")`
 *             (`src/runtime/chrome-daemon.ts:303`) is a flag passed to the browser.
 *   CDP     → (c) DECLARED EXCEPTION. Measured: it occurs in `src/` only inside
 *             comments and inside `error-redaction.ts`'s own alternation. No
 *             name, key, id, probe, ladder, flag or dependency carries it, so a
 *             scan has nothing to read. Pinned by `DECLARED_EXCEPTIONS`.
 *
 * AND THE SHAPE-BASED ALTERNATIVE WAS MEASURED AND REJECTED, because the honest
 * answer here is not always the cleverer one. "Redact any capitalised token that
 * is not a site name" catches all four plus 276 further distinct tokens across
 * the real 162-description corpus — including `Answer`, `Capability`, `Search`,
 * `Tool`, `Image`, `Response`, `Request`, `model` and `session`. A gate that
 * redacts "model" and "Tool" cries wolf on the words a consumer legitimately
 * uses, so the derivation is anchored to a POSITION (a probe argument, a closed
 * path array, a browser-args push) rather than to a letter case.
 */
describe("CONSUMER PROSE: the mechanism nouns are derived from exec surfaces, and the exceptions are pinned", () => {
  /** The sources a mechanism noun can come from: shipped source and the ops
   *  scripts the docs tell an operator to run. `proseSources()` above also walks
   *  `capabilities/`, but a manifest is PROSE and must never be able to declare
   *  an obligation on the gate — that would make the thing being measured the
   *  thing doing the measuring. */
  function mechanismSources(): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        if (e.isDirectory()) walk(child);
        else if (/\.(ts|tsx|js|sh)$/.test(e.name)) out.push(child);
      }
    };
    for (const top of ["src", "scripts"]) if (existsSync(join(ROOT, top))) walk(top);
    return out;
  }

  test("NON-VACUITY: the derivation reads a real vocabulary, and it does not read ITSELF", () => {
    const files = mechanismSources();
    const terms = mechanismTermsIn(ROOT, files);
    // A collapsed walk would make every pin below vacuously GREEN.
    assert.ok(
      terms.size >= 8,
      `the mechanism derivation read only ${terms.size} terms from ${files.length} files — ` +
        `a walk that collapsed proves nothing`,
    );
    // …and it must be reading the TREE, not this gate's own prose about the
    // tree. `consumer-surface.ts` quotes `has("Xvfb")` and
    // `args.push("--headless=new")` as examples of the witnesses; a derivation
    // that read its own documentation would MANUFACTURE the obligations it is
    // supposed to discover, and could be satisfied by editing a comment.
    for (const [term, where] of terms) {
      assert.doesNotMatch(
        where,
        /^src\/prompt\/consumer-surface\.ts/,
        `"${term}" was derived from consumer-surface.ts's own doc comment (${where}). The ` +
          `derivation must read the tree, never its own description of the tree — otherwise ` +
          `editing this comment satisfies the gate.`,
      );
    }
    // The three terms the goals index named as NON-derivable must now come from
    // the real witnesses, named by file and line.
    const expected: Record<string, RegExp> = {
      chrome: /src\/runtime\/browser\.ts:\d+$/,
      xvfb: /src\/runtime\/requirements\.ts:\d+$/,
      headless: /src\/runtime\/chrome-daemon\.ts:\d+$/,
    };
    for (const term of Object.keys(expected)) {
      assert.ok(terms.has(term), `"${term}" is no longer derived at all — the exec surface it came from moved`);
      assert.match(terms.get(term)!, expected[term]!, `"${term}" derived from the wrong witness: ${terms.get(term)}`);
    }
  });

  test("every DERIVED mechanism noun is removed by consumerProse (the list cannot rot open)", () => {
    const terms = mechanismTermsIn(ROOT, mechanismSources());
    assert.ok(terms.size >= 8, "the derivation read nothing — refusing to pass on a collapsed walk");
    const survivors: string[] = [];
    for (const [term, where] of terms) {
      // Probe three shapes, because a rule that matches one spelling and not its
      // siblings is exactly the defect this goal closes.
      for (const probe of [`probe ${term} probe`, `probe ${term.toUpperCase()} probe`, `probe ${term.toUpperCase()}-STABLE probe`]) {
        const out = consumerProse(probe).toLowerCase();
        if (out.includes(term)) survivors.push(`${term} (${where}) leaked from ${JSON.stringify(probe)} -> ${JSON.stringify(out)}`);
      }
    }
    assert.deepEqual(
      survivors,
      [],
      `consumerProse() no longer redacts these mechanism nouns, which the CODE names as things ` +
        `it executes:\n  ${survivors.join("\n  ")}\nA browser binary added to a ladder, a program ` +
        `added to a readiness probe, or a launch flag added to the browser args is covered BY ` +
        `CONSTRUCTION; this pin is what keeps it so.`,
    );
  });

  test("the derivation catches a mechanism noun NOBODY wrote down — the RED half", () => {
    // The anti-vacuity half, in the direction that matters: a term the class
    // list never named, in a spelling it never named, must still be removed.
    // Every one of these is a SIBLING of a declared term, not the term itself —
    // each survived the old exact-match rules (measured on the old table).
    const undeclared = [
      "attach via the user's google-chrome build",
      "the ui2api-chrome profile directory",
      "run it under xvfb on :99",
      "the browser was spawned headful, not headless",
      "spoken over cdp to the endpoint",
      "Playwright/CDP UI path: type into the composer",
      "the Chromium executable is missing",
    ];
    for (const body of undeclared) {
      const out = consumerProse(body);
      for (const leak of [/google-chrome/i, /ui2api-chrome/i, /\bxvfb\b/i, /\bheadful\b/i, /\bheadless\b/i, /\bcdp\b/i, /\bplaywright\b/i, /\bchromium\b/i]) {
        assert.ok(
          !leak.test(out),
          `a mechanism noun the rule list never named survived consumerProse().\n  in : ${body}\n  out: ${out}\n  leaked: ${leak}`,
        );
      }
    }
  });

  test("FALSE-POSITIVE: the ordinary words a consumer legitimately reads are NOT redacted", () => {
    // The other half, and the one that decides whether this goal was worth doing.
    // A gate loosened until it catches everything catches nothing, so these are
    // the words the shape-based rule would have eaten (measured: all of them are
    // among the 276 tokens it flags) and this gate must leave alone.
    const allowed = [
      "Answer", "Capability", "Search", "Tool", "Image", "Response", "Request",
      "model", "session", "account", "message", "stream", "citation", "upload",
      "conversation", "history", "attachment", "summary", "reasoning", "composer",
      "Answer, Capability, Search, Tool, Image, Response, Request, model, session",
    ];
    for (const word of allowed) {
      const body = `the ${word} is available`;
      assert.equal(
        consumerProse(body),
        body,
        `consumerProse() mangled an ordinary consumer word: ${JSON.stringify(body)} -> ${JSON.stringify(consumerProse(body))}. ` +
          `Redacting vocabulary a consumer legitimately reads is a gate that cries wolf, which is worse ` +
          `than a narrow honest one.`,
      );
    }
    // …and the DISCLOSURES must survive the mechanism redaction, exactly as they
    // do for the knob and goal classes: a redaction that eats the diagnosis is a
    // second lie.
    const dated = "LIVE-VERIFIED 2026-09-20 on headed Chrome: 60 results returned";
    const out = consumerProse(dated);
    assert.ok(!/chrome/i.test(out), `the mechanism must go: ${out}`);
    assert.ok(out.includes("2026-09-20"), `the redaction took the disclosure date too: ${out}`);
    assert.ok(/LIVE-VERIFIED/.test(out), `the redaction took the verification verdict too: ${out}`);
  });

  test("the ONE non-derivable term is a DECLARED exception that carries its reason and still works", () => {
    // Disposition (c), done honestly: not derived, so not pretended to be. The
    // list must stay short, every entry must justify itself in writing, and every
    // entry must ACTUALLY be redacted — an exception that stopped working while
    // still being listed is the worst of both worlds.
    assert.ok(
      DECLARED_EXCEPTIONS.length >= 1,
      "DECLARED_EXCEPTIONS is empty. If `CDP` now derives, remove the export and this pin with it — " +
        "an empty exception list is a claim that nothing is non-derivable, which measurement refutes.",
    );
    assert.ok(
      DECLARED_EXCEPTIONS.length <= 2,
      `DECLARED_EXCEPTIONS has grown to ${DECLARED_EXCEPTIONS.length} entries (${DECLARED_EXCEPTIONS.map((e) => e.term).join(", ")}). ` +
        `Each addition means a term was given up on rather than derived, and the list is supposed to be ` +
        `short enough to audit. Derive it from an exec surface instead, or justify why it cannot be.`,
    );
    for (const e of DECLARED_EXCEPTIONS) {
      assert.ok(
        e.why.trim().length >= 40,
        `the exception "${e.term}" has no usable reason (${JSON.stringify(e.why)}). An exception with no ` +
          `stated reason is indistinguishable from a hand-typed list entry, which is the rot this gate exists to kill.`,
      );
      const out = consumerProse(`probe ${e.term} probe`).toLowerCase();
      assert.ok(
        !out.includes(e.term.toLowerCase()),
        `DECLARED_EXCEPTIONS lists "${e.term}" but consumerProse() no longer removes it: ${JSON.stringify(out)}. ` +
          `A declared exception that stopped working is silently still paying the exception's cost.`,
      );
      // Case-insensitively, because that was one of the two live holes.
      const upper = consumerProse(`probe ${e.term.toUpperCase()} probe`).toLowerCase();
      assert.ok(!upper.includes(e.term.toLowerCase()), `the exception "${e.term}" survives in another case: ${upper}`);
    }
  });

  test("MUTATION PROOF: breaking the mechanism rule turns this gate RED (it is not a decoration)", async () => {
    // A test that cannot fail on the change it exists to catch is a decoration.
    // Rather than trust that, this test MUTATES the rule table in a temporary
    // copy of the module and re-runs the same assertions against it — so the
    // assertions are proven load-bearing without ever editing the real source.
    //
    // Each mutation REVERTS one rule to the exact pre-GOAL-167 form and then
    // demands that the sibling spelling it used to miss LEAKS. A mutant that does
    // not leak means the assertion is not exercising the rule, and this test says
    // so rather than passing quietly.
    const srcPath = join(ROOT, "src/prompt/consumer-surface.ts");
    const original = readFileSync(srcPath, "utf8");
    // [label, the current rule as written in the file, the pre-167 rule, the sibling spelling that rule used to miss]
    const mutants: ReadonlyArray<readonly [string, string, string, string, RegExp]> = [
      [
        "chrome family reverted to the exact-match `real Chrome` form",
        "/\\bchrome(?:[-_]?(?:browser|stable|beta|driver))?\\b/gi",
        "/\\breal Chrome\\b/gi",
        "google-chrome",
        /\bgoogle-chrome\b/,
      ],
      [
        "chromium family removed entirely",
        "[/\\bchromium(?:[-_]browser)?\\b/gi, \"an operator-attached session\"],",
        "",
        "Chromium",
        /\bChromium\b/,
      ],
      [
        "display family reverted to the case-sensitive `Xvfb` form",
        "[/\\b(?:xvfb|xorg)\\b/gi, \"a virtual display\"],",
        "[/\\bXvfb\\b/g, \"a virtual display\"],",
        "xvfb",
        /\bxvfb\b/,
      ],
      [
        "headless family reverted to the case-sensitive two-word form",
        "[/\\bhead(?:less|ed|ful)\\b/gi, \"display-attached\"],",
        "[/\\bheadless\\b/g, \"display-attached\"],",
        "headful",
        /\bheadful\b/,
      ],
      [
        "cdp exception reverted to the case-sensitive `CDP` form",
        "[/\\bcdp\\b/gi, \"the attach endpoint\"],",
        "[/\\bCDP\\b/g, \"the attach endpoint\"],",
        "cdp",
        /\bcdp\b/,
      ],
      [
        "automation-library family deleted",
        "[/\\b(?:playwright|selenium|webdriver|puppeteer)\\b/gi, \"a session driven by the service operator\"],",
        "",
        "Playwright",
        /\bPlaywright\b/,
      ],
    ];
    for (const [label, current, reverted, siblingText, sibling] of mutants) {
      assert.ok(
        original.includes(current),
        `the mutation "${label}" could not find its rule in consumer-surface.ts (${current}). The rule moved, ` +
          `so this mutation is no longer proving what it claims — update it rather than let it pass vacuously.`,
      );
      const mutated = original.replace(current, reverted);
      assert.notEqual(mutated, original, `the mutation "${label}" changed nothing`);
      const dir = mkdtempSync(join(tmpdir(), "u2a-prose-mutant-"));
      try {
        const mutantPath = join(dir, "consumer-surface.ts");
        const realDir = dirname(srcPath);
        const wired = mutated.replace(/from "(\.\.?\/[^"]+)"/g, (_m, spec: string) =>
          `from ${JSON.stringify(join(realDir, spec).replace(/\.js$/, ".ts"))}`,
        );
        writeFileSync(mutantPath, wired, "utf8");
        const mod = (await import(mutantPath)) as typeof import("../src/prompt/consumer-surface.js");
        // Probe with the SIBLING spelling, in the case the old rule could not match.
        const probe = `probe ${siblingText} probe`;
        const survived = mod.consumerProse(probe);
        assert.match(
          survived,
          sibling,
          `the mutant "${label}" was expected to LEAK ${JSON.stringify(siblingText)} but did not — the ` +
            `assertion this mutation is meant to falsify is not exercising the rule, so the real rule is ` +
            `being carried by something else.`,
        );
        // …and the REAL module must redact that same sibling, which is the
        // positive half: the mutant fails where the real thing passes.
        assert.doesNotMatch(
          consumerProse(probe),
          sibling,
          `the REAL consumerProse() leaked ${JSON.stringify(siblingText)} — the gate this test claims to ` +
            `pin is not actually holding`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
