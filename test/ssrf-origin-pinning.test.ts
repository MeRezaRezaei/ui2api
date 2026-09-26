import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { sameOrigin, assertChannelUrl } from "../src/runtime/ssrf.js";

/**
 * GOAL 99: the origin-pinning guard had ZERO tests while 7 live call sites
 * (youtube, gmail, both plugin contexts, browser-session) refuse cross-origin
 * navigation/fetch through it. A refactor into an open redirect / SSRF would
 * have stayed GREEN. Every vector below was PROBED empirically, not guessed.
 *
 * Measured behaviour that is CORRECT and must stay: the userinfo case
 * (`https://evil.com@www.youtube.com/` really is www.youtube.com) and the
 * explicit-default-port case (`:443` is stripped by URL normalisation).
 */

const HTTPS = "https://www.youtube.com";

d("GOAL 99: origin pinning refuses cross-origin", () => {
  t("refuses every classic cross-origin vector (the probed set)", () => {
    const mustRefuse: Array<[string, string]> = [
      ["protocol-relative", "//evil.com/x"],
      ["subdomain of the allowed host", "https://evil.www.youtube.com/"],
      ["suffix trick", "https://www.youtube.com.evil.com/"],
      ["trailing-dot host", "https://www.youtube.com./"],
      ["non-default port", "https://www.youtube.com:8443/x"],
      ["file scheme", "file:///etc/passwd"],
      ["javascript scheme", "javascript:alert(1)"],
      ["data scheme", "data:text/html,<h1>x"],
      ["unrelated host", "https://evil.com/"],
    ];
    for (const [name, url] of mustRefuse) {
      assert.equal(sameOrigin(url, HTTPS), false, `must refuse ${name}: ${url}`);
    }
  });

  t("accepts genuinely same-origin URLs, including the two correct subtleties", () => {
    for (const url of [HTTPS, `${HTTPS}/watch?v=1`, "https://WWW.YouTube.COM/x", "https://www.youtube.com:443/x"]) {
      assert.equal(sameOrigin(url, HTTPS), true, `must accept same-origin ${url}`);
    }
    // userinfo: the host really IS www.youtube.com, so accepting is correct
    assert.equal(sameOrigin("https://evil.com@www.youtube.com/x", HTTPS), true, "userinfo on the allowed host is same-origin");
  });

  t("sameOrigin enforces same-ORIGIN, not just same host (protocol downgrade refused)", () => {
    // the measured deviation GOAL 99 closed: host-only comparison accepted this
    assert.equal(sameOrigin("http://www.youtube.com/x", HTTPS), false, "an http URL is NOT same-origin with an https base");
    // and the mirror case, so the rule is symmetric rather than one-sided
    assert.equal(sameOrigin("https://www.youtube.com/x", "http://www.youtube.com"), false, "rule is symmetric");
  });

  t("relative input RESOLVES against the base (correct), a malformed BASE refuses", () => {
    // MEASURED correction: these are not refusals. `new URL(v, base)` resolves a
    // relative reference onto the base, so empty / bare / percent input is
    // legitimately same-origin — a page's own relative links must not be blocked.
    for (const rel of ["", "not a url", "://", "%%%", "/relative", "watch?v=1"]) {
      assert.equal(sameOrigin(rel, HTTPS), true, `relative input must resolve onto the base: ${JSON.stringify(rel)}`);
    }
    // what must actually refuse is an unparseable BASE — the guard never throws
    assert.equal(sameOrigin("https://www.youtube.com/x", "not a base"), false, "a malformed base must refuse, not throw");
  });
});

d("GOAL 99: assertChannelUrl rebuilds from validated components", () => {
  t("accepts the three documented shapes and REBUILDS the url", () => {
    assert.equal(assertChannelUrl("@handle"), "https://www.youtube.com/@handle");
    assert.equal(assertChannelUrl(`UC${"a".repeat(22)}`), `https://www.youtube.com/channel/UC${"a".repeat(22)}`);
    // query + fragment are DROPPED by the rebuild, never carried into the navigation
    assert.equal(assertChannelUrl("https://www.youtube.com/@h?x=1#f"), "https://www.youtube.com/@h");
  });

  t("refuses cross-origin, non-https, traversal and over-long input with an honest message", () => {
    const mustRefuse = [
      "https://evil.com/@h",
      "http://www.youtube.com/@h",
      `@${"a".repeat(200)}`,
      "@a/../..",
      "https://www.youtube.com/@a/../../evil",
      "https://www.youtube.com/user/someone",
      "",
    ];
    for (const v of mustRefuse) {
      assert.throws(() => assertChannelUrl(v), /invalid channel reference|expected a channel id/, `must refuse ${JSON.stringify(v)}`);
    }
  });

  t("negative: the guard CAN fail — a cross-origin url is refused, not served", () => {
    // the mutation proof: feed the real functions the attack and require refusal
    assert.equal(sameOrigin("https://evil.com/steal", HTTPS), false, "cross-origin must be refused");
    assert.throws(() => assertChannelUrl("https://evil.com/@h"), /origin pinning refuses cross-origin/, "cross-origin channel must be refused");
  });
});
