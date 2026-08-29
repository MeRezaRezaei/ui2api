const toSnake = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();

// Resolve LLM config from env. Defaults to OpenAI-compatible shape. A Gemini
// preset is provided so `UI2API_LLM_PROVIDER=gemini` + `UI2API_LLM_KEY` is all
// that's needed (Gemini exposes an OpenAI-compatible /v1/chat/completions API).
function resolveLlmConfig() {
  const provider = process.env.UI2API_LLM_PROVIDER?.toLowerCase();
  const key = process.env.UI2API_LLM_KEY ?? "";
  const isGemini = provider === "gemini" || /generativelanguage\.googleapis\.com/.test(process.env.UI2API_LLM_BASE_URL ?? "");
  const base =
    process.env.UI2API_LLM_BASE_URL ??
    (isGemini ? "https://generativelanguage.googleapis.com/v1beta/openai" : "");
  const model = process.env.UI2API_LLM_MODEL ?? (isGemini ? "gemini-2.0-flash" : "gpt-4o-mini");
  return { base, key, model };
}

export function llmEnabled(): boolean {
  const { base, key } = resolveLlmConfig();
  return !!(base && key);
}
export async function llmDescribe(purpose: string, captureSummary: string): Promise<{ name: string; description: string }> {
  if (!llmEnabled()) {
    const name = toSnake(purpose).replace(/[^a-z0-9_]/g, "_") || "action";
    return { name, description: `Invoke ${purpose} (${captureSummary}).` };
  }
  const { base, key, model } = resolveLlmConfig();
  const sys = "You map a website action to a snake_case tool name and a one-sentence description. Reply JSON only: {\"name\":\"...\",\"description\":\"...\"}.";
  const user = `Action purpose: ${purpose}\nCaptured calls: ${captureSummary}`;
  const resp = await fetch(`${base.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [ { role: "system", content: sys }, { role: "user", content: user } ], response_format: { type: "json_object" } }),
  });
  if (!resp.ok) return { name: toSnake(purpose), description: purpose };
  const data: any = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { }
  const name = /^[a-z][a-z0-9_]*$/.test(parsed.name) ? parsed.name : toSnake(purpose);
  return { name, description: parsed.description || purpose };
}

// Ask the LLM to propose natural-language tasks a user could perform on the
// site, given its discovered interactive controls. Returns a JSON array of
// short task strings (e.g. ["search for cats"]). Falls back to [] when the LLM
// is disabled or the call fails — callers must never throw on this.
export async function llmProposeTasks(controls: string[], summary: string): Promise<string[]> {
  if (!llmEnabled()) return [];
  const { base, key, model } = resolveLlmConfig();
  const sys =
    "You propose natural-language tasks a user could do on a website, given its interactive controls. " +
    "Reply JSON only: an array of short strings (e.g. [\"search for cats\"]). No other text.";
  const user =
    `Site: ${summary}\nControls:\n` +
    controls.map((c, i) => `${i + 1}. ${c}`).join("\n");
  try {
    const resp = await fetch(`${base.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    const text = data?.choices?.[0]?.message?.content || "[]";
    const parsed: any = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((t: any) => typeof t === "string").slice(0, 10);
    if (Array.isArray(parsed.tasks)) return parsed.tasks.filter((t: any) => typeof t === "string").slice(0, 10);
  } catch (e) {}
  return [];
}
