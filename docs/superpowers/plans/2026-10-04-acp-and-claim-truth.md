# ACP Surface & Claim-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining measured defects in this repo's honesty and safety work — a browser-driving origin that is guessed from a *name*, a refusal literal no gate can pin, and a JSON-RPC unknown method that answers in a success shape.

**Architecture:** Three independent defects in three different subsystems (`hub` runtime, the CLI's numeric seam, the ACP JSON-RPC router). Each is fixed at the layer that owns it, and each gets a machine gate that fails if the fix regresses. No task depends on another, so they may be executed in any order or in parallel.

**Tech Stack:** TypeScript (Node 24, ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, Playwright/Chrome for any live browser proof, `node:http` for the ACP surface.

**Spec:** This plan. The defects were measured, not inferred — every line number below was read from the source at the time of writing, and the "Measured" line in each task is the evidence that the defect is real. The governing principles are recorded in `.brain/verbatim-goals.md` rounds N+163 through N+181.

## Global Constraints

- **Every command in every step carries a real `timeout -k 5 <secs>`**, sized to the command's real expected duration. Exit `124` is a NAMED failure to report, never a silent retry.
- **Never fabricate a round trip.** A named, reproducible failure is a valid outcome; a green claim not earned is a failure. If a live proof is not run, say so explicitly in the report.
- **No headless browser may stand in for a proof.** This repo treats headless as a forgery. Any browser proof uses real Chrome **headed under the existing `Xvfb :99`** (`DISPLAY=:99`).
- **Leave the machine as you found it.** No stray listeners, no leftover Chrome, no scratch outside `/tmp/codeg-acp/`. Ownership check before killing anything: listeners on `8799` belong to `semantic-layer`, and Chrome under another lane's `/tmp/codeg-acp/<other-id>/` is not yours.
- **Never touch** `/opt/ui2api`, any systemd unit, or the repo's `data/` (the `0700 ui2api:ui2api` credential vault). Production runs at `999632eb` and must stay there.
- **Do not weaken a gate to make it pass.** Narrow a check; never delete it. Precedent: `test/ci-contract-knob-cites.test.ts` softened a line-exact pin into a file pin plus a disclosed non-regressing drift count.
- **Write one change at a time and verify between changes.** Seven agents in this arc died by building everything in context before writing; every one that was told to get a compiling artefact onto disk early survived.
- Test files use `node:test`, and assertions live inside real top-level `test(...)` calls — **never** inside a bare `describe` body (`test/assertions-are-counted.test.ts` enforces this).

---

### Task 1: A name must never stand in for a URL

**The defect (measured).** `src/hub/runtime.ts:117-118` is the last statement of
`resolveBaseUrl`:

```ts
const declaredHost = typeof manifest.host === "string" ? manifest.host.trim() : "";
return `https://${declaredHost || fallbackHost}`;
```

When a package declares **no** `url` anywhere — not on the manifest, not in its action map —
this **invents an origin from a name**. That is precisely the bug fixed in the previous round:
the store key is `ui2api-site-<host>`, so the fallback can construct
`https://ui2api-site-example.test/`, which resolves nowhere. Measured earlier in this arc:
`page.goto: net::ERR_NAME_NOT_RESOLVED at https://ui2api-site-example.test/`.

**Zero tests reference `baseUrl`** — `grep -rn "resolveBaseUrl\|baseUrl" test/hub-runtime.test.ts
test/registry-contract-hub-truth.test.ts` returns nothing. So the branch is both wrong and
uncovered.

**Why refuse rather than test the guess.** A test that pins `https://${name}` would enshrine a
guess. The repo's rule is that a tool states what it knows and refuses when it does not: an
invented origin fails later, deep inside a browser, as a network error that looks like a site
problem. Refusing at resolution converts that into a named refusal at the moment the operator
can still act.

**Files:**
- Modify: `src/hub/runtime.ts:112-119` (`resolveBaseUrl` tail)
- Test: `test/hub-origin-truth.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `resolveBaseUrl` now **throws** `Error` instead of returning a string, when no
  declared `url` exists. Every caller must already handle a throw from `getInstance` —
  verify `getInstance` (line ~121) does not need a `try`/`catch`, since it is called from an
  `async` command handler whose rejection already propagates.

- [ ] **Step 1: Write the failing test**

Create `test/hub-origin-truth.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubRuntime } from "../src/hub/runtime.js";

// A package that declares NO url anywhere must NOT get an invented origin.
const STORE = {
  get: (key: string) =>
    key === "ui2api-site-nourl.test"
      ? { manifest: { host: "nourl.test", name: key }, module: "" }
      : undefined,
};

test("a package with no declared url REFUSES instead of inventing an origin", () => {
  const rt = new HubRuntime({ store: STORE, dataDir: "/tmp/codeg-acp/origin-truth" } as never);
  assert.throws(
    () => rt.resolveBaseUrl({ host: "nourl.test" } as never, "", "ui2api-site-nourl.test"),
    /no url/i,
    "expected a refusal naming the missing url, not an invented https://<name>",
  );
});

test("a declared url IS still used verbatim", () => {
  const rt = new HubRuntime({ store: STORE, dataDir: "/tmp/codeg-acp/origin-truth" } as never);
  assert.equal(
    rt.resolveBaseUrl({ url: "https://example.com/page" } as never, "", "k"),
    "https://example.com",
    "a declared url must win and be reduced to its origin",
  );
});
```

**If `resolveBaseUrl` is `private`,** expose it for testing the same way the repo already does
elsewhere — check how `test/hub-runtime.test.ts` reaches internals and follow that precedent
rather than inventing a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout -k 5 200 npx tsx --test test/hub-origin-truth.test.ts`
Expected: FAIL — the current code returns `https://nourl.test` instead of throwing.

- [ ] **Step 3: Replace the guess with a named refusal**

In `src/hub/runtime.ts`, replace lines 117-118 with:

```ts
      const declaredHost = typeof manifest.host === "string" ? manifest.host.trim() : "";
      // A NAME IS NOT A URL. Guessing `https://<name>` produced origins like
      // `https://ui2api-site-example.test/`, which resolve nowhere and failed
      // later as ERR_NAME_NOT_RESOLVED inside a browser -- indistinguishable
      // from the site being down. Refuse here, where the operator can act.
      throw new Error(
        `package "${fallbackHost}" declares no url, so there is no origin to drive: ` +
          `its manifest and action-map carry neither a \`url\` nor a usable one. ` +
          `A package must be published from a captured action map (ui2api analyse <url>), ` +
          `which records the site url. Refusing beats inventing https://${declaredHost || fallbackHost}.`,
      );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout -k 5 200 npx tsx --test test/hub-origin-truth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the neighbouring suites — this changes a code path**

Run: `timeout -k 5 200 npx tsx --test test/hub.test.ts test/hub-runtime.test.ts test/hub-store-containment.test.ts test/registry-contract-hub-truth.test.ts test/acp-call-tool.test.ts`
Expected: all pass. **If any fails because it relied on the invented origin, that test was
pinning a guess — report it, do not edit it to restore the guess.**

- [ ] **Step 6: Commit**

```bash
git add src/hub/runtime.ts test/hub-origin-truth.test.ts package.json
git commit -m "hub: refuse an invented origin instead of guessing https://<name>"
```

(`package.json` only if `test:unit` enumerates rather than globs — check; it does, so add the
file in alphabetical position and say so.)

---

### Task 2: Make the numeric refusal's anchor derivable, so a gate can pin it

**The defect (measured).** `test/skills-refusal-truth.test.ts` derives 11 refusal seams from
`src/` and **drops** `numericFlagRefusal`'s `malformed value for …` message. The reason is
structural, and it was recorded as a known limitation:

> its message interpolates `${t.flag}` and its guard names no literal flag (`NUMERIC_FLAGS` is
> a derived set), so no trigger is derivable and the seam is **dropped rather than gated on
> nothing**.

So a skill may name `--pool-max` and owe nothing about the refusal it will print. The anchor
**is** derivable — it is the literal run before the first `${`, which is
`malformed value for ` — but the gate's association step requires a **literal flag** in the
guard and gives up when it finds a derived set.

**This task fixes the GATE, not the source.** The source message is fine and its behaviour is
already pinned by `test/cli-input-validation.test.ts` — read it for the current coverage rather than
trusting a number here: an undated per-file count in a shipped doc is a claim, and claims rot.

**Files:**
- Modify: `test/skills-refusal-truth.test.ts` (the seam-association step)
- Test: `test/skills-refusal-truth.test.ts` (its own mutation test for the new capability)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the gate additionally recognises a guard naming a **derived flag set**
  (`NUMERIC_FLAGS.has(t.flag)`) as a valid trigger, so the seam is gated. It must then require
  any skill naming a derived-numeric flag to carry the `malformed value for ` anchor.

- [ ] **Step 1: Reproduce the drop, so the fix is aimed**

Run: `timeout -k 5 60 npx tsx -e '
import { readFileSync } from "node:fs";
const src = readFileSync("src/cli.ts", "utf8");
const hasLiteralFlagGuard = /if \(!([A-Z_]+)\.has\(t\.flag\)\) continue;/.test(src);
console.log("derived-set guards present:", hasLiteralFlagGuard);
console.log("skills naming a numeric flag:", readFileSync("skills/ui2api-operate/SKILL.md","utf8").includes("--pool-max"));
console.log("skills carrying the anchor:", readFileSync("skills/ui2api/SKILL.md","utf8").includes("malformed value for"));
'`
Expected: `true`, `true`, `false` — the skill names the flag and does not carry the anchor.

- [ ] **Step 2: Write the failing assertion inside the gate's own style**

Add a test to `test/skills-refusal-truth.test.ts` that asserts the derived seam is **not
dropped**:

```ts
t("a seam whose guard names a DERIVED flag set is gated, not dropped", (ctx: TestContext) => {
  const derived = derivedSetSeams();
  assert.ok(
    derived.length > 0,
    "no seam guarded by a derived flag set was found — the association step regressed",
  );
  for (const s of derived) {
    assert.ok(
      s.anchor.length >= 8,
      `derived-set seam ${s.fn} produced a non-token anchor ${JSON.stringify(s.anchor)}`,
    );
  }
});
```

Use the file's real helper names — read them first; the above is the shape, not the spelling.

- [ ] **Step 3: Run it to verify it fails**

Run: `timeout -k 5 200 npx tsx --test test/skills-refusal-truth.test.ts`
Expected: FAIL on the new test — `derivedSetSeams()` does not exist / returns empty.

- [ ] **Step 4: Extend the association step**

In the seam-derivation code, treat a guard of the form
`if (!<IDENT>.has(t.flag)) continue;` where `<IDENT>` is a module-level `Set` **derived from
the parser** (here `NUMERIC_FLAGS`) as a valid trigger set, exactly as a literal flag list is
treated today. Then:

- derive the anchor as the literal run preceding the first `${` in the message
  (`malformed value for ` for this seam);
- assert it is long enough to be a stable token (the file already has an
  "anchor is distinctive enough" check — reuse its threshold).

**Do not** widen the refusal marker or the `*Refusal`/`*ModeArg` allowlist; those are already
calibrated down to 11 seams and widening them is how the marker once swept 61.

- [ ] **Step 5: Run the gate — it should now go RED on the skills, and that is the point**

Run: `timeout -k 5 200 npx tsx --test test/skills-refusal-truth.test.ts`
Expected: the new non-vacuity test **passes**, and the gap test now **FAILS** naming the skills
that owe the `malformed value for ` anchor. **A green run here means the fix did nothing and the
seam is still dropped** — that is a failure of this task, not a clean result.

- [ ] **Step 6: Commit the gate half, then the skill half as a separate task in the wave**

```bash
git add test/skills-refusal-truth.test.ts
git commit -m "test: gate the numeric refusal seam instead of dropping it"
```

Then dispatch a sibling to add the anchor to the named skills (another lane owns `skills/**`),
then re-run:

Run: `timeout -k 5 200 npx tsx --test test/skills-refusal-truth.test.ts test/skills-truth.test.ts`
Expected: both green.

---

### Task 3: An unknown JSON-RPC method must answer in the error shape, not a success shape

**The defect (measured).** `src/agent/acp.ts:380`, inside the router's `default:` arm:

```ts
default:
  return { is_error: true, content: [{ type: "text", text: "unknown method: " + msg.method }] };
```

JSON-RPC defines a specific error for this — **`-32601` Method not found** — and **the file
already declares it at line 93** (`const RPC_METHOD_NOT_FOUND = -32601;`), already used at
line 264 for a handler that throws. Returning a **success-shaped** result means a client cannot
distinguish "the server did not understand you" from "the server understood and the tool
reported a problem", and the HTTP status is 200 in both cases. **The transport already refuses
an unknown path and an unknown HTTP verb with 404/405 — so the router is the only layer that
answers an unknown *JSON-RPC method* in the wrong shape.** That inconsistency is the defect:
the same mistake is refused two layers up and softened one layer down.

**Note the neighbouring `is_error: true` at lines 365 and 372 — those are TOOL results (an
unknown tool name, a tool that failed) and are CORRECT in that shape.** Do not change them.

**Files:**
- Modify: `src/agent/acp.ts` (the router `default:` arm, ~line 378-381)
- Test: `test/acp.test.ts` (add to the existing file — it already drives real JSON-RPC)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: an unknown `method` yields the file's existing error envelope via `sendRpc`
  (`-32601`), NOT a success-shaped tool result.

- [ ] **Step 1: Write the failing test**

Add to `test/acp.test.ts`, following that file's existing request helper:

```ts
test("an unknown JSON-RPC method answers with -32601, not a success-shaped result", async () => {
  const res = await rpc(sendRpcRequest({ jsonrpc: "2.0", id: 9, method: "no/such/method" }));
  assert.equal(res.status, 200, "JSON-RPC errors stay HTTP 200 by convention");
  const body = await res.json();
  assert.equal(body.result, undefined, "an unknown method must not answer in a result envelope");
  assert.equal(body.error?.code, -32601, "JSON-RPC defines -32601 for Method not found");
  assert.match(body.error.message, /no\/such\/method/);
});
```

Adapt the helper names to what `test/acp.test.ts` actually uses — read it first.

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout -k 5 200 npx tsx --test test/acp.test.ts`
Expected: FAIL — `body.result` is present and `body.error` is absent.

- [ ] **Step 3: Return the JSON-RPC error using the constant that already exists**

`RPC_METHOD_NOT_FOUND = -32601` is **already declared at line 93 and already used at line 264**.
**Do not redeclare it** — a second `const` with the same name in one module is a syntax error,
and a second one under a different name is a duplicate source of truth for one protocol code.

Change the `default:` arm to route through the same `sendRpc` the transport refusals use, so the
id is echoed and the HTTP status stays 200:

```ts
      default:
        // Same shape the transport already uses for an unknown PATH (404) and an
        // unknown HTTP verb (405). Answering in a RESULT envelope told a client the
        // server understood the call — the one place this surface lied.
        return sendRpc(res, 200, msg.id ?? null, {
          code: RPC_METHOD_NOT_FOUND,
          message:
            `unknown method: ${msg.method}. This server speaks initialize, tools/list and tools/call. ` +
            `Nothing was read and no tool ran.`,
        });
    }
