#!/usr/bin/env node
// GOAL 93: append a machine-generated capability index to a package's
// CAPABILITIES.md so the "human-readable inventory" is COMPLETE against its own
// manifest, with each capability's HONEST status (never upgraded). Idempotent:
// the block is delimited and regenerated. Node-only, reads manifests, writes
// docs. Not a verification claim — a doc-completeness fix.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const START = "<!-- ui2api:capability-index:start -->";
const END = "<!-- ui2api:capability-index:end -->";

export function capabilityIndexBlock(pid) {
  const mf = resolve("capabilities", pid, "manifest.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  const caps = (m.capabilities || []).filter((c) => c && typeof c === "object" && c.id);
  let meta = {};
  try { meta = JSON.parse(readFileSync(resolve("capabilities", pid, "metadata.json"), "utf8")); } catch {}
  const pkgVerified = meta.verified && typeof meta.verified === "object" && meta.verified.since ? "verified (record in metadata.json)" : meta.status || "unverified (no verified record)";
  const lines = [
    START,
    "<!-- GENERATED from manifest.json by scripts/gen-capability-index.mjs — do not hand-edit. -->",
    "",
    "## Capability index (machine-generated, complete by construction)",
    "",
    `Package status: **${pkgVerified}**.`,
    "The status column below is each capability's OWN declared status — it is a",
    "declared surface, not a claim of a verified live round-trip.",
    "",
    "| capability id | name | declared status | description |",
    "| --- | --- | --- | --- |",
  ];
  for (const c of caps) {
    const status = c.status || (c.notes ? "see notes" : "declared (not verified)");
    const desc = (c.description || c.notes || "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160);
    lines.push(`| \`${c.id}\` | ${c.name || ""} | ${status} | ${desc} |`);
  }
  lines.push("", END);
  return lines.join("\n");
}

function main() {
  for (const pid of process.argv.slice(2)) {
    const mf = resolve("capabilities", pid, "manifest.json");
    if (!existsSync(mf)) { console.log(`skip ${pid}: no manifest.json`); continue; }
    const f = resolve("capabilities", pid, "CAPABILITIES.md");
    if (!existsSync(f)) { console.error(`skip ${pid}: no CAPABILITIES.md`); continue; }
    const cur = readFileSync(f, "utf8");
    const block = capabilityIndexBlock(pid);
    let next;
    if (cur.includes(START) && cur.includes(END)) {
      next = cur.replace(new RegExp(`${START}[\\s\\S]*${END}`), block);
    } else {
      next = cur.trimEnd() + "\n\n" + block + "\n";
    }
    writeFileSync(f, next);
    console.log(`indexed ${pid}`);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main();
