import type { ActionMap } from "../types.js";

export interface PluginManifest {
  name: string; version: string; author: string;
  description: string; authorizedUse: string; license: string;
  capabilities?: string[]; ui2api: string;
}
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; }
export type ToolHandler = (args: Record<string, unknown>, ctx: Ui2ApiContext) => Promise<unknown>;
export interface Logger { info(m: string): void; warn(m: string): void; error(m: string): void; }
export interface HubConfig { dataDir: string; registryUrl?: string; }
export interface AnalyseOpts { root?: string; outDir?: string; llm?: boolean; maxTasks?: number; }
export interface AnalyseInfo { host: string; url: string; actionCount: number; }
export interface PendingRequest { url: string; method: string; headers: Record<string, string>; body?: unknown; }
export interface PendingResponse { status: number; body: unknown; }
export interface Ui2ApiContext {
  config: Readonly<HubConfig>;
  logger: Logger;
  registerTool(def: ToolDefinition, handler: ToolHandler): void;
  analyse(url: string, opts?: AnalyseOpts): Promise<ActionMap>;
  replay(req: { url: string; method?: string; body?: unknown }): Promise<string>;
  call(target: string, args: unknown[]): Promise<unknown>;
  session: { load(host: string): Promise<unknown[]>; save(host: string, cookies: unknown[]): Promise<void> };
  http: { fetch(url: string, init?: RequestInit): Promise<Response> };
  dom: {
    click(selector: string): Promise<void>;
    type(selector: string, text: string): Promise<void>;
    waitFor(selector: string, timeoutMs?: number): Promise<void>;
    extract(expr: string): Promise<unknown>;
  };
}
export interface Ui2ApiPlugin {
  name: string; version: string; manifest: PluginManifest;
  setup(ctx: Ui2ApiContext): void | { tools?: ToolDefinition[] };
  hooks?: {
    onAnalyse?(ctx: Ui2ApiContext, info: AnalyseInfo): void;
    onRequest?(ctx: Ui2ApiContext, req: PendingRequest): PendingRequest | void;
    onResponse?(ctx: Ui2ApiContext, res: PendingResponse): PendingResponse | void;
  };
}
export interface LoadedPlugin {
  manifest?: PluginManifest;
  context: Ui2ApiContext;
  tools: Map<string, { def: ToolDefinition; handler: ToolHandler }>;
  hooks: Ui2ApiPlugin["hooks"];
}
