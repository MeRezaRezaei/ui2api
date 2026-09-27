/**
 * GOAL 139 (addendum) — THE DELEGATION GATE.
 *
 * `test/registry-args-drift.test.ts` re-runs `scripts/derive-capability-args.ts`
 * and compares its output against every package manifest under `capabilities/`.
 * That gate
 * is necessary and it is NOT sufficient: it asserts the manifest matches the
 * derivation, so when the DERIVATION is blind, the manifest matches the blindness
 * and the gate is green. That is exactly the inherited defect —
 * `deepseek_web_search` derived `{}` while `flipToggle` read `args.state`, the
 * manifest was written from that `{}`, and the drift gate agreed with both.
 *
 * So this file is an INDEPENDENT ORACLE, and the duplication is the point, not an
 * accident: it recomputes what each runner can read by a deliberately different,
 * dumber route (whole-body text + naive call walking) and holds the derivation
 * against it in BOTH directions:
 *
 *   - UNDER-claiming: every arg reachable from a capability's dispatch target
 *     must appear in the derived schema. This is the blind spot, and it is why
 *     a one-line forwarder used to look arg-less.
 *   - OVER-claiming: the derived schema must contain NOTHING that is not
 *     reachable. This is the direction that matters most. Reporting an arg the
 *     runner does not read is a fabrication, and a fabrication behind
 *     `argsDeclared: true` is the one failure this whole derivation exists to
 *     prevent — a consumer is entitled to REFUSE it. A fix that widened the
 *     regex and started naming unread args would make things strictly worse.
 *
 * The known cross-module gap is pinned as an EXACT list, so it is visible and
 * fails loud rather than passing quietly or being quietly forgotten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RUNNERS = resolve(ROOT, "src", "capabilities");

type Row = { site: string; cap: string; schema: null | { properties?: Record<string, unknown> }; why: string };

/**
 * Capabilities whose args reads live in ANOTHER MODULE, behind a polymorphic
 * normaliser, and are therefore deliberately NOT transcribed.
 *
 * Each of these runners hands its whole args object to `validateAttachRequest` in
 * `src/runtime/file-attach.ts`, whose `normalizeInput` accepts
 * `string | Buffer | {path | filePath, data | bytes | base64, name | fileName,
 * file: {…}}` — a discriminated union with alias fallbacks, whose real contract
 * is the prose in the package's own recipe
 * (`"Payload: args.path, or args.file={name,mimeType,data|path}, or
 * args.data(base64)+args.name"`), not a flat property list. Flattening it into a
 * JSON Schema would be a guess about a union — exactly the fabrication this file
 * exists to prevent — so the derivation refuses it and the gap is named here.
 *
 * The declared `{}` is a MILD, VISIBLE wrongness for this class, not a silent
 * one: a consumer that sends no args gets the runner's own named refusal
 * (`attach_payload_missing`), never a wrong successful call. That is what
 * separates this class from the deepseek one, where `{}` made a toggle silently
 * toggle the wrong way.
 */
const KNOWN_CROSS_MODULE_GAP = [
  "duckduckgo/duckduckgo_file_upload",
  "gemini/gemini_file_upload",
  "kimi/kimi_file_upload",
  "youtube/youtube_upload",
];

function deriveReport(): Row[] {
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", resolve(ROOT, "scripts", "derive-capability-args.ts"), "--json"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(out) as Row[];
}

function paramList(src: string, open: number): { names: string[]; close: number } {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") d++;
    else if (src[i] === ")") {
      d--;
      if (d === 0)
        return {
          names: src
            .slice(open + 1, i)
            .split(",")
            .map((seg) => seg.trim().match(/(?:^|\s)([a-zA-Z_$][\w$]*)\s*(?::[^,]*)?(?:=|$)/)?.[1])
            .filter((x): x is string => !!x),
          close: i,
        };
    }
  }
  return { names: [], close: -1 };
}

