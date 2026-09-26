// GOAL 107 — the generated ACP consumer server reported a FAILED DOM extraction
// (target element does not exist) as a normal JSON-RPC success whose text was
// the literal string "null", with no is_error and no named reason.
//
// This file pins the fix in two ways:
//   1. a MUTATION assertion — the pre-fix (unconditional-return) emit, produced
//      by excising the guarded region from the real template, provably DOES
//      return success-with-"null" for a missing selector, so the new pin in
//      test/acp.test.ts cannot pass against the old code;
//   2. a source-level pin on the emitted template so the guarded region cannot
//      silently disappear (a mutation test with no marker is a no-op).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert";
import { validateActionMap } from "../src/schema.js";
import { generate } from "../src/generator/generate.js";
import { acpServerTemplate } from "../src/generator/acp-template.js";
import type { ActionMap } from "../src/types.js";
import {
  MISS_CHECK_BEGIN,
  MISS_CHECK_END,
  readEmitted,
  startAcpServer,
  startLocalSite,
  stripMissCheck,
  writeVariant,
} from "./helpers/acp-harness.js";

const PAGE = `<!doctype html><html><body><div class="report">present</div></body></html>`;

function buildMap(url: string): ActionMap {
  const map = {
    host: "example-site",
    url,
    capturedAt: new Date().toISOString(),
    trusted: false,
    auth: { required: false },
    actions: [
      {
        name: "read_missing",
        description: "Read a selector that does not exist on the page.",
        execution: "live-js" as const,
        parameters: [] as any[],
        recipe: { kind: "js-function" as const, target: "window.noop", argsFrom: {} },
        result: { mode: "dom" as const, extract: "text #nope-not-here" },
        verified: true,
      },
    ],
  };
  return validateActionMap(map);
}

test("MUTATION: the pre-fix unconditional-return emit answers a missing selector with success \"null\"", async (t) => {
  const tmp = mkdtempSync(resolve(tmpdir(), "ui2api-acp-mutant-"));
  const site = await startLocalSite(PAGE);
  let client: ReturnType<typeof startAcpServer>["client"] | null = null;
  t.after(async () => {
    if (client) client.close();
    await site.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const serverDir = generate(buildMap(site.url), tmp, "acp");
  const acpPath = resolve(serverDir, "acp.ts");

  // Reconstruct the OLD server: same emitted file with the guarded miss-check
  // excised, i.e. exactly the unconditional `return { content: ... }`.
  const mutantPath = writeVariant(acpPath, stripMissCheck(readEmitted(acpPath)), "acp-mutant.ts");
  const mutant = readEmitted(mutantPath);
  assert.ok(
    !mutant.includes("is_error: true, content") || mutant.includes("unknown tool"),
    "the mutant must not contain the extraction-failure branch",
  );

  const { client: c } = startAcpServer(mutantPath);
  client = c;

  const res = await c.send("call_tool", { name: "read_missing", args: {} });
  // This is the bug: a success, no is_error, text is the literal "null".
  assert.notStrictEqual(res.is_error, true, "the OLD shape is the bug; it must be a plain success");
  assert.strictEqual(res.content?.[0]?.text, "null", "the OLD shape yields the literal string null");
});

test("the emitted ACP template guards its call_tool with the GOAL 107 miss-check region", () => {
  const src = acpServerTemplate("/tmp/whatever");
  assert.ok(src.includes(MISS_CHECK_BEGIN), "template lost the miss-check begin marker");
  assert.ok(src.includes(MISS_CHECK_END), "template lost the miss-check end marker");
  assert.ok(/is_error: true/.test(src), "template must emit an is_error branch for a failed extraction");
  assert.ok(
    /res === null/.test(src),
    "the miss-check must key off the null executeRecipe returns for an absent element",
  );
});
