// GOAL 180 — the REPLAY-FIDELITY gate that `src/runtime/session-store.ts:444`
// claimed and that did not exist.
//
// THE FINDING THIS FILE EXISTS TO RECORD, stated plainly because it is the whole
// point: the claim was FALSE, and it was false in the most expensive way
// available on this codebase — it sat on the credential path.
//
//   The comment said: "the absence of that key is what proves the replay
//   actually ran". Measured, that is an inference that does not survive contact
//   with the code, for three independent reasons:
//
//     1. NOTHING READS THE MARKER. `__ui2api_replay_skipped` is written in
//        exactly one place (session-store.ts, inside the replay script) and read
//        in ZERO places — not in src/, not in test/, not by any caller of
//        injectSnapshot (20+ call sites). A key nobody reads cannot prove
//        anything about whether a replay ran; it is an unobserved write.
//     2. THE REPLAY BODY SWALLOWS EVERY FAILURE. Each of the localStorage,
//        sessionStorage and IndexedDB loops sits in its own `try{}catch(e){}`.
//        A setItem that throws (quota, storage denied by policy), or an
//        `indexedDB.open` that errors, leaves NO marker and NO storage — the
//        exact "written, reported as injected, actually signed out" shape this
//        gate is supposed to catch, with the absence of the marker looking
//        exactly like success.
//     3. THE MARKER WRITE ITSELF IS IN A `try{}catch(e){}`. If localStorage is
//        unavailable the marker write throws and is swallowed, so even on the
//        SKIP path the marker's absence proves nothing.
//
// So this file does NOT pin the false claim. It pins the three things that are
// true, one of which is a measured demonstration that absence is not a receipt
// ("MEASURED FALSITY" below). That is what makes the corrected comment in
// session-store.ts defensible instead of merely different.
//
// METHOD. The artifact under test is the exact string `storageReplayScript()`
// emits — that string IS the replay. It is executed in a controlled sandbox
// (`new Function` with injected `location` / `localStorage` / `sessionStorage` /
// `indexedDB`) so both branches are observable and the storage-failure branch is
// reachable deterministically. No browser, no network, no host reads: the same
// `storageReplayScript` string is injected verbatim, only its environment
// differs. Mutations are applied to that string, never to src/.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { storageReplayScript, type ProfileSnapshot } from "../src/runtime/session-store.js";

const MARKER = "__ui2api_replay_skipped";

/** A Web Storage double whose writes can be made to fail, per key. */
interface Store {
  map: Map<string, string>;
  /** keys whose setItem was made to throw */
  failed: string[];
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function memStore(failOn: (key: string) => boolean = () => false): Store {
  const map = new Map<string, string>();
  const failed: string[] = [];
  return {
    map,
    failed,
    getItem(k: string) {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      if (failOn(k)) {
        failed.push(k);
        throw new Error(`QuotaExceededError (simulated): refusing ${k}`);
      }
      map.set(k, v);
    },
  };
}

function snapshot(over: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    version: 1,
    host: "x.example",
    origin: "https://x.example",
    capturedAt: "",
    cookies: [],
    localStorage: [["auth_token", "real-token"]],
    sessionStorage: [["cart", "3"]],
    indexedDB: [],
    ...over,
  };
}

interface RunOutcome {
  ls: Store;
  ss: Store;
  warns: string[];
  errors: string[];
}

/** Execute an emitted replay script string against an injected environment. */
function run(
  script: string,
  pageOrigin: string,
  opts: { failLs?: (k: string) => boolean; failSs?: (k: string) => boolean } = {}
): RunOutcome {
  const ls = memStore(opts.failLs);
  const ss = memStore(opts.failSs);
  const warns: string[] = [];
  const errors: string[] = [];
  const fakeConsole = {
    warn: (...a: unknown[]) => warns.push(a.map(String).join(" ")),
    log: () => {},
    error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
  };
  // The replay script is an IIFE that touches exactly these five globals.
  // eslint-disable-next-line no-new-func
  new Function(
    "location",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "console",
    script
  )(
    { origin: pageOrigin },
    ls as unknown as Storage,
    ss as unknown as Storage,
    { open: () => ({}) },
    fakeConsole
  );
  return { ls, ss, warns, errors };
}

// --- 1. the replay branch: everything lands, and NO marker is written --------

test("on the snapshot's own origin the replay writes every bucket and leaves no skip marker", () => {
  const out = run(storageReplayScript(snapshot()), "https://x.example");
  assert.equal(out.ls.getItem("auth_token"), "real-token", "localStorage replayed");
  assert.equal(out.ss.getItem("cart"), "3", "sessionStorage replayed");
  assert.equal(
    out.ls.map.has(MARKER),
    false,
    "a successful replay must not write the skip marker"
  );
  assert.deepEqual(out.errors, [], "the replay must not log errors on the happy path");
});

// --- 2. the skip branch: the skip ANNOUNCES itself (ROUND N+105) -------------

