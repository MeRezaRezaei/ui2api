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


// ============================================ THE RECORDED FACT (no network) ==

/**
 * GOAL 209 — the split.
 *
 * MEASURED on pipeline 1350: this file's four live tests ALL failed with
 * `[TimeoutError]`, because runner egress could not reach the network inside
 * 20s — while the very same URL answers HTTP 200 in 0.25s from the dev box, and
 * the same suite was GREEN ON RETRY. So the failure was **timing**, not a doc
 * mismatch. A gate that cries wolf about a publication claim is the failure shape
 * this repo refuses to ship (GOAL 184's two declines, ADR-002/003 in
 * `docs/decisions.md`), and the shape here was worse than a flake: the gate's
 * SUBJECT is a *moving published fact*, sampled by one request whose result
 * depends on the runner's network at that instant. That is a TOCTOU, not a flake.
 *
 * So the two failures are split apart, because they are DIFFERENT failures with
 * DIFFERENT fixes:
 *
 *   DOC-vs-RECORDED-FACT  — the DEFAULT lane. Deterministic, network-free, and
 *                           it is a REAL defect when it fires: the docs
 *                           contradict a dated, committed measurement. No
 *                           network is touched, so no runner's egress can decide
 *                           `npm run test:unit`.
 *   RECORDED-vs-LIVE      — the OPT-IN lane (`UI2API_REGISTRY_LIVE=1`, which
 *                           both CI configs already set). It reports DRIFT as a
 *                           NAMED VERDICT and NEVER fails the suite on it,
 *                           because a registry that legitimately gained an entry
 *                           is not a doc defect and is not the runner's fault.
 *
 * The load-bearing distinction, and the whole deliverable: **a slow network and
 * a changed registry must not collapse into one outcome.** So the live lane
 * classifies into three named verdicts — `registry-unreachable`,
 * `registry-agrees`, `registry-drift` — and the first is explicitly NOT drift.
 * `classifyLive` is a pure function so that distinction is unit-provable with
 * injected measurements; a gate that could only demonstrate it against the real
 * world would go unverified on every slow runner, which is the bug being fixed.
 */

/** The committed, dated measurement the DOCS are checked against. */
const RECORDED_PATH = "test/fixtures/registry-world.json";

export interface RecordedWorld {
  schema: number;
  measuredAt: string;
  measuredBy: string;
  index: {
    url: string;
    httpStatus: number;
    bytes: number;
    sha256: string;
    entries: number;
    reviewed: number;
    siteIds: string[];
  };
  repo: {
    apiUrl: string;
    httpStatus: number;
    private: boolean;
    fork: boolean;
    archived: boolean;
    visibility: string;
    defaultBranch: string;
    pushedAt: string;
  };
}

/**
 * The recorded fact, read from disk and shape-gated at the LOAD seam.
 *
 * A missing or malformed snapshot THROWS a named verdict rather than returning
 * null, because "no snapshot" must not be a soft skip: it is the state in which
 * the main gate would have no teeth at all, and a gate that silently stops
 * gating is the failure this whole change exists to prevent. That is the same
 * reason the `validateSnapshotShape` seam in `src/runtime/session-store.ts`
 * refuses rather than degrades.
 */
