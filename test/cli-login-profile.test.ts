import { test as t } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { interactiveLoginLaunch, interactiveLoginProfileDir } from "../src/cli.js";
import { userChromeLaunchArgs } from "../src/runtime/browser.js";

/**
 * THE `analyse --login` LAUNCH GATE.
 *
 * `doInteractiveLogin` used to do:
 *
 *   const opts = buildLaunchOptions({ headless: false });
 *   const browser = await chromium.launch(opts as any);
 *
 * with a comment claiming "the login happens in THEIR real Chrome and profile so
 * the authenticated session lives in their own data". MEASURED FALSE.
 * `chromium.launch()` has NO `userDataDir` parameter:
 *   - it is not one of `LaunchOptions`' 41 fields (playwright-core types.d.ts —
 *     `headless` is, `userDataDir` is not);
 *   - `filterLaunchOptions` is a 12-key WHITELIST the client applies before the
 *     params leave the process, so the key is silently DROPPED (no error, which
 *     is why this survived);
 *   - the server then mkdtemps a throwaway `playwright_chromiumdev_profile-*`
 *     for `--user-data-dir`.
 * So with `UI2API_USER_DATA_DIR` set, the login landed in a temp profile that
 * died with the process, while the code claimed it was persisting. The
 * `as any` cast is what hid the mismatch from the compiler.
 *
 * The fix is the only API that can do what the comment promised:
 * `launchPersistentContext` — the same declared seam exception
 * `xhost-capture.ts:292` already carries for the identical mechanical reason.
 *
 * These tests launch NOTHING. The launch is a static source shape plus the pure
 * resolver that produces its arguments.
 */

const CLI_SRC = readFileSync("src/cli.ts", "utf8");
const GITIGNORE = readFileSync(".gitignore", "utf8");

