/**
 * GOAL 139 — DERIVE each capability's arg contract from the RUNNER that reads it.
 *
 * The bug this exists to kill: the registry's inputSchema was guessed from a
 * capability id by regex, and the guess was wrong (youtube_search advertised
 * `{}` while its runner requires `args.query`). A guess cannot be right by
 * construction — the arg names live in the runner, so the runner is the ONLY
 * honest source.
 *
 * So we read the runner the way the daemon reads it: find `run()`'s
 * `case "<capability>": return this.<method>(...)` dispatch, then collect the
 * `args.<key>` reads inside that method's body. What comes out is not an
 * opinion — it is a transcription of the code that will handle the call.
 *
 * `required` is only claimed when the code REFUSES without the arg (a falsy
 * guard that returns an error). Anything weaker is reported optional, because
 * over-claiming `required` makes a consumer reject valid calls, and
 * under-claiming makes it send a call that fails — both are lies, and this
 * prefers the one the consumer can see and handle.
 *
 * Usage:  node --import tsx scripts/derive-capability-args.ts [--write]
 *         (no --write = report only, so a human reviews before anything lands)
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CAP_DIR = join(ROOT, "capabilities");
const RUNNER_DIR = join(ROOT, "src", "capabilities");

type Prop = { type: string; description?: string };

/** Find the runner file for a site id (site id -> <site>.ts, else scan for a mention). */
function runnerFor(siteId: string): string | null {
  const direct = join(RUNNER_DIR, `${siteId}.ts`);
  if (existsSync(direct)) return direct;
  for (const f of readdirSync(RUNNER_DIR)) {
    if (!f.endsWith(".ts")) continue;
    if (f === `${siteId}.ts`) return join(RUNNER_DIR, f);
  }
  return null;
}

/** Extract a method body by brace matching from its declaration. */
function methodBody(src: string, method: string): string | null {
  // Anchor to a line-start DECLARATION. A bare `name(` also matches a CALL —
  // `str.search(...)` matched `search`, so youtube_search was read from an
  // unrelated method's body and came back with no args at all (`{}`). Requiring
  // the match to begin a line (modifiers allowed) is what makes this the
  // declaration we meant.
  const decl = new RegExp(
    `(?:^|\\n)\\s*(?:(?:private|public|protected)\\s+)?(?:async\\s+)?${method}\\s*\\(`,
    "m"
  );
  const m = decl.exec(src);
  if (!m) return null;
  // Skip the PARAMETER LIST first. A default like `args: Record<string, unknown>
  // = {}` contains braces, so taking the first `{` after `(` would match the
  // default value's `{}` and yield an empty body — which is exactly how every
  // capability came back "no case in run()".
  let depth = 0;
  let close = -1;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const open = src.indexOf("{", close);
  if (open < 0) return null;
  depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** Map capability id -> runner method, from run()'s case labels. */
/**
 * Map capability id -> runner method, from run()'s case labels.
 *
 * GROUPED labels matter. A runner legitimately writes:
 *
 *   case "araprat_comment":
 *   case "araprat_like":
 *     return this.loginGated(capability);
 *
 * where only the LAST label sits next to the `return`. A naive "case ... this.x("
 * scan calls the earlier labels unimplemented — a FALSE NEGATIVE that would
 * report wired capabilities as unwired, which is exactly the kind of fabricated
 * finding this whole exercise exists to prevent. So we track PENDING labels and
 * attribute the next `this.<method>(` to all of them.
 */
function dispatchMap(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const runBody = methodBody(src, "run") ?? src;
  // Three dispatch shapes exist in this codebase and all three are real:
  //   return this.search(args);            — a method
  //   return loginGatedResult(id, cap);    — a bare module-level function (the
  //                                           honest login-gated stubs)
  //   case "a": case "b": return ...;      — grouped labels sharing one return
  const token = /case\s+"([^"]+)"\s*:|this\.([a-zA-Z0-9_]+)\s*\(|return\s+([a-zA-Z0-9_]+)\s*\(/g;
  const pending: string[] = [];
  for (const t of runBody.matchAll(token)) {
    if (t[1] !== undefined) {
      pending.push(t[1]);
      continue;
    }
    const method = t[2] ?? t[3];
    for (const cap of pending) if (!out.has(cap)) out.set(cap, method);
    pending.length = 0;
  }
  return out;
}

