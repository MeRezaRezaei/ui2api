// GOAL 123: the wigolo engine's base URL used to be read VERBATIM out of
// WIGOLO_DAEMON_URL with no scheme/host/loopback check, so a crafted or typo'd
// value repointed the whole engine at an arbitrary host — which then RECEIVED
// the WIGOLO_API_TOKEN bearer credential and whose payloads
// (`src/plugin/wigolo-context.ts`) are returned verbatim as MCP tool results.
//
// The gate under test lives in `src/runtime/wigolo.ts`. Every assertion here is
// inside a real, counted `test(...)`.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveDaemonBase,
  isLoopbackHost,
  assertLoopbackEndpoint,
  validateWigoloDaemonPort,
  validateWigoloAuthStatePath,
  buildWigoloDaemonEnv,
  ensureWigoloDaemon,
  wigoloFetch,
  WIGOLO_ALLOW_REMOTE_ENV,
  WIGOLO_AUTH_STATE_MAX_BYTES,
} from "../src/runtime/wigolo.js";

const WIGOLO_ENV = [
  "WIGOLO_DAEMON_URL",
  "WIGOLO_DAEMON_PORT",
  "WIGOLO_API_TOKEN",
  "WIGOLO_CDP_URL",
  "WIGOLO_AUTH_STATE_PATH",
  "WIGOLO_CHROME_PROFILE_PATH",
  "UI2API_CDP_URL",
  "UI2API_AUTH_STATE_PATH",
  "UI2API_USER_DATA_DIR",
  "UI2API_CHROME_PROFILE_PATH",
  "UI2API_WIGOLO_ALLOW_REMOTE",
  "UI2API_WIGOLO_AUTOSTART",
  "WIGOLO_BIN",
] as const;

let saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(() => {
  saved = {};
  for (const k of WIGOLO_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = mkdtempSync(join(tmpdir(), "wigolo-gate-"));
});

afterEach(() => {
  for (const k of WIGOLO_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("GOAL 123: wigolo endpoint loopback gate", () => {
  // --- 6: the default must NOT change -------------------------------------------------
  test("with no env set at all the base is still http://127.0.0.1:3333", () => {
    const r = resolveDaemonBase();
    assert.equal(r.base, "http://127.0.0.1:3333");
    assert.equal(r.loopback, true);
  });

  test("an explicit loopback WIGOLO_DAEMON_URL is accepted and trailing slashes trimmed", () => {
    for (const url of [
      "http://127.0.0.1:3999",
      "http://127.0.0.5:3999",
      "http://127.255.255.254:3999",
      "http://localhost:3999",
      "http://[::1]:3999",
      "https://localhost:8443",
      "http://LocalHost:3999",
    ]) {
      process.env.WIGOLO_DAEMON_URL = url;
      const r = resolveDaemonBase();
      assert.equal(r.loopback, true, `${url} must be accepted as loopback`);
      assert.equal(r.base, url.replace(/\/+$/, ""));
    }
    process.env.WIGOLO_DAEMON_URL = "http://127.0.0.1:3999///";
    assert.equal(resolveDaemonBase().base, "http://127.0.0.1:3999");
  });

  test("isLoopbackHost accepts 127.0.0.0/8, ::1, localhost and rejects everything else", () => {
    for (const h of ["127.0.0.1", "127.0.0.53", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1", "localhost", "LOCALHOST"])
      assert.equal(isLoopbackHost(h), true, `${h} should be loopback`);
    for (const h of [
      "128.0.0.1",
      "10.0.0.5",
      "192.168.1.10",
      "0.0.0.0",
      "example.com",
      "localhost.evil.com",
      "notlocalhost",
      "::2",
      "",
      "999.1.1.1",
    ])
      assert.equal(isLoopbackHost(h), false, `${h} must NOT be loopback`);
  });

  // --- 1: the named refusal -----------------------------------------------------------
  test("a non-loopback WIGOLO_DAEMON_URL throws a NAMED refusal naming the var and the host", () => {
    process.env.WIGOLO_DAEMON_URL = "http://evil.example.com:3333";
    let msg = "";
    assert.throws(
      () => resolveDaemonBase(),
      (e: Error) => {
        msg = e.message;
        return true;
      }
    );
    assert.match(msg, /wigolo refused WIGOLO_DAEMON_URL="http:\/\/evil\.example\.com:3333"/);
    assert.match(msg, /host evil\.example\.com is not loopback/);
    assert.match(msg, new RegExp(WIGOLO_ALLOW_REMOTE_ENV));
    assert.match(msg, /127\.0\.0\.1/);
  });

  test("a non-loopback base passed as opts.base is refused too (not only the env var)", () => {
    assert.throws(() => resolveDaemonBase("http://10.1.2.3:3333"), /wigolo refused the wigolo base URL \(opts\.base\)="http:\/\/10\.1\.2\.3:3333".*host 10\.1\.2\.3 is not loopback/s);
  });

  test("a non-http(s)/ws(s) scheme is refused, naming the scheme", () => {
    for (const url of ["file:///etc/passwd", "gopher://127.0.0.1:70", "ftp://127.0.0.1:21"]) {
      process.env.WIGOLO_DAEMON_URL = url;
      assert.throws(() => resolveDaemonBase(), /scheme ".*" is not allowed/, `${url} must be refused`);
    }
  });

  test("a value that is not a host[:port]/URL at all is refused", () => {
    for (const url of ["", "   ", "not a url", "http://", "://1.2.3.4"]) {
      process.env.WIGOLO_DAEMON_URL = url;
      if (url.trim() === "") {
        // blank is treated as unset -> the loopback default
        assert.equal(resolveDaemonBase().base, "http://127.0.0.1:3333");
      } else {
        assert.throws(() => resolveDaemonBase(), /wigolo refused WIGOLO_DAEMON_URL/);
      }
    }
  });

  test("an out-of-range port inside the URL is refused", () => {
    process.env.WIGOLO_DAEMON_URL = "http://127.0.0.1:70000";
    assert.throws(() => resolveDaemonBase(), /port 70000 is not an integer in 1-65535/);
    process.env.WIGOLO_DAEMON_URL = "http://127.0.0.1:0";
    assert.throws(() => resolveDaemonBase(), /port 0 is not an integer in 1-65535/);
  });

  // --- the explicit opt-in ------------------------------------------------------------
  test("UI2API_WIGOLO_ALLOW_REMOTE=1 explicitly allows a non-loopback base, and reports it as NOT loopback", () => {
    process.env.WIGOLO_DAEMON_URL = "http://wigolo.internal:3333";
    assert.throws(() => resolveDaemonBase(), /not loopback/);
    process.env[WIGOLO_ALLOW_REMOTE_ENV] = "1";
    const r = resolveDaemonBase();
    assert.equal(r.base, "http://wigolo.internal:3333");
    assert.equal(r.loopback, false, "a remote base must be reported as non-loopback");
  });

  // --- 3: the port knob ---------------------------------------------------------------
  test("WIGOLO_DAEMON_PORT accepts integers 1-65535 and defaults to 3333", () => {
    delete process.env.WIGOLO_DAEMON_URL;
    assert.equal(validateWigoloDaemonPort(undefined), 3333);
    assert.equal(validateWigoloDaemonPort(""), 3333);
    assert.equal(validateWigoloDaemonPort("  "), 3333);
    assert.equal(validateWigoloDaemonPort("1"), 1);
    assert.equal(validateWigoloDaemonPort("65535"), 65535);
    process.env.WIGOLO_DAEMON_PORT = "4001";
    assert.equal(resolveDaemonBase().base, "http://127.0.0.1:4001");
  });

  test("WIGOLO_DAEMON_PORT refuses non-integer / out-of-range values and never yields :NaN", () => {
    for (const bad of ["abc", "NaN", "1.5", "0", "-1", "65536", "99999", "1e3", "0x10", "1 2", "3333abc", "Infinity"]) {
      let msg = "";
      try {
        validateWigoloDaemonPort(bad);
      } catch (e) {
        msg = (e as Error).message;
      }
      assert.ok(msg, `WIGOLO_DAEMON_PORT=${JSON.stringify(bad)} must be refused`);
      assert.match(msg, /wigolo refused WIGOLO_DAEMON_PORT=/);
      process.env.WIGOLO_DAEMON_PORT = bad;
      let viaBase = "";
      try {
        viaBase = resolveDaemonBase().base;
      } catch (e) {
        viaBase = (e as Error).message;
      }
      assert.ok(
        !viaBase.includes(":NaN"),
        `WIGOLO_DAEMON_PORT=${JSON.stringify(bad)} must never produce a :NaN base (got ${viaBase})`,
      );
      assert.match(viaBase, /wigolo refused WIGOLO_DAEMON_PORT=/);
    }
  });

  // --- 2: the token never rides a non-loopback request ---------------------------------
  test("a non-loopback base throws AND issues ZERO fetches, so no token can be sent", async () => {
    process.env.WIGOLO_API_TOKEN = "super-secret-wigolo-token";
    process.env.WIGOLO_DAEMON_URL = "http://evil.example.com:3333";
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const real = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ ok: true, markdown: "FABRICATED ANSWER" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await assert.rejects(() => wigoloFetch({ url: "https://example.com" }), /host evil\.example\.com is not loopback/);
      assert.equal(calls.length, 0, "a refused base must issue no fetch at all");
      assert.equal(
        calls.filter((c) => JSON.stringify(c.headers).includes("super-secret-wigolo-token")).length,
        0,
        "no request may carry the WIGOLO_API_TOKEN",
      );
    } finally {
      (globalThis as any).fetch = real;
    }
  });

  test("even with the remote opt-in set, the bearer token is NOT attached to a non-loopback request", async () => {
    process.env.WIGOLO_API_TOKEN = "super-secret-wigolo-token";
    process.env[WIGOLO_ALLOW_REMOTE_ENV] = "1";
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const real = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init: any) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ url: "https://example.com/", markdown: "real answer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const out = await wigoloFetch({ url: "https://example.com" }, { base: "http://wigolo.internal:3333" });
      assert.equal(out.markdown, "real answer");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "http://wigolo.internal:3333/v1/fetch");
      assert.equal(
        seen[0].headers.authorization,
        undefined,
        "the bearer credential must never leave loopback",
      );
    } finally {
      (globalThis as any).fetch = real;
    }
  });

  test("on a loopback base the bearer token IS still attached (the feature is not removed)", async () => {
    process.env.WIGOLO_API_TOKEN = "local-token";
    process.env[WIGOLO_ALLOW_REMOTE_ENV] = "1";
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const real = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init: any) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ markdown: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await wigoloFetch({ url: "https://example.com" }, { base: "http://127.0.0.1:3333" });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].headers.authorization, "Bearer local-token");
    } finally {
      (globalThis as any).fetch = real;
    }
  });

  test("wigoloHealth does not contact a non-loopback base (returns false, throws nothing out)", async () => {
    process.env.WIGOLO_DAEMON_URL = "http://evil.example.com:3333";
    const calls: string[] = [];
    const real = globalThis.fetch;
    (globalThis as any).fetch = async (url: any) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    };
    try {
      const { wigoloHealth } = await import("../src/runtime/wigolo.js");
      assert.equal(await wigoloHealth(), false);
      assert.equal(calls.length, 0, "the health probe must not contact a refused base");
    } finally {
      (globalThis as any).fetch = real;
    }
  });

  // --- 4: forwarded knobs, validated before the spawn -----------------------------------
  test("a non-loopback WIGOLO_CDP_URL is refused naming the knob, before any spawn", () => {
    process.env.WIGOLO_CDP_URL = "http://10.9.9.9:9222";
    let msg = "";
    assert.throws(
      () => buildWigoloDaemonEnv(),
      (e: Error) => {
        msg = e.message;
        return true;
      }
    );
    assert.match(msg, /wigolo refused WIGOLO_CDP_URL="http:\/\/10\.9\.9\.9:9222"/);
    assert.match(msg, /host 10\.9\.9\.9 is not loopback/);
  });

  test("a non-loopback UI2API_CDP_URL forwarded to the daemon is refused naming the daemon knob", () => {
    delete process.env.WIGOLO_CDP_URL;
    process.env.UI2API_CDP_URL = "http://cdn.attacker.test:9222";
    assert.throws(() => buildWigoloDaemonEnv(), /wigolo refused WIGOLO_CDP_URL="http:\/\/cdn\.attacker\.test:9222"/);
  });

  test("a loopback CDP URL is still forwarded — validation does not weaken the feature", () => {
    process.env.UI2API_CDP_URL = "http://127.0.0.1:9222";
    process.env.UI2API_USER_DATA_DIR = join(tmp, "profile");
    const env = buildWigoloDaemonEnv();
    assert.equal(env.WIGOLO_CDP_URL, "http://127.0.0.1:9222");
    assert.equal(env.WIGOLO_CHROME_PROFILE_PATH, join(tmp, "profile"));
  });

  test("WIGOLO_AUTH_STATE_PATH must be an existing readable regular file", () => {
    const missing = join(tmp, "nope.json");
    assert.throws(() => validateWigoloAuthStatePath(missing), /wigolo refused WIGOLO_AUTH_STATE_PATH=".*nope\.json": not an existing readable file/);
    const dir = join(tmp, "adir");
    mkdirSync(dir);
    assert.throws(() => validateWigoloAuthStatePath(dir), /not a regular file/);
    const good = join(tmp, "state.json");
    writeFileSync(good, JSON.stringify({ cookies: [], origins: [] }));
    assert.equal(validateWigoloAuthStatePath(good), good);
    process.env.WIGOLO_AUTH_STATE_PATH = good;
    assert.equal(buildWigoloDaemonEnv().WIGOLO_AUTH_STATE_PATH, good);
  });

  test("an oversized auth-state file is refused naming the byte bound", () => {
    const big = join(tmp, "big.json");
    writeFileSync(big, "{}");
    truncateSync(big, WIGOLO_AUTH_STATE_MAX_BYTES + 1);
    let msg = "";
    assert.throws(
      () => validateWigoloAuthStatePath(big),
      (e: Error) => {
        msg = e.message;
        return true;
      }
    );
    assert.match(msg, /wigolo refused WIGOLO_AUTH_STATE_PATH=/);
    assert.match(msg, new RegExp(`exceeds the ${WIGOLO_AUTH_STATE_MAX_BYTES}-byte bound`));
  });

  test("ensureWigoloDaemon refuses a bad forwarded knob and spawns NOTHING", async () => {
    // Autostart is ENABLED here (not "0"), and the base is a closed loopback port,
    // so the old code would have gone on to spawn `npx -y wigolo serve`. The
    // sentinel WIGOLO_BIN does not exist, so a spawn would surface as an
    // exit/ENOENT failure — never as our named refusal.
    process.env.WIGOLO_DAEMON_URL = "http://127.0.0.1:1";
    process.env.WIGOLO_CDP_URL = "http://203.0.113.7:9222";
    process.env.WIGOLO_BIN = join(tmp, "no-such-wigolo-binary");
    await assert.rejects(
      () => ensureWigoloDaemon({ timeoutMs: 1500 }),
      /wigolo refused WIGOLO_CDP_URL="http:\/\/203\.0\.113\.7:9222"/,
    );
  });

  test("ensureWigoloDaemon refuses a non-loopback base before probing or spawning", async () => {
    process.env.WIGOLO_DAEMON_URL = "http://evil.example.com:3333";
    process.env.WIGOLO_BIN = join(tmp, "no-such-wigolo-binary");
    await assert.rejects(() => ensureWigoloDaemon(), /host evil\.example\.com is not loopback/);
    await assert.rejects(
      () => ensureWigoloDaemon({ base: "http://198.51.100.9:3333" }),
      /host 198\.51\.100\.9 is not loopback/,
    );
  });

  // --- 5: the mutation pin -------------------------------------------------------------
  test("MUTATION: the PRE-FIX daemonBase (verbatim source) accepts a hostile base the gate now refuses", () => {
    // The old implementation, copied verbatim from the pre-fix source at
    // src/runtime/wigolo.ts:93-98. It is reproduced here (not imported) so the
    // mutation is explicit: reverting the gate would make the FIRST assertion
    // of this pair the only difference, and the gate's refusal the thing that
    // disappears.
    function preFixDaemonBase(): string {
      const url = process.env.WIGOLO_DAEMON_URL;
      if (url) return url.replace(/\/+$/, "");
      const port = Number(process.env.WIGOLO_DAEMON_PORT || 3333);
      return `http://127.0.0.1:${port}`;
    }

    process.env.WIGOLO_DAEMON_URL = "http://evil.example.com:3333";
    // (a) The pre-fix code silently repointed the engine at the hostile host.
    assert.equal(
      preFixDaemonBase(),
      "http://evil.example.com:3333",
      "precondition: the pre-fix code really did repoint the engine at a hostile host",
    );
    // (b) The fixed gate refuses it BY NAME, quoting the offending value.
    let msg = "";
    try {
      resolveDaemonBase();
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.ok(msg, "the fixed gate MUST refuse the base the pre-fix code accepted");
    assert.ok(
      msg.includes("http://evil.example.com:3333"),
      "the refusal must quote the offending value so an operator can see what was rejected",
    );
    // (c) The pre-fix header construction attached the token UNCONDITIONALLY,
    // so the hostile base above would have received the credential.
    process.env.WIGOLO_API_TOKEN = "secret";
    const preFixHeaders = {
      "content-type": "application/json",
      ...(process.env.WIGOLO_API_TOKEN ? { authorization: `Bearer ${process.env.WIGOLO_API_TOKEN}` } : {}),
    };
    assert.equal(preFixHeaders.authorization, "Bearer secret");
  });

  test("MUTATION: the port validator is what stops the :NaN base the pre-fix Number() produced", () => {
    process.env.WIGOLO_DAEMON_PORT = "abc";
    // pre-fix: Number("abc" || 3333) -> NaN -> "http://127.0.0.1:NaN"
    const preFixBase = `http://127.0.0.1:${Number(process.env.WIGOLO_DAEMON_PORT || 3333)}`;
    assert.equal(preFixBase, "http://127.0.0.1:NaN", "precondition: the pre-fix code produced a :NaN base");
    let msg = "";
    try {
      resolveDaemonBase();
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.match(msg, /wigolo refused WIGOLO_DAEMON_PORT="abc"/);
  });

  test("assertLoopbackEndpoint reports the host and the loopback verdict for callers", () => {
    assert.deepEqual(assertLoopbackEndpoint("http://127.0.0.1:3333", "X"), { host: "127.0.0.1", loopback: true });
    process.env[WIGOLO_ALLOW_REMOTE_ENV] = "true";
    assert.deepEqual(assertLoopbackEndpoint("http://wigolo.internal:3333", "X"), {
      host: "wigolo.internal",
      loopback: false,
    });
  });
});
