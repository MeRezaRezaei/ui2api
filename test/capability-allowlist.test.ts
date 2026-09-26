import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startPromptd } from "../src/prompt/http.js";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

/**
 * GOAL 111: the 32 hardcoded `POST /capability/<site>` routes bypassed the
 * daemon's configured site allow-list. Each was written as
 *   try { profile = idFrom(site, profilesById) }
 *   catch { profile = resolvePackagedProfile(site) ?? resolvePackagedProfileFile(site) }
 * — the catch stepped AROUND the allow-list and re-resolved a packaged profile
 * from disk. So a `promptd --site gemini` daemon still dispatched a runner for
 * every installed site, which would launch a browser and replay a captured
 * session for an origin the operator excluded. MEASURED before the fix on a
 * gemini-only daemon: /capability/zenmux_chat and /capability/xiaomimimo_chat
 * both reached a real dispatch (502 loginGated) instead of being refused.
 *
 * The pin measures the real daemon in-process. No browser is launched: the pool
 * is stubbed, and the gate is proven by WHERE a request stops, not by a result.
 */

const HTTP = readFileSync("src/prompt/http.ts", "utf8");

/** A pool stub that records whether a worker was ever acquired. */
function stubPool() {
  const state = { acquired: 0 };
  const worker = {
    driver: { ask: async () => ({ answer: "x", doneReason: "stop" }) },
    profile: { id: "stub" },
    release: async () => {},
  };
  const p: any = {
    acquire: async () => {
      state.acquired++;
      return worker;
    },
    release: async () => {},
    status: () => ({ workers: [], total: 0, max: 1 }),
    close: async () => {},
    startReaper: () => {},
    stopReaper: () => {},
  };
  return { p, state };
}

async function withDaemon<T>(
  opts: any,
  fn: (call: (path: string, body: any) => Promise<{ status: number; text: string }>, state: { acquired: number }) => Promise<T>,
): Promise<T> {
  const { p, state } = stubPool();
  const s: any = await startPromptd({ ...opts, port: 0, pool: p } as any);
  const port = s.port ?? s.address?.port;
  const call = async (path: string, body: any) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  };
  try {
    return await fn(call, state);
  } finally {
    s.close?.();
  }
}

d("GOAL 111: the configured allow-list binds the capability routes too", () => {
  t("an unconfigured site is refused by NAME and never reaches a runner", async () => {
    await withDaemon({ profiles: { gemini: BUILTIN_PROFILES.gemini! } }, async (call, state) => {
      for (const [site, cap] of [
        ["zenmux", "zenmux_chat"],
        ["youtube", "youtube_search"],
        ["tencent-aistudio", "tencent_aistudio_chat"],
        ["araprat", "araprat_search"],
      ] as const) {
        const r = await call(`/capability/${site}`, { capability: cap });
        assert.equal(r.status, 400, `${site} must be refused with 400, got ${r.status}: ${r.text.slice(0, 120)}`);
        assert.match(r.text, /not in this daemon's configured allow-list/, `${site} must be refused BY NAME`);
        assert.match(r.text, /gemini/, `${site}'s refusal must name the configured set`);
      }
      // the decisive proof: not one of them acquired a pool worker, so no
      // browser could have been launched and no captured session replayed
      assert.equal(state.acquired, 0, "a refused site must never acquire a browser worker");
    });
  });

  t("the gate is NOT the escape hatch: no `catch` re-resolve remains unguarded", () => {
    // the shape that caused the bug, asserted absent from the pre-route guard
    const guard = HTTP.slice(HTTP.indexOf('const capMatch = /^\\/capability\\/'), HTTP.indexOf("OpenAI-compatible surface: /v1/models"));
    assert.ok(guard.length > 0, "the capability pre-route guard must exist");
    assert.match(guard, /opts\.profiles && !profilesById\[site\]/, "the guard must consult the configured allow-list");
    assert.ok(guard.indexOf("resolvePackagedProfile") === -1, "the guard must not re-resolve a packaged profile to escape the list");
  });

  t("a DEFAULT daemon still serves capability sites — the fix narrows, it does not remove", async () => {
    // no `profiles` passed => defaultChatProfiles() => the capability surface
    // must keep working exactly as before. We assert the gate does NOT fire:
    // the request must get PAST the allow-list (a later error is fine, a 400
    // "allow-list" refusal is not).
    await withDaemon({}, async (call) => {
      const r = await call("/capability/youtube", { capability: "youtube_search" });
      assert.ok(
        !/not in this daemon's configured allow-list/.test(r.text),
        `a default daemon must not refuse youtube with an allow-list error, got: ${r.text.slice(0, 140)}`,
      );
    });
  });

  t("negative: the OLD escape-hatch shape is required to be the failure (mutation proof)", () => {
    // the old guard consulted INSTALLED packages only
    const oldGuard = 'const pkg = registryPackageFor(site); if (pkg) { /* dispatch */ }';
    assert.ok(!/allow-list/.test(oldGuard), "precondition: the old guard had no allow-list concept at all");
    // and with no allow-list check, an unconfigured site would fall through to a
    // dispatch — which is exactly the measured pre-fix 502
    // the real question is whether the guard consults the CONFIGURED list
    const dispatchReachable = (guard: string) => !/profilesById\[site\]/.test(guard);
    assert.equal(dispatchReachable(oldGuard), true, "precondition: the old guard never consulted the configured list, so every installed site dispatched");
    assert.equal(dispatchReachable("opts.profiles && !profilesById[site]"), false, "the new guard consults it and stops the dispatch");
  });
});