/** Blank comment bodies so prose about a launch is never counted as a launch. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1 + " ".repeat(80));
}

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

const PROFILE_KEYS = ["UI2API_USER_DATA_DIR", "UI2API_CHROME_PROFILE_PATH", "UI2API_CHROME_OWNER_PROFILE"] as const;

t("the login window is a PERSISTENT context — chromium.launch() cannot carry a profile at all", () => {
  const src = code(CLI_SRC);
  assert.ok(
    !/chromium\s*\.\s*launch\s*\(/.test(src),
    "src/cli.ts must not call chromium.launch() — Playwright drops userDataDir there, so the login profile is a lie",
  );
  assert.match(
    src,
    /chromium\s*\.\s*launchPersistentContext\s*\(\s*launch\.profileDir/,
    "the login must open launchPersistentContext on the resolved profile dir",
  );
  assert.ok(
    /context\s*\.\s*close\s*\(\s*\)/.test(src),
    "a persistent context owns the profile handle, so the cleanup must close the CONTEXT",
  );
});

t("the login comment tells the truth: it names the persistent-context reason, not a launch() profile claim", () => {
  // The old comment asserted a behaviour the code did not have. A future edit
  // must not be able to reintroduce that sentence.
  // The sentence may still APPEAR — quoted, as the claim this comment is
  // correcting — so a literal "must not contain the string" rule would forbid the
  // evidence and only the evidence. What must never come back is the sentence
  // being ASSERTED. So: every occurrence must sit inside a correction, i.e. be
  // preceded (within its own line block) by a refutation.
  const occurrences = [...CLI_SRC.matchAll(/.{0,220}happens in THEIR real Chrome/gs)].map((m) => m[0]);
  assert.ok(occurrences.length > 0, "precondition: the corrected claim is still quoted as the thing being corrected");
  for (const ctx of occurrences) {
    assert.match(
      ctx,
      /MEASURED FALSE|false|previous call|used to|silently opened|not in `LaunchOptions`|DROPS it/i,
      `the 'happens in THEIR real Chrome' claim must only ever appear as a refuted quote; this occurrence asserts it:\n${ctx}`,
    );
  }
  assert.match(
    CLI_SRC,
    /launchPersistentContext[\s\S]{0,400}THROWAWAY|THROWAWAY|throwaway `playwright_chromiumdev_profile/,
    "the declared exception must state the mechanical reason Playwright needs the persistent form",
  );
});

t("the option bag is DERIVED from the seam, and userDataDir is positional — never in the bag", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-loginunit-"));
  try {
    withEnv(PROFILE_KEYS, { UI2API_USER_DATA_DIR: undefined, UI2API_CHROME_PROFILE_PATH: undefined, UI2API_CHROME_OWNER_PROFILE: undefined }, () => {
      const launch = interactiveLoginLaunch(dir);
      assert.equal(launch.usingRealProfile, false, "no profile configured -> this site's own login profile");
      assert.ok(
        !("userDataDir" in launch.options),
        "userDataDir must be the POSITIONAL argument of launchPersistentContext, not an option — Playwright ignores it in a bag",
      );
      assert.equal(launch.options.headless, false, "an invisible window is not a login — headless is forced false");
      assert.deepEqual(
        launch.options.args as string[],
        userChromeLaunchArgs(undefined),
        "the flag set must come from the seam (no --no-sandbox/--disable-gpu tells on a real profile)",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("the operator's OWN profile is used when one is configured, and is named as such", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-loginunit-"));
  const mine = resolve(dir, "my-real-profile");
  try {
    withEnv(PROFILE_KEYS, { UI2API_USER_DATA_DIR: mine, UI2API_CHROME_PROFILE_PATH: undefined, UI2API_CHROME_OWNER_PROFILE: undefined }, () => {
      const launch = interactiveLoginLaunch(dir);
      assert.equal(launch.usingRealProfile, true, "a configured profile must be used, not overridden with ours");
      assert.equal(launch.profileDir, mine, "and the login must land in THAT profile — the claim the old comment made");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("with no configured profile the login profile is DURABLE and inside the gitignored session dir", () => {
  const sessionDir = resolve("/tmp", "sites", "example.com", ".session");
  const profileDir = interactiveLoginProfileDir(sessionDir);
  assert.ok(profileDir.startsWith(sessionDir + sep), `the login profile must live under the session dir, got ${profileDir}`);
  assert.ok(
    profileDir.includes(`${sep}.session${sep}`),
    "it must sit inside .session, which the snapshot is written to and .gitignore already excludes",
  );
  assert.match(
    GITIGNORE,
    /^sites\/\*\/\.session\/$/m,
    ".gitignore must exclude sites/<host>/.session/ — the login profile is a Chrome profile with a cookie DB",
  );
});

t("the resolver is PURE: it names a profile dir but creates nothing and launches nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-loginunit-"));
  try {
    withEnv(PROFILE_KEYS, { UI2API_USER_DATA_DIR: undefined, UI2API_CHROME_PROFILE_PATH: undefined, UI2API_CHROME_OWNER_PROFILE: undefined }, () => {
      const launch = interactiveLoginLaunch(dir);
      assert.equal(
        existsSync(launch.profileDir),
        false,
        "resolving the launch must not create the profile — only the launch itself may, and this test never launches",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t("the launch stays a DECLARED seam exception — the gate's function name must not drift", () => {
  // test/runtime-launch-seam.test.ts (not this file's to edit) declares the
  // exception as `src/cli.ts` / `doInteractiveLogin` and fails LOUD if the
  // declared exception stops existing. This asserts the name it depends on.
  const seamGate = readFileSync("test/runtime-launch-seam.test.ts", "utf8");
  assert.match(
    seamGate,
    /module: "src\/cli\.ts",\s*\n\s*fn: "doInteractiveLogin"/,
    "the seam gate's declared exception names doInteractiveLogin — renaming the function needs that table updated",
  );
  assert.match(CLI_SRC, /async function doInteractiveLogin\(/, "doInteractiveLogin must keep its declared name");
  assert.match(CLI_SRC, /await doInteractiveLogin\(url, host, dirname\(snapshotPath\(/, "both call sites must pass the session dir");
});

t("negative: the reported launch actually MOVES with the env (a resolver frozen to one answer is worthless)", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-loginunit-"));
  try {
    let bare = "";
    let owned = "";
    withEnv(PROFILE_KEYS, { UI2API_USER_DATA_DIR: undefined, UI2API_CHROME_PROFILE_PATH: undefined, UI2API_CHROME_OWNER_PROFILE: undefined }, () => {
      bare = interactiveLoginLaunch(dir).profileDir;
    });
    withEnv(PROFILE_KEYS, { UI2API_USER_DATA_DIR: "/somewhere/else", UI2API_CHROME_PROFILE_PATH: undefined, UI2API_CHROME_OWNER_PROFILE: undefined }, () => {
      owned = interactiveLoginLaunch(dir).profileDir;
    });
    assert.notEqual(bare, owned, "the resolver must follow the profile env, not ignore it");
    assert.equal(owned, "/somewhere/else");
    assert.ok(bare.includes("chrome-login-profile"), "the fallback names itself, so the operator can find the sign-in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
