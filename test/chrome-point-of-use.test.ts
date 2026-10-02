import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolveChromeOwner, chromeOwnerUser, chromeOwnerStatus, CHROME_USER_ENV } from "../src/runtime/chrome-owner.js";
import { userChromeProfile } from "../src/runtime/browser.js";

/**
 * THE CHROME POINT OF USE.
 *
 * ui2api drives the Chrome of a DEDICATED LINUX USER, not the operator's own
 * browser. Chrome refuses to let another process attach to the browser a person
 * is actively using, and refuses `--remote-debugging-port` on a live profile —
 * that is a wall, not a bug. The dedicated user's Chrome works fine, headless
 * included, so the only required setup in the whole world is that this user's
 * Chrome info EXISTS. Writing the Chrome info into that user IS the integration.
 *
 * The owner is DATA, not a hardcode (`UI2API_CHROME_USER`), and the launch seam
 * and the docs must never disagree about it — which is what these pins enforce.
 * Without them this fact has been re-litigated repeatedly, which is the real cost.
 */

const AGENTS = readFileSync("AGENTS.md", "utf8");
const DOC = readFileSync("docs/CHROME_POINT_OF_USE.md", "utf8");
const GITIGNORE = readFileSync(".gitignore", "utf8");

d("the Chrome point of use is a dedicated user, and it is pinned", () => {
  t("the owner is named by env, defaulting to ui2api — data, not a hardcode", () => {
    assert.equal(CHROME_USER_ENV, "UI2API_CHROME_USER");
    const prev = process.env.UI2API_CHROME_USER;
    try {
      delete process.env.UI2API_CHROME_USER;
      assert.equal(chromeOwnerUser(), "ui2api", "the default owner on this box is `ui2api`");
      process.env.UI2API_CHROME_USER = "some-svc-acct";
      assert.equal(chromeOwnerUser(), "some-svc-acct", "a per-customer service account must be selectable");
    } finally {
      if (prev === undefined) delete process.env.UI2API_CHROME_USER;
      else process.env.UI2API_CHROME_USER = prev;
    }
  });

  t("it resolves the owner's real profile, and says so honestly when absent", () => {
    const o = resolveChromeOwner();
    assert.equal(o.user, "ui2api");
    if (o.home) {
      assert.match(o.home, /^\//, "the home must be an absolute path from getent");
    } else {
      assert.ok(o.missing, "with no home there MUST be a named reason");
    }
    // a real profile is one with Default / Profile 1 / Local State — not an empty dir
    if (o.profile) {
      assert.ok(
        /ui2api-chrome|google-chrome|chromium|chrome/.test(o.profile),
        `the profile must come from the owner's ~/.config, got ${o.profile}`,
      );
    }
  });

  t("a NON-existent user is a NAMED verdict, never a silent fallback", () => {
    const prev = process.env.UI2API_CHROME_USER;
    try {
      process.env.UI2API_CHROME_USER = "definitely-not-a-real-user-xyz";
      const o = resolveChromeOwner();
      assert.equal(o.profile, null, "no profile can be resolved for a user that does not exist");
      assert.match(o.missing ?? "", /no such user/, "and it must say so by name");
      const st = chromeOwnerStatus();
      assert.equal(st.ready, false);
      assert.match(st.line, /NOT READY/, "the status line must be honest, not quietly fine");
    } finally {
      if (prev === undefined) delete process.env.UI2API_CHROME_USER;
      else process.env.UI2API_CHROME_USER = prev;
    }
  });

  t("the launch seam uses the owner's profile ONLY when it can actually", () => {
    const prevU = process.env.UI2API_USER_DATA_DIR;
    const prevP = process.env.UI2API_CHROME_PROFILE_PATH;
    const prevO = process.env.UI2API_CHROME_USER;
    const prevF = process.env.UI2API_CHROME_OWNER_PROFILE;
    try {
      delete process.env.UI2API_USER_DATA_DIR;
      delete process.env.UI2API_CHROME_PROFILE_PATH;
      delete process.env.UI2API_CHROME_OWNER_PROFILE;
      delete process.env.UI2API_CHROME_USER;
      const owner = resolveChromeOwner();
      // MEASURED FLAW this pin now guards: handing the owner's 0700 PROFILE-LOCKED
      // profile to a caller that is not the owner dies with
      // `chrome exited early (code 21)`, and it silently coupled the whole test
      // suite to the machine's ambient state. So it is used only when we ARE the
      // owner (the real production case), or when explicitly asked.
      if (!owner.runningAsOwner) {
        assert.equal(
          userChromeProfile(),
          undefined,
          "a non-owner must NOT be handed the owner's locked profile",
        );
      }
      // explicit opt-in is the escape hatch, and is honoured
      process.env.UI2API_CHROME_OWNER_PROFILE = "1";
      if (owner.profile) {
        assert.equal(userChromeProfile(), owner.profile, "the explicit opt-in must hand it over");
      }
      delete process.env.UI2API_CHROME_OWNER_PROFILE;
      // an EXPLICIT choice always wins — all of this is a default, not an override
      process.env.UI2API_USER_DATA_DIR = "/tmp/explicit-profile";
      assert.equal(userChromeProfile(), "/tmp/explicit-profile", "explicit must always win");
    } finally {
      for (const [k, v] of [
        ["UI2API_USER_DATA_DIR", prevU],
        ["UI2API_CHROME_PROFILE_PATH", prevP],
        ["UI2API_CHROME_USER", prevO],
        ["UI2API_CHROME_OWNER_PROFILE", prevF],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  t("the docs state the rule, the xhost + login path, and the wall", () => {
    for (const [name, text] of [["AGENTS.md", AGENTS], ["docs/CHROME_POINT_OF_USE.md", DOC]] as const) {
      assert.match(text, /UI2API_CHROME_USER/, `${name} must name the env knob`);
      assert.match(text, /xhost \+/, `${name} must carry the xhost + login path — that is how a human logs in`);
      assert.match(text, /headless/i, `${name} must say headless works for the dedicated user`);
    }
    // the wrong assumption must be gone, stated as the thing it was
    assert.match(AGENTS + DOC, /cannot be driven|refuses/i, "the interactive-browser wall must be stated");
    assert.match(AGENTS, /UI2API_CHROME_USER.*chrome-owner\.ts/, "AGENTS must point at the resolver");
  });

  t("CI is GITLAB, and the readiness state must not point at the GitHub lane", () => {
    assert.ok(existsSync(".gitlab-ci.yml"), "the GitLab pipeline must exist");
    const ci = readFileSync(".gitlab-ci.yml", "utf8");
    assert.match(ci, /npm run test:unit/, "and must run the full unit suite");
    const ready = readFileSync(".brain/PRODUCTION_READINESS.md", "utf8");
    assert.ok(
      !/\.github\/workflows\/ci\.yml/.test(ready),
      "the readiness state still cites the GitHub workflow as the CI lane — GitLab is the CI",
    );
  });

  t("negative: the old 'just use the operator's browser' assumption is rejected (mutation proof)", () => {
    // the wrong model, stated as the wrong model
    const wrongModel = "Attach to the operator's interactive Chrome via --remote-debugging-port.";
    assert.match(wrongModel, /interactive Chrome/, "precondition: the old model targeted the human's browser");
    assert.match(DOC, /cannot be driven|refuses/i, "the real doc must state that this is refused");
    assert.match(DOC, /dedicated/i, "and that the point of use is a dedicated user");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DUAL-SPELLING HOLE, CLOSED.
//
// A repo-wide sweep found the readiness gate probing a directory nothing
// provisions or launches:
//
//   requirements.ts (defaultCopiedProfileProbe) built its OWN path,
//       join(home, ".ui2api-chrome")
//   while the launch seam, the systemd unit and the provision script all used
//       join(home, ".config", "ui2api-chrome")
//
// MEASURED on this box, not guessed:
//   live + launched : /home/ui2api/.config/ui2api-chrome
//       (systemd ui2api-chrome.service MainPID 1895, `--user-data-dir=` read out
//        of /proc/1895/cmdline; 154M, dir mtime the day this was written)
//   probed by the gate : /home/ui2api/.ui2api-chrome
//       (187M, dir mtime 2026-09-22 — a STALE ORPHAN from a "wave-19 seam"
//        nothing provisions)
//
// So the gate was not merely vacuous, which would at least be honest about
// nothing: it was PASSING FOR THE WRONG REASON, on a dead directory. It would
// have kept reporting "present" if the real profile were deleted outright.
//
// Two tests made this survivable: one pinned the dead spelling and one pinned
// the live one. BOTH were green. They were green BECAUSE THEY DISAGREED — each
// pinned a string, neither pinned the fact, so the divergence was the passing
// condition rather than a failure. These tests below pin the FACT instead.
// ─────────────────────────────────────────────────────────────────────────────

/** The profile path the launch seam actually resolves, from the real resolver. */
function liveOwnerProfile(): string | null {
  return resolveChromeOwner().profile;
}

/**
 * The dead spelling, minus the legitimate `.config/ui2api-chrome` that shares its
 * tail. `.ui2api-chrome` is a MATCH for `config/ui2api-chrome` as a substring, so
 * a naive `includes` reports the CORRECT path as a violation — which is how a
 * guard like this gets quietly disabled.
 */
function deadSpelling(text: string): boolean {
  return /(?<!\.config)\.ui2api-chrome/.test(text);
}

/**
 * Strip comment-only lines so the gate judges EXECUTABLE CODE.
 *
 * This exists because the fix's own provenance comment in requirements.ts quotes
 * the dead spelling, and a guard that forbids its own history rots the
 * documentation — a pin that fires on the sentence explaining the pin teaches the
 * next maintainer to delete the sentence, and then the pin. The comments stay; the
 * CODE is what must be clean.
 *
 * This is a line-class filter, not a parser: it drops lines whose first non-space
 * characters open a comment. That is enough for this codebase's comment style and
 * it fails SAFE (an offender hidden inside a trailing comment is still reported),
 * which is the correct direction for a guard.
 */
function executableCode(text: string): string {
  return text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#"));
    })
    .join("\n");
}

d("the readiness gate and the launch seam resolve the SAME profile", () => {
  t("POSITIVE CONTROL first: this box HAS a live owner profile, so the pins below bite", () => {
    // A gate that can only fail on a machine that has no profile is a gate that
    // never fires in CI and never fires where it matters. MEASURED, not assumed:
    assert.ok(
      liveOwnerProfile(),
      "no owner profile resolved on this box — every negative assertion below would pass vacuously, " +
        "so they would prove nothing. Run these on the box that has the profile.",
    );
    assert.match(liveOwnerProfile()!, /\.config\/ui2api-chrome/, "and it must be the .config spelling that the unit launches");
  });

  t("browser-home reports the path resolveChromeOwner() returns — DERIVED, not pinned", async () => {
    // THE gate. `browserHomeCheck` must not build a path of its own; it reads the
    // same `chromeOwner` seam the launch seam's `userChromeProfile()` consumes, so
    // a divergence is now structurally impossible rather than merely tested for.
    // The expectation is computed from the REAL resolver, so if chrome-owner.ts
    // ever moves the profile again, this test follows it instead of failing for a
    // reason an operator would not recognise.
    const { runOsChecks } = await import("../src/runtime/requirements.js");
    const base = (await import("../src/runtime/requirements.js")).defaultRequirementsDeps();
    const owner = resolveChromeOwner();

    const { checks } = await runOsChecks({
      ...base,
      // host-reading seams pinned so the verdict is decided by the owner seam only
      ui2apiUser: () => owner.user,
      userExists: () => true,
      ui2apiUserDataDir: () => "/tmp/chrome-path-truth-data",
      chromeOwner: () => ({
        user: owner.user,
        profile: owner.profile,
        missing: owner.missing,
        profileExistsButUnreadable: owner.profileExistsButUnreadable,
      }),
    });

    const browserHome = checks.find((c) => c.id === "browser-home")!;
    assert.equal(browserHome.status, "pass", "the owner's profile exists, so the gate must pass");
    assert.ok(
      browserHome.detail!.includes(owner.profile!),
      `browser-home must name the RESOLVED profile ${owner.profile}, got: ${browserHome.detail}`,
    );
    assert.equal(
      browserHome.detail!.includes("/.ui2api-chrome"),
      false,
      "browser-home must never name the dead dot-spelling",
    );

    // and the two checks in the SAME report must agree with each other
    const chromeOwnerCheck = checks.find((c) => c.id === "chrome-owner")!;
    assert.ok(
      chromeOwnerCheck.detail!.includes(owner.profile!),
      `the chrome-owner check in the same report names ${chromeOwnerCheck.detail}, not the resolved profile`,
    );
  });

  t("no `.ui2api-chrome` literal survives in src/ — the second copy is GONE, not merely unused", () => {
    // Derivation, not a preference: if the literal is gone, there is nothing left
    // to keep in sync. This is what makes "someone adds the path back" a red
    // build rather than a silent second source of truth.
    const offenders: string[] = [];
    for (const f of walk("src")) {
      if (deadSpelling(executableCode(readFileSync(f, "utf8")))) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `the dead profile spelling is back in executable code: ${offenders.join(", ")}`);
  });

  t("MUTATION PROOF: re-inserting the dead spelling is CAUGHT", () => {
    // A gate nobody has seen go red is a gate nobody can trust. The mutation is
    // named: put back exactly the line the fix deleted —
    //   const dir = join(ui2apiUserHome(user), ".ui2api-chrome");
    // — and assert the detector fires on it and NOT on the real source.
    const realSrc = readFileSync("src/runtime/requirements.ts", "utf8");
    assert.equal(
      deadSpelling(executableCode(realSrc)),
      false,
      "POSITIVE CONTROL: the real source's CODE must NOT trip the detector",
    );

    const mutated = realSrc.replace(
      "  const owner = (deps.chromeOwner ?? resolveChromeOwner)();",
      [
        "  const owner = (deps.chromeOwner ?? resolveChromeOwner)();",
        '  const dir = join(ui2apiUserHome(user), ".ui2api-chrome");',
        "  void dir;",
      ].join("\n"),
    );
    assert.notEqual(mutated, realSrc, "MUTATION SETUP FAILED — the anchor line moved, so the mutation changed nothing");
    assert.equal(
      deadSpelling(executableCode(mutated)),
      true,
      "the mutation went undetected — the gate is broken, not the mutation",
    );
  });

  t("MUTATION PROOF 2: a ready-made fake path that CLEANS UP after itself is still caught", () => {
    // The subtlety that makes the previous guard silently worthless: a mutation
    // that writes the dead spelling to disk and then deletes it leaves the tree
    // exactly as it found it. A guard that only inspects the live tree passes it.
    // `deadSpelling` takes the text as an ARGUMENT, so it judges a snapshot the
    // mutation cannot reach after the fact — proven here without touching disk.
    const sneaky = `export function probe(user) {
  const dir = join(homeOf(user), ".ui2api-chrome");
  return existsSync(dir);
}
export function cleanup() { /* removes the file it wrote */ }`;
    assert.equal(deadSpelling(sneaky), true, "a self-cleaning mutation must still be caught by the text the guard reads");
  });
});

/** Every tracked file under a directory, recursively, extensions we read as text. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}


d("GOAL 128: GitHub and GitLab are both wired, and .brain only reaches private remotes", () => {
  const WIRING = readFileSync("docs/GIT_WIRING.md", "utf8");
  const GITIGNORE = readFileSync(".gitignore", "utf8");

  t("origin pushes to BOTH remotes, so one push lands in both", () => {
    // the doc must state the invariant, and the knob for it is real config
    assert.match(WIRING, /push to BOTH|pushes to BOTH/i, "the dual-push invariant must be documented");
    assert.match(WIRING, /gitlab\.pubg-sell\.ir/, "and the GitLab host named");
    assert.match(AGENTS, /GIT WIRING/, "AGENTS must point at the wiring doc");
  });

  t("CI is GitLab and the pipeline actually runs the full unit suite", () => {
    const ci = readFileSync(".gitlab-ci.yml", "utf8");
    assert.match(ci, /npm run test:unit/, "the GitLab pipeline must run the full unit suite");
    assert.match(ci, /check:verbatim/, "and the verbatim gates");
    assert.match(ci, /timeout:\s*30 minutes/, "and a time cap — this box must not run it");
  });

  t("the privacy gate is stated for BOTH remotes, and data/ stays ignored", () => {
    for (const [name, text] of [["AGENTS.md", AGENTS], ["docs/GIT_WIRING.md", WIRING]] as const) {
      assert.match(text, /isPrivate/, `${name} must carry the GitHub privacy check`);
      assert.match(text, /private/i, `${name} must state that the remotes are private`);
    }
    assert.match(GITIGNORE, /^data\/?$/m, "data/ (real sessions + credentials) must stay gitignored");
  });

  t("the SSH trap is documented so nobody 'fixes' a push into a hang", () => {
    assert.match(WIRING, /Port 22 is blocked|port 22 is blocked/i, "the SSH hang must be documented");
    assert.match(WIRING, /0600/, "and the credential file's mode must be stated");
  });
});
