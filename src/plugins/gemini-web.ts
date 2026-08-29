import type { Ui2ApiPlugin, Ui2ApiContext, ToolHandler } from "../plugin/types.js";

// Selectors are best-effort for gemini.google.com's current web UI. After you run
// `analyse https://gemini.google.com --llm` with your own session, tune them to
// the exact elements your account sees. The point of this file is the CONTRACT:
// Gemini's web abilities become typed, callable MCP tools via the allow-listed
// Ui2ApiContext (click / type / waitFor / extract only — never raw browser access).
const COMPOSER = 'textarea, div[contenteditable="true"][role="textbox"], [aria-label="Prompt"]';
const SEND = 'button[aria-label="Send"], button[aria-label="Submit"], button.send-button';
const NEW_CHAT = 'a[aria-label="New chat"], button[aria-label="New chat"]';
const RESPONSE = '[data-test-id="answer-container"], .model-response-text, .response-content';

const sendPrompt: ToolHandler = async (args, ctx) => {
  const c = ctx as Ui2ApiContext;
  const text = String(args.text ?? "");
  if (!text) throw new Error("send_prompt requires `text`");
  if (args.newChat) await c.dom.click(NEW_CHAT);
  await c.dom.type(COMPOSER, text);
  await c.dom.click(SEND);
  await c.dom.waitFor(RESPONSE, 60000);
  return c.dom.extract("text " + RESPONSE);
};

const newChat: ToolHandler = async (_args, ctx) => {
  await (ctx as Ui2ApiContext).dom.click(NEW_CHAT);
  return "new chat started";
};

const readLast: ToolHandler = async (_args, ctx) => {
  return (ctx as Ui2ApiContext).dom.extract("text " + RESPONSE);
};

const plugin: Ui2ApiPlugin = {
  name: "gemini-web",
  version: "1.0.0",
  manifest: {
    name: "gemini.google.com",
    version: "1.0.0",
    author: "ui2api",
    description: "Drive your own Gemini web session (gemini.google.com) as MCP tools.",
    authorizedUse: "Automate your own Gemini web session via a browser you control. You are responsible for complying with Google's Terms of Service.",
    license: "MIT",
    ui2api: "0.1.0",
  },
  setup(c: Ui2ApiContext) {
    c.registerTool(
      { name: "send_prompt", description: "Send a prompt to Gemini in the current web chat and return the model's response text.", inputSchema: { type: "object", properties: { text: { type: "string" }, newChat: { type: "boolean" } }, required: ["text"] } },
      sendPrompt
    );
    c.registerTool(
      { name: "new_chat", description: "Start a new Gemini chat.", inputSchema: { type: "object", properties: {} } },
      newChat
    );
    c.registerTool(
      { name: "read_last_response", description: "Extract the most recent Gemini response from the page.", inputSchema: { type: "object", properties: {} } },
      readLast
    );
  },
};

export default plugin;
