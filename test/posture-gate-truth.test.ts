import { test as t } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daemonPosture, effectiveChromeNoSandbox, realProfileInPlay } from "../src/prompt/posture.js";
import {
  attachRoots,
  attachMaxBytes,
  ATTACH_ROOTS_ENV,
  ATTACH_MAX_BYTES_ENV,
} from "../src/runtime/file-attach.js";

/**
 * THE REPORT-AGREES-WITH-THE-GATE GATE.
 *
 * `GET /health` and `GET /status` are what an operator READS to decide whether
 * the daemon is safe. A posture row that is more permissive than the runtime is
 * worse than no row at all, and both defects measured here were exactly that:
 *
 *   LIE 1 — `attachRootsCount` re-parsed `UI2API_ATTACH_ROOTS` on `/[:,]/` while
 *   the gate (`file-attach.ts`) splits on `/[:;,]/` and keeps only ABSOLUTE
 *   entries. MEASURED: `"/tmp/a:/tmp/b;/tmp/c,/tmp/d"` → the gate opens FOUR
 *   roots, /health reported THREE. `"/a,rel/path,./x"` → gate 1, report 3.
 *   The byte cap drifted the other way: the gate parses with `Number.parseInt`
 *   and the report used `Number`, so `20mb` capped the gate at 20 BYTES while
 *   /health reported 20 MiB — a million-fold over-statement.
 *
 *   LIE 2 — `chromeNoSandbox` reported the env's INTENT
 *   (`UI2API_CHROME_NO_SANDBOX !== "0"`). The launch seam
 *   (`browser.ts:413`) applies `--no-sandbox` only when
 *   `!(usingRealProfile || env.UI2API_CHROME_NO_SANDBOX === "0")`. MEASURED
 *   with a real profile in play: reported "sandbox disabled" while the spawned
 *   Chrome kept its sandbox ON — a TRUST row stating the opposite of the truth.
 *
 * These tests assert the report equals the GATE, case by case, against the real
 * gate functions — not against a re-typed expectation. They touch no browser.
 */

const POSTURE_SRC = readFileSync("src/prompt/posture.ts", "utf8");
const BROWSER_SRC = readFileSync("src/runtime/browser.ts", "utf8");
const CLI_SRC = readFileSync("src/cli.ts", "utf8");

