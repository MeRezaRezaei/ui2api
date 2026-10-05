// OpenAI-compatible surface tests — pure helpers + HTTP shape via a stub pool
// (no browser is launched; the driver path is stubbed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { siteIdFromModel, messagesToPrompt, handleOpenAIRoutes } from "../src/prompt/openai.js";
import { INVALID_JSON_MESSAGE } from "../src/prompt/consumer-surface.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

const fakeProfile = {
  id: "deepseek",
  name: "DeepSeek",
  url: "https://chat.deepseek.com",
  loginRequired: true,
} as unknown as ChatSiteProfile;

const fakeKimiProfile = {
  id: "kimi",
  name: "Kimi",
  url: "https://www.kimi.ai",
  loginRequired: true,
} as unknown as ChatSiteProfile;

const profilesById = { deepseek: fakeProfile, kimi: fakeKimiProfile };

test("siteIdFromModel accepts bare, ui2api/ and ui2api- prefixes", () => {
  assert.equal(siteIdFromModel("deepseek", "kimi"), "deepseek");
  assert.equal(siteIdFromModel("ui2api/deepseek", ""), "deepseek");
  assert.equal(siteIdFromModel("ui2api-deepseek", ""), "deepseek");
  assert.equal(siteIdFromModel(undefined, "kimi"), "kimi");
  assert.equal(siteIdFromModel(undefined, ""), "");
});

// RETARGETED (was: "joins text parts and drops non-text multimodal parts").
//
// The old expectation — that a non-text part is SILENTLY DROPPED and the text
// around it is still sent — pinned a shape the implementation deliberately
// abandoned (commit b276c10). Silently dropping an image meant the caller got
// a confident, real answer to a question that was never asked, with no way to
// detect it. The part is now NAMED and refused. The test was the stale side, so
// it is rewritten to assert the CURRENT contract, by EXERCISING it:
//
//   - text parts (both "text" and "input_text") ARE joined, in order
//   - roles are LABELLED, so a flattened transcript can be reconstructed
//   - any non-text part REFUSES, naming every offending kind
//
// The refusal assertion is deliberately not `typeof out === "string"`: it
// asserts the throw, its error class, and that the offending kind appears in
// the message, so a silent-drop regression cannot pass here.
test("messagesToPrompt joins text parts and refuses non-text multimodal parts by name", () => {
  // text parts join, in order, for both OpenAI spellings
  assert.equal(
    messagesToPrompt([
      { role: "user", content: [{ type: "text", text: "describe this" }, { type: "input_text", text: "in detail" }] },
    ] as never),
    "describe this\nin detail",
    "text parts must be joined, not dropped or reordered",
  );

  // roles are labelled, so a consumer can reconstruct who said what
  assert.equal(
    messagesToPrompt([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as never),
    "[system instruction]: be terse\nhello\n[assistant]: hi",
  );

  // a non-text part is REFUSED and NAMED — never silently dropped
  const throws = (msgs: unknown) => {
    try {
      const out = messagesToPrompt(msgs as never);
      return { threw: false as const, out };
    } catch (e) {
      return { threw: true as const, err: e as { name?: string; message?: string; kinds?: string[] } };
    }
  };

  const img = throws([
    { role: "user", content: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "data:..." } }] },
  ]);
  assert.equal(img.threw, true, "an image part must NOT be silently dropped — a dropped image yields a confident answer to a question never asked");
  if (img.threw) {
    assert.equal(img.err.name, "ContentPartUnsupported");
    assert.deepEqual(img.err.kinds, ["image_url"], "the refusal must name the offending kind");
    assert.ok(String(img.err.message).includes("image_url"), "the message must name the kind so a caller can act on it");
  }

  // every offending kind is collected, so one refusal names them all
  const many = throws([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:..." } },
        { type: "file", file: { file_id: "f" } },
      ],
    },
  ]);
  assert.equal(many.threw, true);
  if (many.threw) assert.deepEqual(many.err.kinds, ["image_url", "file"], "every non-text kind must be named");

  assert.equal(messagesToPrompt([]), "");
  assert.equal(messagesToPrompt([{ role: "user" }] as never), "");
});

