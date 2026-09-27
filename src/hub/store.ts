import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, sep } from "node:path";
// The segment gate is OWNED by src/registry/safe-segment.ts and re-exported
// here, unchanged, so this module's public API and its existing importer
// (test/hub-store-containment.test.ts) keep working while the install seam
// (src/registry/install.ts) shares the SAME definition. Two seams turn an
// identifier into a filesystem path; two copies of the rule is exactly how they
// drift apart — the install seam had no copy of it at all, and a registry index
// key of "../PWNED" wrote a package outside the install root. Cycle check, not
// assumed: safe-segment.ts's only import is `node:path`, so its relative-import
// closure is itself alone and this edge cannot close a loop.
import { assertSafePackageSegment } from "../registry/safe-segment.js";
export { assertSafePackageSegment };

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
 * The gate now lives in `src/registry/safe-segment.ts` and is re-exported above
 * — see the import note for why it moved and why that is not a cycle.
 */

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
  /**
   * Returns WHETHER the review actually landed. This used to return void and
   * no-op silently on a missing package, so the router above answered
   * `200 {"ok":true,"trust":"reviewed"}` for a review of something that was
   * never published — a success reported for a mutation that did not happen.
   * The boolean is the truth the route needs; the write itself is unchanged.
   */
  setTrust(name: string, version: string, trust: "reviewed" | "unreviewed"): boolean {
    const i = this.readIndex(); const p = i.packages[name]?.versions[version];
    if (!p) return false;
    p.trust = trust; this.writeIndex(i);
    return true;
  }
}
