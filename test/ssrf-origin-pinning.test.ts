import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { sameOrigin, assertChannelUrl, sameOriginAllowingWwwSibling, WWW_SIBLING_ALLOWANCE } from "../src/runtime/ssrf.js";

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

/**
 * The www-sibling allowance (the ONE cross-host navigation this repo allows).
 * It exists because `capabilities/youtube/profile.json` pins the BARE host —
 * which is also the VAULT KEY (`data/sessions/<host>/`), so it may not move
 * without repointing a real stored account — while every URL
 * `src/capabilities/youtube.ts` builds is `www.youtube.com`, the host the site
 * actually serves. `sameOrigin` demands exact host equality, so youtube_search
 * could never navigate at all.
 *
 * These tests exist to pin the allowance NARROW: the pair is literal and every
 * other host — including ones that look like the pair — is still refused.
 */
d("www sibling allowance: literal host pair, everything else still refused", () => {
  const BARE = "https://youtube.com";
  const WWW = "https://www.youtube.com";

  t("allows the youtube.com <-> www.youtube.com pair in both directions", () => {
    assert.equal(sameOriginAllowingWwwSibling("https://www.youtube.com/results?search_query=x", BARE), true);
    assert.equal(sameOriginAllowingWwwSibling("https://youtube.com/results?search_query=x", WWW), true);
    // and plain same-origin still works through the sibling entry point
    assert.equal(sameOriginAllowingWwwSibling(`${BARE}/watch?v=1`, BARE), true);
  });

  t("the allowance is OPT-IN: strict sameOrigin still refuses the pair", () => {
    assert.equal(sameOrigin("https://www.youtube.com/results", BARE), false, "strict guard unchanged");
    assert.equal(sameOrigin("https://youtube.com/results", WWW), false, "strict guard unchanged");
  });

  t("REFUSES every off-host / look-alike URL, including www tricks", () => {
    const mustRefuse = [
      "https://evil.com/",
      "https://youtube.com.evil.com/",
      "https://notyoutube.com/",
      "https://evil.www.youtube.com/",
      "https://www.youtube.com.evil.com/",
      "https://youtube.com.www.evil.com/",
      "https://m.youtube.com/",
      "https://youtu.be/",
      "https://youtube.com:8443/x",
      "https://www.youtube.com./",
    ];
    for (const url of mustRefuse) {
      assert.equal(sameOriginAllowingWwwSibling(url, BARE), false, `must refuse ${url}`);
      assert.equal(sameOriginAllowingWwwSibling(url, WWW), false, `must refuse ${url} (www base)`);
    }
  });

  t("REFUSES a protocol downgrade even across the allowed pair", () => {
    assert.equal(sameOriginAllowingWwwSibling("http://www.youtube.com/results", BARE), false, "http sibling refused");
    assert.equal(sameOriginAllowingWwwSibling("http://youtube.com/results", WWW), false, "http sibling refused");
    assert.equal(sameOriginAllowingWwwSibling("file:///etc/passwd", BARE), false);
    assert.equal(sameOriginAllowingWwwSibling("javascript:alert(1)", BARE), false);
  });

  t("a base host with NO allowance entry gains nothing (not a generic www rule)", () => {
    // a hypothetical `evil.com` / `www.evil.com` pair is NOT same-origin here
    assert.equal(sameOriginAllowingWwwSibling("https://www.evil.com/", "https://evil.com"), false);
    assert.deepEqual(Object.keys(WWW_SIBLING_ALLOWANCE).sort(), ["www.youtube.com", "youtube.com"],
      "the allowance table names exactly one host pair");
  });
});
