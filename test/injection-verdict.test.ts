// GOAL 182 — the gate for the INJECTION VERDICT. `injectSnapshot` used to
// return `Promise<void>` and swallow BOTH channel failures in `catch {}`, while
// the comment above it claimed "a REJECTED injection is a NAMED failure, never
// swallowed". The `throw` that said so sat INSIDE the `try` whose `catch {}`
// ate it. 22 call sites then proceeded believing a session had been replayed.
//
// This file pins the replacement contract. There is no prior test for it: the
// behaviour change landed in the working tree with no gate at all, which is why
// the change was, for one fold, indistinguishable from the bug it replaced.
//
// METHOD. `injectSnapshot` is called with a STUB BrowserContext — a two-method
// object whose `addCookies` / `addInitScript` either resolve or reject on
// demand. That is the whole seam the real function touches, so every branch is
// reachable deterministically with no browser, no network, no host read, and no
// live session anywhere near it. No test in this file shells out or reads the
// machine (host-independence gate).
//
// WHAT IS PINNED, and why each one is a product decision and not a restatement
// of the code:
//   1. cookies refused + storage registered → `partial` + NAMED reason, NO THROW.
//      THE load-bearing one. Sites in this repo genuinely authenticate from
//      localStorage alone (kimi `access_token`, deepseek `userToken`), so one
//      expired cookie must not fail every request. The naive fix — delete the
//      swallowing `catch {}` and let any rejection throw — was rejected for
//      exactly this reason; it is a regression across the whole surface.
//   2. everything refused → THROWS, named `session-injection-refused`. The page
//      is certainly signed out, so an answer read from it would be a lie.
//   3. nothing refused → `accepted`, and NO reason key at all.
//   4. a zero-cookie snapshot is `accepted`, not a failure — a legitimate shape.
//   5. a zero-cookie snapshot whose replay script is refused THROWS. This is
//      the hole the first cut of the change shipped: it counted "no cookies to
//      add" as an accepted channel, so nothing-injected came back `partial`.
//      Measured — this test fails against that predicate.
//   6. `storageRegistered` is never INFERRED. `addInitScript` returns void, so
//      the only thing knowable is "it resolved". The verdict must report the
//      mechanism, never the effect, and must keep "there were no cookies to
//      take" distinguishable from "the browser took the cookies".

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "playwright";
import {
  injectSnapshot,
  INJECTION_PARTIAL_COOKIES,
  INJECTION_PARTIAL_STORAGE,
  INJECTION_REFUSED,
  type InjectionVerdict,
  type ProfileSnapshot,
} from "../src/runtime/session-store.js";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

function snap(over: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    version: 1,
    host: "x.example",
    origin: "https://x.example",
    capturedAt: "2026-10-02T00:00:00.000Z",
    cookies: [{ name: "sid", value: "SECRET-COOKIE-VALUE", domain: "x.example", path: "/", expires: -1 }],
    localStorage: [["access_token", "SECRET-STORAGE-VALUE"]],
    sessionStorage: [],
    indexedDB: [],
    ...over,
  };
}

/** The ONLY two methods `injectSnapshot` touches on a BrowserContext. */
interface Stub {
  context: BrowserContext;
  calls: { addCookies: number; addInitScript: number };
}

function stub(opts: { cookies?: "ok" | "reject"; storage?: "ok" | "reject" }): Stub {
  const calls = { addCookies: 0, addInitScript: 0 };
  const context = {
    async addCookies(cookies: unknown[]) {
      calls.addCookies++;
      if (opts.cookies === "reject") throw new Error(`addCookies refused ${cookies.length} (simulated)`);
    },
    async addInitScript() {
      calls.addInitScript++;
      if (opts.storage === "reject") throw new Error("addInitScript refused (simulated)");
      // NOTE the real signature returns void — that is the whole reason
      // `storageRegistered` can only ever mean "it resolved".
    },
  } as unknown as BrowserContext;
  return { context, calls };
}

/** Run `injectSnapshot` with `console.warn` captured (no host read, no spawn). */
async function inject(
  s: Stub,
  snapshot: ProfileSnapshot
): Promise<{ verdict?: InjectionVerdict; error?: Error; warns: string[] }> {
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  };
  try {
    const verdict = await injectSnapshot(s.context, snapshot);
    return { verdict, warns };
  } catch (e) {
    return { error: e as Error, warns };
  } finally {
    console.warn = real;
  }
}

// --- 1. THE PRODUCT DECISION: one refused channel must NOT sink the request ---

