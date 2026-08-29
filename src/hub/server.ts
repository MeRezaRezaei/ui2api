import { RegistryStore } from "./store.js";
import { createHubRouter } from "./api.js";
import { createServer } from "node:http";

export function startHub(opts: { port: number; dataDir: string; token: string; registryUrl: string }) {
  const store = new RegistryStore(opts.dataDir);
  const server = createServer(createHubRouter(store, opts));
  server.listen(opts.port, () => console.log(`[ui2api] hub listening on :${opts.port} (token ${opts.token ? "set" : "MISSING"})`));
  return server;
}
