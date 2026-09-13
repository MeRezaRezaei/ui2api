import type { Ui2ApiPlugin, Ui2ApiContext, ToolHandler } from "../plugin/types.js";

// Selectors are best-effort for gemini.google.com's current web UI. After you run
// `analyse https://gemini.google.com --login` with your own session, tune them to
// the exact elements your account sees. The point of this file is the CONTRACT:
// Gemini's web abilities become typed, callable MCP tools via the allow-listed
// Ui2ApiContext — and the send flow is the JS-level primitive path: the prompt is
// pasted into the composer (keyboard/paste events, NOT a mouse click on a send
// button), Enter fires Gemini's own JS, and the streamed answer is captured from
// the DOM as the event-bus chunks Gemini writes (see docs/VISION.md).
const COMPOSER = 'textarea, div[contenteditable="true"][role="textbox"], [aria-label="Prompt"]';
const RESPONSE = '[data-test-id="answer-container"], .model-response-text, .response-content';
const NEW_CHAT = 'a[aria-label="New chat"], button[aria-label="New chat"]';
const ANSWER_CAPTURE_MS = 30000;

const sendPrompt: ToolHandler = async (args, ctx) => {
  const c = ctx as Ui2ApiContext;
  const text = String(args.text ?? "");
  if (!text) throw new Error("send_prompt requires `text`");
  if (args.newChat) await c.dom.click(NEW_CHAT);
  // Paste the prompt (site listens for paste/input), then Enter sends — no mouse.
  await c.dom.paste(COMPOSER, text);
  await c.dom.press(COMPOSER, ["Enter"]);
  // Read the streamed response off the screen like the event bus it is.
  const captured = (await c.dom.capture(RESPONSE, ANSWER_CAPTURE_MS)) as {
    text?: string; chunkCount?: number; title?: string;
  };
  if (!captured?.text?.trim()) throw new Error("Gemini returned no streamed response in time; are you signed in to gemini.google.com in this profile?");
  return { answer: captured.text, chunkCount: captured.chunkCount ?? 0, url: captured.title };
};

const newChat: ToolHandler = async (_args, ctx) => {
  await (ctx as Ui2ApiContext).dom.click(NEW_CHAT);
  return "new chat started";
};

const readLast: ToolHandler = async (args, ctx) => {
  const c = ctx as Ui2ApiContext;
  const sinceMs = Number(args.untilMs ?? 30000);
  const captured = (await c.dom.capture(RESPONSE, sinceMs)) as
    | { text?: string; chunkCount?: number }
    | undefined;
  if (captured?.text?.trim()) return { answer: captured.text, chunkCount: captured.chunkCount ?? 0 };
  return c.dom.extract("text " + RESPONSE);
};

const geminiStatus: ToolHandler = async (_args, ctx) => {
  return (ctx as Ui2ApiContext).dom.status(RESPONSE);
};

const plugin: Ui2ApiPlugin = {
  name: "gemini-web",
  version: "1.1.0",
  manifest: {
    name: "gemini.google.com",
    version: "1.1.0",
    author: "ui2api",
    description: "Drive your own Gemini web session (gemini.google.com) as MCP tools — prompt via paste+Enter, answers stream back from the page event bus.",
    authorizedUse: "Automate your own Gemini web session via a browser you control. You are responsible for complying with Google's Terms of Service.",
    license: "MIT",
    ui2api: "0.1.0",
  },
  setup(c: Ui2ApiContext) {
    c.registerTool(
      { name: "send_prompt", description: "Send a prompt to Gemini in the current web chat by pasting it into the composer and pressing Enter; returns the streamed answer.", inputSchema: { type: "object", properties: { text: { type: "string" }, newChat: { type: "boolean" } }, required: ["text"] } },
      sendPrompt
    );
    c.registerTool(
      { name: "new_chat", description: "Start a new Gemini chat.", inputSchema: { type: "object", properties: {} } },
      newChat
    );
    c.registerTool(
      { name: "read_last_response", description: "Read the most recent Gemini response from the page (optionally keep capturing for `untilMs` more streamed chunks).", inputSchema: { type: "object", properties: { untilMs: { type: "number" } } } },
      readLast
    );
    c.registerTool(
      { name: "gemini_status", description: "Situation status of the Gemini page: url, readyState, and whether a response container is present with its current text.", inputSchema: { type: "object", properties: {} } },
      geminiStatus
    );
  },
};

export default plugin;
