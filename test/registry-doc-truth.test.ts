import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REGISTRY_BRANCH,
  DEFAULT_REGISTRY_URL,
  fetchRegistryIndex,
} from "../src/registry/install.js";

/**
 * GOAL 116 — the docs advertised a PUBLIC community registry that does not
 * exist, so the documented one-command install path failed exactly as written
 * (`install --catalog` -> HTTP 404 on the code's own default URL). The parent
 * owns the goal; this file PINS doc/code agreement so the two can never drift
 * again — offline, hermetically, with a proven-mutation negative.
 *
 * Truth being pinned (as of this writing):
 *   - the code's default registry URL is an INTENTIONAL placeholder with no
 *     public repo behind it, and the docs SAY so instead of implying a live
 *     public registry;
 *   - every registry repo name + branch a doc asserts equals
 *     `DEFAULT_REGISTRY_URL` / `DEFAULT_REGISTRY_BRANCH` in the code;
 *   - the default-URL failure names the real cause (nothing is published) and
 *     the real remedy (`--registry` / `UI2API_REGISTRY_URL`).
 *
 * The "is the registry published YET?" half is NOT a unit assertion: it is a
 * fact about the world, so it is a documented one-line curl (in the last
 * describe) rather than a fetch inside `test:unit` — no third party's uptime
 * can decide a verdict here, and no slow network can burn the file timeout.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const README = read("README.md");
const ONBOARDING = read("docs/ONBOARDING.md");
// GOAL 120: the class must not regrow outside README/ONBOARDING. The GOAL 116
// agent found three more live false claims (hub/mirror.ts, VISION.md,
// STEALTH.md); this pin now covers them too.
const VISION = read("docs/VISION.md");
const STEALTH = read("docs/STEALTH.md");
const MIRROR = read("src/hub/mirror.ts");
const INSTALL_SRC = read("src/registry/install.ts");

/** The registry repo name the code's default points at. */
const DEFAULT_REPO = /\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(DEFAULT_REGISTRY_URL)?.slice(1) ?? [];
const [DEF_OWNER, DEF_REPO, DEF_BRANCH] = DEFAULT_REPO as [string, string, string];

/** A doc token that is a FILL-IN placeholder (`<you>`, `<owner>`, `your-fork`), not a claim. */
const isPlaceholder = (s: string) => /<|YOUR_|your-fork|example/i.test(s);

/** Every `raw.githubusercontent.com/<owner>/<repo>/<branch>` URL a doc mentions. */
export function rawRegistryUrls(doc: string): string[] {
  return [...doc.matchAll(/raw\.githubusercontent\.com\/[^\s`'")\]]+/g)].map((m) => m[0]);
}

/**
 * Violations of the doc↔code contract for ONE doc. Empty array = the doc
 * agrees with the code's default registry URL/branch.
 *
 * A URL presented as the CLI's DEFAULT (or as *the* public registry) is a
 * claim about where packages come from, so it must equal `DEFAULT_REGISTRY_URL`
 * — a different repo name, a different branch (`main` vs `master`), or a
 * different owner is a violation, which is exactly what the mutation tests
 * below prove. A URL presented as "your own / a fork" (a line that claims
 * nothing about the default) is a fill-in and is not a claim; a line-scoped
 * claim is what keeps a mutated repo NAME from escaping the check.
 */
export function docTruthViolations(doc: string): string[] {
  const out: string[] = [];
  // A claim is scoped to its PARAGRAPH (blank-line separated), not its line:
  // prose wraps, and "The registry the CLI defaults to" routinely sits on the
  // line above the URL it names. A paragraph that asserts the default / the
  // public registry must name exactly the code's URL; a paragraph that only
  // shows the reader's own fork is a fill-in, not a claim.
  for (const para of doc.split(/\n\s*\n/)) {
    const claimsDefault = /\b(default|public)\b/i.test(para);
    for (const url of rawRegistryUrls(para)) {
      const parts = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        `https://${url.replace(/^https?:\/\//, "")}`
      );
      if (!parts) continue;
      const [, owner, repo, branch] = parts as unknown as [string, string, string, string];
      if (isPlaceholder(owner) || isPlaceholder(repo) || isPlaceholder(branch)) continue; // fill-in example
      const expected = `${DEF_OWNER}/${DEF_REPO}/${DEF_BRANCH}`;
      const got = `${owner}/${repo}/${branch}`;
      if (got === expected) continue;
      // Any URL in a paragraph that claims to BE the default/public registry
      // must be the code's; outside such a paragraph, a URL on THIS repo must
      // still agree with the code's owner + branch.
      if (claimsDefault || repo === DEF_REPO) {
        out.push(
          `doc claims the default/public registry is ${got} but the code default is ${expected} (${DEFAULT_REGISTRY_URL})`
        );
      }
    }
  }
  return out;
}

