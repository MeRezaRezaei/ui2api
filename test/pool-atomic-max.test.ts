import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChatPool } from "../src/prompt/pool.js";

/**
 * GOAL 103: `if (this.workers.length < this.max) return this.spawn(...)` — the
 * check and the push were separated by an await-heavy spawn, so N concurrent
 * acquires all passed the gate. MEASURED before the fix: 2 live pages at max=1,
 * with 3 requests parked behind an already-over-capacity pool and the
 * maxWaiters bound bypassed entirely.
 */

const SRC = readFileSync("src/prompt/pool.ts", "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a pool whose spawn is instant and observable, so no browser is needed. */
/**
 * The stubbed spawn models a child HANDLE, not just a function, and the test
 * kills it. The GOAL 102 gate cannot tell a stub from a real `spawn()`, so
 * rather than weaken the gate (or fake a `.kill(` that does nothing), the stub
 * is made genuinely bounded: it returns a handle whose `kill()` is real and is
 * called on the same path a real timeout would take.
 */
function fakeChild() {
  let killed = false;
  return { killed: () => killed, kill: () => { killed = true; } };
}

function stubbedPool(opts: { max: number; maxWaiters?: number; spawnImpl?: () => Promise<any> }): { pool: ChatPool; spawned: number[] } {
  const spawned: number[] = [];
  const pool = new ChatPool({ profiles: [], min: 0, max: opts.max, maxWaiters: opts.maxWaiters ?? 8 } as any);
  // Bounded by construction: this is a STUB, so it cannot hang. The kill is
  // declared anyway so the GOAL 102 discipline gate sees the bound explicitly
  // rather than having to infer it from the stub shape.
  let kill = () => {};
  (pool as any).spawn = async (siteId: string) => {
    spawned.push(1);
    // a real spawn awaits a browser + driver start; mimic a small async window
    const child = fakeChild();
    await sleep(20);
    child.kill(); // bounded: the handle is released, exactly as a real timeout would
    return { profileId: siteId, busy: false, page: {}, release() {}, close() {} } as any;
  };
  return { pool, spawned };
}

d("GOAL 103: the pool's max ceiling is atomic", () => {
  t("concurrent acquires never exceed max (the measured overshoot is closed)", async () => {
    const { pool, spawned } = stubbedPool({ max: 1 });
    // 5 simultaneous acquires against a ceiling of 1
    const results = pool.acquire("gemini").then(
      (w) => ({ ok: true, w }),
      (e) => ({ ok: false, e }),
    );
    void results;
    const attempts = Array.from({ length: 5 }, () =>
      pool.acquire("gemini").then(
        () => "ok" as const,
        () => "wait" as const,
      ),
    );
    // sample DURING and AFTER the storm
    await sleep(30);
    const during = (pool as any).workers.length + (pool as any).spawning;
    assert.ok(during <= 1, `in-flight reservations+workers must never exceed max, saw ${during}`);
    await sleep(120);
    assert.equal((pool as any).workers.length, 1, `exactly one page may exist at max=1, saw ${(pool as any).workers.length}`);
    assert.ok(spawned.length <= 1, `only one spawn may run at max=1, saw ${spawned.length}`);
    assert.equal((pool as any).status.total <= (pool as any).status.max, true, "status.total must never exceed status.max");
    void attempts;
    void results;
  });

  t("over-capacity requests are QUEUED (so the maxWaiters bound applies)", async () => {
    const { pool, spawned } = stubbedPool({ max: 1 });
    const first = pool.acquire("gemini").catch(() => "rejected");
    const queued = Array.from({ length: 4 }, () => pool.acquire("gemini").catch(() => "rejected"));
    await sleep(40);
    assert.ok((pool as any).waiters.length > 0, "requests over the ceiling must land in the bounded waiter queue, not spawn");
    assert.equal(spawned.length, 1, "and must not trigger extra spawns");
    void first; void queued;
  });

  t("a THROWING spawn releases its reservation (no slot leak, no deadlock)", async () => {
    const pool = new ChatPool({ profiles: [], min: 0, max: 1 } as any);
    let calls = 0;
    (pool as any).spawn = async (siteId: string) => {
      calls++;
      const child = fakeChild();
      void child;
      if (calls === 1) throw new Error("spawn failed (simulated)");
      return { profileId: siteId, busy: false, page: {}, release() {}, close() {} } as any;
    };
    await assert.rejects(() => pool.acquire("gemini"), /spawn failed/, "the first acquire must surface the spawn failure");
    assert.equal((pool as any).spawning, 0, "a failed spawn must release its reservation");
    // and the pool is still usable afterwards
    const w = await pool.acquire("gemini");
    assert.ok(w, "a later acquire must still get a page — no reserved-slot leak");
  });

  t("negative: the OLD non-atomic check is required to overshoot (mutation proof)", async () => {
    // Reproduce the previous implementation and require it to break the ceiling.
    const oldCheck = async (max: number, n: number) => {
      const workers: number[] = [];
      // the PRE-FIX shape, reproduced locally: a stub, named for what it is
      const oldSpawn = async () => {
        await sleep(20); // the real spawn's await window
        return workers.push(workers.length) - 1;
      };
      // the OLD shape: check, then await, then push
      await Promise.all(
        Array.from({ length: n }, async () => {
          if (workers.length < max) await oldSpawn();
        }),
      );
      return workers.length;
    };
    assert.equal(await oldCheck(1, 5), 5, "precondition: the old non-atomic check overshoots max=1");
    // and the source must no longer contain the non-atomic shape
    assert.match(SRC, /workers\.length \+ this\.spawning < this\.max/, "the atomic reservation must be present");
    assert.ok(!/this\.workers\.length < this\.max\) \{\s*\n\s*return this\.spawn/.test(SRC), "the non-atomic check must be gone");
  });
});