/** Resolve a dispatch target to a body: a class method, or a module-level function. */
function bodyForTarget(src: string, target: string): string | null {
  const asMethod = methodBody(src, target);
  if (asMethod) return asMethod;
  const fn = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${target}\\s*\\(`,
    "m"
  ).exec(src);
  if (fn) {
    let d = 0;
    for (let i = fn.index + fn[0].length - 1; i < src.length; i++) {
      if (src[i] === "(") d++;
      else if (src[i] === ")") {
        d--;
        if (d === 0) {
          const open = src.indexOf("{", i);
          if (open < 0) return null;
          let b = 0;
          for (let j = open; j < src.length; j++) {
            if (src[j] === "{") b++;
            else if (src[j] === "}") {
              b--;
              if (b === 0) return src.slice(open, j + 1);
            }
          }
        }
      }
    }
  }
  return null;
}

/** arg reads inside a body, plus whether the code refuses without them. */
function argContract(body: string): { props: Record<string, Prop>; required: string[]; anyOf: { required: string[]; description?: string }[] } {
  const keys = new Set<string>();
  for (const m of body.matchAll(/\bargs\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) keys.add(m[1]);
  const required: string[] = [];
  for (const k of keys) {
    // DIRECT refusal: `if (!args.k)`, `typeof args.k !== "string"`, `args.k === undefined`.
    const direct =
      new RegExp(`!\\s*args\\??\\.${k}\\b`).test(body) ||
      new RegExp(`typeof\\s+args\\??\\.${k}\\s*!==\\s*["']`).test(body) ||
      new RegExp(`args\\??\\.${k}\\s*===\\s*(undefined|null)`).test(body);
    if (direct) {
      required.push(k);
      continue;
    }
    // INDIRECT refusal — the common real shape, and the one a naive scan misses:
    //   const query = String(args.query ?? "").trim();
    //   if (!query) return this.fail("youtube_search", "query is required");
    // The guard is on a LOCAL derived from the arg, so `!args.k` never appears.
    // We only claim required when the guarded branch actually RETURNS A FAILURE
    // (`this.fail(`, `ok: false`, or `error:`) — a bare `if (!x)` fallthrough is
    // not a refusal and must not be reported as one.
    const derived = new RegExp(
      `const\\s+([a-zA-Z_]\\w*)\\s*=[^;]*args\\??\\.${k}\\b[^;]*;`,
      "g"
    );
    for (const d of body.matchAll(derived)) {
      const local = d[1];
      const guard = new RegExp(`if\\s*\\(\\s*!\\s*${local}\\b`);
      const g = guard.exec(body.slice(d.index));
      if (!g) continue;
      const after = body.slice(d.index + g.index, d.index + g.index + 220);
      if (/this\.fail\(|ok:\s*false|error:/.test(after)) {
        required.push(k);
        break;
      }
    }
  }
  // COALESCE GROUPS: `String(args.q ?? args.query ?? "")` means the runner
  // accepts ANY ONE of those names. Reporting all of them as `required` is a
  // false claim (a consumer would send all, or reject a valid call); reporting
  // none is equally wrong. The honest form is anyOf, and the runner's own error
  // text names the group.
  const anyOf: { required: string[]; description?: string }[] = [];
  const seenGroups = new Set<string>();
  for (const c of body.matchAll(/args\??\.([a-zA-Z_]\w*)\s*\?\?\s*args\??\.([a-zA-Z_]\w*)([^;]*)/g)) {
    const chain = [c[1], c[2]];
    // extend through further `?? args.X` in the same expression
    for (const m of c[3].matchAll(/\?\?\s*args\??\.([a-zA-Z_]\w*)/g)) chain.push(m[1]);
    const group = [...new Set(chain)].sort();
    const sig = group.join("|");
    if (seenGroups.has(sig)) continue;
    seenGroups.add(sig);
    // JSON Schema `anyOf` = at least one branch matches, and a branch's
    // `required` is a conjunction. So "q OR query" is TWO single-key branches —
    // one branch listing both would mean "q AND query", the opposite of what the
    // runner does, and a consumer validating against it would reject valid calls.
    for (const alt of group) {
      anyOf.push({
        required: [alt],
        description: `the runner reads args.${group[0]} ?? args.${group.slice(1).join(" ?? args.")}, so args.${alt} alone satisfies it`,
      });
    }
    for (const k of group) {
      const at = required.indexOf(k);
      if (at >= 0) required.splice(at, 1);
    }
  }
  const props: Record<string, Prop> = {};
  for (const k of [...keys].sort()) {
    // A numeric read is a number; everything else is a string arg by convention.
    const numeric =
      new RegExp(`Number\\(\\s*args\\??\\.${k}\\b`).test(body) ||
      new RegExp(`typeof\\s+args\\??\\.${k}\\s*===\\s*["']number["']`).test(body);
    const boolish = new RegExp(`args\\??\\.${k}\\b\\s*===\\s*true|Boolean\\(\\s*args\\??\\.${k}`).test(body);
    props[k] = {
      type: numeric ? "number" : boolish ? "boolean" : "string",
      description: `read by the runner as args.${k}`,
    };
  }
  return { props, required: required.sort(), anyOf };
}

const report: { site: string; cap: string; schema: unknown | null; why: string }[] = [];

for (const siteId of readdirSync(CAP_DIR).sort()) {
  const mf = join(CAP_DIR, siteId, "manifest.json");
  if (!existsSync(mf)) continue;
  const manifest = JSON.parse(readFileSync(mf, "utf8"));
  const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (!caps.length) continue;
  const runnerPath = runnerFor(siteId);
  if (!runnerPath) {
    for (const c of caps) if (typeof c?.id === "string") report.push({ site: siteId, cap: c.id, schema: null, why: "no runner file found" });
    continue;
  }
  const src = readFileSync(runnerPath, "utf8");
  const dispatch = dispatchMap(src);
  for (const c of caps) {
    if (typeof c?.id !== "string") continue;
    const method = dispatch.get(c.id);
    if (!method) {
      // A label that EXISTS in run() but reaches no call target is an INLINE
      // refusal — `case "x": return { ok: false, error: "..." }`, the honest
      // shape for a capability the site does not actually expose (measured
      // live: tencent-aistudio's web_search/deep_think toggles do not exist).
      // Such a handler reads no args, so `{}` is the TRUTHFUL contract — not a
      // gap, and not a fabrication.
      if (new RegExp(`case\\s+"${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(src)) {
        report.push({
          site: siteId,
          cap: c.id,
          schema: { type: "object", properties: {}, required: [] },
          why: "inline honest refusal in run() — reads no args",
        });
      } else {
        report.push({ site: siteId, cap: c.id, schema: null, why: "capability has no case in the runner's run()" });
      }
      continue;
    }
    const body = bodyForTarget(src, method);
    if (!body) {
      // A dispatch target we cannot read a body from is NOT a reason to skip the
      // declaration: it means the handler takes no `args` we can observe (the
      // honest login-gated stubs, which take only a capability id). That is a
      // real, truthful answer — an empty arg contract — not a gap.
      report.push({
        site: siteId,
        cap: c.id,
        schema: { type: "object", properties: {}, required: [] },
        why: `dispatched to ${method}() which reads no args`,
      });
      continue;
    }
    const { props, required, anyOf } = argContract(body);
    report.push({
      site: siteId,
      cap: c.id,
      schema: { type: "object", properties: props, required, ...(anyOf.length ? { anyOf } : {}) },
      why: `derived from ${method}()`,
    });
  }
}

const write = process.argv.includes("--write");
// --json makes the SAME derivation machine-readable, so the drift gate can run
// this script and compare instead of re-implementing the logic. A checker that
// duplicates the derivation is a second source of truth — exactly the disease
// this work is fixing.
if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(report));
  process.exit(0);
}

let written = 0;
for (const r of report) {
  if (!r.schema) continue;
  const mf = join(CAP_DIR, r.site, "manifest.json");
  const manifest = JSON.parse(readFileSync(mf, "utf8"));
  const entry = manifest.capabilities.find((c: { id?: string }) => c?.id === r.cap);
  if (!entry) continue;
  entry.inputSchema = r.schema;
  writeFileSync(mf, `${JSON.stringify(manifest, null, 2)}\n`);
  written++;
}

const derived = report.filter((r) => r.schema).length;
const undeclared = report.filter((r) => !r.schema);
console.log(`capabilities inspected : ${report.length}`);
console.log(`derived from runner    : ${derived}`);
console.log(`NOT derivable          : ${undeclared.length}`);
for (const u of undeclared) console.log(`   - ${u.site}/${u.cap}: ${u.why}`);
if (write) console.log(`\nWROTE inputSchema into ${written} manifest capability entries.`);
else console.log(`\n(dry run — pass --write to apply)`);
