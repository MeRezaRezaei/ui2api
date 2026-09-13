import type { Ui2ApiPlugin, Ui2ApiContext, ToolHandler } from "../plugin/types.js";
import { resolveProfile } from "../profile/profile.js";

// ai-web — the profile-driven plugin that turns ANY configured AI chat site into
// MCP tools: send_prompt / new_chat / read_last_response / ai_status. Works for
// Gemini, ChatGPT, Claude, Copilot (anonymous), Perplexity and HuggingChat by
// picking a profile (UI2API_AI_SITE or --profile FILE) and driving the site the
// same way a human does: paste + Enter, then read the streamed answer.
//
//   npx tsx src/cli.ts plugin serve src/plugins/ai-web.ts --base-url https://gemini.google.com
//
// When served through the Hub/runtime, the profile also drives the shared
// browser context, so the plugin still works in a long-lived MCP server.

const sendPrompt: ToolHandler = async (args, ctx) => {
  const c = ctx as Ui2ApiContext & { _aiWebProfile?: import("../profile/profile.js").ChatSiteProfile };
  const profile = c._aiWebProfile ?? resolveProfile();
  const text = String(args.text ?? "");
  if (!text) throw new Error("send_prompt requires `text`");
  if (args.newChat && profile.newChat) await c.dom.click(profile.newChat);
  await c.dom.paste(profile.composer.join(", "), text);
  if (profile.send.kind === "keyEnter") {
    await c.dom.press(profile.composer.join(", "), ["Enter"]);
  } else if (profile.send.selector) {
    await c.dom.press(profile.composer.join(", "), [" "]);
    await c.dom.click(profile.send.selector);
  }
  const captured = (await c.dom.awaitAnswer(profile.answer.join(", ") || "body", {
    timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : profile.captureMs,
    stableMs: profile.stableMs,
  })) as { text?: string; chunkCount?: number; title?: string };
  if (!captured?.text?.trim()) {
    throw new Error(
      `${profile.id} returned no answer in time` +
        (profile.loginRequired ? ` — are you signed in to ${profile.name} (${profile.loginHint})?` : "")
    );
  }
  return { answer: captured.text, chunkCount: captured.chunkCount ?? 0, url: captured.title };
};

const newChat: ToolHandler = async (_args, ctx) => {
  const profile = resolveProfile();
  if (!profile.newChat) throw new Error("this site profile has no new-chat affordance configured");
  await (ctx as Ui2ApiContext).dom.click(profile.newChat);
  return "new chat started";
};

const readLast: ToolHandler = async (args, ctx) => {
  const profile = resolveProfile();
  const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : profile.captureMs;
  const captured = (await (ctx as Ui2ApiContext).dom.awaitAnswer(profile.answer.join(", ") || "body", {
    timeoutMs,
    stableMs: profile.stableMs,
  })) as { text?: string; chunkCount?: number };
  return { answer: captured?.text ?? "", chunkCount: captured?.chunkCount ?? 0 };
};

const aiStatus: ToolHandler = async (_args, ctx) => {
  const profile = resolveProfile();
  return (ctx as Ui2ApiContext).dom.status(profile.answer[0]);
};

const plugin: Ui2ApiPlugin = {
  name: "ai-web",
  version: "2.0.0",
  manifest: {
    name: "ai-web",
    version: "2.0.0",
    author: "ui2api",
    description:
      "Drive AI chat websites (Gemini, ChatGPT, Claude, Copilot, Perplexity, HuggingChat) as MCP tools — paste a prompt into the site's composer, hit Enter, read the streamed answer off the page.",
    authorizedUse: "Automate your own AI chat sessions via a browser you control. You are responsible for complying with each site's Terms of Service.",
    license: "MIT",
    capabilities: ["ui2ai-site-prompting", "mcp"],
    ui2api: "0.1.0",
  },
  setup(c: Ui2ApiContext) {
    const profile = resolveProfile();
    (c as Ui2ApiContext & { _aiWebProfile?: unknown })._aiWebProfile = profile;
    c.registerTool(
      {
        name: "send_prompt",
        description: `Send a prompt to ${profile.name} (${profile.url}${profile.loginRequired ? ", requires an authenticated session" : ", anonymous"}). Returns the streamed answer.`,
        inputSchema: { type: "object", properties: { text: { type: "string" }, newChat: { type: "boolean" }, timeoutMs: { type: "number" } }, required: ["text"] },
      },
      sendPrompt as ToolHandler
    );
    c.registerTool(
      { name: "new_chat", description: "Start a new chat on the configured AI site.", inputSchema: { type: "object", properties: {} } },
      newChat
    );
    c.registerTool(
      { name: "read_last_response", description: "Read the most recent answer from the page (keeps capturing until it stabilizes or `timeoutMs` passes).", inputSchema: { type: "object", properties: { timeoutMs: { type: "number" } } } },
      readLast
    );
    c.registerTool(
      { name: "ai_status", description: "Situation status of the AI site page: url, readyState, and the current answer container text.", inputSchema: { type: "object", properties: {} } },
      aiStatus
    );
  },
};

export default plugin;