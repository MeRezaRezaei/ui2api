import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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

  t("the launch seam's default IS the chrome owner", () => {
    const prevU = process.env.UI2API_USER_DATA_DIR;
    const prevP = process.env.UI2API_CHROME_PROFILE_PATH;
    const prevO = process.env.UI2API_CHROME_USER;
    try {
      delete process.env.UI2API_USER_DATA_DIR;
      delete process.env.UI2API_CHROME_PROFILE_PATH;
      delete process.env.UI2API_CHROME_USER;
      const owner = resolveChromeOwner();
      if (owner.profile) {
        assert.equal(userChromeProfile(), owner.profile, "with no explicit env, the owner's profile is the default");
      }
      // an EXPLICIT choice always wins — the owner is a default, not an override
      process.env.UI2API_USER_DATA_DIR = "/tmp/explicit-profile";
      assert.equal(userChromeProfile(), "/tmp/explicit-profile", "explicit must always win");
    } finally {
      for (const [k, v] of [
        ["UI2API_USER_DATA_DIR", prevU],
        ["UI2API_CHROME_PROFILE_PATH", prevP],
        ["UI2API_CHROME_USER", prevO],
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
