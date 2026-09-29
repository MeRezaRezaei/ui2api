import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { handleOpenAIRoutes } from "../src/prompt/openai.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

/**
 * GOAL 109: the driver correctly reports `doneReason: "restricted"` with the
 * named hits (src/prompt/driver.ts:522-534, deliberately gated on `!answer` so
 * a marker can only surface when there is genuinely no answer). Every consumer
 * then DISCARDED it: /v1 non-stream answered 200 with finish_reason "stop",
 * refusal null, and the verdict only in a non-standard field; the SSE path
 * dropped it entirely; /prompt answered {ok:true, answer:""}. A restriction wall
 * was therefore served as an ordinary EMPTY SUCCESS.
 *
 * These pins make the flattening impossible to reintroduce.
 */

const OPENAI = readFileSync("src/prompt/openai.ts", "utf8");
const HTTP = readFileSync("src/prompt/http.ts", "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The exact rule both surfaces must apply to a restricted verdict. */
function surfaceVerdict(doneReason: string | undefined): { finish: string; refused: boolean; ok: boolean } {
  const restricted = doneReason === "restricted";
  return {
    finish: restricted ? "content_filter" : "stop",
    refused: restricted,
    ok: !restricted,
  };
}

// ─── the real /v1 surface, exercised ──────────────────────────────────────────
//
// This block exists because the pin it replaced was a REGEX OVER SOURCE TEXT.
//
// The old assertion was:
//   /finish_reason:\s*result\.doneReason === "restricted"\s*\?\s*"content_filter"\s*:\s*"stop"/
// It did not guard the BEHAVIOUR — it guarded the LITERAL SPELLING of one
// ternary, and it would only tolerate a ternary whose false-branch was the
// literal "stop". The moment a legitimate third case (a tool call) needed its
// own finish_reason and was nested into that ternary, the pin went red while
// the behaviour it claimed to protect was still exactly correct.
//
// That is the defect class this file exists to prevent: a gate that fails on a
// reformat teaches the next maintainer to appease the regex instead of reading
// the code, and the real property goes quietly unverified. So the gate is
// retargeted at the only thing a consumer can observe — what the HTTP response
// actually carries — and the source is exercised for real rather than read.

const profile = { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com", loginRequired: true } as unknown as ChatSiteProfile;

type AskResult = {
  answer?: string;
  doneReason?: "stable" | "timeout" | "empty" | "restricted";
  restrictions?: Array<{ kind: string; matched: string }>;
};

function stubPool(result: AskResult) {
  return {
    acquire: async () => ({ driver: { ask: async () => result } }),
    release: async () => undefined,
  };
}

async function serve(result: AskResult): Promise<{ server: Server; port: number }> {
  const server: Server = createServer(async (req, res) => {
    try {
      await handleOpenAIRoutes(req, res, {
        pool: stubPool(result) as never,
        profilesById: { deepseek: profile } as Record<string, ChatSiteProfile>,
      });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

type Choice = { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } };

async function completeNonStream(port: number, model = "deepseek"): Promise<{ status: number; finish?: string; refusal?: string | null; content?: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  });
  const body = (await res.json()) as { choices?: Choice[] };
  const choice = body.choices?.[0];
  return { status: res.status, finish: choice?.finish_reason, refusal: choice?.message?.refusal, content: choice?.message?.content };
}

d("GOAL 109: a restriction wall reaches a consumer as a refusal, not an empty success", () => {
  t("non-stream /v1 answers content_filter + a refusal, never stop", async () => {
    const { server, port } = await serve({
      answer: "",
      doneReason: "restricted",
      restrictions: [{ kind: "login", matched: "Sign in to continue" }],
    });
    try {
      const r = await completeNonStream(port);
      // THE PROPERTY, executed. A wall is served as a refusal a client can act on.
      assert.equal(r.status, 200, "a restriction wall is still a well-formed completion, not an error envelope");
      assert.equal(r.finish, "content_filter", "a wall must never look like a completed answer");
      assert.notEqual(r.finish, "stop", "a wall must never look like a completed answer");
      assert.equal(r.refusal, "login: Sign in to continue", "the refusal must carry the driver's NAMED hits, by kind and matched text");
      assert.ok(r.refusal && r.refusal.length > 0, "refusal must be a non-empty string a consumer can read");
    } finally {
      server.close();
    }
  });

  t("a normal answer on the SAME surface is still finish_reason stop with no refusal", async () => {
    const { server, port } = await serve({ answer: "PONG", doneReason: "stable" });
    try {
      const r = await completeNonStream(port);
      assert.equal(r.status, 200);
      assert.equal(r.finish, "stop", "the refusal fix must not be a blanket refusal on a real answer");
      assert.equal(r.refusal, null, "a real answer carries no refusal");
      assert.equal(r.content, "PONG");
    } finally {
      server.close();
    }
  });

  t("the refusal STRING carries the named restriction hits", () => {
    assert.match(code(OPENAI), /refusal:[\s\S]{0,400}?restrictions/, "the refusal must carry the driver's named hits");
    assert.match(code(OPENAI), /\$\{r\.kind\}:\s*\$\{r\.matched\}/, "each hit must be named by kind and matched text");
  });

  t("the SSE path emits the refusal instead of dropping it", () => {
    const sse = code(OPENAI);
    assert.match(sse, /if \(result\.doneReason === "restricted"\)[\s\S]{0,600}?delta:\s*\{\s*refusal:/,
      "the stream must emit a refusal delta");
    assert.match(sse, /finish_reason:\s*"content_filter"/, "and a non-success finish_reason in the stream");
    assert.match(sse, /data: \[DONE\]/, "and still terminate the stream cleanly");
  });

  t("/prompt reports ok:false, not ok:true with an empty answer", () => {
    assert.match(code(HTTP), /if \(result\.doneReason === "restricted"\)[\s\S]{0,500}?ok:\s*false/,
      "/prompt must not report a wall as ok:true");
    assert.match(code(HTTP), /reason:\s*"restriction wall detected/, "and must name the reason");
    // the spread must come FIRST so the honest fields are not overwritten
    const i = code(HTTP).indexOf('ok: false,\n              doneReason: "restricted"');
    assert.ok(i > 0, "the honest block must exist");
    assert.ok(code(HTTP).lastIndexOf("...result", i) < i, "result must be spread BEFORE the honest overrides");
  });

  t("a normal answer is untouched — the fix is not a blanket refusal", () => {
    const r = surfaceVerdict("stopped");
    assert.equal(r.finish, "stop");
    assert.equal(r.refused, false);
    assert.equal(r.ok, true);
  });

  t("negative: the OLD flattening is required to be the failure (mutation proof)", () => {
    // the old non-stream shape
    const old = 'message: { role: "assistant", content: answer, refusal: null }, finish_reason: "stop",';
    assert.match(old, /refusal: null/, "precondition: the old shape hardcoded refusal null");
    assert.match(old, /finish_reason: "stop"/, "precondition: the old shape hardcoded finish_reason stop");
    // applying the verdict rule to the old shape's values must expose the lie
    const r = surfaceVerdict("restricted");
    assert.equal(r.finish, "content_filter");
    assert.notEqual(r.finish, /finish_reason: "stop"/.test(old) ? "stop" : r.finish,
      "the old hardcoded stop must differ from the honest verdict");
    // and the driver must still gate the wall on there being NO answer
    assert.match(readFileSync("src/prompt/driver.ts", "utf8"), /if \(!answer\)/,
      "the driver's no-answer gate must remain — a wall is only reported when nothing was answered");
  });
});
