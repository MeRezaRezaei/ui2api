import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionMap } from "../types.js";
import { validateActionMap } from "../schema.js";
import { acpServerTemplate } from "./acp-template.js";
import { skillTemplate, skillLoaderTemplate } from "./skill-template.js";

// Absolute path to this project's src/ so generated servers can import the
// shared runtime/types under tsx.
export const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function serverTemplate(root: string): string {
  return `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrowserSession } from "${SRC_DIR}/runtime/browser-session.ts";
import type { ActionMap, Action } from "${SRC_DIR}/types.ts";

const mapPath = fileURLToPath(new URL("./action-map.json", import.meta.url));
const map = JSON.parse(readFileSync(mapPath, "utf8")) as ActionMap;
const SITES_ROOT = ${JSON.stringify(root)};
const session = new BrowserSession(map, SITES_ROOT);

function sanitize(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return s.length > 8000 ? s.slice(0, 8000) + "\\u2026" : s;
  } catch (e) {
    return String(v);
  }
}

export async function runServer(): Promise<void> {
  await session.start();
  const server = new McpServer({ name: "ui2api-" + map.host, version: "0.1.0" });
  for (const action of map.actions) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const p of action.parameters) {
      let zt: z.ZodTypeAny = z.any();
      if (p.type === "string") zt = z.string();
      else if (p.type === "number") zt = z.number();
      else if (p.type === "boolean") zt = z.boolean();
      else zt = z.object({}).passthrough();
      shape[p.name] = p.required
        ? zt.describe(p.description || p.name)
        : zt.optional().describe(p.description || p.name);
    }
    server.registerTool(
      action.name,
      { description: action.description, inputSchema: shape },
      async (args: Record<string, unknown>) => {
        const res = await session.executeRecipe(action as Action, args);
        return { content: [{ type: "text", text: sanitize(res) }] };
      }
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ui2api] server for " + map.host + " ready, " + map.actions.length + " tools");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
`;
}

export function generate(
  map: ActionMap,
  outDir?: string,
  target: "mcp" | "acp" = "mcp",
  opts: { skill?: boolean } = {}
): string {
  validateActionMap(map);
  const root = outDir || resolve(SRC_DIR, "..", "sites", map.host);
  const serverDir = resolve(root, "server");
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(resolve(serverDir, "index.ts"), serverTemplate(root));
  if (target === "acp") {
    writeFileSync(resolve(serverDir, "acp.ts"), acpServerTemplate(root));
  }
  if (opts.skill) {
    writeFileSync(resolve(serverDir, "SKILL.md"), skillTemplate(map));
    writeFileSync(resolve(serverDir, "skill-loader.mjs"), skillLoaderTemplate());
  }
  const mapSrc = resolve(root, "action-map.json");
  if (existsSync(mapSrc)) {
    // keep the analyzed map as source of truth; copy into server dir
    copyFileSync(mapSrc, resolve(serverDir, "action-map.json"));
  } else {
    const generated: ActionMap = { ...map, trusted: false };
    writeFileSync(mapSrc, JSON.stringify(generated, null, 2));
    writeFileSync(resolve(serverDir, "action-map.json"), JSON.stringify(generated, null, 2));
  }
  return serverDir;
}
