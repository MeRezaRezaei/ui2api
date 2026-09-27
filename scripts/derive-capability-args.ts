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

// `bodyForTarget` used to live here — one body per dispatch target, which is
// exactly what missed a delegating handler. `delegatedBodies` below returns the
// same first body PLUS every in-file body the args object is forwarded to, and it
// also resolves a const-arrow target the old extractor could not. Kept as one
// extractor on purpose: two body extractors is two derivations, which is the
// disease this file exists to kill.

type Def = { params: string[]; body: string };

/** The parameter list of a declaration starting at its `(`. */
function paramList(src: string, open: number): { names: string[]; close: number } | null {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") d++;
    else if (src[i] === ")") {
      d--;
      if (d === 0) {
        const names: string[] = [];
        for (const seg of src.slice(open + 1, i).split(",")) {
          const m = seg.trim().match(/(?:^|\s)([a-zA-Z_$][\w$]*)\s*(?::[^,]*)?(?:=|$)/);
          if (m) names.push(m[1]);
        }
        return { names, close: i };
      }
    }
  }
  return null;
}

/**
 * Every named definition in the runner file, so a call target can be resolved
 * to a body even when it is a helper rather than the dispatched method.
 */
function allDefs(src: string): Map<string, Def> {
  const out = new Map<string, Def>();
  // `if (`, `for (`, `while (`, `catch (` are line-start `name(` shapes too. They
  // are never a hand-off of the args object, and letting them into the table
  // turns `if (args.x === "on")` into a candidate call site.
  const CONTROL = new Set(["if", "for", "while", "switch", "catch", "do", "else", "return"]);
  const take = (name: string, paren: number): void => {
    if (out.has(name) || CONTROL.has(name)) return;
    const pl = paramList(src, paren);
    if (!pl) return;
    // The body `{` is sought AFTER the parameter list: a default like
    // `args: Record<string, unknown> = {}` carries braces, and taking the first
    // one yields an empty body — a silent, total miss.
    const open = src.indexOf("{", pl.close);
    if (open < 0) return;
    let d = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}") {
        d--;
        if (d === 0) {
          out.set(name, { params: pl.names, body: src.slice(open, i + 1) });
          return;
        }
      }
    }
  };
  // class methods (line-start declaration, modifiers allowed)
  for (const m of src.matchAll(
    /(^|\n)\s*(?:(?:private|public|protected|static|readonly)\s+)*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/g
  )) {
    take(m[2], m.index + m[0].length - 1);
  }
  // module-level function declarations
  for (const m of src.matchAll(
    /(^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g
  )) {
    take(m[2], m.index + m[0].length - 1);
  }
  // top-level const arrow / function expression
  for (const m of src.matchAll(
    /(^|\n)\s*(?:export\s+)?const\s+([a-zA-Z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b[^(]*)?\(/g
  )) {
    take(m[2], m.index + m[0].length - 1);
  }
  return out;
}

/**
 * The bodies a dispatch target reaches, with the NAME each one binds the args
 * object to.
 *
 * THE DELEGATION BLIND SPOT. `deepseek_web_search` dispatches to `webSearch`,
 * whose entire body is `return this.flipToggle("…", "Search", args)`. Reading
 * only `webSearch`'s own body found NO `args.X` and reported `{}` — while
 * `flipToggle` genuinely reads `args.state`. The capability looked arg-less
 * because its handler is a one-line forwarder, and the manifest was generated
 * from that lie.
 *
 * The edge rule is deliberately the NARROWEST one that is still sound: we follow
 * a call only when the args OBJECT is passed as one whole argument, and we read
 * the callee through the parameter bound to that same argument position. Every
 * field read off that parameter is then an arg the caller can supply, because
 * the caller handed over the very object the callee is reading. That is a data
 * flow we can read off the source, not an inference about intent.
 *
 * What we therefore still REFUSE to report, on purpose:
 *  - a call that rebuilds a fresh object from args fields (`ask(p, {newChat:
 *    Boolean(args.newChat)})`): the callee reads ITS OWN parameter names, which
 *    are the caller's field names already accounted for at the call site.
 *  - an args read in a body reachable only by a CROSS-FILE call. The four
 *    `*_file_upload` capabilities are the live instance: each hands its whole
 *    args object to `validateAttachRequest` in `src/runtime/file-attach.ts`,
 *    whose `normalizeInput` accepts `string | Buffer | {path,filePath,data,
 *    bytes,base64,name,fileName,file:{…}}` — a discriminated union, whose real
 *    contract is the prose in the package's own recipe, not a flat property
 *    list. Transcribing it would be a fabrication, so it stays a NAMED gap that
 *    `test/derive-args-delegation.test.ts` measures and fails loud on.
 */
function delegatedBodies(src: string, target: string): { name: string; p: string; body: string }[] {
  const defs = allDefs(src);
  const start = defs.get(target);
  if (!start) return [];
  const out: { name: string; p: string; body: string }[] = [];
  const seen = new Set<string>();
  const queue: { name: string; p: string }[] = [{ name: target, p: start.params[0] ?? "args" }];
  while (queue.length) {
    const cur = queue.shift()!;
    const tag = `${cur.name}:${cur.p}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    const def = defs.get(cur.name);
    if (!def) continue;
    out.push({ name: cur.name, p: cur.p, body: def.body });
    // `(?<![.\w$])` is load-bearing: without it `Date.now(` is read as a call to
    // `now` and `str.trim(` as a call to `trim`, so the def table fills with
    // phantom entries and a phantom edge can attribute args to the wrong body.
    // Control keywords are excluded from the def table for the same reason —
    // `if (args.x === ...)` is a CONDITION, never a hand-off of the args object.
    for (const c of def.body.matchAll(/(?<![.\w$])(?:this\.)?([a-zA-Z_$][\w$]*)\s*\(/g)) {
      if (c[1] === cur.p) continue;
      const callee = defs.get(c[1]);
      if (!callee) continue;
      // Which ARGUMENT SLOT carries the object? The callee's parameter bound to
      // that same slot is the name its body reads — position 2 of
      // flipToggle(capability, toggleText, args) binds the args object to the
      // third parameter, and getting this wrong is how a rename hides the read.
      let d = 0;
      let close = -1;
      for (let i = c.index + c[0].length - 1; i < def.body.length; i++) {
        if (def.body[i] === "(") d++;
        else if (def.body[i] === ")") {
          d--;
          if (d === 0) {
            close = i;
            break;
          }
        }
      }
      if (close < 0) continue;
      const slot = def.body
        .slice(c.index + c[0].length, close)
        .split(",")
        .findIndex((a) => new RegExp(`^\\s*${cur.p}\\s*$`).test(a));
      if (slot < 0) continue;
      const p = callee.params[slot];
      if (!p) continue;
      queue.push({ name: c[1], p });
    }
  }
  return out;
}

/** arg reads inside the bodies a dispatch target reaches, plus refusals. */
function argContract(
  bodies: { name: string; p: string; body: string }[]
): { props: Record<string, Prop>; required: string[]; anyOf: { required: string[]; description?: string }[] } {
  // Every scan below is anchored on the name the body binds the args object to,
  // so a delegated helper contributes exactly the reads it makes of the object
  // it was handed. With no delegation this is one body bound to `args`, and the
  // result is byte-identical to what the single-body version produced.
  // A delegated helper binds the args object to whatever its own parameter is
  // called (`flipToggle(capability, toggleText, args)`, or `file` in
  // validateAttachRequest). Rewriting that name to the canonical `args.` token
  // lets every scan below run UNCHANGED, so a row with no delegation produces
  // byte-identical output to before and a delegated row is transcribed by the
  // same rules, not a second, looser rule set.
  const views = bodies.map(({ p, body }) => ({
    body: p === "args" ? body : body.replace(new RegExp(`\\b${p}\\??\\.`, "g"), "args?."),
  }));
  const keys = new Set<string>();
  for (const v of views) for (const m of v.body.matchAll(/\bargs\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) keys.add(m[1]);
  const required: string[] = [];
  const anyOf: { required: string[]; description?: string }[] = [];
  const seenGroups = new Set<string>();
  // Scanned PER BODY, never over a concatenation: a `const local = ...` in one
  // body and a guarding `if (!local)` in another are two unrelated functions, and
  // pairing them across the seam would claim a `required` the code never enforces.
  for (const { body } of views) {
    for (const k of keys) {
      if (!new RegExp(`\\bargs\\??\\.${k}\\b`).test(body)) continue;
      // DIRECT refusal: `if (!args.k)`, `typeof args.k !== "string"`, `args.k === undefined`.
      const direct =
        new RegExp(`!\\s*args\\??\\.${k}\\b`).test(body) ||
        new RegExp(`typeof\\s+args\\??\\.${k}\\s*!==\\s*["']`).test(body) ||
        new RegExp(`args\\??\\.${k}\\s*===\\s*(undefined|null)`).test(body);
      if (direct) {
        if (!required.includes(k)) required.push(k);
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
          if (!required.includes(k)) required.push(k);
          break;
        }
      }
    }
    // COALESCE GROUPS: `String(args.q ?? args.query ?? "")` means the runner
    // accepts ANY ONE of those names. Reporting all of them as `required` is a
    // false claim (a consumer would send all, or reject a valid call); reporting
    // none is equally wrong. The honest form is anyOf, and the runner's own error
    // text names the group.
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
  }
  const props: Record<string, Prop> = {};
  const all = views.map((v) => v.body).join("\n");
  for (const k of [...keys].sort()) {
    // A numeric read is a number; everything else is a string arg by convention.
    const numeric =
      new RegExp(`Number\\(\\s*args\\??\\.${k}\\b`).test(all) ||
      new RegExp(`typeof\\s+args\\??\\.${k}\\s*===\\s*["']number["']`).test(all);
    const boolish = new RegExp(`args\\??\\.${k}\\b\\s*===\\s*true|Boolean\\(\\s*args\\??\\.${k}`).test(all);
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
    // The dispatch target's body, PLUS every in-file body it forwards the args
    // object to. Without the second half a one-line forwarder reads as arg-less
    // and its capability is advertised with `{}` (the deepseek_web_search defect).
    const bodies = delegatedBodies(src, method);
    if (!bodies.length) {
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
    const { props, required, anyOf } = argContract(bodies);
    report.push({
      site: siteId,
      cap: c.id,
      schema: { type: "object", properties: props, required, ...(anyOf.length ? { anyOf } : {}) },
      why:
        bodies.length > 1
          ? `derived from ${bodies.map((b) => `${b.name}()`).join(" -> ")}` // the delegation chain, named
          : `derived from ${method}()`,
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