/** The doc's claim that the default registry is NOT published. */
function statesUnpublished(doc: string): boolean {
  return /no public (community )?registry is published/i.test(doc);
}

/** Swap globalThis.fetch for a 404 stub and restore it afterwards. */
async function withStubbedFetch<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("404: Not Found", { status: 404 })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

d("GOAL 116 — registry doc/code truth", () => {
  t("the code's default really is the documented placeholder (master, this repo name)", () => {
    assert.equal(DEF_BRANCH, DEFAULT_REGISTRY_BRANCH, "parsed branch must equal DEFAULT_REGISTRY_BRANCH");
    assert.equal(
      DEFAULT_REGISTRY_URL,
      `https://raw.githubusercontent.com/${DEF_OWNER}/${DEF_REPO}/${DEFAULT_REGISTRY_BRANCH}`,
      "DEFAULT_REGISTRY_URL must be owner/repo/DEFAULT_REGISTRY_BRANCH"
    );
  });

  t("README.md names no registry repo/branch that the code's default contradicts", () => {
    assert.deepEqual(docTruthViolations(README), []);
  });

  t("GOAL 120: VISION/STEALTH/mirror make no live claim about an unpublished registry", () => {
    for (const [name, doc] of [["VISION", VISION], ["STEALTH", STEALTH]] as const) {
      // several honest phrasings are acceptable; the requirement is that the doc
      // CARRIES the truth, not that it matches one exact wording
      assert.match(doc, /no public registry is published|not published|NOT YET PUBLISHED|does not exist/i,
        `docs/${name}.md must say the registry is not published`);
    }
    // the hub mirror must not default to a repo that does not exist
    assert.ok(!/\?\?\s*"https:\/\/github\.com\/MeRezaRezaei\/ui2api-registry/.test(MIRROR),
      "src/hub/mirror.ts must not default the mirror target to the unpublished repo");
    assert.match(MIRROR, /no default community mirror/i, "and must say so by name");
  });

  t("negative: GOAL 120 — a doc claiming the registry IS live must fail (mutation proof)", () => {
    const lyingDoc = "The public package registry is the `ui2api-registry` repo (default branch `master`).";
    const truthy = /no public registry is published|not published|NOT YET PUBLISHED|does not exist/i;
    assert.ok(!truthy.test(lyingDoc), "precondition: the lying doc does not carry the truth statement");
    assert.deepEqual(docTruthViolations(lyingDoc), [], "and it introduces no repo/branch literal the code contradicts");
  });

  t("docs/ONBOARDING.md names no registry repo/branch that the code's default contradicts", () => {
    assert.deepEqual(docTruthViolations(ONBOARDING), []);
  });

  t("both docs state plainly that no public registry is published yet", () => {
    assert.ok(statesUnpublished(README), "README must state the registry is not published");
    assert.ok(statesUnpublished(ONBOARDING), "ONBOARDING must state the registry is not published");
  });

  t("both docs give the working alternative: --registry / UI2API_REGISTRY_URL + vendored capabilities/", () => {
    for (const [name, doc] of [["README.md", README], ["docs/ONBOARDING.md", ONBOARDING]] as const) {
      assert.match(doc, /--registry/, `${name} must document the --registry remedy`);
      assert.match(doc, /UI2API_REGISTRY_URL/, `${name} must document UI2API_REGISTRY_URL`);
      assert.match(doc, /capabilities\/<site/, `${name} must point at the vendored package layout`);
    }
  });

  t("MUTATION: a doc claiming a different branch on the same repo goes red", () => {
    const mutated = README.replaceAll("/ui2api-registry/master", "/ui2api-registry/main");
    assert.notEqual(mutated, README, "the mutation must actually change the doc");
    const violations = docTruthViolations(mutated);
    assert.ok(violations.length > 0, "a /main claim must violate the code's master default");
    assert.match(violations[0]!, /\/main but the code default is .*\/master/);
  });

  t("MUTATION: a doc claiming a different registry repo name goes red", () => {
    const mutated = README.replaceAll("/ui2api-registry/", "/some-other-registry/");
    assert.notEqual(mutated, README, "the mutation must actually change the doc");
    assert.ok(docTruthViolations(mutated).length > 0, "a foreign repo name must violate the contract");
  });

  t("MUTATION: a doc claiming a different owner on the registry repo goes red", () => {
    const mutated = README.replaceAll(`/${DEF_OWNER}/ui2api-registry`, "/someone-else/ui2api-registry");
    assert.notEqual(mutated, README, "the mutation must actually change the doc");
    assert.ok(docTruthViolations(mutated).length > 0, "a different owner must violate the contract");
  });

  t("MUTATION: a doc that drops the 'not published' truth is detected", () => {
    // The real docs are caught by statesUnpublished(); prove the checker bites
    // by feeding it a doc that claims a live public registry.
    const lying = "The public ui2api-registry is live; run `ui2api install --catalog`.";
    assert.equal(statesUnpublished(lying), false, "a live-registry claim must not read as 'unpublished'");
  });
});