function startTestServer(pool: unknown): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        await handleOpenAIRoutes(req, res, {
          pool: pool as never,
          profilesById: profilesById as Record<string, ChatSiteProfile>,
        });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function stubPool(answer: string) {
  return {
    acquire: async () => ({ driver: { ask: async () => ({ answer, chunkCount: 1, doneReason: "stop", url: "https://chat.deepseek.com/chat/1", title: "t" }) } }),
    release: async () => undefined,
  };
}

test("GET /v1/models advertises only the MEASURED-answering ids, and names the rest", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string }>;
      withheld?: Array<{ model: string; class: string; reason: string }>;
      advertisement?: { offered: number; withheld: number; addressable: number };
    };
    assert.equal(body.object, "list");
    // This daemon serves deepseek and kimi, and the 2026-09-30 measurement
    // record files BOTH as SIGN-OUT — so the honest advertisement is empty and
    // both are withheld by name. The pin used to assert the opposite ("both are
    // listed"), which was the promise the record contradicts.
    assert.deepEqual(body.data.map((d) => d.id), []);
    const withheld = new Map((body.withheld ?? []).map((w) => [w.model, w]));
    for (const id of ["deepseek", "kimi"]) {
      const w = withheld.get(id);
      assert.ok(w, `${id}: not advertised and not named as withheld — the omission is silent`);
      assert.equal(w.class, "SIGN-OUT");
      assert.ok(w.reason.length > 20, `${id}: the omission carries no readable reason`);
    }
    assert.equal(body.advertisement?.addressable, 2, "both served ids are addressable");
    assert.equal(body.advertisement?.offered, 0, "neither was measured answering");
    assert.equal(body.advertisement?.withheld, 2);
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions returns OpenAI completion shape (non-stream)", async () => {
  const { server, port } = await startTestServer(stubPool("2 + 2 = 4"));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ui2api/deepseek", messages: [{ role: "user", content: "2+2?" }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      model: string;
      choices: Array<{ message: { content: string; role: string }; finish_reason: string }>;
      ui2api: { site: string };
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "deepseek");
    assert.equal(body.choices[0].message.role, "assistant");
    assert.equal(body.choices[0].message.content, "2 + 2 = 4");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.ui2api.site, "deepseek");
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions streams SSE chunks then [DONE]", async () => {
  const { server, port } = await startTestServer(stubPool("Hello world!"));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /data: \{"id":"chatcmpl-ui2api-/);
    assert.match(text, /"object":"chat.completion.chunk"/);
    assert.match(text, /content":"Hello/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
    // reconstruct the content from deltas
    const deltas = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
    assert.equal(deltas, "Hello world!");
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions with unknown model -> 404 OpenAI error", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nope", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "unknown_model");
  } finally {
    server.close();
  }
});

test("POST /v1/chat/completions with empty messages -> 400", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [] }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// ─── GOAL 145's defect class, on the /v1 reader ──────────────────────────────
//
// THE DEFECT. The daemon's `/prompt` reader has refused a non-object body with
// a NAMED 400 `invalid_json` since GOAL 145 (`readJson`,
// src/prompt/http.ts:738). THIS path did not: `readJsonBody` in openai.ts
// resolved whatever parsed, so a body of literal `null` reached
// `Boolean(body.stream)` at the very next line and threw a TypeError, which the
// last-resort net answered as a 500. One daemon, one caller mistake, two answers
// — and the wrong one blamed the server for a typo.

test("POST /v1/chat/completions with a non-object body is a named 400, never a 500", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    for (const raw of ["null", "[1,2]", '"hi"', "42", "true"]) {
      const res = await probeV1(port, "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      assert.equal(res.status, 400, `body \`${raw}\` must be a named 400, never a 500`);
      const body = (await res.json()) as { error: { message: string; type: string; code?: string } };
      assert.equal(body.error.type, "invalid_request_error", "OpenAI clients parse this shape");
      assert.equal(body.error.message, INVALID_JSON_MESSAGE, "one condition, one owned sentence");
      // and a body that is not JSON AT ALL is the same named refusal
      const broken = await probeV1(port, "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      assert.equal(broken.status, 400, "a body that is not JSON is the same caller mistake");
      assert.equal(((await broken.json()) as { error: { message: string } }).error.message, INVALID_JSON_MESSAGE);
    }
  } finally {
    server.close();
  }
});

