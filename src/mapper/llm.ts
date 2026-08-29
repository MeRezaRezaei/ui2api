const toSnake = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
export function llmEnabled(): boolean {
  return !!(process.env.UI2API_LLM_BASE_URL && process.env.UI2API_LLM_KEY);
}
export async function llmDescribe(purpose: string, captureSummary: string): Promise<{ name: string; description: string }> {
  if (!llmEnabled()) {
    const name = toSnake(purpose).replace(/[^a-z0-9_]/g, "_") || "action";
    return { name, description: `Invoke ${purpose} (${captureSummary}).` };
  }
  const base = process.env.UI2API_LLM_BASE_URL!;
  const key = process.env.UI2API_LLM_KEY!;
  const model = process.env.UI2API_LLM_MODEL || "gpt-4o-mini";
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