test("a foreign origin announces the skip in the marker and writes nothing else", () => {
  const out = run(storageReplayScript(snapshot()), "https://other.example");
  assert.ok(
    out.ls.map.has(MARKER),
    `the skip must be announced in ${MARKER}; absence of an announcement is the silent-return bug ROUND N+105 fixed`
  );
  const announced = out.ls.getItem(MARKER) as string;
  assert.match(announced, /other\.example/, `marker must name the page origin: ${announced}`);
  assert.match(announced, /x\.example/, `marker must name the snapshot origin: ${announced}`);
  assert.equal(
    out.ls.getItem("auth_token"),
    null,
    "a foreign origin must NOT receive the snapshot's credentials"
  );
  assert.equal(out.ss.getItem("cart"), null, "a foreign origin must NOT receive sessionStorage");
  assert.equal(
    out.warns.some((w) => w.includes("origin-gate-mismatch")),
    true,
    "the skip must also warn on the console, so it is visible without a storage probe"
  );
});

// --- 3. THE MEASURED FALSITY: absence of the marker is NOT a receipt --------

test("MEASURED FALSITY: a replay whose storage writes throw leaves NO marker — so marker-absence does not prove the replay ran", () => {
  // The dangerous shape: the benign key lands, the AUTH key throws. The page is
  // signed out, nothing errored, and the marker — the thing the old comment
  // called proof — is absent exactly as it is on a fully successful replay.
  const snap = snapshot({
    localStorage: [["benign_pref", "dark"], ["auth_token", "real-token"]],
  });
  const out = run(storageReplayScript(snap), "https://x.example", {
    failLs: (k) => k === "auth_token",
  });

  assert.deepEqual(out.ls.failed, ["auth_token"], "the auth write really did throw");
  assert.equal(out.ls.getItem("benign_pref"), "dark", "the write before the failure really did land");
  assert.equal(
    out.ls.getItem("auth_token"),
    null,
    "the credential did NOT reach the page — this is the signed-out-with-no-error case"
  );
  assert.equal(
    out.ls.map.has(MARKER),
    false,
    "no marker is written on a partial replay, so marker-absence cannot be read as success"
  );
  assert.deepEqual(
    out.errors,
    [],
    "the replay swallows the failure entirely, which is why nothing downstream can notice"
  );

  // The distinction the old comment claimed, made measurable: identical marker
  // state, opposite outcomes. If these two states are indistinguishable, no
  // consumer of the marker could ever tell a good replay from a broken one.
  const good = run(storageReplayScript(snap), "https://x.example");
  assert.equal(good.ls.getItem("auth_token"), "real-token", "control: the same snapshot replays fully");
  assert.equal(
    good.ls.map.has(MARKER),
    out.ls.map.has(MARKER),
    "both a good replay and a credential-losing replay report marker-absence — the inference fails"
  );
  assert.notEqual(
    good.ls.getItem("auth_token"),
    out.ls.getItem("auth_token"),
    "…yet their actual outcomes differ, which is the entire point"
  );
});

// --- 4–6. MUTATIONS: prove the three assertions above actually BITE ---------

test("MUTATION (a): emptying the replay body is caught by the positive read-back", () => {
  const script = storageReplayScript(snapshot());
  const gutted = script.replace(
    "try{for(const[k,v]of LS)localStorage.setItem(k,v)}catch(e){}",
    "/* emptied by mutation (a) */"
  );
  assert.notEqual(gutted, script, "mutation (a) must actually change the script");
  const out = run(gutted, "https://x.example");
  assert.equal(
    out.ls.getItem("auth_token"),
    null,
    "an emptied replay body must NOT pass the positive read-back (test 1 depends on this)"
  );
});

test("MUTATION (b): removing the origin gate lets a wrong-origin snapshot leak its credentials into the page", () => {
  const script = storageReplayScript(snapshot());
  const ungated = script.replace(/if\(location\.origin!==ORIGIN\)\{[\s\S]*?return;\}/, "");
  assert.notEqual(ungated, script, "mutation (b) must actually change the script");
  assert.ok(!ungated.includes("origin-gate-mismatch"), "mutation (b) must remove the whole gate");
  const out = run(ungated, "https://other.example");
  assert.equal(
    out.ls.getItem("auth_token"),
    "real-token",
    "with the gate gone the snapshot's credentials DO land on a foreign origin — the leak is real"
  );
});

test("MUTATION (c): inverting the gate breaks BOTH directions, so no inversion is survivable", () => {
  const script = storageReplayScript(snapshot());
  const inverted = script.replace("location.origin!==ORIGIN", "location.origin===ORIGIN");
  assert.notEqual(inverted, script, "mutation (c) must actually change the script");

  const skippedRealMatch = run(inverted, "https://x.example");
  assert.equal(
    skippedRealMatch.ls.getItem("auth_token"),
    null,
    "an inverted gate silently no-ops on a TRUE match — the credentials never land"
  );

  const leakedForeign = run(inverted, "https://other.example");
  assert.equal(
    leakedForeign.ls.getItem("auth_token"),
    "real-token",
    "…and simultaneously leaks them on a foreign origin. The comparison must be `!==` with a mismatch early-out."
  );
});

// --- 7. the origin literal is the SNAPSHOT's origin -------------------------

test("the replay bakes in the snapshot's own origin as the gate's expected origin", () => {
  const script = storageReplayScript(snapshot({ origin: "https://other-host.example:8443" }));
  assert.ok(
    script.includes(JSON.stringify("https://other-host.example:8443")),
    "the gate must compare against the SNAPSHOT's origin, not a hardcoded one"
  );
  assert.ok(
    !script.includes(JSON.stringify("https://x.example")),
    "and must not carry another snapshot's origin alongside it"
  );
});