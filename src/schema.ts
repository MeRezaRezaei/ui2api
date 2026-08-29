import type { ActionMap } from "./types.js";

export function validateActionMap(map: any): ActionMap {
  const err = (m: string): never => {
    throw new Error(`Invalid action-map: ${m}`);
  };
  if (!map || typeof map !== "object") err("root must be an object");
  if (typeof map.host !== "string") err("host must be a string");
  if (typeof map.url !== "string") err("url must be a string");
  if (!Array.isArray(map.actions)) err("actions must be an array");
  for (const a of map.actions) {
    if (typeof a.name !== "string") err("action.name must be a string");
    if (!/^[a-z][a-z0-9_]*$/.test(a.name))
      err(`action name "${a.name}" must be snake_case`);
    if (typeof a.description !== "string") err("action.description required");
    if (a.execution !== "live-js" && a.execution !== "replay")
      err("action.execution must be live-js|replay");
    if (!Array.isArray(a.parameters)) err("action.parameters must be an array");
    for (const p of a.parameters) {
      if (typeof p.name !== "string") err("param.name required");
      if (!["string", "number", "boolean", "object"].includes(p.type))
        err(`param.type invalid: ${p.type}`);
    }
    if (a.recipe?.kind !== "js-function") err("recipe.kind must be js-function");
    if (typeof a.recipe?.target !== "string") err("recipe.target required");
    if (a.result?.mode !== "return" && a.result?.mode !== "dom")
      err("result.mode must be return|dom");
  }
  map.trusted = !!map.trusted;
  return map as ActionMap;
}