test("the 400 body is client-safe: no stack, no internal detail", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    const res = await probeV1(port, "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const text = await res.text();
    for (const leak of [/\.ts:\d+/, /\bat \w+ \(/, /node:internal/, /readJsonBody/, /openai\.ts/, /Cannot read properties/]) {
      assert.ok(!leak.test(text), `the refusal leaked an internal detail: ${leak} in ${text}`);
    }
    assert.ok(!/\n\s{2,}\S/.test(text), "a stack frame reached the client");
  } finally {
    server.close();
  }
});

test("a valid object body is still served — the gate refuses only non-objects", async () => {
  const { server, port } = await startTestServer(stubPool("still answering"));
  try {
    const res = await probeV1(port, "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200, "the gate must not touch a well-formed body");
    assert.equal(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content, "still answering");
  } finally {
    server.close();
  }
});

test("negative: the OLD reader accepted `null`, and the next line threw — the 500 in one assertion", () => {
  // The pre-fix reader, verbatim in shape: `resolve(raw ? JSON.parse(raw) : {})`.
  const oldRead = (raw: string): unknown => {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };
  assert.equal(oldRead("null"), null, "precondition: the old rule resolved a null body");
  // and the handler's very next read is what turned it into a server fault
  assert.throws(
    () => Boolean((oldRead("null") as { stream?: unknown }).stream),
    TypeError,
    "precondition: `Boolean(body.stream)` on that body is a TypeError, i.e. the 500",
  );
});

test("the gate is IN the reader, so no caller can skip it", () => {
  const src = readFileSync(new URL("../src/prompt/openai.ts", import.meta.url), "utf8");
  const reader = src.slice(src.indexOf("function readJsonBody"));
  assert.match(reader, /parsed === null \|\| typeof parsed !== "object" \|\| Array\.isArray\(parsed\)/, "the object gate must live in the reader itself");
  assert.match(reader, /reject\(new Error\(INVALID_JSON_MESSAGE\)\)/, "the refusal must use the OWNED sentence");
  // the empty-body default survives: a body-less POST is still the {} it always was
  assert.match(reader, /raw \? JSON\.parse\(raw\) : \{\}/, "an empty body stays the {} default");
});

// ─── GOAL 81: the /v1/* surface must NEVER hang — every unmatched path 404s ──

// Probe with a client-side timeout so a pre-fix handler (which left the socket
// open forever) FAILS the test with a timeout instead of hanging the runner —
// a hanging pin is a second dead path.
async function probeV1(port: number, path: string, init: RequestInit, timeoutMs = 1500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

test("GET /v1/embeddings (unmatched /v1 path) -> 404 not_found, never a hang", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    const res = await probeV1(port, "/v1/embeddings", { method: "GET" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { message: string; code: string } };
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.message, /unknown endpoint GET \/v1\/embeddings/);
    assert.match(body.error.message, /serves GET \/v1\/models and POST \/v1\/chat\/completions/);
  } finally {
    server.close();
  }
});

test("GET /v1/chat/completions (wrong method on a real /v1 path) -> 404 not_found, never a hang", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    const res = await probeV1(port, "/v1/chat/completions", { method: "GET" });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "not_found");
  } finally {
    server.close();
  }
});

// Source-level invariant (GOAL 81): the daemon keeps BOTH 404 layers — the
// terminal openai.ts fallback for /v1/* paths AND the native http.ts fallback
// for everything else. If either is removed the coverage silently collapses
// (a path class stops answering). Pin both against the on-disk source.
test("http.ts still serves the native non-/v1 404 next to the /v1 delegation", () => {
  const httpSrc = readFileSync(new URL("../src/prompt/http.ts", import.meta.url), "utf8");
  const v1Branch = httpSrc.indexOf('req.url?.startsWith("/v1/")');
  const native404 = httpSrc.indexOf('send(res, 404, { error: "not found" })');
  assert.ok(v1Branch >= 0, "http.ts must still contain the /v1/* delegation branch");
  assert.ok(native404 > v1Branch, "the native non-/v1 404 must follow the /v1 branch");
  const between = httpSrc.slice(v1Branch, native404);
  // the branch delegates to openai.ts AND returns — so a /v1 path never falls
  // through to the native 404, and a non-/v1 path always reaches it.
  assert.match(between, /handleOpenAIRoutes\(req, res, \{/, "the /v1 branch must delegate to handleOpenAIRoutes");
  assert.match(between, /return;/, "the /v1 branch must return after delegating (no fall-through to the native 404)");
});