```

Keep the two TOOL-result `is_error: true` returns (lines 365 and 372) exactly as they are — those
are tool outcomes, and the result shape is correct for them.

- [ ] **Step 4: Run it to verify it passes**

Run: `timeout -k 5 200 npx tsx --test test/acp.test.ts test/acp-call-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/acp.ts test/acp.test.ts
git commit -m "acp: answer an unknown JSON-RPC method with -32601, not a result envelope"
```

---

## Explicitly NOT in this plan

- **`UI2API_ACP_TOKEN`'s `AGENTS.md` row and the `serveInstanceAcp` bind plumbing.** Both were
  dispatched as separate lanes before this plan was written and may still be in flight. Do not
  start them here; if a lane is still running when you begin, wait for it, because both touch
  files this plan's verification reads.
- **A `--bind` CLI flag for `hub run --acp`.** The env knob is sufficient and a flag would need
  its own doc row. YAGNI.
- **Auth on the ACP surface.** Closed in the previous round (`UI2API_ACP_TOKEN`), with a wider
  bind now requiring two keys.
- **Retyping the whole ACP router.** Three seams are wrong; the other eleven are right and
  pinned by `test/acp.test.ts`.

## Self-Review

**1. Spec coverage.** Three defects were measured and each has a task: invented origin (Task 1),
ungated numeric refusal (Task 2), success-shaped unknown method (Task 3). No measured defect is
left without a task.

**2. Placeholder scan.** No `TBD`, no "add appropriate handling", no "write tests for the
above". The one place a spelling must be adapted — the helpers in `test/acp.test.ts` and
`test/skills-refusal-truth.test.ts` — says so explicitly and names what to read, because those
files' helper names are not fixed by this plan and inventing them would be a lie.

**3. Type consistency.** `resolveBaseUrl` returning `string` becomes returning `never` (it
always throws on the new path); Task 1's test therefore asserts `assert.throws`, never a
returned value, so it does not encode the old signature. `RPC_METHOD_NOT_FOUND` is introduced
and used inside the same task. No cross-task type dependency exists — which is the point of
splitting them.