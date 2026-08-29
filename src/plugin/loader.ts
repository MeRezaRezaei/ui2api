import { createContext } from "./context.js";
import { validateActionMap } from "../schema.js";
import type { ActionMap, Action } from "../types.js";
import type { Ui2ApiContext, Ui2ApiPlugin, ToolDefinition, ToolHandler, HubConfig, LoadedPlugin } from "./types.js";

function actionToTool(action: Action): { def: ToolDefinition; handler: ToolHandler } {
  const def: ToolDefinition = {
    name: action.name, description: action.description,
    inputSchema: { type: "object", properties: Object.fromEntries(action.parameters.map((p) => [p.name, { type: "string" }])), required: action.parameters.map((p) => p.name) },
  };
  const handler: ToolHandler = async (args, ctx) => {
    const c = ctx as Ui2ApiContext;
    if (action.execution === "replay" && action.recipe.network) {
      const net = action.recipe.network;
      const body = net.requestBody ?? Object.values(args)[0];
      return c.replay({ url: net.url, method: net.method, body });
    }
    if (action.recipe.kind === "dom-interaction") { await c.dom.click(action.recipe.target); return ""; }
    if (action.result.mode === "dom" && action.result.extract) return c.dom.extract(action.result.extract);
    return c.call(action.recipe.target, action.parameters.map((p) => args[p.name]));
  };
  return { def, handler };
}
export function loadPluginFromMap(map: ActionMap, config: HubConfig, baseUrl: string): LoadedPlugin {
  const m = validateActionMap(map);
  const ctx = createContext(config, { baseUrl });
  for (const a of m.actions) { const { def, handler } = actionToTool(a); ctx.registerTool(def, handler); }
  return { manifest: { name: m.host, version: "0.0.0-generated", author: "generated", description: m.host, authorizedUse: "generated", license: "MIT", ui2api: "0.1.0" }, tools: ctx.tools, hooks: {} };
}
export async function loadPluginModule(path: string, config: HubConfig, baseUrl: string): Promise<LoadedPlugin> {
  const mod = await import(path);
  const plugin: Ui2ApiPlugin = mod.default ?? mod.plugin;
  if (!plugin?.setup) throw new Error(`plugin at ${path} must export a default Ui2ApiPlugin with setup()`);
  const ctx = createContext(config, { baseUrl });
  plugin.setup(ctx);
  return { manifest: plugin.manifest, tools: ctx.tools, hooks: plugin.hooks || {} };
}
