import type { RegistryStore } from "./store.js";
import { loadPluginModule, loadPluginFromMap } from "../plugin/loader.js";
import { createExecContext } from "../plugin/context.js";
import type { HubConfig, Ui2ApiContext, LoadedPlugin } from "../plugin/types.js";

export interface ManagedInstance {
  /** The package identity AS THE STORE KEYS IT (the resolved store name). */
  host: string;
  /**
   * The origin the loaded tools actually drive — the PACKAGE'S OWN `url`.
   * Never a value derived from a name (see `resolveBaseUrl`).
   */
  baseUrl: string;
  store: RegistryStore;
  plugin: LoadedPlugin;
}

/**
 * WHAT NAME MAY AN OPERATOR TYPE? — derived from the store's ACTUAL contents,
 * never from a second hardcoded `ui2api-site-<host>` format string.
 *
 * THE MISMATCH THIS EXISTS TO KILL (measured): `buildPackage` names the package
 * `ui2api-site-<host>` (`src/registry/package.ts`) and `RegistryStore.save`
 * keys the index by THAT name, so `hub publish example.test` prints
 * `published ui2api-site-example.test@1.0.0`. `getInstance` then looked the
 * package up by the BARE HOST and answered
 * `no package registered for host example.test` — and the same line also built
 * the browser origin from that bare host, i.e. `https://ui2api-site-<host>`
 * once the lookup was satisfied by the other form. No single argument could
 * satisfy both: the store wants the name, the origin wanted the host.
 *
 * `src/hub/publish-contract.ts` already documents the real contract — the store
 * keys by `name`, and `host` is a redundant second identity the store does not
 * own. So the CODE now agrees with the contract that was already written:
 * every stored package is reachable by its store name AND by the identities the
 * package itself declares (`manifest.host`, and the captured action map's
 * `host`/`url` host). Each alias comes from package DATA, so a publisher that
 * names a package anything else is still reachable by that name and by the host
 * the package declares.
 */
function normalizeQuery(q: string): string {
  const raw = q.trim();
  if (!raw) return "";
  // Accept a full URL as well as a bare name (`hub run https://example.test/x`):
  // the operator's browser origin is the one thing they always have to hand.
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return new URL(raw).host.toLowerCase();
  } catch { /* not a URL — fall through to the name form */ }
  return raw.toLowerCase();
}

/** Every name one stored package answers to, derived from its OWN manifest/module. */
function aliasesFor(name: string, manifest: Record<string, unknown>, moduleText: string): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim()) out.add(v.trim().toLowerCase()); };
  add(name);
  add(manifest.host);
  // The captured action map carries the same site twice more: its own `host`,
  // and the `url` the recipe network calls are same-origin with. Reading the
  // MODULE for those is why this takes moduleText rather than the index entry.
  try {
    const parsed = JSON.parse(moduleText) as { host?: unknown; url?: unknown };
    if (parsed && typeof parsed === "object") {
      add(parsed.host);
      if (typeof parsed.url === "string") { try { add(new URL(parsed.url).host); } catch { /* relative/non-http url */ } }
    }
  } catch { /* JS plugin module — the name + manifest.host aliases still stand */ }
  return [...out];
}

export class HubRuntime {
  private instances = new Map<string, ManagedInstance>();
  constructor(private opts: { store: RegistryStore; dataDir: string }) {}

  /**
   * The store key for whatever the operator typed, or null when no stored
   * package claims that name. Exact store-key hits are checked FIRST and cost
   * no file read, so the common case is unchanged.
   */
  resolveKey(query: string): string | null {
    const wanted = normalizeQuery(query);
    if (!wanted) return null;
    const index = this.opts.store.readIndex();
    if (index.packages[query.trim()]) return query.trim();
    for (const key of Object.keys(index.packages)) {
      const entry = index.packages[key];
      const exact = this.opts.store.get(key);
      const aliases = aliasesFor(key, (exact?.manifest ?? entry.versions[entry.latest]?.manifest ?? {}) as Record<string, unknown>, exact?.module ?? "");
      if (aliases.includes(wanted)) return key;
    }
    return null;
  }

  /**
   * THE ORIGIN, from the package's OWN `url`.
   *
   * This used to be `https://${host}` where `host` was the STORE KEY, so a
   * package published as `ui2api-site-example.test` handed its tools
   * `https://ui2api-site-example.test/` and every call died with
   * `page.goto: net::ERR_NAME_NOT_RESOLVED` — a tool driving a domain that
   * cannot exist. The origin is now the URL the package declares: the action
   * map's own `url` (what `analyse` captured and `publish` shipped), else the
   * manifest's, else a hostname the manifest declares as `host`. Only that last
   * fallback is name-derived, and only because it is then a real hostname.
   */
  private resolveBaseUrl(manifest: Record<string, unknown>, moduleText: string, fallbackHost: string): string {
    const candidates: unknown[] = [];
    try {
      const parsed = JSON.parse(moduleText) as { url?: unknown };
      if (parsed && typeof parsed === "object") candidates.push(parsed.url);
    } catch { /* JS module */ }
    candidates.push(manifest.url);
    for (const c of candidates) {
      if (typeof c !== "string" || !/^https?:\/\//i.test(c.trim())) continue;
      try { return new URL(c.trim()).origin; } catch { /* malformed — next candidate */ }
    }
    const declaredHost = typeof manifest.host === "string" ? manifest.host.trim() : "";
    return `https://${declaredHost || fallbackHost}`;
  }

  async getInstance(host: string): Promise<ManagedInstance> {
    const key = this.resolveKey(host);
    if (!key) throw new Error(`no package registered for host ${host}`);
    const existing = this.instances.get(key);
    if (existing) return existing;
    const pkg = this.opts.store.get(key);
    if (!pkg) throw new Error(`no package registered for host ${host}`);
    const baseUrl = this.resolveBaseUrl(pkg.manifest ?? {}, pkg.module ?? "", key);
    // The Hub owns the per-host runtime: it builds the allow-listed context
    // (which internally manages the host-scoped browser session) and never
    // hands the plugin launchBrowser/generate or raw fs access.
    const config: HubConfig = { dataDir: this.opts.dataDir };
    const context: Ui2ApiContext = createExecContext(config, {
      baseUrl,
      dataDir: this.opts.dataDir,
    });
    const moduleText = pkg.module ?? "";
    // Action-map packages store the captured map as JSON; hand-written plugin
    // packages store a JS module. Dispatch on which one we have.
    let asMap: unknown = null;
    try { const parsed = JSON.parse(moduleText); if (parsed && Array.isArray((parsed as any).actions)) asMap = parsed; } catch { /* not JSON → JS module */ }
    const plugin: LoadedPlugin = asMap
      ? loadPluginFromMap(asMap as any, config, baseUrl)
      : await loadPluginModule(moduleText, context);
    const inst: ManagedInstance = { host: key, baseUrl, store: this.opts.store, plugin };
    this.instances.set(key, inst);
    return inst;
  }

  async closeInstance(host: string): Promise<void> {
    // The same resolution the load path uses, so `closeInstance` works with
    // EITHER name form; a bare miss is a no-op exactly as before.
    const key = this.resolveKey(host) ?? host.trim();
    const inst = this.instances.get(key);
    if (!inst) return;
    this.instances.delete(key);
  }

  async closeAll(): Promise<void> {
    for (const h of [...this.instances.keys()]) await this.closeInstance(h);
  }
}