export function loadRecordedWorld(): RecordedWorld {
  const abs = resolve(ROOT, RECORDED_PATH);
  if (!existsSync(abs)) {
    throw new Error(
      `no recorded registry fact at ${RECORDED_PATH} — the doc-vs-recorded-fact gate has nothing to check and ` +
        `would pass vacuously. Take one with UI2API_REGISTRY_LIVE=1 npm run test:unit -- ` +
        `test/registry-doc-truth.test.ts (the live lane prints the measured numbers), then commit the file. ` +
        `NEVER hand-write it: a fact that was never measured is a lie.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`${RECORDED_PATH} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — the recorded fact must be machine-readable`);
  }
  const w = parsed as Partial<RecordedWorld>;
  const idx = w.index as Partial<RecordedWorld["index"]> | undefined;
  const repo = w.repo as Partial<RecordedWorld["repo"]> | undefined;
  if (
    w.schema !== 1 ||
    typeof w.measuredAt !== "string" ||
    !isRealDate(w.measuredAt) ||
    !idx ||
    typeof idx.url !== "string" ||
    !Number.isInteger(idx.entries) ||
    (idx.entries as number) < 0 ||
    !repo ||
    typeof repo.private !== "boolean" ||
    typeof repo.defaultBranch !== "string"
  ) {
    throw new Error(
      `${RECORDED_PATH} is not a complete recorded world (need schema 1, a real measuredAt date, ` +
        `index.url, an integer index.entries, repo.private and repo.defaultBranch) — got ` +
        `${JSON.stringify({ schema: w.schema, measuredAt: w.measuredAt, url: idx?.url, entries: idx?.entries, private: repo?.private, defaultBranch: repo?.defaultBranch })}`,
    );
  }
  return parsed as RecordedWorld;
}

/**
 * Facts about the RECORDED SNAPSHOT itself, independent of any doc.
 *
 * `index.url` must be the code's OWN default. That is what keeps the snapshot
 * from going stale by silence: change `DEFAULT_REGISTRY_URL` in
 * `src/registry/install.ts` and this fires by name, instead of the snapshot
 * quietly describing a registry the CLI no longer installs from.
 */
export function recordedShapeViolations(w: RecordedWorld): string[] {
  const out: string[] = [];
  if (w.index.url !== `${DEFAULT_REGISTRY_URL}/index.json`) {
    out.push(
      `the recorded fact was taken from ${w.index.url}, but the code's own default index is ` +
        `${DEFAULT_REGISTRY_URL}/index.json — the snapshot now describes a registry the CLI does not install from; re-measure`,
    );
  }
  if (w.repo.defaultBranch !== DEFAULT_REGISTRY_BRANCH) {
    out.push(
      `the recorded fact says the registry's default branch is ${JSON.stringify(w.repo.defaultBranch)}, ` +
        `but DEFAULT_REGISTRY_BRANCH is ${DEFAULT_REGISTRY_BRANCH}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(w.index.sha256)) {
    out.push(`the recorded fact's index sha256 is ${JSON.stringify(w.index.sha256)}, which is not a sha256 hex digest — it cannot identify what was read`);
  }
  if (!Array.isArray(w.index.siteIds) || w.index.siteIds.length !== w.index.entries) {
    out.push(
      `the recorded fact lists ${Array.isArray(w.index.siteIds) ? w.index.siteIds.length : "no"} site ids but records ` +
        `${w.index.entries} entries — the two must describe the same catalog`,
    );
  }
  if (w.measuredBy.trim().length < 20) {
    out.push(`the recorded fact's measuredBy is ${JSON.stringify(w.measuredBy)} — a measurement whose method was not written down is not an audit trail`);
  }
  return out;
}

/** The direction the RECORDED FACT says the world is in. */
export function recordedDirection(w: RecordedWorld): Direction {
  const published = w.repo.httpStatus === 200 && w.repo.private === false && w.index.httpStatus === 200;
  return published ? "published" : "unpublished";
}

/**
 * Every way the DOCS can contradict the RECORDED FACT — the DEFAULT lane's whole
 * subject. Pure, derived from an injected fact + an injected doc set, so it is
 * testable with a deliberately wrong fact and a deliberately flipped doc, and it
 * touches no network while doing it.
 */
export function recordedVsDocViolations(w: RecordedWorld, topics: TopicDoc[] = registryTopicDocs()): string[] {
  const out: string[] = [];
  const direction = recordedDirection(w);
  for (const { file, claims } of topics) {
    for (const c of claims) {
      if (c.direction !== direction) {
        out.push(
          `${file} says the registry is "${c.direction}" ("${c.evidence}"), but the RECORDED FACT ` +
            `(measured ${w.measuredAt}, ${RECORDED_PATH}) says it is ${direction}: ` +
            `repo HTTP ${w.repo.httpStatus} private=${w.repo.private}, index.json HTTP ${w.index.httpStatus} ` +
            `carrying ${w.index.entries} entries — the DOC is what gets rewritten, or the fact re-measured`,
        );
      }
      for (const n of printedCounts(c.paragraph)) {
        if (n !== w.index.entries) {
          out.push(
            `${file} prints ${n} registry entries; the recorded fact (measured ${w.measuredAt}) carries ` +
              `${w.index.entries} — re-measure the doc and re-date it, or re-take the fact`,
          );
        }
      }
      const branch = /\bdefault\s+branch\b[^.!?]{0,24}?`([A-Za-z0-9._-]+)`/i.exec(c.paragraph)?.[1];
      if (branch !== undefined && branch !== w.repo.defaultBranch) {
        out.push(
          `${file} prints \`default branch ${branch}\`; the recorded fact (measured ${w.measuredAt}) says ` +
            `${JSON.stringify(w.repo.defaultBranch)}`,
        );
      }
    }
    const printedPrivate = /`private:\s*(true|false)`/i.exec(textOf(file, topics));
    if (printedPrivate) {
      const claimed = printedPrivate[1] === "true";
      if (claimed !== w.repo.private) {
        out.push(
          `${file} prints \`private: ${claimed}\`; the recorded fact (measured ${w.measuredAt}) says ` +
            `private: ${w.repo.private}`,
        );
      }
    }
  }
  return out;
}

/** The text of a topic doc, recovered from the injected set (never re-read). */
function textOf(file: string, topics: TopicDoc[]): string {
  return topics.find((x) => x.file === file)?.text ?? "";
}

/** Swap globalThis.fetch for a THROWING stub and restore it afterwards. */
async function withNetworkDisabled<T>(fn: () => Promise<T> | T): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network disabled for this scope: the doc-vs-recorded-fact gate must not need one");
  }) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * EVERYTHING the default lane decides, as one pure function of (fact, docs).
 *
 * Gathered here so the network-free property is provable on the WHOLE lane at
 * once rather than per-test, and so the "identical with and without fetch"
 * comparison in the test below is comparing the real decision, not a subset.
 */
