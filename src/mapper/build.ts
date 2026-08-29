import type { ActionMap, Action, MethodCall, ActionParam, DomInteraction, NetworkInfo } from "../types.js";
import { llmDescribe } from "./llm.js";

function humanize(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function inferType(v: unknown): "string" | "number" | "boolean" | "object" {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v && typeof v === "object") return "object";
  return "string";
}

export async function buildActionMap(
  host: string,
  url: string,
  methodCalls: MethodCall[],
  domActions: DomInteraction[],
  authRequired: boolean,
  llm = false
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
    const purpose = mc.method;
    const summary = `js-function ${mc.target}(${mc.params.join(",")})`;
    const { name, description } = await llmDescribe(purpose, summary);
    const action: Action = {
      name,
      description,
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

  for (const di of domActions) {
    const parameters: ActionParam[] = di.fields.map((f) => ({
      name: f,
      type: "string",
      required: true,
      description: humanize(f),
    }));
    // A pure network call with no live-JS need → replay; otherwise re-drive the DOM.
    const execution: "replay" | "live-js" = di.network ? "replay" : "live-js";
    const network: NetworkInfo | undefined = di.network || undefined;
    const purpose = di.label || di.selector;
    const summary = `dom ${di.domKind} ${di.selector}`;
    const { name, description } = await llmDescribe(purpose, summary);
    const action: Action = {
      name,
      description,
      execution,
      parameters,
      recipe: {
        kind: "dom-interaction",
        target: di.selector,
        argsFrom: Object.fromEntries(parameters.map((p) => [p.name, p.name])),
        network,
      },
      result: { mode: "return" },
      verified: di.verified,
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