test("cookies refused but storage registered → `partial` with a NAMED reason, and NO throw", async () => {
  const s = stub({ cookies: "reject", storage: "ok" });
  const { verdict, error, warns } = await inject(s, snap());

  assert.equal(error, undefined, "one refused channel must NOT throw — a storage-only site would break");
  assert.ok(verdict, "a partial verdict is returned, not void");
  assert.equal(verdict!.outcome, "partial");
  assert.equal(verdict!.cookiesAccepted, false, "the cookie channel really was refused");
  assert.equal(verdict!.storageRegistered, true, "the storage channel really was taken");
  assert.ok(
    verdict!.reason!.includes(INJECTION_PARTIAL_COOKIES),
    `the refused channel must be NAMED on the return value: ${verdict!.reason}`
  );
  assert.ok(!verdict!.reason!.includes(INJECTION_PARTIAL_STORAGE), "the ACCEPTED channel must not be named as refused");
  assert.equal(s.calls.addCookies, 1, "the refused channel was still attempted exactly once");
  assert.equal(
    warns.filter((w) => w.includes(INJECTION_PARTIAL_COOKIES)).length,
    1,
    "a refusal must also be warned once, so it is visible without reading the return value"
  );
});

test("storage refused but cookies accepted → `partial`, NAMED, and still no throw", async () => {
  const s = stub({ cookies: "ok", storage: "reject" });
  const { verdict, error } = await inject(s, snap());

  assert.equal(error, undefined, "a cookie-only site must survive a refused replay script");
  assert.equal(verdict!.outcome, "partial");
  assert.equal(verdict!.cookiesAccepted, true);
  assert.equal(verdict!.storageRegistered, false);
  assert.ok(
    verdict!.reason!.includes(INJECTION_PARTIAL_STORAGE),
    `the storage refusal must be NAMED: ${verdict!.reason}`
  );
});

// --- 2. total refusal THROWS, named ----------------------------------------

test("both channels refused → THROWS `session-injection-refused`, naming both causes", async () => {
  const s = stub({ cookies: "reject", storage: "reject" });
  const { verdict, error } = await inject(s, snap());

  assert.equal(verdict, undefined, "a total refusal must never be REPORTED as a return value");
  assert.ok(error, "a total refusal must throw — the caller must not proceed believing the session replayed");
  assert.ok(
    error!.message.startsWith(INJECTION_REFUSED),
    `the throw must carry the stable name callers classify on: ${error!.message}`
  );
  assert.ok(error!.message.includes(INJECTION_PARTIAL_COOKIES), "the cookie cause must be named");
  assert.ok(error!.message.includes(INJECTION_PARTIAL_STORAGE), "the storage cause must be named");
  assert.ok(error!.message.includes("x.example"), `the host must be named: ${error!.message}`);
});

test("neither the throw nor a partial verdict ever leaks a cookie or storage VALUE", async () => {
  for (const opts of [
    { cookies: "reject", storage: "reject" },
    { cookies: "reject", storage: "ok" },
    { cookies: "ok", storage: "reject" },
  ] as const) {
    const { verdict, error } = await inject(stub(opts), snap());
    const text = `${error?.message ?? ""} ${verdict?.reason ?? ""} ${JSON.stringify(verdict ?? {})}`;
    assert.ok(
      !text.includes("SECRET-COOKIE-VALUE") && !text.includes("SECRET-STORAGE-VALUE"),
      `credentials must never appear in a verdict or a throw: ${text}`
    );
  }
});

// --- 3. the clean path ------------------------------------------------------

test("nothing refused → `accepted` with NO reason key at all", async () => {
  const s = stub({ cookies: "ok", storage: "ok" });
  const { verdict, error, warns } = await inject(s, snap());

  assert.equal(error, undefined);
  assert.deepEqual(verdict, {
    host: "x.example",
    cookies: 1,
    cookiesAttempted: true,
    cookiesAccepted: true,
    storageRegistered: true,
    outcome: "accepted",
  } satisfies InjectionVerdict);
  assert.ok(!("reason" in verdict!), "an accepted verdict must not carry a reason key");
  assert.deepEqual(warns, [], "a clean injection must be silent");
  assert.deepEqual(s.calls, { addCookies: 1, addInitScript: 1 });
});

// --- 4. a zero-cookie snapshot is a legitimate shape, NOT a failure --------

