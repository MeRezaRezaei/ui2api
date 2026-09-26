import { RegistryStore } from "./store.js";
import { createHubRouter } from "./api.js";
import { createServer } from "node:http";

/**
 * GOAL 122: the hub called `server.listen(opts.port)` with NO host, which binds
 * EVERY interface (measured: `BOUND_ADDRESS: ::`). The hub's read surface — the
 * full package + manifest inventory — was therefore LAN-exposed, while
 * `promptd` binds `127.0.0.1`. Writes are not bypassable when the token is
 * unset (an empty bearer never matches), so the exposure is the READ side.
 *
 * Loopback by default, like promptd. Going wider is an explicit, visible choice.
 */
export const HUB_BIND_HOST = "127.0.0.1";

export function resolveHubBindHost(requested?: string): string {
  if (!requested) return HUB_BIND_HOST;
  if (requested === HUB_BIND_HOST || requested === "localhost" || requested === "::1") return requested;
  if (process.env.UI2API_HUB_BIND === requested) return requested; // explicit opt-in
  throw new Error(
    `refusing to bind the hub to ${requested}: it defaults to ${HUB_BIND_HOST} because the package ` +
      `inventory is LAN-visible on a wider bind. Set UI2API_HUB_BIND=${requested} to opt in deliberately.`
  );
}

export function startHub(opts: { port: number; dataDir: string; token: string; registryUrl: string; bindHost?: string }) {
  const store = new RegistryStore(opts.dataDir);
  const server = createServer(createHubRouter(store, opts));
  const host = resolveHubBindHost(opts.bindHost);
  server.listen(opts.port, host, () => console.log(`[ui2api] hub listening on http://${host}:${opts.port} (token ${opts.token ? "set" : "MISSING"})`));
  return server;
}