function block(src: string, open: number): string {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") {
      d--;
      if (d === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

/** name -> {params, body} for every definition in a runner file. */
function defs(src: string): Map<string, { params: string[]; body: string }> {
  const out = new Map<string, { params: string[]; body: string }>();
  // `if (`, `for (`, `while (`, `catch (` are line-start `name(` shapes as well.
  // They are a CONDITION, never a hand-off of the args object, and admitting them
  // turns `if (args.x === "on")` into a candidate call site.
  const CONTROL = new Set(["if", "for", "while", "switch", "catch", "do", "else", "return"]);
  const take = (name: string, paren: number): void => {
    if (out.has(name) || CONTROL.has(name)) return;
    const pl = paramList(src, paren);
    if (pl.close < 0) return;
    // The `{` must be sought AFTER the parameter list: a default like
    // `args: Record<string, unknown> = {}` carries braces, and taking the first
    // one yields an empty body — which silently makes every oracle check vacuous.
    const open = src.indexOf("{", pl.close);
    if (open < 0) return;
    out.set(name, { params: pl.names, body: block(src, open) });
  };
  for (const m of src.matchAll(/(^|\n)\s*(?:(?:private|public|protected|static|readonly)\s+)*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/g))
    take(m[2], m.index + m[0].length - 1);
  for (const m of src.matchAll(/(^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g))
    take(m[2], m.index + m[0].length - 1);
  return out;
}

/** capability id -> dispatch target, from run()'s case labels. */
function dispatchOf(src: string): Map<string, string> {
  const rm = /(^|\n)\s*(?:(?:private|public|protected)\s+)?(?:async\s+)?run\s*\(/.exec(src);
  if (!rm) return new Map();
  const pl = paramList(src, rm.index + rm[0].length - 1);
  if (pl.close < 0) return new Map();
  const braceAt = src.indexOf("{", pl.close);
  const runBody = braceAt >= 0 ? block(src, braceAt) : src;
  const out = new Map<string, string>();
  const pending: string[] = [];
  for (const t of runBody.matchAll(/case\s+"([^"]+)"\s*:|this\.([a-zA-Z0-9_]+)\s*\(|return\s+([a-zA-Z0-9_]+)\s*\(/g)) {
    if (t[1] !== undefined) {
      pending.push(t[1]);
      continue;
    }
    const m = t[2] ?? t[3];
    for (const c of pending) if (!out.has(c)) out.set(c, m);
    pending.length = 0;
  }
  return out;
}

/**
 * Every arg the runner can read for this capability: the dispatch target's own
 * body, plus every IN-FILE body it forwards the args object to (following the
 * object through the argument slot it was passed in, so a renamed or
 * re-ordered parameter is still resolved).
 */
function reachable(src: string, target: string): Set<string> {
  const d = defs(src);
  const start = d.get(target);
  const keys = new Set<string>();
  if (!start) return keys;
  const seen = new Set<string>();
  const queue: { name: string; p: string }[] = [{ name: target, p: start.params[0] ?? "args" }];
  while (queue.length) {
    const cur = queue.shift()!;
    const tag = `${cur.name}:${cur.p}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    const def = d.get(cur.name);
    if (!def) continue;
    for (const r of def.body.matchAll(new RegExp(`\\b${cur.p}\\??\\.([a-zA-Z_][\\w]*)`, "g"))) keys.add(r[1]!);
    // `(?<![.\w$])` is load-bearing: without it `Date.now(` reads as a call to
    // `now` and `str.trim(` as a call to `trim`, and the table fills with phantom
    // entries that can attribute an arg to the wrong body.
    for (const c of def.body.matchAll(/(?<![.\w$])(?:this\.)?([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const callee = d.get(c[1]!);
      if (!callee) continue;
      let depth = 0;
      let close = -1;
      for (let i = c.index + c[0].length - 1; i < def.body.length; i++) {
        if (def.body[i] === "(") depth++;
        else if (def.body[i] === ")") {
          depth--;
          if (depth === 0) {
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
      if (p) queue.push({ name: c[1]!, p });
    }
  }
  return keys;
}

test("GOAL 139 delegation: THE ORACLE IS NOT VACUOUS — it really walks the whole surface", () => {
  // This test exists because the oracle WAS vacuous and passed anyway. Two
  // separate silent-zero bugs got it there, and both are the kind that never
  // announce themselves: (1) seeking the body's `{` from the `(` of the
  // parameter list, which lands on the `{}` of a default like
  // `args: Record<string, unknown> = {}` and yields an empty body for every
  // method; (2) `\bargs\?\.` — an ESCAPED `?` is a mandatory literal, so it
  // only ever matched `args?.x` and never plain `args.x`. Both produced a
  // green gate over zero rows checked. A gate that can silently check nothing is
  // worse than no gate, so the row count is asserted here.
  const report = deriveReport();
  const inlineRefusals = report.filter((r) => /inline honest refusal/.test(r.why));
  let checked = 0;
  let withArgs = 0;
  for (const row of report) {
    const rp = resolve(RUNNERS, `${row.site}.ts`);
    if (!existsSync(rp)) continue;
    const target = dispatchOf(readFileSync(rp, "utf8")).get(row.cap);
    if (!target) continue;
    checked++;
    if (reachable(readFileSync(rp, "utf8"), target).size) withArgs++;
  }
  assert.equal(
    checked,
    report.length - inlineRefusals.length,
    `the oracle must check every row except the inline refusals: checked ${checked} of ${report.length} ` +
      `(${inlineRefusals.length} inline refusals). A drop here means the dispatch map or the body ` +
      `extractor went blind, and every assertion below is passing over nothing.`
  );
  assert.ok(
    withArgs >= 30,
    `the oracle must find real arg reads on a real share of the surface; found only ${withArgs} rows ` +
      "with any reachable arg — that is the vacuous-gate signature again"
  );
  // An inline honest refusal returns `{ ok: false, error }` from run() itself, so
  // it provably reads no args and declaring nothing is the truthful contract.
  for (const r of inlineRefusals) {
    assert.deepEqual(
      r.schema,
      { type: "object", properties: {}, required: [] },
      `${r.site}/${r.cap}: an inline refusal reads no args, so declaring none is correct — a property here would be a fabrication`
    );
  }
});

test("GOAL 139 delegation: the derived contract is COMPLETE — no arg the runner can read is missing", () => {
  const report = deriveReport();
  assert.ok(report.length > 100, `expected the whole capability surface, got ${report.length}`);
  const incomplete: string[] = [];
  for (const row of report) {
    const rp = resolve(RUNNERS, `${row.site}.ts`);
    if (!existsSync(rp)) continue;
    const src = readFileSync(rp, "utf8");
    const target = dispatchOf(src).get(row.cap);
    if (!target) continue;
    const can = reachable(src, target);
    const got = new Set(Object.keys(row.schema?.properties ?? {}));
    const missing = [...can].filter((k) => !got.has(k));
    if (missing.length) {
      incomplete.push(`${row.site}/${row.cap}: runner can read [${missing.sort()}] but the schema declares [${[...got].sort()}]`);
    }
  }
  assert.deepEqual(
    incomplete,
    [],
    "a derived contract must be a faithful copy of the runner's reads.\n" +
      "A capability whose handler DELEGATES must still report the args its helper reads.\n" +
      `incomplete:\n${incomplete.map((i) => `  - ${i}`).join("\n")}`
  );
});

test("GOAL 139 delegation: the derived contract does NOT OVER-claim — no arg the runner never reads", () => {
  // The direction that must never regress. `argsDeclared: true` exists so a
  // consumer can REFUSE a fabrication; a schema naming an unread arg is a
  // fabrication wearing that flag.
  const report = deriveReport();
  const fabricated: string[] = [];
  for (const row of report) {
    const rp = resolve(RUNNERS, `${row.site}.ts`);
    if (!existsSync(rp)) continue;
    const src = readFileSync(rp, "utf8");
    const target = dispatchOf(src).get(row.cap);
    if (!target) continue;
    const can = reachable(src, target);
    const got = Object.keys(row.schema?.properties ?? {});
    const extra = got.filter((k) => !can.has(k));
    if (extra.length) fabricated.push(`${row.site}/${row.cap}: declares [${extra}] the runner never reads`);
  }
  assert.deepEqual(
    fabricated,
    [],
    `a declared arg the runner does not read is a FABRICATION, and argsDeclared:true lets a consumer trust it.\n${fabricated
      .map((f) => `  - ${f}`)
      .join("\n")}`
  );
});

test("GOAL 139 delegation: the KNOWN cross-module gap is exactly the named set — no more, no fewer", () => {
  // The 4 file-upload capabilities read their args inside
  // `src/runtime/file-attach.ts`, behind a discriminated union the schema cannot
  // honestly flatten. They are NOT fixed; they are MEASURED and PINNED, so a
  // fifth one appearing — or one of them being fixed — turns this red instead of
  // letting the gap drift unnoticed in either direction.
  const report = deriveReport();
  const gap: string[] = [];
  for (const row of report) {
    const key = `${row.site}/${row.cap}`;
    if (!KNOWN_CROSS_MODULE_GAP.includes(key)) continue;
    const rp = resolve(RUNNERS, `${row.site}.ts`);
    if (!existsSync(rp)) continue;
    const src = readFileSync(rp, "utf8");
    const target = dispatchOf(src).get(row.cap);
    // The runner's OWN body reads no args — that is why the derivation sees none.
    // The reads are behind the cross-file hand-off to validateAttachRequest.
    const own = target ? reachable(src, target) : new Set<string>();
    if (own.size === 0) gap.push(key);
  }
  assert.deepEqual(
    gap,
    KNOWN_CROSS_MODULE_GAP,
    "the cross-module gap changed. If a capability here is now derivable, FIX it in " +
      "scripts/derive-capability-args.ts and drop it from KNOWN_CROSS_MODULE_GAP. If a NEW " +
      "capability reads its args only across a module boundary, name it here and explain why it " +
      "cannot be transcribed — never let it pass as an empty contract."
  );
});

test("GOAL 139 delegation: a delegating handler is no longer reported as arg-less (the deepseek regression)", () => {
  // The measured instance, pinned by capability id so a rename cannot quietly
  // retire the pin. `webSearch`'s entire body is
  // `return this.flipToggle("…", "Search", args)`; `flipToggle` reads
  // `args.state`, which is how a consumer asks for a specific toggle state
  // instead of taking the default flip. Reported as `{}` it made a consumer's
  // "turn search off" silently turn it ON.
  const report = deriveReport();
  for (const cap of ["deepseek_web_search", "deepseek_reasoner"]) {
    const row = report.find((r) => r.cap === cap);
    assert.ok(row, `${cap} must be in the derivation report`);
    const props = Object.keys(row!.schema?.properties ?? {});
    assert.deepEqual(
      props,
      ["state"],
      `${cap} must declare exactly the args its runner reads — the delegated flipToggle reads args.state`
    );
    assert.match(
      row!.why,
      /->/,
      `${cap} derives through a delegation, so the report must name the chain it followed`
    );
  }
});

test("GOAL 139 delegation: a manifest's declared args match the derivation for every delegating capability", () => {
  // Closes the loop on the manifest side for the rows this gate governs: the
  // deepseek manifests must actually carry `state` on disk, not just in the
  // derivation's output. A fix that changed the script but never regenerated the
  // manifest would leave the lie in place and the drift gate would (correctly)
  // complain about it — this asserts the intent so the failure names the cause.
  const report = deriveReport();
  for (const cap of ["deepseek_web_search", "deepseek_reasoner"]) {
    const row = report.find((r) => r.cap === cap);
    const mf = resolve(ROOT, "capabilities", row!.site, "manifest.json");
    const manifest = JSON.parse(readFileSync(mf, "utf8"));
    const entry = (manifest.capabilities ?? []).find((c: { id?: string }) => c?.id === cap);
    assert.ok(entry, `${cap} must exist in ${row!.site}/manifest.json`);
    assert.deepEqual(
      entry.inputSchema,
      row!.schema,
      `${cap}: the manifest must carry what the runner reads — re-run: node --import tsx scripts/derive-capability-args.ts --write`
    );
  }
});
