import type { Ui2ApiPlugin, Ui2ApiContext, ToolHandler } from "../plugin/types.js";

// Selectors are best-effort for www.google.com's current web UI. After you run
// `analyse https://www.google.com --llm --login` with your own session, tune them
// to the exact elements your account sees. The point of this file is the CONTRACT:
// Google Search + AI overviews become typed, callable MCP tools via the
// allow-listed Ui2ApiContext — search is driven with JS-level primitives (paste
// the query, press Enter; the site's own search JS runs) and the AI overview is
// read off the page event bus as streamed chunks. Never raw browser access.
//
// This is a browser capability, not an API: no GOOGLE_API_KEY, no SDK. The site
// simply sees a normal user in their own browser (see docs/VISION.md).

const SEARCH_BOX = 'textarea[name="q"], input[type="search"], input[name="q"]';
const RESULTS = "#search, #main";
// AI overview / AI Mode answer containers (Google keeps changing these classes —
// re-analyse and tune).
const AI_ANSWER_SELECTORS = [
  '[data-attrid="ai_web_answer"]',
  ".Ants3c",
  'div[data-md][class*="Ai"]',
  '[aria-label="AI overview"]',
  "#AI-MODE",
  "#via-container",
];

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (truncated at ${n} chars)` : s;
}

async function runSearch(ctx: Ui2ApiContext, query: string): Promise<void> {
  // JS-level primitives: paste the query (site listens for paste/input), then
  // Enter triggers Google's own search JS — no mouse.
  await ctx.dom.paste(SEARCH_BOX, query);
  await ctx.dom.press(SEARCH_BOX, ["Enter"]);
  await ctx.dom.waitFor(RESULTS, 30000);
  // Small settle window so AI overviews can render into the page event bus.
  await ctx.dom.waitFor("#sentinel, #search, .main", 2000);
}

async function firstExisting(ctx: Ui2ApiContext, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    const t = (await ctx.dom.extract("text " + sel)) as string | null;
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  return null;
}

const googleSearch: ToolHandler = async (args, ctx) => {
  const c = ctx as Ui2ApiContext;
  const query = String(args.query ?? "");
  if (!query.trim()) throw new Error("google_search requires `query`");
  await runSearch(c, query);
  const results = await firstExisting(c, [RESULTS]);
  if (!results) throw new Error("google_search: no results container found (tune selector)");
  return cap(`Search results for "${query}"\n\n` + results, 8000);
};

const googleSearchAi: ToolHandler = async (args, ctx) => {
  const c = ctx as Ui2ApiContext;
  const query = String(args.query ?? "");
  if (!query.trim()) throw new Error("google_search_ai requires `query`");
  await runSearch(c, query);
  // The AI overview streams into the page in chunks — read them off the event bus.
  const captured = (await c.dom.capture(AI_ANSWER_SELECTORS.join(", "), 8000)) as {
    text?: string; chunkCount?: number;
  };
  if (captured?.text?.trim()) return `AI overview for "${query}" (from your Google session)\n\n${cap(captured.text, 6000)}`;
  const answer = await firstExisting(c, AI_ANSWER_SELECTORS);
  if (answer) return `AI overview for "${query}" (from your Google session)\n\n${cap(answer, 6000)}`;
  // No recognised AI-overview container on this session — surface the top of the
  // results page and tell the agent to tune selectors after running `analyse`.
  const top = await firstExisting(c, [RESULTS]);
  const head = top ? cap(top, 4000) : "(no results container)";
  return `google_search_ai: no AI-overview container recognised on this session.\n` +
    `Tune the AI_ANSWER selectors after \`ui2api analyse https://www.google.com --login\`.\n` +
    `Top of results page:\n${head}`;
};

const plugin: Ui2ApiPlugin = {
  name: "google-web",
  version: "1.1.0",
  manifest: {
    name: "www.google.com",
    version: "1.1.0",
    author: "ui2api",
    description: "Drive Google Search and AI overviews from your own logged-in Google session as MCP tools — search via paste+Enter, answers read off the page event bus.",
    authorizedUse: "Automate your own Google session via a browser you control. You are responsible for complying with Google's Terms of Service.",
    license: "MIT",
    ui2api: "0.1.0",
  },
  setup(c: Ui2ApiContext) {
    c.registerTool(
      {
        name: "google_search",
        description:
          "Search Google from your own session and return the top result titles, URLs, and snippets. `query` is the search text.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      googleSearch
    );
    c.registerTool(
      {
        name: "google_search_ai",
        description:
          "Ask Google a question and read the AI overview / AI Mode answer from your own search session.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
      googleSearchAi
    );
  },
};

export default plugin;