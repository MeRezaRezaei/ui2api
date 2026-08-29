import type { RegistryStore } from "./store.js";
import { loadPluginModule } from "../plugin/loader.js";
import { createContext } from "../plugin/context.js";
import type { HubConfig, Ui2ApiContext, LoadedPlugin } from "../plugin/types.js";

export interface ManagedInstance {
  host: string;
  store: RegistryStore;
  plugin: LoadedPlugin;
}

export class HubRuntime {
  private instances = new Map<string, ManagedInstance>();
  constructor(private opts: { store: RegistryStore; dataDir: string }) {}

  async getInstance(host: string): Promise<ManagedInstance> {
    const existing = this.instances.get(host);
    if (existing) return existing;
    const pkg = this.opts.store.get(host);
    if (!pkg) throw new Error(`no package registered for host ${host}`);
    const config: HubConfig = { dataDir: this.opts.dataDir };
    // The Hub owns the per-host runtime: it builds the allow-listed context
    // (which internally manages the host-scoped browser session) and never
    // hands the plugin launchBrowser/generate or raw fs access.
    const context: Ui2ApiContext = createContext(config, {
      baseUrl: `https://${host}`,
      dataDir: this.opts.dataDir,
    });
    const plugin = await loadPluginModule(pkg.module ?? "", context);
    const inst: ManagedInstance = { host, store: this.opts.store, plugin };
    this.instances.set(host, inst);
    return inst;
  }

  async closeInstance(host: string): Promise<void> {
    const inst = this.instances.get(host);
    if (!inst) return;
    this.instances.delete(host);
  }

  async closeAll(): Promise<void> {
    for (const h of [...this.instances.keys()]) await this.closeInstance(h);
  }
}
