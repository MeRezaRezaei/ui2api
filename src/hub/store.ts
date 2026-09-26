import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface PackageVersion { file: string; manifest: Record<string, unknown>; module?: string; trust: "reviewed" | "unreviewed"; }
export interface RegistryIndex { packages: Record<string, { versions: Record<string, PackageVersion>; latest: string }>; }

/**
 * GOAL 121: `name` and `version` are ATTACKER-SUPPLIED (they arrive in the
 * `PUT /api/packages` body) and were interpolated straight into
 * `resolve(dataDir, "pkgs", name, version + ".json")`. PROVEN over the wire
 * against a real hub: `name:"../../ESCAPED-DATA-DIR"` landed OUTSIDE dataDir,
 * `version:"/etc/passwd"` resolved ABSOLUTE (it failed only on EACCES because
 * this box is unprivileged), and `name:"..", version:"registry"` overwrote
 * `registry.json` itself — which then made every later publish die with an
 * UNHANDLED TypeError. The install seam got this gate in GOAL 113; the hub seam
 * never had one.
 *
 * A publish target is not user input, it is an identifier: one safe segment.
 */
export function assertSafePackageSegment(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid package ${field}: must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  if (value === "." || value === "..") {
    throw new Error(`invalid package ${field}: ${JSON.stringify(value)} is a directory reference, not a name`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\u0000")) {
    throw new Error(
      `invalid package ${field}: ${JSON.stringify(value)} must be a single path segment (no separators, no NUL)`
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`invalid package ${field}: ${JSON.stringify(value)} may only contain letters, digits, dot, underscore and dash`);
  }
  return value;
}

/** The index must be an INDEX. A valid-JSON non-index is served back today. */
function isRegistryIndexShape(v: unknown): v is RegistryIndex {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    typeof (v as RegistryIndex).packages === "object" && (v as RegistryIndex).packages !== null &&
    !Array.isArray((v as RegistryIndex).packages);
}

export class RegistryStore {
  constructor(private dataDir: string) { mkdirSync(resolve(dataDir, "pkgs"), { recursive: true }); }
  private indexFile() { return resolve(this.dataDir, "registry.json"); }
  // GOAL 121: parse AND shape. A valid-JSON non-index (e.g. a package payload
  // clobbered over registry.json by a traversal publish) used to be served back
  // as the index, and `save` then dereferenced `i.packages[...]` unguarded —
  // an unhandled TypeError that killed the hub process, permanently.
  readIndex(): RegistryIndex {
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile(), "utf8"));
      if (!isRegistryIndexShape(parsed)) return { packages: {} };
      return parsed;
    } catch { return { packages: {} }; } }
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
    // GOAL 121: refuse BEFORE any filesystem work, so a bad name writes nothing.
    const safeName = assertSafePackageSegment("name", name);
    const safeVersion = assertSafePackageSegment("version", version);
    const pkgsRoot = resolve(this.dataDir, "pkgs");
    const file = resolve(pkgsRoot, safeName, `${safeVersion}.json`);
    // belt and braces: containment, not just segment shape
    if (!file.startsWith(pkgsRoot + sep)) {
      throw new Error(`refusing package path ${JSON.stringify(file)} — outside the store's pkgs root`);
    }
    mkdirSync(resolve(pkgsRoot, safeName), { recursive: true });
    writeFileSync(file, JSON.stringify({ manifest, module: moduleText }, null, 2));
    const i = this.readIndex();
    i.packages[safeName] ??= { versions: {}, latest: safeVersion };
    i.packages[safeName].versions[safeVersion] = { file, manifest, trust: "unreviewed" };
    if (!i.packages[safeName].latest) i.packages[safeName].latest = safeVersion;
    this.writeIndex(i);
  }
  setTrust(name: string, version: string, trust: "reviewed" | "unreviewed"): void {
    const i = this.readIndex(); const p = i.packages[name]?.versions[version];
    if (p) { p.trust = trust; this.writeIndex(i); }
  }
}