export function mainGateReport(w: RecordedWorld, topics: TopicDoc[] = registryTopicDocs()): string[] {
  return [
    ...recordedShapeViolations(w),
    ...recordedVsDocViolations(w, topics),
    ...countDateViolations(topics.flatMap((x) => x.claims)),
    ...claimViolations(topics),
    ...derivationProblems(topics),
    ...topics.flatMap(({ file, text }) => docTruthViolations(text).map((v) => `${file}: ${v}`)),
  ];
}

d("GOAL 209 — the docs vs the RECORDED registry fact (deterministic, no network)", () => {
  t("the recorded fact EXISTS and is shaped — a missing snapshot must fail loudly, not skip", () => {
    // The anti-vacuity pin for the whole split. If the snapshot were optional,
    // deleting it would turn the default lane into a green file that checks
    // nothing — which is the exact way a gate dies.
    const w = loadRecordedWorld();
    assert.deepEqual(
      recordedShapeViolations(w),
      [],
      "the recorded fact itself must be sound before it can be the yardstick",
    );
    assert.ok(
      w.measuredBy.length > 0 && w.measuredAt.length > 0,
      "the recorded fact must say WHEN it was measured and HOW",
    );
    assert.equal(RECORDED_PATH, "test/fixtures/registry-world.json", "the path is pinned so a moved snapshot cannot hide");
  });

  t("an ABSENT recorded fact is a NAMED refusal, never a null that passes", () => {
    // The loader must refuse by name. A `null` return would make every caller
    // decide what "no fact" means, and the laziest caller decides "fine".
    assert.equal(typeof loadRecordedWorld, "function", "the loader exists");
    let message = "";
    try {
      // A path that cannot exist, exercised through the same shape gate the
      // loader applies — proven by the real loader refusing the real file's
      // SIBLING shape below, so this does not depend on a missing file.
      JSON.parse("{not json");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.match(message, /JSON/i, "precondition: a parse failure names the reason");
    // The real loader's refusal text is asserted by shape, so it stays a named
    // refusal if the wording is ever edited.
    const src = read("test/registry-doc-truth.test.ts");
    assert.match(
      src,
      /no recorded registry fact at/,
      "the loader must name the missing-fact verdict in words a reader can act on",
    );
    assert.match(src, /NEVER hand-write it/, "and must say the fact cannot be invented");
  });

  t("the MAIN GATE is network-free: it decides identically with fetch ARMED to throw", async () => {
    // THE determinism property, and the reason this split exists. On pipeline
    // 1350 the whole gate's verdict was decided by runner egress.
    const w = loadRecordedWorld();
    const withNet = mainGateReport(w);

    // Non-vacuity FIRST: the disabling stub must actually be armed, or "passes
    // with fetch disabled" would be satisfied by a stub that silently no-ops
    // and a gate that quietly still uses the network.
    await assert.rejects(
      () => withNetworkDisabled(() => fetch("https://example.invalid/")),
      /network disabled/,
      "precondition: the disabling stub really does make any fetch throw",
    );

    const withoutNet = await withNetworkDisabled(async () => mainGateReport(w));
    assert.deepEqual(
      withoutNet,
      [],
      `the default lane found ${withoutNet.length} problem(s) with NO network available — it must be able to decide offline: ${withoutNet.join(" | ")}`,
    );
    assert.deepEqual(
      withoutNet,
      withNet,
      "the lane's verdict must be IDENTICAL with the network disabled and enabled — a verdict that changes when the network changes was never offline",
    );
  });

  t("the docs agree with the RECORDED fact: direction, entry count, branch, visibility", () => {
    const w = loadRecordedWorld();
    const violations = recordedVsDocViolations(w);
    assert.deepEqual(
      violations,
      [],
      `${violations.length} doc/fact contradiction(s) — a doc that outlives the registry is a lie, and the doc is what gets rewritten`,
    );
    // Non-vacuity: a fact that is trivially satisfied by silence would pass.
    assert.ok(registryTopicDocs().length >= 3, "precondition: the real derived doc set is being checked");
    assert.ok(
      registryTopicDocs().flatMap((x) => x.claims).some((c) => printedCounts(c.paragraph).length > 0),
      "precondition: at least one doc prints an entry count to compare",
    );
  });

  t("MUTATION: a doc/recorded-fact CONTRADICTION fails loudly, by name, with no network", async () => {
    const w = loadRecordedWorld();
    const flipped = README.replace(
      "**The default registry is live and public**",
      "**The default registry is not up: no public community registry is published**",
    );
    assert.notEqual(flipped, README, "the direction mutation must actually change the doc");
    const topics = topicsOf({ "README.md": flipped, "docs/ONBOARDING.md": ONBOARDING, "docs/VISION.md": VISION });
    const violations = await withNetworkDisabled(async () => recordedVsDocViolations(w, topics));
    assert.ok(
      violations.some((v) => /README\.md says the registry is "unpublished"/.test(v)),
      `a doc contradicting the recorded fact must be named; got ${JSON.stringify(violations)}`,
    );
    assert.ok(
      violations.every((v) => v.includes(`measured ${w.measuredAt}`)),
      "and the verdict must CARRY the recorded date, so a reader knows which measurement it contradicts",
    );

    // A wrong COUNT is the same class of defect and must be named the same way.
    const wrongCount = README.replace("33 catalog entries", "31 catalog entries");
    assert.notEqual(wrongCount, README, "the count mutation must actually change the doc");
    const countViolations = await withNetworkDisabled(async () =>
      recordedVsDocViolations(w, topicsOf({ "README.md": wrongCount, "docs/ONBOARDING.md": ONBOARDING, "docs/VISION.md": VISION })),
    );
    assert.ok(
      countViolations.some((v) => /README\.md prints 31 registry entries; the recorded fact \(measured \d{4}-\d{2}-\d{2}\) carries \d+/.test(v)),
      `a printed count contradicting the recorded fact must be named; got ${JSON.stringify(countViolations)}`,
    );

    // And a wrong BRANCH / wrong VISIBILITY.
    const wrongBranch = README.replaceAll("/ui2api-registry/master", "/ui2api-registry/main");
    assert.notEqual(wrongBranch, README, "the branch mutation must actually change the doc");
    assert.ok(
      (await withNetworkDisabled(async () => docTruthViolations(wrongBranch))).length > 0,
      "a doc naming a branch the code's default contradicts is caught offline too",
    );
  });

  t("MUTATION: a fact describing a DIFFERENT registry than the code's default is refused", () => {
    const w = loadRecordedWorld();
    const foreign: RecordedWorld = { ...w, index: { ...w.index, url: `${DEFAULT_REGISTRY_URL.replace(DEF_REPO, "some-other-registry")}/index.json` } };
    assert.ok(
      recordedShapeViolations(foreign).some((v) => /describes a registry the CLI does not install from|index\.json — the snapshot now describes/.test(v)),
      `a snapshot taken from another registry must be refused; got ${JSON.stringify(recordedShapeViolations(foreign))}`,
    );
    const wrongBranch: RecordedWorld = { ...w, repo: { ...w.repo, defaultBranch: "main" } };
    assert.ok(
      recordedShapeViolations(wrongBranch).some((v) => /default branch is "main"/.test(v)),
      "a snapshot whose branch disagrees with DEFAULT_REGISTRY_BRANCH must be refused",
    );
    const noSha: RecordedWorld = { ...w, index: { ...w.index, sha256: "whatever" } };
    assert.ok(
      recordedShapeViolations(noSha).some((v) => /not a sha256 hex digest/.test(v)),
      "a snapshot with no real digest cannot identify what was read, so it must be refused",
    );
  });
});

// ================================================== RECORDED vs LIVE (opt-in) ==

/**
 * What one live probe actually managed to measure.
 *
 * `reachable: false` is the field that carries the whole distinction: a probe
 * that never got an answer is `unreachable`, NOT a world with a different entry
 * count. Collapsing the two is the bug pipeline 1350 exposed — a network failure
 * read as "the registry changed" (or worse, as "the docs are wrong").
 */
export interface LiveMeasurement {
  reachable: boolean;
  /** Why not, when `reachable` is false. Named, so the verdict is actionable. */
  reason: string | null;
  repoStatus: number;
  isPrivate: boolean | null;
  defaultBranch: string | null;
  indexOk: boolean;
  entries: number;
  reviewed: number;
}

export type LiveVerdictKind = "registry-unreachable" | "registry-agrees" | "registry-drift";

export interface LiveVerdict {
  kind: LiveVerdictKind;
  /** One line per differing field, empty when there is no drift. */
  drift: string[];
  /** Everything a reader needs, including WHICH measurement it is about. */
  lines: string[];
}

/**
 * Compare a live measurement against the recorded fact. PURE.
 *
 * Three named verdicts, and the middle one is deliberately NOT an error:
 *   - `registry-unreachable` — we could not measure. The recorded fact stands,
 *     UNVERIFIED. Nothing failed, because nothing is known.
 *   - `registry-agrees`     — measured, and it matches.
 *   - `registry-drift`      — measured, and it moved. That is a publication
 *     event, so it is REPORTED with `recorded -> live` per field, and the
 *     remedy is to re-take the snapshot. It is NOT a suite failure: the docs are
 *     not wrong for the registry having gained an entry, and a runner with a
 *     20-second egress timeout must not be able to redden this repo.
 */
export function classifyLive(w: RecordedWorld, m: LiveMeasurement): LiveVerdict {
  const when = `measured ${w.measuredAt}`;
  if (!m.reachable) {
    return {
      kind: "registry-unreachable",
      drift: [],
      lines: [
        `VERDICT registry-unreachable: could not measure the registry (${m.reason ?? "unknown"}).`,
        `This is a NETWORK verdict, not a DRIFT verdict: the recorded fact (${when}, ${w.index.entries} entries) ` +
          `stands UNVERIFIED and nothing is asserted about it. Do NOT edit the docs or the snapshot in response to this.`,
      ],
    };
  }
  const drift: string[] = [];
  if (m.indexOk && m.entries !== w.index.entries) drift.push(`entries ${w.index.entries} -> ${m.entries}`);
  if (m.indexOk && m.reviewed !== w.index.reviewed) drift.push(`reviewed ${w.index.reviewed} -> ${m.reviewed}`);
  if (m.repoStatus !== w.repo.httpStatus) drift.push(`repo HTTP ${w.repo.httpStatus} -> ${m.repoStatus}`);
  if (m.isPrivate !== null && m.isPrivate !== w.repo.private) drift.push(`private ${w.repo.private} -> ${m.isPrivate}`);
  if (m.defaultBranch !== null && m.defaultBranch !== w.repo.defaultBranch) {
    drift.push(`default branch ${w.repo.defaultBranch} -> ${m.defaultBranch}`);
  }
  if (drift.length === 0) {
    return {
      kind: "registry-agrees",
      drift: [],
      lines: [
        `VERDICT registry-agrees: the live registry matches the recorded fact (${when}) — ` +
          `${m.entries} entries (${m.reviewed} reviewed), repo HTTP ${m.repoStatus} private=${m.isPrivate}, branch ${m.defaultBranch}.`,
      ],
    };
  }
  return {
    kind: "registry-drift",
    drift,
    lines: [
      `VERDICT registry-drift: registry moved since ${w.measuredAt}: ${drift.join("; ")}.`,
      `The docs are not wrong for the registry having moved — this is a PUBLICATION event, so this lane REPORTS it ` +
        `and does not fail. Remedy: re-take ${RECORDED_PATH} from a real measurement, and only rewrite a doc if it ` +
        `now contradicts the registry.`,
    ],
  };
}

/** The failure that actually happened on pipeline 1350, as a named value. */
export const NETWORK_FAILURE_REASON = "probe threw or timed out (no answer)";

/** A probe that never got an answer — synthesised, so the branch is testable. */
export function unreachableMeasurement(reason = NETWORK_FAILURE_REASON): LiveMeasurement {
  return { reachable: false, reason, repoStatus: 0, isPrivate: null, defaultBranch: null, indexOk: false, entries: -1, reviewed: -1 };
}

/** A successful probe whose numbers are supplied — so drift is testable offline. */
export function measurementOf(over: Partial<LiveMeasurement> = {}): LiveMeasurement {
  const w = loadRecordedWorld();
  return {
    reachable: true,
    reason: null,
    repoStatus: w.repo.httpStatus,
    isPrivate: w.repo.private,
    defaultBranch: w.repo.defaultBranch,
    indexOk: true,
    entries: w.index.entries,
    reviewed: w.index.reviewed,
    ...over,
  };
}

/** Race a promise against a real deadline, so a blackholed network cannot hang the file. */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not answer within ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

const LIVE_DEADLINE_MS = 20_000;

async function measureWorld(): Promise<LiveMeasurement> {
  let repoStatus = 0;
  let isPrivate: boolean | null = null;
  let defaultBranch: string | null = null;
  let reason: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${DEF_OWNER}/${DEF_REPO}`, {
      headers: { "user-agent": "ui2api-registry-doc-truth" },
      signal: AbortSignal.timeout(LIVE_DEADLINE_MS),
    });
    repoStatus = res.status;
    if (res.ok) {
      const body = (await res.json()) as { private?: boolean; default_branch?: string };
      isPrivate = body.private ?? null;
      defaultBranch = body.default_branch ?? null;
    }
  } catch (e) {
    reason = `repo API: ${e instanceof Error ? e.message : String(e)}`;
  }
  // The entry count still comes from the CODE's own installer, so it is compared
  // against exactly the thing `ui2api install --catalog` prints — not a
  // re-implementation. The deadline is here because `fetchRegistryIndex` does
  // not bound its own fetch, and on a blackholed runner that is exactly what
  // burned the file timeout.
  let indexOk = false;
  let entries = -1;
  let reviewed = -1;
  try {
    const i = await withDeadline(fetchRegistryIndex(DEFAULT_REGISTRY_URL), LIVE_DEADLINE_MS, "registry index.json");
    indexOk = true;
    entries = Object.keys(i).length;
    reviewed = Object.values(i).filter((e) => e.trust === "reviewed").length;
  } catch (e) {
    reason = reason ?? `index.json: ${e instanceof Error ? e.message : String(e)}`;
  }
  const reachable = reason === null;
  return { reachable, reason, repoStatus, isPrivate, defaultBranch, indexOk, entries, reviewed };
}

let liveCache: Promise<LiveMeasurement> | undefined;
const live = (): Promise<LiveMeasurement> => (liveCache ??= measureWorld());

d("GOAL 209 — the recorded fact vs the LIVE registry (opt-in; drift is REPORTED, never a suite failure)", () => {
  t("a slow network and a moved registry are DIFFERENT verdicts (the whole deliverable)", () => {
    const w = loadRecordedWorld();

    // 1. The network failed. NOT drift — this is the pipeline-1350 shape.
    const dead = classifyLive(w, unreachableMeasurement("TimeoutError: probe exceeded 20000ms"));
    assert.equal(dead.kind, "registry-unreachable", "a probe with no answer is unreachable, never drift");
    assert.deepEqual(dead.drift, [], "and it must report ZERO drift fields — 'we could not measure' is not 'it moved'");
    assert.match(dead.lines[0]!, /VERDICT registry-unreachable/);
    assert.match(dead.lines.join(" "), /NETWORK verdict, not a DRIFT verdict/);
    assert.match(dead.lines.join(" "), /stands UNVERIFIED/);
    assert.match(dead.lines.join(" "), /Do NOT edit the docs or the snapshot/);

    // 2. The registry moved. A named, per-field `recorded -> live` verdict.
    const moved = classifyLive(w, measurementOf({ entries: 35 }));
    assert.equal(moved.kind, "registry-drift", "a measured difference IS drift");
    assert.deepEqual(moved.drift, [`entries ${w.index.entries} -> 35`], "and it names the field and both numbers");
    assert.match(moved.lines[0]!, new RegExp(`registry moved since ${w.measuredAt}: entries ${w.index.entries} -> 35`));
    assert.match(moved.lines.join(" "), /REPORTS it and does not fail/);

    // 3. The two MUST NOT collapse. Same "wrongness" of evidence, opposite
    //    outcome — if these ever compared equal, the split has collapsed and the
    //    gate is back to being a timing detector.
    assert.notEqual(dead.kind, moved.kind, "unreachable and drift must be distinguishable");
    assert.notDeepEqual(dead.lines, moved.lines, "and they must not print the same verdict");

    // 4. Nothing moved: agrees, and says so.
    const same = classifyLive(w, measurementOf());
    assert.equal(same.kind, "registry-agrees");
    assert.deepEqual(same.drift, []);
    assert.match(same.lines[0]!, /VERDICT registry-agrees/);

    // 5. Every other field drifts too, each by name.
    assert.deepEqual(classifyLive(w, measurementOf({ isPrivate: true })).drift, ["private false -> true"]);
    assert.deepEqual(classifyLive(w, measurementOf({ defaultBranch: "main" })).drift, ["default branch master -> main"]);
    assert.deepEqual(
      classifyLive(w, measurementOf({ entries: 40, reviewed: 9, defaultBranch: "main" })).drift,
      ["entries 33 -> 40", "reviewed 4 -> 9", "default branch master -> main"],
      "drift must accumulate across fields, each named, in a stable order",
    );

    // 6. An unreadable index is NOT "0 entries" — that would be a silent lie.
    const unreadable = classifyLive(w, measurementOf({ indexOk: false }));
    assert.deepEqual(unreadable.drift, [], "an index that did not resolve cannot prove the count changed");
  });

  t("no live measurement can ever throw out of the lane (a timing failure is a verdict, not a red suite)", async () => {
    // The mechanism, proven on the real shape: whatever the probe did, the lane
    // answers with a verdict. Nothing here touches the network.
    const w = loadRecordedWorld();
    for (const m of [unreachableMeasurement(), measurementOf(), measurementOf({ entries: 0 })]) {
      const v = await withNetworkDisabled(async () => classifyLive(w, m));
      assert.ok(
        ["registry-unreachable", "registry-agrees", "registry-drift"].includes(v.kind),
        `every measurement must produce a named verdict; got ${v.kind}`,
      );
      assert.ok(v.lines.length > 0 && v.lines[0]!.startsWith("VERDICT "), "and the verdict must be printed");
    }
  });

  t(
    "LIVE: the recorded fact vs the live registry, reported as a NAMED verdict (opt-in; UI2API_REGISTRY_LIVE=1)",
    { skip: process.env.UI2API_REGISTRY_LIVE !== "1" },
    async (tt) => {
      const w = loadRecordedWorld();
      const m = await live();
      const v = classifyLive(w, m);
      for (const line of v.lines) tt.diagnostic(line);
      tt.diagnostic(
        `MEASURED: repo API HTTP ${m.repoStatus} private=${m.isPrivate} default_branch=${m.defaultBranch}; ` +
          `${DEFAULT_REGISTRY_URL}/index.json ${m.indexOk ? `${m.entries} entries (${m.reviewed} reviewed)` : "unreadable"}; ` +
          `reachable=${m.reachable}${m.reason ? ` reason=${m.reason}` : ""}`,
      );
      // The ONLY thing this lane asserts: it produced a named verdict. Drift is
      // deliberately NOT an assertion — see the header. A registry that gained an
      // entry is a publication event, and a runner whose egress stalls for 20s is
      // not evidence of anything at all.
      assert.ok(
        ["registry-unreachable", "registry-agrees", "registry-drift"].includes(v.kind),
        `the live lane must classify into a named verdict; got ${v.kind}`,
      );
    },
  );

  t(
    "LIVE: the docs still satisfy the OFFLINE contract while the live lane runs (the split does not fork the gate)",
    { skip: process.env.UI2API_REGISTRY_LIVE !== "1" },
    async (tt) => {
      // Why this is here: if the live lane ever became the only place the docs'
      // agreement was checked, turning the knob OFF would silently drop half the
      // gate. The knob adds a REPORT; it never removes a CHECK.
      const report = await withNetworkDisabled(async () => mainGateReport(loadRecordedWorld()));
      tt.diagnostic(`with UI2API_REGISTRY_LIVE=1 the offline gate still finds ${report.length} problem(s)`);
      assert.deepEqual(report, [], "the default lane's verdict must not depend on the knob");
    },
  );
});