test("a zero-cookie snapshot whose replay script registers → `accepted`, and says the cookie channel was never attempted", async () => {
  const s = stub({ cookies: "ok", storage: "ok" });
  const { verdict, error } = await inject(s, snap({ cookies: [] }));

  assert.equal(error, undefined, "having no cookies is a legitimate snapshot shape, not a failure");
  assert.equal(verdict!.outcome, "accepted");
  assert.equal(verdict!.cookies, 0);
  // THE honesty pin: `cookiesAccepted` is `true` here because there was nothing
  // to reject. Without `cookiesAttempted` a reader could not tell that apart from
  // "the browser took the cookies" — which would be an INFERRED claim, the one
  // thing this layer refuses to make.
  assert.equal(verdict!.cookiesAccepted, true);
  assert.equal(verdict!.cookiesAttempted, false, "no cookies were attempted, so none were accepted");
  assert.equal(s.calls.addCookies, 0, "addCookies must not be called for a cookie-free snapshot");
});

// --- 5. THE HOLE IN THE FIRST CUT: nothing attempted+refused is not `partial` -

test("a zero-cookie snapshot whose replay script is refused THROWS — nothing was injected", async () => {
  const s = stub({ cookies: "ok", storage: "reject" });
  const { verdict, error } = await inject(s, snap({ cookies: [] }));

  // MEASURED FAILURE against the first cut of this change, whose predicate was
  // `refused.length && !cookiesAccepted && !storageRegistered`: with no cookies
  // `cookiesAccepted` starts `true` ("nothing to reject"), so nothing-injected
  // came back as `partial` and the request proceeded against a signed-out page.
  // That is the original defect wearing a new name, so it is pinned here.
  assert.equal(verdict, undefined, "NOTHING was injected, so this must not be reported as a partial success");
  assert.ok(error, "a total refusal must throw even when the cookie channel was never attempted");
  assert.ok(error!.message.startsWith(INJECTION_REFUSED), error!.message);
  assert.ok(error!.message.includes("no cookies"), `the message must say why there was nothing to lose: ${error!.message}`);
  assert.ok(error!.message.includes(INJECTION_PARTIAL_STORAGE), "the one real refusal is still named");
});

// --- 6. the channels are MEASURED, never inferred --------------------------

test("each channel flag is exactly the resolution of its own call, across every combination", async () => {
  const combos = [
    { cookies: "ok", storage: "ok" },
    { cookies: "ok", storage: "reject" },
    { cookies: "reject", storage: "ok" },
    { cookies: "reject", storage: "reject" },
  ] as const;
  const expected = [
    { accepted: true, partial: false, throw: false },
    { accepted: false, partial: true, throw: false },
    { accepted: false, partial: true, throw: false },
    { accepted: false, partial: false, throw: true },
  ] as const;

  for (const [i, opts] of combos.entries()) {
    const s = stub(opts);
    const { verdict, error } = await inject(s, snap());
    const want = expected[i];
    if (want.throw) {
      assert.ok(error, `${opts.cookies}/${opts.storage} must throw`);
      assert.equal(verdict, undefined);
      continue;
    }
    assert.equal(error, undefined, `${opts.cookies}/${opts.storage} must not throw`);
    assert.equal(verdict!.outcome, want.accepted ? "accepted" : "partial", `${opts.cookies}/${opts.storage}`);
    // The flags must be the RESOLUTION of their own call and nothing else:
    assert.equal(verdict!.cookiesAccepted, opts.cookies === "ok", "cookiesAccepted === addCookies resolved");
    assert.equal(verdict!.storageRegistered, opts.storage === "ok", "storageRegistered === addInitScript resolved");
    assert.equal(
      verdict!.cookiesAttempted,
      true,
      "a snapshot with cookies must report the cookie channel as attempted"
    );
  }
});

test("`storageRegistered` is never inferred: it is true because the call RESOLVED, and the method reports nothing more", async () => {
  // `addInitScript` returns void, so the strongest claim available is "the
  // browser took the registration". A resolved registration that would replay
  // nothing at all (a foreign origin) is still reported as `storageRegistered:
  // true` — and that is CORRECT, because this layer is not entitled to the
  // stronger claim. The refusal to over-claim is the point, so it is pinned in
  // both directions: a resolved call is never reported as refused…
  const ok = await inject(stub({ cookies: "ok", storage: "ok" }), snap({ origin: "https://other.example" }));
  assert.equal(ok.verdict!.storageRegistered, true);
  assert.equal(ok.verdict!.outcome, "accepted");

  // …and a rejected call is never reported as accepted, whatever the snapshot.
  for (const cookies of [[], snap().cookies] as ProfileSnapshot["cookies"][]) {
    const bad = await inject(stub({ cookies: "ok", storage: "reject" }), snap({ cookies }));
    if (cookies.length === 0) assert.ok(bad.error, "no cookies + refused script is a total refusal");
    else assert.equal(bad.verdict!.storageRegistered, false);
  }
});