d("GOAL 116 — the default-registry failure names the real cause and remedy", () => {
  t("a default-URL 404 says the registry is NOT published and how to supply one", async () => {
    const err = await withStubbedFetch(() =>
      fetchRegistryIndex(DEFAULT_REGISTRY_URL).then(
        () => assert.fail("expected the default registry to be unreachable"),
        (e: Error) => e
      )
    );
    assert.match(err.message, /index\.json not readable/);
    assert.match(err.message, /no public community registry is published/i);
    assert.match(err.message, /--registry/);
    assert.match(err.message, /UI2API_REGISTRY_URL/);
    assert.match(err.message, new RegExp(DEFAULT_REGISTRY_BRANCH), "must name the branch a real registry uses");
    // The old message sent readers hunting for a repo that does not exist.
    assert.doesNotMatch(err.message, /verify the registry repo is reachable/);
  });

  t("a non-default URL 404 is not blamed on 'not published' — it names the index/branch contract", async () => {
    const err = await withStubbedFetch(() =>
      fetchRegistryIndex("https://example.invalid/some-registry/master").then(
        () => assert.fail("expected an unreachable registry"),
        (e: Error) => e
      )
    );
    assert.match(err.message, /index\.json not readable/);
    assert.doesNotMatch(err.message, /no public community registry is published/i);
    assert.match(err.message, /must point at a registry that publishes index\.json/);
  });

  t("the shipped source keeps the honest-default comment (no drift back to 'PUBLIC')", () => {
    assert.match(INSTALL_SRC, /no public community registry is published/i);
    assert.doesNotMatch(INSTALL_SRC, /Fetches a per-site capability package from the PUBLIC/);
  });
});

d("GOAL 116 — the not-published claim is pinned to the 404 it is written for (hermetic: no third party's uptime)", () => {
  t("while the default registry answers 404, both docs say so — driven by a STUBBED 404, never by api.github.com", async () => {
    // The probe this replaces fetched `https://api.github.com/repos/…` and
    // tt.skip()'d on any failure. A unit test must not depend on a third
    // party's uptime, and a slow one could burn the whole 120 s FILE timeout
    // (one hung file takes the suite's signal with it — the GOAL 102 class).
    //
    // What it was really proving is a CONDITIONAL: WHILE the default registry
    // answers 404, the docs must say it is not published. A conditional is
    // testable with no network at all — drive the 404 in through the same
    // `withStubbedFetch` stub the failure-message pins use, and assert both
    // halves. The live half ("has the repo been published YET?") is a fact
    // about the world, not about this code, so it is run ON DEMAND instead:
    //
    //   curl -s -o /dev/null -w '%{http_code}\n' \
    //     "https://api.github.com/repos/${DEF_OWNER}/${DEF_REPO}"
    //
    // 404 = still unpublished, the pins above stand. 200 = the registry now
    // exists and these doc-truth pins MUST be revisited.
    const err = await withStubbedFetch(() =>
      fetchRegistryIndex(DEFAULT_REGISTRY_URL).then(
        () => assert.fail("a 404 on the code's own default URL must reject, never resolve"),
        (e: Error) => e,
      ),
    );
    assert.match(
      err.message,
      /no public community registry is published/i,
      "precondition: the code's own 404 on its default URL is what 'not published' means",
    );
    assert.ok(statesUnpublished(README), "while the default registry is 404, README must say it is not published");
    assert.ok(statesUnpublished(ONBOARDING), "while the default registry is 404, ONBOARDING must say it is not published");
  });
});