/** Run `fn` with the named env keys set, then restore exactly. */
function withEnv(keys: readonly string[], values: Record<string, string | undefined>, fn: () => void): void {
  const saved = keys.map((k) => [k, process.env[k]] as const);
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ROOTS_CASES: ReadonlyArray<readonly [string, string]> = [
  ["semicolon-separated (the measured LIE)", "/tmp/a:/tmp/b;/tmp/c,/tmp/d"],
  ["colon-separated (the shape both parsers agreed on)", "/a:/b:/c"],
  ["relative entries the gate drops but a naive count kept", "/a,rel/path,./x"],
  ["whitespace around a semicolon", "  /a ; /b  "],
  ["empty segments", "/a::/b"],
  ["unset", ""],
];

const MAX_BYTES_CASES: ReadonlyArray<readonly [string, string]> = [
  ["plain integer", " 4096 "],
  ["a suffixed number the gate parses with parseInt", "20mb"],
  ["scientific notation", "1e6"],
  ["hex-looking", "0x1000"],
  ["fractional", "12.9"],
  ["negative", "-5"],
  ["zero (falls back to the default)", "0"],
  ["unset", ""],
];

t("LIE 1: the reported attach-root COUNT is the gate's own root list, not a second parse", () => {
  for (const [label, raw] of ROOTS_CASES) {
    withEnv([ATTACH_ROOTS_ENV], { [ATTACH_ROOTS_ENV]: raw }, () => {
      const gate = attachRoots();
      const report = daemonPosture({ [ATTACH_ROOTS_ENV]: raw }).attachRootsCount;
      assert.equal(
        report,
        gate.length,
        `${label}: roots=${JSON.stringify(raw)} — the gate opens ${gate.length} (${JSON.stringify(gate)}), the report said ${report}`,
      );
    });
  }
});

t("LIE 1: a semicolon-separated config reports every root the gate opens (the exact measured case)", () => {
  const raw = "/tmp/a:/tmp/b;/tmp/c,/tmp/d";
  withEnv([ATTACH_ROOTS_ENV], { [ATTACH_ROOTS_ENV]: raw }, () => {
    assert.equal(attachRoots().length, 4, "the gate really does open four roots here — the measurement this pins");
    assert.equal(
      daemonPosture({ [ATTACH_ROOTS_ENV]: raw }).attachRootsCount,
      4,
      "the report under-counted 4 as 3 before the fix, which understated the file-read surface",
    );
  });
});

t("LIE 1: the reported byte cap is the GATE's cap — never a larger number than may be read", () => {
  for (const [label, raw] of MAX_BYTES_CASES) {
    withEnv([ATTACH_MAX_BYTES_ENV], { [ATTACH_MAX_BYTES_ENV]: raw }, () => {
      const gate = attachMaxBytes();
      const report = daemonPosture({ [ATTACH_MAX_BYTES_ENV]: raw }).attachMaxBytes;
      assert.equal(
        report,
        gate,
        `${label}: cap=${JSON.stringify(raw)} — the gate allows ${gate} bytes, the report said ${report}`,
      );
      assert.ok(
        report <= gate,
        `${label}: a posture report must never claim MORE may be read than the gate allows`,
      );
    });
  }
});

t("LIE 1: `20mb` cannot report 20 MiB while the gate caps at 20 bytes", () => {
  withEnv([ATTACH_MAX_BYTES_ENV], { [ATTACH_MAX_BYTES_ENV]: "20mb" }, () => {
    assert.equal(attachMaxBytes(), 20, "the gate's parseInt really does read 20 — the measurement this pins");
    assert.equal(
      daemonPosture({ [ATTACH_MAX_BYTES_ENV]: "20mb" }).attachMaxBytes,
      20,
      "reporting the 20 MiB default here overstated the readable size a million-fold",
    );
  });
});

t("LIE 1: posture.ts holds NO parser of its own for the attach knobs", () => {
  // The defect class is a second implementation of a gate's parsing. If a
  // hand-rolled split/Number ever reappears here, this fails before the report
  // can quietly disagree again.
  assert.match(POSTURE_SRC, /attachRoots as gateAttachRoots/, "the gate's attachRoots() must be imported");
  assert.match(POSTURE_SRC, /attachMaxBytes as gateAttachMaxBytes/, "the gate's attachMaxBytes() must be imported");
  assert.ok(
    !/\.split\(\s*\/\[:?,;]/.test(POSTURE_SRC),
    "posture.ts must not split the roots knob itself — that is exactly how the count drifted",
  );
  assert.ok(
    !/Number\(\s*env\[?\s*ATTACH_MAX_BYTES/.test(POSTURE_SRC) && !/Number\.parseInt\(\s*env\[/.test(POSTURE_SRC),
    "posture.ts must not re-parse the byte cap — the gate's own parser is the only parser",
  );
});

t("LIE 2: chromeNoSandbox is the EFFECTIVE launch outcome, and a real profile flips it", () => {
  const profile = "/home/ui2api/.config/ui2api-chrome";
  withEnv(
    ["UI2API_USER_DATA_DIR", "UI2API_CHROME_PROFILE_PATH", "UI2API_CHROME_OWNER_PROFILE"],
    { UI2API_USER_DATA_DIR: profile, UI2API_CHROME_PROFILE_PATH: undefined, UI2API_CHROME_OWNER_PROFILE: undefined },
    () => {
      assert.equal(realProfileInPlay(process.env), true, "the seam's own resolver must see the configured profile");
      assert.equal(
        effectiveChromeNoSandbox(process.env),
        false,
        "browser.ts:413 never adds --no-sandbox for a real profile, so the EFFECTIVE value is sandbox-ON",
      );
      const reported = daemonPosture({ UI2API_USER_DATA_DIR: profile });
      assert.equal(reported.chromeNoSandbox, false, "the report said the OPPOSITE before the fix (sandbox disabled)");
      assert.equal(reported.realProfileInPlay, true, "and it now discloses WHY");
      assert.ok(
        reported.warnings.some((w) => /sandbox ON/.test(w) && /real user profile/.test(w)),
        `the suppressed-by-profile case must be named in the warnings, got ${JSON.stringify(reported.warnings)}`,
      );
    },
  );
});

t("LIE 2: the profile alias is honoured, and the no-profile default is unchanged", () => {
  withEnv(
    ["UI2API_USER_DATA_DIR", "UI2API_CHROME_PROFILE_PATH", "UI2API_CHROME_OWNER_PROFILE"],
    { UI2API_USER_DATA_DIR: undefined, UI2API_CHROME_PROFILE_PATH: "/home/x/.config/google-chrome", UI2API_CHROME_OWNER_PROFILE: undefined },
    () => {
      assert.equal(effectiveChromeNoSandbox(process.env), false, "the alias profile suppresses --no-sandbox too");
    },
  );
  withEnv(
    ["UI2API_USER_DATA_DIR", "UI2API_CHROME_PROFILE_PATH", "UI2API_CHROME_OWNER_PROFILE", "UI2API_CHROME_NO_SANDBOX"],
    { UI2API_USER_DATA_DIR: undefined, UI2API_CHROME_PROFILE_PATH: undefined, UI2API_CHROME_OWNER_PROFILE: undefined, UI2API_CHROME_NO_SANDBOX: undefined },
    () => {
      // The two rows the existing suite already pins (daemon-posture.test.ts)
      // must keep holding: no profile and no knob really does mean no sandbox.
      assert.equal(effectiveChromeNoSandbox(process.env), true, "temp profile + no opt-out -> --no-sandbox IS applied");
      assert.equal(daemonPosture({}).chromeNoSandbox, true, "the documented default posture is unchanged");
      process.env.UI2API_CHROME_NO_SANDBOX = "0";
      assert.equal(effectiveChromeNoSandbox(process.env), false, "the documented opt-out still flips it");
      assert.equal(daemonPosture({ UI2API_CHROME_NO_SANDBOX: "0" }).chromeNoSandbox, false, "…and still reports it");
    },
  );
});

t("LIE 2: the predicate in posture is pinned to the launcher's OWN source line", () => {
  // A transcription can rot. This asserts the launcher still says what posture
  // transcribes — `--no-sandbox` is skipped for a real profile OR the "0"
  // opt-out — so an edit there fails LOUD here instead of inverting a TRUST row.
  assert.match(
    BROWSER_SRC,
    /usingRealProfile\s*\|\|\s*process\.env\.UI2API_CHROME_NO_SANDBOX\s*===\s*"0"\s*\?\s*\[\]\s*:\s*\["--no-sandbox"\]/,
    "browser.ts no longer applies --no-sandbox under the condition posture transcribes — re-derive before trusting the row",
  );
  assert.ok(
    !/chromeNoSandbox\s*=\s*env\.UI2API_CHROME_NO_SANDBOX\s*!==\s*"0"/.test(POSTURE_SRC),
    "posture must not report the env's intent as the effective outcome",
  );
  assert.match(
    POSTURE_SRC,
    /!\(realProfileInPlay\(env\)\s*\|\|\s*env\.UI2API_CHROME_NO_SANDBOX\s*===\s*"0"\)/,
    "posture must apply the same two conditions the launcher does",
  );
});

t("the production path and the injectable path are the SAME function of the environment", () => {
  // http.ts calls daemonPosture(process.env, bind). The gate bridge must be a
  // no-op there, so a test with an injected env and the live daemon cannot see
  // two different reports.
  withEnv(
    [ATTACH_ROOTS_ENV, ATTACH_MAX_BYTES_ENV, "UI2API_USER_DATA_DIR"],
    { [ATTACH_ROOTS_ENV]: "/a;/b", [ATTACH_MAX_BYTES_ENV]: "4096", UI2API_USER_DATA_DIR: "/p" },
    () => {
      assert.deepEqual(
        daemonPosture(),
        daemonPosture(process.env, "127.0.0.1"),
        "daemonPosture() and daemonPosture(process.env) must be identical — the env bridge is transparent",
      );
    },
  );
});

t("the report still discloses SHAPES only — no root path, no token value, after the re-derivation", () => {
  const SECRET = "super-secret-token-value";
  const ROOT = "/home/me/very-private-dir";
  const p = daemonPosture({ UI2API_PROMPTD_TOKEN: SECRET, [ATTACH_ROOTS_ENV]: `${ROOT}:/srv/x;/tmp/y` });
  const serialised = JSON.stringify(p);
  assert.ok(!serialised.includes(SECRET), "the token VALUE must never appear");
  assert.ok(!serialised.includes(ROOT), "an attach ROOT is a filesystem location — never disclosed, only counted");
  assert.equal(p.attachRootsCount, 3, "the count is disclosed instead (semicolon-separated roots included)");
});

t("negative: the report RESPONDS to each knob it discloses (a report that cannot move is not a report)", () => {
  const roots = daemonPosture({ [ATTACH_ROOTS_ENV]: "/a:/b:/c" });
  assert.equal(roots.attachRootsCount, 3);
  assert.ok(roots.warnings.some((w) => /3 attach root/.test(w)), `expected the real count in a warning, got ${JSON.stringify(roots.warnings)}`);

  const none = daemonPosture({});
  assert.equal(none.attachRootsCount, 0);
  assert.ok(none.warnings.some((w) => /attach path form refused/.test(w)), "the closed default must be stated");

  const capped = daemonPosture({ [ATTACH_MAX_BYTES_ENV]: "1024" });
  assert.equal(capped.attachMaxBytes, 1024, "the cap must be disclosed as the gate reads it");
  assert.equal(daemonPosture({}).attachMaxBytes, 20 * 1024 * 1024, "and the default is the gate's own default");
});

t("LIE 3: the token knob NAME has exactly one definition site in the code it owns", () => {
  // `TOKEN_ENV` is the definition. cli.ts must not type the literal beside it,
  // or a renamed knob would keep gating in one file and not the other.
  assert.match(POSTURE_SRC, /export const TOKEN_ENV = "UI2API_PROMPTD_TOKEN"/, "posture.ts owns the name");
  assert.match(CLI_SRC, /import \{ TOKEN_ENV \} from "\.\/prompt\/posture\.js"/, "cli.ts must import the name");
  assert.ok(
    !/process\.env\.UI2API_PROMPTD_TOKEN/.test(CLI_SRC),
    "src/cli.ts must not hand-type the token knob — it imports TOKEN_ENV",
  );
});
