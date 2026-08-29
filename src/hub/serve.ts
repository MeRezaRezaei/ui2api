import type { ManagedInstance } from "./runtime.js";
import { servePlugin } from "../plugin/serve.js";
import { runServer } from "../agent/acp.js";

export async function serveInstanceStdio(inst: ManagedInstance): Promise<void> {
  await servePlugin(inst.plugin, { transport: "stdio", trust: true });
}

export async function serveInstanceAcp(inst: ManagedInstance, port: number): Promise<void> {
  await runServer({ plugin: inst.plugin, port });
}
