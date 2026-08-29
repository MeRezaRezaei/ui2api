import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface PackageVersion { file: string; manifest: Record<string, unknown>; module?: string; trust: "reviewed" | "unreviewed"; }
export interface RegistryIndex { packages: Record<string, { versions: Record<string, PackageVersion>; latest: string }>; }

export class RegistryStore {
  constructor(private dataDir: string) { mkdirSync(resolve(dataDir, "pkgs"), { recursive: true }); }
  private indexFile() { return resolve(this.dataDir, "registry.json"); }
  readIndex(): RegistryIndex { try { return JSON.parse(readFileSync(this.indexFile(), "utf8")); } catch { return { packages: {} }; } }
  private writeIndex(i: RegistryIndex) { writeFileSync(this.indexFile(), JSON.stringify(i, null, 2)); }
  list(): { name: string; latest: string; trust: string; author: string }[] {
    const i = this.readIndex();
    return Object.entries(i.packages).map(([name, p]) => ({ name, latest: p.latest, trust: p.versions[p.latest].trust, author: String(p.versions[p.latest].manifest.author ?? "") }));
  }
  get(name: string, version?: string): PackageVersion | null {
    const i = this.readIndex(); const p = i.packages[name]; if (!p) return null;
    const v = version ?? p.latest; const ver = p.versions[v]; if (!ver) return null;
    let module = "";
    try { module = JSON.parse(readFileSync(ver.file, "utf8")).module ?? ""; } catch {}
    return { ...ver, module };
  }
  save(name: string, version: string, manifest: Record<string, unknown>, moduleText: string): void {
    const file = resolve(this.dataDir, "pkgs", name, `${version}.json`);
    mkdirSync(resolve(this.dataDir, "pkgs", name), { recursive: true });
    writeFileSync(file, JSON.stringify({ manifest, module: moduleText }, null, 2));
    const i = this.readIndex();
    i.packages[name] ??= { versions: {}, latest: version };
    i.packages[name].versions[version] = { file, manifest, trust: "unreviewed" };
    if (!i.packages[name].latest) i.packages[name].latest = version;
    this.writeIndex(i);
  }
  setTrust(name: string, version: string, trust: "reviewed" | "unreviewed"): void {
    const i = this.readIndex(); const p = i.packages[name]?.versions[version];
    if (p) { p.trust = trust; this.writeIndex(i); }
  }
}
