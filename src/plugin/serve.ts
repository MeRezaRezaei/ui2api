import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { LoadedPlugin } from "./types.js";

// Convert a minimal JSON-schema object (as stored on ToolDefinition.inputSchema)
// into a Zod raw shape that the MCP server can validate against. Only the field
// types we emit are supported; anything else falls back to z.any() (permissive).
function fieldToZod(field: unknown): z.ZodTypeAny {
  const f = field as { type?: string } | undefined;
  switch (f?.type) {
    case "string": return z.string();
    case "number": return z.number();
    case "boolean": return z.boolean();
    case "object": return z.object({}).passthrough();
    default: return z.any();
  }
}

function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = (Array.isArray(schema.required) ? schema.required : []) as string[];
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(props)) {
    const zz = fieldToZod(value);
    out[key] = required.includes(key) ? zz : zz.optional();
  }
  return out;
}

export async function servePlugin(loaded: LoadedPlugin, opts: { transport?: "stdio" | "ws"; trust: boolean }): Promise<{ close(): Promise<void> }> {
  const server = new McpServer({ name: loaded.manifest?.name ?? "ui2api", version: loaded.manifest?.version ?? "0.0.0" });
  for (const { def, handler } of loaded.tools.values()) {
    server.registerTool(def.name, { description: def.description, inputSchema: jsonSchemaToZodShape(def.inputSchema) }, async (args: Record<string, unknown>) => {
      const out = await handler(args, loaded.context);
      return { content: [{ type: "text" as const, text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
    });
  }
  if (opts.transport === "ws") throw new Error("ws transport implemented in sub-project 3");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[ui2api] plugin ${loaded.manifest?.name} ready, ${loaded.tools.size} tools`);
  console.error("[ui2api] use at your own risk — only automate sites you are authorized to use.");
  return { close: () => server.close() };
}
