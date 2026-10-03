import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REGISTRY_BRANCH,
  DEFAULT_REGISTRY_URL,
  fetchRegistryIndex,
} from "../src/registry/install.js";

/**
 * GOAL 116 — the docs must not disagree with the registry about whether the
 * registry is published.
 *
 * ============================ WHAT WENT WRONG, MEASURED ====================
 *
 * Measured on GitLab CI (pipeline 218, job 437) and again by hand in the box
 * this file was rewritten in:
 *
 *   GET https://api.github.com/repos/MeRezaRezaei/ui2api-registry
 *     -> HTTP 200, private:false, fork:false, archived:false,
 *        pushed_at 2026-09-24T08:10:31Z, default_branch "master"
 *   GET .../ui2api-registry/master/index.json            -> HTTP 200
 *   fetchRegistryIndex(DEFAULT_REGISTRY_URL)              -> 33 entries
 *
 * So the registry IS published. The docs were corrected to say so. This file
 * went RED — and it went red for the WRONG reason, which is the whole subject
 * of the rewrite below.
 *
 * The old pins asserted a WORLD-STATE, not an AGREEMENT:
 *
 *   - `statesUnpublished()` was `assert.ok(...)`'d on README + ONBOARDING — a
 *     test that can only be true in one world. The moment the world legitimately
 *     changed, this went red and the only way to "fix" it was to delete the pin,
 *     which is how a gate dies.
 *   - the hermetic half drove a STUBBED 404 and then demanded the docs say "not
 *     published". A stub decides the premise, so it proved nothing about the
 *     world — it proved the docs match a fixture the test itself chose.
 *   - the live half read api.github.com and demanded the OPPOSITE of the same
 *     one-directional predicate, so it failed for exactly the same reason.
 *   - the claim set was hardcoded to README + ONBOARDING. docs/VISION.md made the
 *     SAME claim and was in NO set (the offline half even demanded the OPPOSITE
 *     phrasing for it), and docs/STEALTH.md was pinned by a regex that its
 *     unrelated "NOT YET PUBLISHED (npm)" sentence satisfied by accident. A doc
 *     outside the set could not fail. THAT is the coverage gap that let the drift
 *     land, and the reason this file is now derived from disk.
 *
 * ============================== THE CONTRACT NOW ============================
 *
 * The claim's truth is the WORLD's, so the world supplies it and the pins check
 * AGREEMENT, in BOTH directions:
 *
 *   HERMETIC (default `test:unit`, no network, still has teeth):
 *     1. every registry-talking doc STATES a claim  (silence is not agreement)
 *     2. no doc contradicts ITSELF
 *     3. all such docs state the SAME direction      (no hardcoded direction)
 *     4. a printed catalog-entry count is DATED `measured <YYYY-MM-DD>`
 *     5. all docs printing a count print the SAME count
 *     6. every command offered to RE-DERIVE the claim is still dispatched by
 *        src/cli.ts, and the index URL a doc curls is the code's own default
 *     7. no doc names a registry repo/branch the code's default contradicts
 *     8. the code's own 404 on its default URL still names the real cause+remedy
 *
 *   LIVE (opt-in behind UI2API_REGISTRY_LIVE=1, which CI sets):
 *     9.  every doc's direction matches what the registry actually serves
 *     10. every printed entry count equals the real `index.json` entry count
 *     11. every printed count is dated, and the date is a real calendar date
 *     12. every derivation command is still dispatched, and the branch a doc
 *         prints is the registry's real default branch
 *
 * The ONLY reason any of 1-12 can go red is "the docs and the world (or the
 * code) disagree" — which is the defect worth failing on. A world-state change
 * that the docs already reflect changes nothing here; a world-state change the
 * docs ignore goes red on the doc, not on the test.
 *
 * `test:unit` must never have its verdict decided by a third party's uptime, so
 * the network half stays OPT-IN (the same idiom as test/install.test.ts:141).
 * That is precisely why the hermetic half above has to carry the weight alone.
 *
 * ------------------------ THE SOURCE, TOO (inverted 2026-10-03) -------------
 *
 * 1-8 gate the DOCS. Two pins also gate the SOURCE, and on 2026-10-03 both of
 * them had to be INVERTED because they asserted the opposite of the truth:
 *
 *   assert.match(INSTALL_SRC, /no public community registry is published/i)
 *   assert.match(err.message,  /no public community registry is published/i)
 *
 * MEASURED that day against the default registry: `index.json` -> HTTP 200
 * (7198 bytes, 33 entries, `install --catalog` exit 0; repo API `private:false`,
 * branch `master`, pushed_at 2026-09-24). So those two pins did not merely fail
 * to catch a lie — they REQUIRED the lie to stay in the code. The one surface a
 * user actually reads when a fetch fails (the error hint) was being protected by
 * this gate while telling them to go and look for a registry that is right
 * there. A gate that pins a falsehood can only be made green by keeping the
 * falsehood, so it protects the wrong claim by construction.
 *
 * Both are now the same pin in the honest direction, and phrased as the CLASS
 * rather than the one sentence a diff happened to touch: this file's own
 * registry-anchored classifier is run over the installer and over the hint, so
 * ANY rephrasing the classifier reads as "unpublished" is refused — the old
 * wording, "has no repo behind it", "404s by design", all of them. Silence is
 * not enough (it would pass a header that only deleted the lie without adding
 * the fact), so the truth must be STATED, and stated as a dated measurement.
 *
 * The original intent of the hint test was never wrong — "must not send readers
 * hunting for a repo that does not exist" is exactly right, and it is kept. Only
 * the regex was wrong, because the corrected message names the failure that
 * actually happened instead of the registry's non-existence.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const INSTALL_SRC = read("src/registry/install.ts");
const MIRROR = read("src/hub/mirror.ts");
const CLI_SRC = read("src/cli.ts");

/** The registry repo name the code's default points at. */
const DEFAULT_REPO = /\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(DEFAULT_REGISTRY_URL)?.slice(1) ?? [];
const [DEF_OWNER, DEF_REPO, DEF_BRANCH] = DEFAULT_REPO as [string, string, string];

/** A doc token that is a FILL-IN placeholder (`<you>`, `<owner>`, `your-fork`), not a claim. */
const isPlaceholder = (s: string) => /<|YOUR_|your-fork|example/i.test(s);

// ---------------------------------------------------------------- doc set ---

export interface DocSurface {
  file: string;
  text: string;
}

/**
 * Every markdown surface a registry claim can live in, DERIVED from disk.
 *
 * A hardcoded array of three filenames is the same rot in a different shape: it
 * passes on the day VISION.md joined and fails on the day TOMORROW.md joins. The
 * audit follows the tree, so a new doc is audited the moment it lands, with no
 * edit to this file.
 */
function docSurfaces(): DocSurface[] {
  const docsDir = resolve(ROOT, "docs");
  const inDocs = existsSync(docsDir)
    ? readdirSync(docsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => `docs/${e.name}`)
    : [];
  return ["README.md", "AGENTS.md", ...inDocs]
    .filter((rel) => existsSync(resolve(ROOT, rel)))
    .sort()
    .map((file) => ({ file, text: read(file) }));
}

const DOCS = docSurfaces();

