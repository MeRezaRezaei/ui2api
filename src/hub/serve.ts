import type { ManagedInstance } from "./runtime.js";
import { servePlugin } from "../plugin/serve.js";
import { runServer } from "../agent/acp.js";

export async function serveInstanceStdio(inst: ManagedInstance): Promise<void> {
  await servePlugin(inst.plugin, { transport: "stdio", trust: true });
}

/**
 * The ACP surface for a `hub run <host> --acp` instance.
 *
 * DELIBERATELY PASSES NEITHER `bindHost` NOR `token`, and that is the whole
 * contract rather than an omission: the environment is the SINGLE source, and
 * the resolution happens inside `runServer` (`src/agent/acp.ts`) —
 * `resolveAcpToken` is `opts ?? process.env[ACP_TOKEN_ENV] ?? ""` and
 * `resolveAcpBindHost` is `requested ?? process.env[ACP_BIND_ENV]`. Threading
 * the values down from here would add a SECOND place that reads the environment
 * and could disagree with the first.
 *
 * This was reported as a silent no-op once already — "`UI2API_ACP_BIND` does
 * nothing on the `hub run --acp` path" — and the report was wrong: `runServer`
 * has exactly one caller in the tree (this function, from `cmdHubRun --acp`;
 * `src/generator/generate.ts`'s own `runServer` is unrelated and speaks stdio),
 * so the env fallback resolves the knob here with no threading at all.
 * MEASURED through this function, reading the kernel's own listen address and
 * not the server's log line: both knobs unset -> `127.0.0.1`;
 * `UI2API_ACP_BIND=0.0.0.0` with no token -> refused before the socket exists;
 * `UI2API_ACP_BIND=0.0.0.0` with `UI2API_ACP_TOKEN` set -> `0.0.0.0`.
 *
 * SO: if you are here because a reader reported this knob as inert, the fix is
 * NOT to add a parameter — read `resolveAcpBindHost` first.
 */
export async function serveInstanceAcp(inst: ManagedInstance, port: number): Promise<void> {
  await runServer({ plugin: inst.plugin, port });
}
