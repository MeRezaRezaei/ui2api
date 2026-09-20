// OpenAI-compatible surface tests — pure helpers + HTTP shape via a stub pool
// (no browser is launched; the driver path is stubbed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { siteIdFromModel, messagesToPrompt, handleOpenAIRoutes } from "../src/prompt/openai.js";
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

test("messagesToPrompt joins text parts and drops non-text multimodal parts", () => {
  const out = messagesToPrompt([
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:..." } },
      ],
    },
  ]);
  assert.equal(out, "be terse\nhello\ndescribe this");
  assert.equal(messagesToPrompt([]), "");
  assert.equal(messagesToPrompt([{ role: "user" }]), "");
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

test("GET /v1/models lists configured sites", async () => {
  const { server, port } = await startTestServer(stubPool("x"));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    assert.equal(body.object, "list");
    assert.deepEqual(body.data.map((d) => d.id), ["deepseek", "kimi"]);
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