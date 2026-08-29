import type { ActionMap, Action, MethodCall, ActionParam } from "../types.js";

function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function humanize(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function inferType(v: unknown): "string" | "number" | "boolean" | "object" {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v && typeof v === "object") return "object";
  return "string";
}

// Optional LLM hook: if UI2API_LLM_BASE_URL + UI2API_LLM_KEY are set, the mapper
// can call them to name/describe actions more naturally. Falls back to heuristics.
async function describe(method: string, params: ActionParam[]): Promise<string> {
  const argList = params.map((p) => p.name).join(", ");
  return `Invoke \`${method}\` on the site${argList ? ` with ${argList}` : ""}.`;
}

export async function buildActionMap(
  host: string,
  url: string,
  methodCalls: MethodCall[],
  authRequired: boolean
): Promise<ActionMap> {
  const actions: Action[] = [];
  for (const mc of methodCalls) {
    const parameters: ActionParam[] = mc.params.map((p, i) => ({
      name: p,
      type: inferType(mc.sampleArgs[i]),
      required: true,
      description: humanize(p),
    }));
    const network = mc.networkCapture
      ? {
          method: mc.networkCapture.method || "GET",
          url: mc.networkCapture.url,
          requestBody: mc.networkCapture.requestBody,
        }
      : undefined;
    const action: Action = {
      name: toSnake(mc.method),
      description: await describe(mc.method, parameters),
      execution: "live-js",
      parameters,
      recipe: {
        kind: "js-function",
        target: mc.target,
        argsFrom: Object.fromEntries(parameters.map((p) => [p.name, p.name])),
        network,
      },
      result: { mode: "return" },
      verified: !mc.jsReturnCapture.error,
    };
    actions.push(action);
  }
  return {
    host,
    url,
    capturedAt: new Date().toISOString(),
    auth: { required: authRequired, method: authRequired ? "cookies" : undefined },
    actions,
  };
}