// --- 7. MUTATIONS: the gate must go RED on the original defect --------------

/** Extract the `injectSnapshot` function body from source, by brace matching. */
function injectSnapshotSource(): string {
  const src = readFileSync(join(ROOT, "src/runtime/session-store.ts"), "utf8");
  const start = src.indexOf("export async function injectSnapshot(");
  assert.notEqual(start, -1, "injectSnapshot must exist in src/runtime/session-store.ts");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("could not brace-match injectSnapshot");
}

/** The catch BLOCK spans of a function body (the braces after `catch (…)`). */
function catchSpans(body: string): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  const re = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const open = body.indexOf("{", m.index);
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") {
        depth--;
        if (depth === 0) {
          spans.push({ from: open, to: i });
          break;
        }
      }
    }
  }
  return spans;
}

/** catch blocks that do NOT record the refusal they observed. */
function unrecordedCatchBlocks(body: string): string[] {
  return catchSpans(body)
    .map((s) => body.slice(s.from, s.to))
    .filter((blk) => !blk.includes("refused.push"));
}

/** Is the first `throw` in `body` lexically inside one of these spans? */
function throwIsInsideCatch(body: string, spans: Array<{ from: number; to: number }>): boolean {
  const at = body.indexOf("throw ");
  return at >= 0 && spans.some((s) => at > s.from && at < s.to);
}

test("MUTATION-PROOF: no `throw` in injectSnapshot may sit inside a `catch` that can swallow it", () => {
  const body = injectSnapshotSource();

  // The throw must EXIST — a vacuous pass on a body with no throw would pin
  // nothing, so the detector is only meaningful if it has something to find.
  assert.ok(
    [...body.matchAll(/\bthrow\b/g)].length >= 1,
    "injectSnapshot must actually throw somewhere"
  );
  assert.ok(
    !throwIsInsideCatch(body, catchSpans(body)),
    "a `throw` sits inside a `catch` block: it can be swallowed, which IS the GOAL 182 " +
      "defect. Move the refusal decision out of any try — the accepted design collects names " +
      "in per-channel catches and decides once, from evidence."
  );
});

test("MUTATION (a): re-introducing the swallowing `catch {}` around the throw IS caught", () => {
  const body = injectSnapshotSource();

  // EXACTLY the predecessor's shape, re-inserted into the real file: a `throw`
  // raised from INSIDE a catch block, with an empty catch around it. That is how
  // `cookie-injection-rejected` was reported as injected — the inner throw eaten
  // by an outer `catch {}`, so `injectSnapshot` resolved `void`.
  const mutated = body.replace(
    "} catch (e) {",
    `} catch (e) { try { throw new Error("cookie-injection-rejected: simulated"); } catch {}`
  );
  assert.notEqual(mutated, body, "mutation (a) must actually change the body");
  assert.ok(mutated.includes("} catch {}"), "the mutation must introduce an EMPTY catch, not a handling one");
  assert.equal(
    throwIsInsideCatch(mutated, catchSpans(mutated)),
    true,
    "MUTATION NOT CAUGHT — the detector cannot see the original defect, so it pins nothing"
  );
  // Control: the shipped body is not in that shape, which is why the gate is green.
  assert.equal(throwIsInsideCatch(body, catchSpans(body)), false);
});

test("MUTATION (b): a catch that stops RECORDING its refusal is the same defect, and is caught", () => {
  const body = injectSnapshotSource();
  // Every catch in this function exists to record a refusal. One that returns,
  // logs, or falls through instead makes the decision below read a clean run —
  // the storage swallow had no `throw` at all and was invisible for that reason.
  assert.ok(catchSpans(body).length >= 2, "both channel catches must exist");
  assert.deepEqual(
    unrecordedCatchBlocks(body),
    [],
    "every catch in injectSnapshot must record the refusal it observed"
  );

  const mutated = body.replace(
    /refused\.push\(\s*`\$\{INJECTION_PARTIAL_STORAGE[\s\S]*?\);/,
    "/* refusal not recorded */"
  );
  assert.notEqual(mutated, body, "mutation (b) must actually change the body");
  assert.equal(
    unrecordedCatchBlocks(mutated).length,
    1,
    "MUTATION NOT CAUGHT — a catch can stop recording its refusal without failing this gate"
  );
});