/** `src/**` files that make a registry publishedness claim, also derived. */
function srcClaimFiles(): string[] {
  const out: string[] = [];
  const walk = (absDir: string, rel: string): void => {
    for (const e of readdirSync(absDir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      const nextAbs = resolve(absDir, e.name);
      if (e.isDirectory()) walk(nextAbs, next);
      else if (e.name.endsWith(".ts") && claimsIn(`src/${next}`, read(`src/${next}`)).length > 0) out.push(`src/${next}`);
    }
  };
  walk(resolve(ROOT, "src"), "");
  return out.sort();
}

// ------------------------------------------------------- the claim itself ---

export type Direction = "published" | "unpublished";

/**
 * How each direction is WRITTEN. Both lists are registry-ANCHORED on purpose.
 *
 * The first cut of this classifier also had a bare `NOT YET PUBLISHED`, and it
 * pulled docs/STEALTH.md into the registry claim set off the back of an unrelated
 * sentence about the **npm** publish of the CLI. A gate that misreads its own
 * subject is worse than no gate, so every pattern here must name the registry and
 * then a publishedness state inside the SAME sentence. `[^.!?]` is that fence;
 * collapsing wrapped newlines first is what lets a claim that wraps across lines
 * still pair its anchor with its state.
 */
const PUBLISHEDNESS: { direction: Direction; re: RegExp }[] = [
  // published — "the public registry IS published", "the default registry is live
  // and public", "the public <repo> repo, published"
  { direction: "published", re: /\bregistry\b[^.!?]{0,90}?\bIS\s+published\b/i },
  { direction: "published", re: /\bregistry\b[^.!?]{0,90}?\bis\s+live\s+and\s+public\b/i },
  { direction: "published", re: /\bregistry\b[^.!?]{0,90}?\brepo,?\s*published\b/i },
  // not published — "no public community registry is published yet", "… has no repo
  // behind it", "there is no published community registry", the mirror's
  // "no default community mirror — none is published"
  { direction: "unpublished", re: /\bno\b[^.!?]{0,90}?\bregistry\b[^.!?]{0,90}?\bis\s+(?:yet\s+)?published\b/i },
  { direction: "unpublished", re: /\bno\b[^.!?]{0,90}?\bregistry\b[^.!?]{0,90}?\bdoes\s+not\s+exist\b/i },
  { direction: "unpublished", re: /\bno\b[^.!?]{0,90}?\bregistry\b[^.!?]{0,90}?\bno\s+repo\s+behind\s+it\b/i },
  { direction: "unpublished", re: /\bno\b[^.!?]{0,90}?\bpublished\b[^.!?]{0,40}?\bregistry\b/i },
  { direction: "unpublished", re: /\bno\b[^.!?]{0,60}?\bmirror\b[^.!?]{0,60}?\bnone\s+is\s+published\b/i },
];

export interface Claim {
  file: string;
  /** Blank-line separated paragraph index. */
  index: number;
  offset: number;
  direction: Direction;
  evidence: string;
  /** The paragraph, newlines collapsed so wrapped prose reads as one sentence. */
  paragraph: string;
}

/** Prose wraps; a wrapped sentence is one claim. */
const flatten = (p: string): string => p.replace(/\s*\n\s*/g, " ");

/**
 * A NEGATION governing a publishedness state, in the same sentence and just
 * before it. This is why `is published` cannot be a plain substring test: the
 * old wording "no public community registry IS published" contains the positive
 * phrase verbatim, and a first cut of this classifier read it as PUBLISHED —
 * which would have made the shipped docs' direction unreportable and the
 * self-contradiction detector fire on a perfectly honest sentence.
 *
 * `[^.!?]` keeps the window inside one sentence, so a negation in an earlier
 * sentence cannot veto an unrelated claim.
 */
const NEGATED_BEFORE = /(?:\bno\b|\bnot\b|\bnever\b|\bn't\b|\bunpublished\b)[^.!?]{0,60}$/i;

/** Every publishedness claim a text makes about the REGISTRY, either direction. */
export function claimsIn(file: string, text: string): Claim[] {
  const out: Claim[] = [];
  let offset = 0;
  for (const [index, para] of text.split(/\n\s*\n/).entries()) {
    const flat = flatten(para);
    for (const { direction, re } of PUBLISHEDNESS) {
      const m = re.exec(flat);
      if (!m) continue;
      // A positive state is only positive if nothing negates it in the same
      // sentence; a negative one is left alone (it already carries its own "no").
      if (direction === "published" && NEGATED_BEFORE.test(flat.slice(0, m.index))) continue;
      out.push({ file, index, offset, direction, evidence: m[0].trim().slice(0, 80), paragraph: flat });
    }
    offset += para.length + 2;
  }
  return out;
}

/**
 * A surface that TALKS ABOUT the community registry, so it is a surface the
 * claim could be stated on — and therefore must be.
 *
 * This is the anti-vacuity boundary. Requiring a claim of "the docs that make a
 * claim" would be circular (a doc stripped of its claim would drop out of the
 * set and the gate would pass). The set is therefore keyed on TOPIC, and the
 * claim is then required of every member.
 */
const REGISTRY_TOPIC = /\bui2api-registry\b|\b(?:public|community|default)\s+registry\b/i;

export interface TopicDoc {
  file: string;
  text: string;
  claims: Claim[];
}

export function registryTopicDocs(documents: DocSurface[] = DOCS): TopicDoc[] {
  return documents
    .filter((doc) => REGISTRY_TOPIC.test(doc.text))
    .map((doc) => ({ ...doc, claims: claimsIn(doc.file, doc.text) }));
}

/** Every way the topic docs can fail to AGREE, in either world state. */
export function claimViolations(topics: TopicDoc[]): string[] {
  const out: string[] = [];
  const perDoc = new Map<string, Set<Direction>>();
  for (const { file, claims } of topics) {
    if (claims.length === 0) {
      out.push(
        `${file} talks about the community registry but states NO published/not-published claim — ` +
          `silence is not agreement: a reader cannot tell which way the world is, and the live half has nothing to check`,
      );
      continue;
    }
    const dirs = new Set(claims.map((c) => c.direction));
    perDoc.set(file, dirs);
    if (dirs.size > 1) {
      out.push(
        `${file} contradicts ITSELF — it claims the registry is ${[...dirs].join(" AND ")}: ` +
          claims.map((c) => `"${c.evidence}"`).join(" | "),
      );
    }
  }
  const all = new Set<Direction>([...perDoc.values()].flatMap((s) => [...s]));
  if (all.size > 1) {
    out.push(
      `the docs disagree about whether the registry is published: ` +
        `${[...perDoc].map(([f, s]) => `${f}=${[...s].join("/")}`).join("; ")} — ` +
        `the same fact cannot be published in one doc and unpublished in another`,
    );
  }
  return out;
}

// ------------------------------------------------ count / date / re-derive ---

/**
 * Numbers a claim paragraph prints as the registry's catalog size.
 *
 * The gap between the number and the noun excludes DIGITS as well as sentence
 * punctuation, and that is load-bearing: with a digit-permitting gap,
 * "…last pushed 2026-09-24, 33 catalog entries" reads as the count `2026` and
 * "served HTTP 200 with **33** entries" reads as `200`. A count extractor that
 * reports the year is worse than one that reports nothing, because the pin above
 * it then gates on the wrong number.
 */
export function printedCounts(paragraph: string): number[] {
  return [
    ...paragraph.matchAll(/\b(\d{1,4})\b[^.!?\d]{0,24}?\b(?:catalog\s+)?entr(?:y|ies)\b/gi),
  ].map((m) => Number(m[1]));
}

/** The `measured <date>` a claim paragraph dates its world-facts with. */
export function measuredDate(paragraph: string): string | null {
  return /\bmeasured\s+(\d{4}-\d{2}-\d{2})\b/i.exec(flatten(paragraph))?.[1] ?? null;
}

/** A real calendar date, so `measured 2026-02-31` cannot pass as an audit trail. */
const isRealDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * A printed count is a WORLD-fact, so it must be dated and it must agree with
 * the other docs. An undated number cannot be audited: when it goes stale nobody
 * can tell whether it was measured and has rotted, or was never measured at all.
 */
export function countDateViolations(claims: Claim[]): string[] {
  const out: string[] = [];
  const byDoc = new Map<string, Set<number>>();
  for (const c of claims) {
    const counts = printedCounts(c.paragraph);
    if (counts.length === 0) continue;
    byDoc.set(c.file, new Set([...(byDoc.get(c.file) ?? new Set<number>()), ...counts]));
    const date = measuredDate(c.paragraph);
    if (date === null) {
      out.push(
        `${c.file} prints a registry entry count (${counts.join(", ")}) with no "measured <YYYY-MM-DD>" ` +
          `in the same claim — an undated world-fact cannot be audited`,
      );
    } else if (!isRealDate(date)) {
      out.push(`${c.file} dates its registry entry count with ${JSON.stringify(date)}, which is not a real calendar date`);
    }
  }
  const distinct = new Set([...byDoc.values()].flatMap((s) => [...s]));
  if (distinct.size > 1) {
    out.push(
      `the docs print DIFFERENT registry entry counts: ` +
        `${[...byDoc].map(([f, s]) => `${f}=${[...s].join("/")}`).join("; ")} — ` +
        `they describe one catalog, so the numbers must be re-measured together`,
    );
  }
  return out;
}

export interface Invocation {
  text: string;
  cmd: string;
  sub: string | null;
  flags: string[];
}

/**
 * `ui2api <cmd> [sub] [--flag]` / `npx tsx src/cli.ts <cmd> …` occurrences.
 *
 * Only the commands a doc offers in order to RE-DERIVE its claim are audited —
 * that is the section the claim paragraph lives in, not the whole file's command
 * list. A doc cannot offer a reader no way to check itself.
 */
export function ui2apiInvocations(section: string): Invocation[] {
  const out: Invocation[] = [];
  const re =
    /\b(?:npx\s+tsx\s+src\/cli\.ts|ui2api)\s+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?((?:[ \t]+--[a-z0-9-]+)*)/g;
  for (const m of section.matchAll(re)) {
    out.push({
      text: m[0].trim(),
      cmd: m[1]!,
      sub: m[2] ?? null,
      flags: [...(m[3] ?? "").matchAll(/--([a-z0-9-]+)/g)].map((f) => f[1]!),
    });
  }
  return out;
}

/** The body of `switch (cmd) { case "<cmd>": … }` in src/cli.ts, or null. */
function cliCaseBlock(cmd: string): string | null {
  const start = new RegExp(`^ {4}case "${cmd}":`, "m").exec(CLI_SRC);
  if (!start) return null;
  const next = /\n {4}case "/g;
  next.lastIndex = start.index + 1;
  const stop = next.exec(CLI_SRC);
  return CLI_SRC.slice(start.index, stop ? stop.index : CLI_SRC.length);
}

/**
 * Subcommands a `case` body dispatches (`arg === "x"`). A body that dispatches
 * NONE takes a POSITIONAL (`ui2api install duckduckgo`), so a bare token after
 * the command is an argument, not a renamed subcommand. Reading that difference
 * off the code is what keeps `install duckduckgo` from being reported as a
 * missing subcommand while `profile ingst` still is.
 */
function cliSubcommands(block: string): string[] {
  return [...block.matchAll(/arg === "([^"]+)"/g)].map((m) => m[1]!);
}

/** The `raw.githubusercontent.com/…/index.json` URLs a section tells the reader to fetch. */
export function indexUrlsCited(section: string): string[] {
  return [
    ...new Set(
      [...section.matchAll(/https?:\/\/raw\.githubusercontent\.com\/[^\s`'")\]]+\/index\.json/g)].map((m) => m[0]),
    ),
  ];
}

/**
 * A claim a doc offers no way to re-derive is a claim that rots un-noticed: a
 * renamed subcommand turns "check this yourself" into a command that errors while
 * the paragraph still LOOKS self-verifying. Every derivation command must still
 * be dispatched by the CLI, and the index URL a doc points at must be the code's
 * OWN default, or the reader is checking a different registry than the one the
 * CLI uses.
 */
export function derivationProblems(topics: TopicDoc[]): string[] {
  const out: string[] = [];
  for (const { file, text, claims } of topics) {
    if (claims.length === 0) continue;
    const section = sectionAround(text, claims[0]!.offset);
    for (const inv of ui2apiInvocations(section)) {
      const block = cliCaseBlock(inv.cmd);
      if (block === null) {
        out.push(
          `${file} offers \`${inv.text}\` to re-derive its registry claim, but src/cli.ts dispatches ` +
            `no \`case "${inv.cmd}"\` — the re-derivation is a command that errors, so the claim is ` +
            `unfalsifiable while looking self-verifying`,
        );
        continue;
      }
      const subs = cliSubcommands(block);
      if (inv.sub !== null && subs.length > 0 && !subs.includes(inv.sub)) {
        out.push(
          `${file} offers \`${inv.text}\`, but \`${inv.cmd}\` dispatches subcommands [${subs.join(", ")}] ` +
            `and not "${inv.sub}" — the subcommand was renamed or never existed`,
        );
      }
      for (const flag of inv.flags) {
        if (!new RegExp(`flags\\.${flag}\\b`).test(block)) {
          out.push(
            `${file} offers \`${inv.text}\`, but \`${inv.cmd}\` never reads \`--${flag}\` — ` +
              `the flag was renamed or never existed`,
          );
        }
      }
    }
    for (const url of indexUrlsCited(section)) {
      if (url !== `${DEFAULT_REGISTRY_URL}/index.json`) {
        out.push(
          `${file} tells the reader to re-derive its registry claim from ${url}, which is not the ` +
            `code's own default ${DEFAULT_REGISTRY_URL}/index.json — the reader would check a different registry`,
        );
      }
    }
  }
  return out;
}

/** The markdown section (heading-delimited) an offset falls in. */
export function sectionAround(text: string, offset: number): string {
  const heads = [...text.matchAll(/^#{1,6}\s.*$/gm)].map((m) => m.index!);
  const start = Math.max(0, ...heads.filter((h) => h < offset));
  const end = Math.min(text.length, ...heads.filter((h) => h > offset).concat([text.length]));
  return text.slice(start, end);
}

// ------------------------------------------------- doc <-> code (unchanged) ---

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

/** The doc text by file name, for the mutation proofs below. */
const TEXT_OF = new Map(DOCS.map((doc) => [doc.file, doc.text]));
const README = TEXT_OF.get("README.md") ?? "";
const ONBOARDING = TEXT_OF.get("docs/ONBOARDING.md") ?? "";
const VISION = TEXT_OF.get("docs/VISION.md") ?? "";

/** Build a topic-doc set from in-memory texts, so a mutation is audited. */
const topicsOf = (texts: Record<string, string>): TopicDoc[] =>
  registryTopicDocs(Object.entries(texts).map(([file, text]) => ({ file, text })));

// ============================================================= HERMETIC ====

d("GOAL 116 — registry doc/code truth", () => {
  t("the code's default really is the one the docs document (master, this repo name)", () => {
    assert.equal(DEF_BRANCH, DEFAULT_REGISTRY_BRANCH, "parsed branch must equal DEFAULT_REGISTRY_BRANCH");
    assert.equal(
      DEFAULT_REGISTRY_URL,
      `https://raw.githubusercontent.com/${DEF_OWNER}/${DEF_REPO}/${DEFAULT_REGISTRY_BRANCH}`,
      "DEFAULT_REGISTRY_URL must be owner/repo/DEFAULT_REGISTRY_BRANCH"
    );
  });

  t("the doc set is DERIVED from disk, and it really scanned the tree", () => {
    // Anti-vacuity for the DERIVATION itself. A `readdirSync` that returned one
    // file, or none, would make every pin below compare a set against itself.
    assert.ok(DOCS.length >= 8, `expected the README + AGENTS.md + docs/*.md scan to find a real tree; found ${DOCS.length}: ${DOCS.map((d) => d.file).join(", ")}`);
    assert.ok(DOCS.some((doc) => doc.file === "README.md"), "README.md must be in the derived set");
    assert.ok(DOCS.some((doc) => doc.file === "AGENTS.md"), "AGENTS.md must be in the derived set");
    assert.ok(
      DOCS.some((doc) => doc.file.startsWith("docs/") && doc.file.endsWith(".md")),
      "docs/*.md must be in the derived set",
    );
    for (const doc of DOCS) {
      assert.ok(doc.text.length > 0, `${doc.file} read as empty — the scan is not reading what it claims to`);
    }
  });

  t("the claim set is the docs that TALK ABOUT the registry, and it is not empty", () => {
    const topics = registryTopicDocs();
    assert.ok(
      topics.length >= 3,
      `expected at least 3 registry-talking docs in the derived set; got ${topics.length}: ${topics.map((x) => x.file).join(", ")}`,
    );
    // The GOAL 116 gap, named: VISION.md made the same claim as README and
    // ONBOARDING and used to be in NO set. It must be in the DERIVED one.
    assert.ok(
      topics.some((x) => x.file === "docs/VISION.md"),
      `docs/VISION.md states the same published/not-published claim and must be audited with the others; derived set: ${topics.map((x) => x.file).join(", ")}`,
    );
  });

  t("every registry-talking doc STATES a claim, and no doc contradicts itself (silence is not agreement)", () => {
    assert.deepEqual(
      claimViolations(registryTopicDocs()),
      [],
      "a doc that talks about the registry without saying which way the world is has no claim to check, and no reader can audit it",
    );
  });

  t("all the registry-talking docs state the SAME direction — the direction itself is NOT pinned here", () => {
    // The heart of the rewrite. This asserts AGREEMENT, not a world-state: it is
    // equally satisfied by "published" in every doc and by "not published" in
    // every doc. WHICH one is true is the live half's job, because only the world
    // can answer it. A test that pinned the direction here would go red the next
    // time the world legitimately moves, and the only "fix" would be to delete it.
    const perDoc = registryTopicDocs().map((x) => ({
      file: x.file,
      directions: [...new Set(x.claims.map((c) => c.direction))].sort(),
    }));
    for (const { file, directions } of perDoc) {
      assert.equal(
        directions.length,
        1,
        `${file} must state exactly ONE direction about the registry, got [${directions.join(", ")}]`,
      );
    }
    const distinct = new Set(perDoc.flatMap((x) => x.directions));
    assert.equal(
      distinct.size,
      1,
      `the docs must agree on one direction; got ${perDoc.map((x) => `${x.file}=${x.directions.join("/")}`).join("; ")}`,
    );
  });

  t("the classifier reads BOTH directions, not just one (a one-way predicate is what broke)", () => {
    // If the classifier only knew the old wording, a doc rewritten in the new
    // wording would read as SILENT and the anti-vacuity pin above would pass it
    // for the wrong reason. Both phrasings are asserted here, and the shipped
    // docs' own direction is reported, so the reading is visible in the output.
    const published = claimsIn("x.md", "The public community registry IS published and the CLI defaults to it.");
    const unpublished = claimsIn("x.md", "no public community registry is published yet, so install 404s by design.");
    assert.deepEqual([...new Set(published.map((c) => c.direction))], ["published"]);
    assert.deepEqual([...new Set(unpublished.map((c) => c.direction))], ["unpublished"]);
    const shipped = new Set(
      registryTopicDocs()
        .flatMap((x) => x.claims)
        .map((c) => c.direction),
    );
    assert.equal(shipped.size, 1, `the shipped docs must resolve to exactly one direction, got [${[...shipped].join(", ")}]`);
  });

  t("an npm-publish sentence is NOT a registry claim (the STEALTH.md class of misread)", () => {
    // docs/STEALTH.md says the community install loop is "NOT YET PUBLISHED" and
    // mentions `promptd /registry` — but that is a sentence about the **npm**
    // publish of the CLI, not about the registry repo. The old pin here matched
    // it by accident and passed for the wrong reason. The boundary is asserted so
    // it stays a decision rather than an accident.
    const npmLoop =
      "the community install loop, which is designed but NOT YET PUBLISHED (`npm i -g ui2api` → `ui2api install <site>` → `promptd /registry`) is live";
    assert.deepEqual(claimsIn("stealth.md", npmLoop), [], "an npm publish loop is not a registry publishedness claim");
    assert.ok(!REGISTRY_TOPIC.test(npmLoop), "and it does not put the file in the registry claim set either");
  });

  t("the docs' own truth is stated, one direction, and the shipped reading is reported", (tt) => {
    for (const { file, text, claims } of registryTopicDocs()) {
      assert.ok(claims.length > 0, `${file} must state the registry's publishedness (either direction)`);
      assert.ok(text.length > 0, `${file} must be readable`);
    }
    // The direction the shipped docs currently take, printed so a reader of a
    // red run does not have to guess which world this file last saw.
    const dir = [...new Set(registryTopicDocs().flatMap((x) => x.claims).map((c) => c.direction))][0];
    tt.diagnostic(`the shipped docs currently claim the registry is: ${dir}`);
  });

  t("no doc names a registry repo/branch that the code's default contradicts (derived over the whole set)", () => {
    for (const { file, text } of DOCS) {
      assert.deepEqual(docTruthViolations(text), [], `${file} names a registry repo/branch the code's default contradicts`);
    }
  });

  t("every doc that prints a registry entry count DATES it, and all of them print the same count", () => {
    const claims = registryTopicDocs().flatMap((x) => x.claims);
    // Non-vacuity: a set with no printed count would satisfy the date rule by
    // having nothing to date.
    assert.ok(claims.some((c) => printedCounts(c.paragraph).length > 0), "precondition: at least one doc prints a catalog-entry count");
    assert.deepEqual(
      countDateViolations(claims),
      [],
      "a printed count is a world-fact: it must carry `measured <YYYY-MM-DD>` and agree across the docs",
    );
  });

  t("every command a doc offers to RE-DERIVE its registry claim is still dispatched by src/cli.ts", () => {
    const topics = registryTopicDocs();
    // Non-vacuity: the audit must have actually FOUND derivation commands, or
    // "every command is dispatched" is vacuously true of an empty set.
    const cited = topics.flatMap((x) =>
      ui2apiInvocations(sectionAround(x.text, x.claims[0]!.offset)),
    );
    assert.ok(
      cited.length >= 3,
      `expected each claim doc to offer re-derivation commands; found ${cited.length}: ${cited.map((c) => c.text).join(" | ")}`,
    );
    assert.ok(
      topics.some((x) => indexUrlsCited(sectionAround(x.text, x.claims[0]!.offset)).length > 0),
      "precondition: at least one claim doc points at an index.json URL to re-derive against",
    );
    assert.deepEqual(
      derivationProblems(topics),
      [],
      "a claim whose re-derivation command no longer exists is unfalsifiable while looking self-verifying",
    );
  });

  t("the hub mirror must not default to a repo that does not exist, and must say so by name", () => {
    // GOAL 120. Kept as the CODE-side contract: the mirror's own text is what
    // refuses a bare publish, and it is not a doc claim about the world.
    assert.ok(
      !/\?\?\s*"https:\/\/github\.com\/MeRezaRezaei\/ui2api-registry/.test(MIRROR),
      "src/hub/mirror.ts must not default the mirror target to the unpublished repo",
    );
    assert.match(MIRROR, /no default community mirror/i, "and must say so by name");
  });

  t("the shipped source STATES the default registry is published, and never calls it an unpublished placeholder", (tt) => {
    // INVERTED 2026-10-03 — and the inversion IS the fix, so it is worth saying
    // why. This used to read
    //   `assert.match(INSTALL_SRC, /no public community registry is published/i)`
    // i.e. it required `src/registry/install.ts` to KEEP asserting something
    // false. The world had already moved (MEASURED 2026-10-03: default registry
    // HTTP 200, 7198 bytes, 33 entries, `install --catalog` exit 0; repo API
    // `private:false`, branch `master`), so the pin had exactly one way to stay
    // green: keep the lie. That is what made this file blind — it was the gate
    // for registry truth, and it was defending a falsehood.
    //
    // Phrased as the CLASS, not as the literal the sibling's diff deleted: the
    // classifier below (`claimsIn`) is this file's own registry-anchored
    // publishedness reader, so ANY rephrasing it reads as "unpublished" is
    // refused — the old wording, "has no repo behind it", "404s by design" —
    // rather than one string someone chose to delete.
    const claims = claimsIn("src/registry/install.ts", INSTALL_SRC);
    assert.deepEqual(
      claims.filter((c) => c.direction === "unpublished").map((c) => c.evidence),
      [],
      "src/registry/install.ts must not claim the default registry is unpublished / has no repo behind it — " +
        "it is published and served, and this file's whole subject is that class of claim",
    );
    // Non-vacuity, and the reason a bare `doesNotMatch` would be worthless here:
    // "no false claim" is also satisfied by SAYING NOTHING, which leaves the next
    // reader of the installer's header unable to tell published from unpublished.
    assert.ok(
      claims.some((c) => c.direction === "published"),
      `precondition: the installer must STATE that the default registry is published, not merely stop denying it; ` +
        `its claims were ${JSON.stringify(claims.map((c) => [c.direction, c.evidence]))}`,
    );
    // …and the stated fact must be AUDITABLE, on the same terms the docs' own
    // printed counts are (`measured <YYYY-MM-DD>`, enforced by countDateViolations
    // above). A source comment asserting a world-state with no measurement is a
    // world-state that rots silently — which is what the deleted fiction was.
    assert.match(
      INSTALL_SRC,
      /\bmeasured\s+\d{4}-\d{2}-\d{2}\b/i,
      "the installer's publishedness claim must carry the `measured <YYYY-MM-DD>` it was measured on",
    );
    tt.diagnostic(
      `installer's registry claim: ${claims.map((c) => `${c.direction} ("${c.evidence}")`).join("; ") || "NONE"}`,
    );
    // Unchanged from before the inversion, and still a real gate: the old header
    // described a per-site fetch as coming "from the PUBLIC" registry, which the
    // modern <name>/<version>.json mirror layout made wrong. Do not drift back.
    assert.doesNotMatch(INSTALL_SRC, /Fetches a per-site capability package from the PUBLIC/);
  });

  t("the code files that make a registry claim are ENUMERATED from disk, and each is classified", (tt) => {
    // The code surface is derived too, so a NEW src file carrying the claim is
    // counted rather than invisible. Its direction is deliberately NOT folded
    // into the docs' world-agreement: `src/registry/install.ts` states the claim
    // in its header + fetch-error text and `src/hub/mirror.ts` in its refusal
    // text, and both are contracts about what the code SAYS — the code's runtime
    // behaviour is checked against the world by the live half below. What this
    // pin holds is that the enumeration is live and every hit classifies cleanly.
    //
    // The mirror's stale world-claim was FIXED 2026-10-03, and this test is part of
    // why it is load-bearing rather than cosmetic: `mirror.ts` used to justify
    // itself with "there is NO published community registry", which read as
    // `unpublished` and would have tripped this loop's `dirs.size === 1` rule
    // beside the installer's `published`. It now states the real fact — the
    // registry IS published and public (measured 2026-09-24: index.json HTTP 200,
    // 33 entries, `private:false`, branch `master`) — and keeps the invariant that
    // actually holds, "NO default WRITE target", which the mirror pin above gates.
    //
    // So the mirror still yields exactly ONE claim, direction `published`
    // (MEASURED over this classifier, evidence "registry itself is published"), and
    // is NOT dropped from `srcClaimFiles()` — the assertion below is satisfied as
    // written. This note exists to stop the next well-meaning reword: phrasing the
    // mirror so it states no publishedness claim at all would remove it from the
    // derived set, silently switch off the `dirs.size === 1` rule for that file,
    // and quietly invalidate the `files.includes("src/hub/mirror.ts")` line right
    // below. If that wording ever does change, the derived set is the thing to
    // re-measure — not this comment's prediction.
    const files = srcClaimFiles();
    assert.ok(
      files.includes("src/registry/install.ts") && files.includes("src/hub/mirror.ts"),
      `the derived src claim set must contain the two files that carry the claim; got ${JSON.stringify(files)}`,
    );
    for (const f of files) {
      const dirs = new Set(claimsIn(f, read(f)).map((c) => c.direction));
      assert.equal(
        dirs.size,
        1,
        `${f} makes a registry claim in BOTH directions; it must state one: [${[...dirs].join(", ")}]`,
      );
    }
    tt.diagnostic(
      `src files making a registry publishedness claim: ${files
        .map((f) => `${f}=${[...new Set(claimsIn(f, read(f)).map((c) => c.direction))].join("/")}`)
        .join(", ")}`,
    );
  });

  t("MUTATION: a doc claiming the registry IS live is a claim, and carries no repo/branch literal the code contradicts", () => {
    const lyingDoc = "The public package registry is the `ui2api-registry` repo (default branch `master`).";
    assert.deepEqual(docTruthViolations(lyingDoc), [], "and it introduces no repo/branch literal the code contradicts");
    // It states nothing about the world, so it is not a claim at all — which is
    // exactly the failure the anti-vacuity pin reports when a real doc does this.
    assert.deepEqual(claimsIn("README.md", lyingDoc), [], "a doc that names a repo but never says whether it is published states no claim");
    assert.match(
      claimViolations(topicsOf({ "README.md": lyingDoc }))[0] ?? "",
      /states NO published\/not-published claim/,
      "and the gate must name that as the defect, not pass it",
    );
  });

  t("MUTATION: a doc whose direction is FLIPPED is reported as a disagreement", () => {
    const flipped = README.replace(
      "**The default registry is live and public**",
      "**The default registry is not up: no public community registry is published**",
    );
    assert.notEqual(flipped, README, "the mutation must actually change the doc");
    const topics = topicsOf({
      "README.md": flipped,
      "docs/ONBOARDING.md": ONBOARDING,
      "docs/VISION.md": VISION,
    });
    assert.deepEqual(
      [...new Set(topics.flatMap((x) => x.claims).map((c) => c.direction))].sort(),
      ["published", "unpublished"],
      "precondition: the mutation really flips one doc to the other direction",
    );
    // Flipping one doc's direction legitimately trips TWO rules, and both are true:
    // the corpus no longer agrees, AND the flipped doc now contradicts ITSELF (it
    // carries the "live and public" wording elsewhere). This test used to demand
    // exactly one violation, which is a false constraint — it would have taught a
    // future maintainer to suppress the self-contradiction rule to keep a count.
    // Assert the rule that must fire, not the number of rules that fire.
    const v = claimViolations(topics);
    const disagree = v.filter((x) => /the docs disagree about whether the registry is published/.test(x));
    assert.equal(disagree.length, 1, `the corpus-disagreement rule must fire exactly once; got ${JSON.stringify(v)}`);
    assert.match(disagree[0]!, /README\.md=/, "the flipped doc must be NAMED in the disagreement (it reports published/unpublished because the same doc still carries the opposite wording elsewhere)");
  });

  t("MUTATION: a doc STRIPPED of its claim is reported (the anti-vacuity proof)", () => {
    const stripped = README.replace("**The default registry is live and public**", "**The default registry**");
    assert.notEqual(stripped, README, "the mutation must actually change the doc");
    const topics = topicsOf({ "README.md": stripped, "docs/ONBOARDING.md": ONBOARDING, "docs/VISION.md": VISION });
    const strippedClaims = topics.find((x) => x.file === "README.md")!;
    assert.equal(REGISTRY_TOPIC.test(stripped), true, "precondition: it still TALKS about the registry, so it is still in the set");
    assert.deepEqual(
      claimViolations(topics),
      [`README.md talks about the community registry but states NO published/not-published claim — silence is not agreement: a reader cannot tell which way the world is, and the live half has nothing to check`],
      "a doc stripped of its claim must be named, not silently dropped from the audit",
    );
    assert.equal(strippedClaims.claims.length, 0, "precondition: the stripped doc has no claim left to check");
  });

  t("MUTATION: a doc that PRINTS A DIFFERENT count is reported, and an UNDATED count is reported", () => {
    // The whole point of the count rule is CROSS-doc, so every mutation below is
    // measured against the REAL sibling docs — a lone mutated doc would have
    // nothing to disagree with, and "one doc printing 31" is not a defect.
    const siblings = { "docs/ONBOARDING.md": ONBOARDING, "docs/VISION.md": VISION };

    const wrongCount = README.replace("33 catalog entries", "31 catalog entries");
    assert.notEqual(wrongCount, README, "the count mutation must actually change the doc");
    assert.deepEqual(printedCounts(claimsIn("README.md", wrongCount)[0]!.paragraph), [31], "precondition: the mutation really changed the printed count");
    const wrong = countDateViolations(topicsOf({ "README.md": wrongCount, ...siblings }).flatMap((x) => x.claims));
    assert.ok(
      wrong.some((v) => /the docs print DIFFERENT registry entry counts: README\.md=31/.test(v)),
      `a count that disagrees with the other docs must be named; got ${JSON.stringify(wrong)}`,
    );

    const undated = README.replace(" (measured 2026-09-27)", "");
    assert.notEqual(undated, README, "the date mutation must actually change the doc");
    const undatedOut = countDateViolations(topicsOf({ "README.md": undated, ...siblings }).flatMap((x) => x.claims));
    assert.ok(
      undatedOut.some((v) => /prints a registry entry count \(33\) with no "measured <YYYY-MM-DD>"/.test(v)),
      `a count with no measured date must be named; got ${JSON.stringify(undatedOut)}`,
    );
    // A fake date is not an audit trail either.
    const fakeDate = countDateViolations(
      topicsOf({ "README.md": README.replace("2026-09-27", "2026-02-31"), ...siblings }).flatMap((x) => x.claims),
    );
    assert.ok(
      fakeDate.some((v) => /not a real calendar date/.test(v)),
      `a non-calendar measured date must be named; got ${JSON.stringify(fakeDate)}`,
    );
  });

  t("MUTATION: a DEAD derivation command (renamed subcommand / flag) is reported", () => {
    const dead = README.replace("ui2api install --catalog", "ui2api install --catlog");
    assert.notEqual(dead, README, "the derivation mutation must actually change the doc");
    const problems = derivationProblems(topicsOf({ "README.md": dead, "docs/ONBOARDING.md": ONBOARDING, "docs/VISION.md": VISION }));
    assert.ok(
      problems.some((p) => /never reads `--catlog`/.test(p)),
      `a renamed flag in a re-derivation command must be named; got ${JSON.stringify(problems)}`,
    );
    // And a command the CLI does not dispatch at all.
    const ghost = README.replace("ui2api install --catalog", "ui2api instal --catalog");
    assert.notEqual(ghost, README, "the ghost-command mutation must actually change the doc");
    assert.ok(
      derivationProblems(topicsOf({ "README.md": ghost, "docs/ONBOARDING.md": ONBOARDING, "docs/VISION.md": VISION })).some((p) =>
        /dispatches no `case "instal"`/.test(p),
      ),
      "a subcommand the CLI does not dispatch at all must be named",
    );
    // And a re-derivation pointed at a DIFFERENT registry than the CLI uses.
    const wrongRegistry = README.replace(
      `${DEFAULT_REGISTRY_URL}/index.json`,
      "https://raw.githubusercontent.com/MeRezaRezaei/ui2api-registry/main/index.json",
    );
    assert.notEqual(wrongRegistry, README, "the registry-URL mutation must actually change the doc");
    assert.ok(
      derivationProblems(topicsOf({ "README.md": wrongRegistry, "docs/ONBOARDING.md": ONBOARDING, "docs/VISION.md": VISION })).some(
        (p) => /is not the code's own default/.test(p),
      ),
      "a re-derivation aimed at a different registry must be named",
    );
  });

  t("MUTATION: a NEW doc joins the audit the moment it lands (the derivation is not a frozen list)", () => {
    // Nothing on disk was added: the point is that the classifier + violation
    // report take a FILE, so a doc that did not exist when this file was written
    // is audited with the same teeth the moment it exists.
    const fresh = "A brand new doc.\n\nThe public community registry IS published (measured 2026-09-27), 33 catalog entries.\n";
    const topics = topicsOf({ "docs/NEW-SITE.md": fresh });
    assert.deepEqual(claimViolations(topics), [], "a new doc whose claim agrees passes without this file being edited");
    const stripped = "A brand new doc.\n\nThe public community registry is the one to use.\n";
    assert.match(
      claimViolations(topicsOf({ "docs/NEW-SITE.md": stripped }))[0] ?? "",
      /states NO published\/not-published claim/,
      "and a new doc that talks about the registry without stating the claim fails with no edit to this file",
    );
    const flipped = "The public community registry IS published. Also no public community registry is published.\n";
    assert.match(
      claimViolations(topicsOf({ "docs/NEW-SITE.md": flipped }))[0] ?? "",
      /contradicts ITSELF/,
      "and a new doc that contradicts itself is named, too",
    );
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

  t("both docs give the working alternative: --registry / UI2API_REGISTRY_URL + vendored capabilities/", () => {
    for (const { file, text } of registryTopicDocs()) {
      assert.match(text, /--registry/, `${file} must document the --registry remedy`);
      assert.match(text, /UI2API_REGISTRY_URL/, `${file} must document UI2API_REGISTRY_URL`);
      assert.match(text, /capabilities\/<site/, `${file} must point at the vendored package layout`);
    }
    // The two the GOAL 116 original named, kept explicitly so the floor cannot be
    // met by accident by some other doc.
    for (const [name, doc] of [["README.md", README], ["docs/ONBOARDING.md", ONBOARDING]] as const) {
      assert.match(doc, /--registry/, `${name} must document the --registry remedy`);
      assert.match(doc, /UI2API_REGISTRY_URL/, `${name} must document UI2API_REGISTRY_URL`);
      assert.match(doc, /capabilities\/<site/, `${name} must point at the vendored package layout`);
    }
  });
});

d("GOAL 116 — the default-registry failure names the real cause and remedy", () => {
  t("a default-URL fetch failure names a REAL cause and the escape hatch, and never blames non-existence", async () => {
    const err = await withStubbedFetch(() =>
      fetchRegistryIndex(DEFAULT_REGISTRY_URL).then(
        () => assert.fail("expected the default registry to be unreachable"),
        (e: Error) => e
      )
    );
    assert.match(err.message, /index\.json not readable/);
    // THE INTENT THIS TEST WAS WRITTEN FOR IS UNCHANGED, and it is the reason the
    // test exists at all: a user must not be sent hunting for a repo that does not
    // exist. What was wrong was the REGEX — it `assert.match`ed the exact false
    // wording ("no public community registry is published"), so correcting the
    // source's lie turned the gate RED. The protected behaviour is now asserted
    // against the corrected message.
    //
    // First, as the CLASS: the classifier reads the hint itself for a
    // publishedness claim, so any rephrasing a reader would take as "the registry
    // is not there" fails — not only the literal that was deleted.
    assert.deepEqual(
      claimsIn("default-hint", err.message).filter((c) => c.direction === "unpublished").map((c) => c.evidence),
      [],
      "the default-URL hint must not claim the registry is unpublished — a failed FETCH is not evidence of non-existence",
    );
    // …then the named hunting trips, spelled out rather than left to the
    // classifier's coverage: each of these is a sentence this gate once shipped.
    for (const trip of [
      /no public community registry is published/i,
      /has no repo behind it/i,
      /404s? by design/i,
      /unreachable by design/i,
      /intentional placeholder/i,
      /\bdoes not exist\b/i,
      /verify the registry repo is reachable/i,
    ]) {
      assert.doesNotMatch(err.message, trip, `the default-URL hint must not say ${trip} — that is the hunting trip`);
    }
    // A hint that names no cause and no remedy is not honest, it is merely
    // shorter, so the OTHER half is asserted positively: the user must be told
    // what actually happened and what they can do about it.
    assert.match(err.message, /\bfetch\b/i, "must say the FETCH failed — that is the fact it can see");
    assert.match(
      err.message,
      /(offline|dns|proxy|connectivity)/i,
      "must name a connectivity cause (offline / DNS / proxy) — the most common real one",
    );
    assert.match(err.message, /(5xx|rate limit)/i, "must name an upstream 5xx or rate limit as a possible cause");
    assert.match(err.message, /non-JSON/i, "must name a non-JSON body as a possible cause");
    // The escape hatch, if it is offered at all, has to still be the real one.
    assert.match(err.message, /--registry/);
    assert.match(err.message, /UI2API_REGISTRY_URL/);
    assert.match(err.message, new RegExp(DEFAULT_REGISTRY_BRANCH), "must name the branch a real registry uses");
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

  t("the code's default-URL failure text is what the docs' remedy names (the two agree offline)", async () => {
    // Hermetic bridge between the code's error and the docs' escape hatch: the
    // message names `--registry`, `UI2API_REGISTRY_URL` and `capabilities/<site>`,
    // and every claim doc must offer exactly those three. No world-fact here, so
    // it belongs in the default run.
    const err = await withStubbedFetch(() =>
      fetchRegistryIndex(DEFAULT_REGISTRY_URL).then(
        () => assert.fail("expected the default registry to be unreachable"),
        (e: Error) => e
      )
    );
    for (const remedy of ["--registry", "UI2API_REGISTRY_URL", "capabilities/<site"]) {
      assert.ok(err.message.includes(remedy), `precondition: the code's own error must name ${remedy}`);
    }
    for (const { file, text } of registryTopicDocs()) {
      for (const remedy of ["--registry", "UI2API_REGISTRY_URL", "capabilities/<site"]) {
        assert.ok(text.includes(remedy), `${file} must offer the remedy the code's error names: ${remedy}`);
      }
    }
  });
});

// ================================================================== LIVE ====

/**
 * The world, measured ONCE per run and only when the knob is on.
 *
 * Two independent facts, because the docs make two claims and one probe cannot
 * answer both:
 *   - `repoStatus`/`isPrivate`/`defaultBranch` come from the GitHub repo API.
 *     This is the only thing that measures the word **public**: a private repo
 *     serves `index.json` perfectly well to an authenticated caller, so a green
 *     `index.json` alone would NOT prove the docs' "public registry" claim.
 *   - `entries`/`reviewed` come from the CODE's own installer, so the entry
 *     count is compared against exactly the thing `ui2api install --catalog`
 *     prints — not against a re-implementation of it.
 *
 * `private: false` and the default branch are pinned because they are part of
 * the CLAIM. The docs' "last pushed" line is deliberately NOT pinned: it moves
 * on any commit to the registry repo without changing the claim, so gating on it
 * would be the snapshot-of-the-world mistake this file exists to stop.
 */
interface World {
  repoStatus: number;
  isPrivate: boolean | null;
  defaultBranch: string | null;
  indexOk: boolean;
  entries: number;
  reviewed: number;
}

async function measureWorld(): Promise<World> {
  const res = await fetch(`https://api.github.com/repos/${DEF_OWNER}/${DEF_REPO}`, {
    headers: { "user-agent": "ui2api-registry-doc-truth" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = res.ok
    ? ((await res.json()) as { private?: boolean; default_branch?: string })
    : null;
  const index = await fetchRegistryIndex(DEFAULT_REGISTRY_URL).then(
    (i) => ({
      indexOk: true,
      entries: Object.keys(i).length,
      reviewed: Object.values(i).filter((e) => e.trust === "reviewed").length,
    }),
    () => ({ indexOk: false, entries: -1, reviewed: -1 })
  );
  return {
    repoStatus: res.status,
    isPrivate: body?.private ?? null,
    defaultBranch: body?.default_branch ?? null,
    ...index,
  };
}

let worldCache: Promise<World> | undefined;
const world = (): Promise<World> => (worldCache ??= measureWorld());

/** Every doc's claim, resolved against a measured world. */
function directionMismatches(w: World): string[] {
  const published = w.repoStatus === 200 && w.isPrivate === false && w.indexOk;
  const out: string[] = [];
  for (const { file, claims } of registryTopicDocs()) {
    for (const c of claims) {
      if (c.direction === (published ? "published" : "unpublished")) continue;
      out.push(
        `${file} says the registry is "${c.direction}" ("${c.evidence}"), but MEASURED: ` +
          `GET api.github.com/repos/${DEF_OWNER}/${DEF_REPO} -> HTTP ${w.repoStatus} (private: ${w.isPrivate}), ` +
          `and ${DEFAULT_REGISTRY_URL}/index.json ${w.indexOk ? `serves ${w.entries} entries` : "does NOT resolve"} ` +
          `— so it IS ${published ? "published" : "not published"}. Rewrite the DOC; the pin is the agreement, not a snapshot.`
      );
    }
  }
  return out;
}

d("GOAL 116 — the registry claim, checked against the world (opt-in; UI2API_REGISTRY_LIVE=1)", () => {
  // Skipped (not failed, not silently passed) when the knob is unset, exactly
  // like test/install.test.ts:141 — so `npm run test:unit` can never have its
  // verdict decided by a third party's uptime, while CI (which sets the knob) can
  // MACHINE-CHECK the "published yet?" fact instead of eyeballing a curl.
  t(
    "LIVE: every claiming doc's direction matches what the registry actually serves (opt-in; UI2API_REGISTRY_LIVE=1)",
    { skip: process.env.UI2API_REGISTRY_LIVE !== "1" },
    async (tt) => {
      const w = await world();
      tt.diagnostic(
        `MEASURED: api.github.com/repos/${DEF_OWNER}/${DEF_REPO} -> HTTP ${w.repoStatus} private=${w.isPrivate} ` +
          `default_branch=${w.defaultBranch}; ${DEFAULT_REGISTRY_URL}/index.json ${w.indexOk ? `-> ${w.entries} entries (${w.reviewed} reviewed)` : "-> unreadable"}`
      );
      const mismatches = directionMismatches(w);
      assert.deepEqual(
        mismatches,
        [],
        `${mismatches.length} doc claim(s) disagree with the world. A doc that outlives the registry is a lie; the doc is what gets fixed.`
      );
      // The world must have been MEASURED, not defaulted: a probe that silently
      // failed would report "unpublished" and quietly pass a stale "published".
      assert.ok(
        w.repoStatus > 0 && (w.indexOk ? w.entries > 0 : w.repoStatus !== 200),
        `the world probe returned nothing usable (repo HTTP ${w.repoStatus}, indexOk ${w.indexOk}) — this pin proved nothing`
      );
    }
  );

  t(
    "LIVE: every entry count a doc prints equals the real index.json entry count (opt-in; UI2API_REGISTRY_LIVE=1)",
    { skip: process.env.UI2API_REGISTRY_LIVE !== "1" },
    async () => {
      const w = await world();
      if (!w.indexOk) {
        assert.fail(
          `${DEFAULT_REGISTRY_URL}/index.json did not resolve, so the docs' printed entry counts cannot be checked at all — measure the world first`
        );
      }
      const printed = registryTopicDocs()
        .flatMap((x) => x.claims)
        .map((c) => ({ file: c.file, counts: printedCounts(c.paragraph) }))
        .filter((x) => x.counts.length > 0);
      assert.ok(printed.length > 0, "precondition: at least one doc prints a catalog-entry count");
      const stale = printed.filter((x) => x.counts.some((n) => n !== w.entries));
      assert.deepEqual(
        stale.map((x) => `${x.file} prints ${x.counts.join("/")}`),
        [],
        `index.json really carries ${w.entries} entries; re-measure the doc and re-date it with the new measurement`
      );
    }
  );

  t(
    "LIVE: every printed count carries a real `measured <date>`, and the docs still agree with each other (opt-in; UI2API_REGISTRY_LIVE=1)",
    { skip: process.env.UI2API_REGISTRY_LIVE !== "1" },
    async () => {
      await world(); // the world is what makes a printed count meaningful at all
      const claims = registryTopicDocs().flatMap((x) => x.claims);
      const dated = claims
        .filter((c) => printedCounts(c.paragraph).length > 0)
        .map((c) => ({ file: c.file, date: measuredDate(c.paragraph) }));
      assert.ok(dated.length > 0, "precondition: at least one doc prints a count");
      for (const { file, date } of dated) {
        assert.notEqual(date, null, `${file} prints a world-fact with no \`measured <date>\` to audit it against`);
      }
      assert.deepEqual(countDateViolations(claims), []);
    }
  );

  t(
    "LIVE: the branch and visibility the docs print are the registry's real ones, and every re-derivation still works (opt-in; UI2API_REGISTRY_LIVE=1)",
    { skip: process.env.UI2API_REGISTRY_LIVE !== "1" },
    async () => {
      const w = await world();
      if (w.repoStatus !== 200) {
        assert.fail(`could not read the registry repo (HTTP ${w.repoStatus}) — the branch/visibility claims cannot be checked`);
      }
      const printedBranches = registryTopicDocs()
        .flatMap((x) => x.claims)
        .map((c) => ({ file: c.file, branch: /\bdefault\s+branch\b[^.!?]{0,24}?`([A-Za-z0-9._-]+)`/i.exec(c.paragraph)?.[1] }))
        .filter((x): x is { file: string; branch: string } => x.branch !== undefined);
      assert.ok(printedBranches.length > 0, "precondition: at least one doc prints the registry's default branch");
      for (const { file, branch } of printedBranches) {
        assert.equal(
          branch,
          w.defaultBranch,
          `${file} says the registry's default branch is \`${branch}\`; the repo says ${JSON.stringify(w.defaultBranch)}`
        );
        assert.equal(branch, DEFAULT_REGISTRY_BRANCH, `and the code's DEFAULT_REGISTRY_BRANCH is ${DEFAULT_REGISTRY_BRANCH}`);
      }
      // "public" is a claim about visibility, not about index.json being readable.
      for (const { file, text } of registryTopicDocs()) {
        if (!/`private:\s*(?:true|false)`/i.test(text)) continue;
        const claimed = /`private:\s*(true|false)`/i.exec(text)![1] === "true";
        assert.equal(
          claimed,
          w.isPrivate,
          `${file} prints \`private: ${claimed}\`; the repo answers private: ${w.isPrivate}`
        );
      }
      // Re-derivation commands: re-checked here so the live lane proves the
      // escape hatch is real, not just internally consistent.
      assert.deepEqual(derivationProblems(registryTopicDocs()), []);
    }
  );
});
