#!/usr/bin/env node
// scripts/verify-verbatim-index.mjs
//
// Standing mechanical check for .brain/verbatim.md Index completeness (GOAL 74,
// extraction round N+41 — user verbatim 2026-09-25T14:59 "you seem to not
// extract index all verbtaims use the skill…"). Answers "did we extract+index
// ALL verbatims?" with a measured verdict instead of a claim.
//
// Verifies, bidirectionally:
//   P1  every non-machine user block has exactly one Index row (global + per-date)
//   P2  every Index row's timestamp exists among the archive's dated markers
//   P3  every row's one-line is its block's OWN words — ordered token containment
//       (token-LCS) over the block's full text, ~0.7 ratio; tolerant of the
//       arrival protocol's spelling fixes (e.g. 2026-09-25T01:00 "prent…stoping"
//       -> "prevent…stopping") and hand-curated one-lines that quote later block
//       content (the 08-29T15:20 [ERROR] line); the known hand-compressed
//       one-lines are allow-listed honestly and named — never faked
//   P4  Index rows are strictly chronological
//   P5  (--goals) every verbatim timestamp cited in .brain/verbatim-goals.md
//       resolves to a real archive block
//
// Machine-noise semantics are the archive's own fold #15 filter: pty_exited,
// SUBAGENT-STOP, goal-plugin echoes, and the continuation auto-echo get NO row.
// Exit 0 = all checks pass; exit 1 = at least one named failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const V = join(root, ".brain", "verbatim.md");
const G = join(root, ".brain", "verbatim-goals.md");
const GOALS = process.argv.includes("--goals");

// fold #15 machine-noise markers — the archive's own filter. No row for these.
const NOISE = [
  "<pty_exited>",
  "<SUBAGENT-STOP>",
  "New active goal:",
  "⚠️ Replacing active goal",
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
  "Use `/goal history`",
];

// Known hand-compressed one-lines (NOT their blocks' first words) — honest
// allow-list, named per row so a future compressed row fails LOUD until added.
const COMPRESSED = new Set([
  "2026-09-24T00:00",
  "2026-09-24T01:00",
  "2026-09-22T11:00:intent-mapped",
  "2026-09-23T11:00:intent-mapped",
]);

const text = readFileSync(V, "utf8");
const bodyStart = text.indexOf("\n## 2026-08-29");
if (bodyStart < 0) throw new Error("no `## 2026-08-29` body marker in .brain/verbatim.md");
const head = text.slice(0, bodyStart);
const body = text.slice(bodyStart);

// --- Index rows ---
const rows = [];
for (const line of head.split("\n")) {
  const m = line.match(/^\| (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}) \| ([^|]+?) \| (.*) \|$/);
  if (m) rows.push({ date: m[1], who: m[2].trim(), one: m[3].trim() });
}

// --- archive blocks (dated markers + their text) ---
const blocks = [];
{
  const markRe = /<!-- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d{3})?Z?)? -->/g;
  let cur = null;
  for (const m of body.matchAll(markRe)) {
    if (cur) cur.text = body.slice(cur.idx, m.index).trim();
    // idx = END of this marker, so block text excludes its own `<!-- … -->`
    // comment — the first line is the block's real content (noise filter and
    // the P3 own-words check depend on that).
    cur = { date: m[1], idx: m.index + m[0].length, text: "" };
    blocks.push(cur);
  }
  if (cur) cur.text = body.slice(cur.idx).trim();
}

// A block's own words, with the who-prefix line-stripped like the Index does
// (rows carry who in their own column; the one-line drops "[user] "/"[ses_x] "/"[intent-mapped] ").
const stripWho = (t) => {
  const first = t.split("\n")[0];
  const m = first.match(/^\[(user|ses_[A-Za-z0-9_]+|intent-mapped)\]\s*(.*)$/);
  return m ? m[2].replace(/\s+$/, "") + t.slice(first.length) : t;
};

const isNoise = (b) => {
  const t = b.text.trim();
  const first = t.split("\n")[0].trim();
  return NOISE.some((n) => first.startsWith(n)) || t === NOISE[4];
};

const userBlocks = blocks.filter((b) => !isNoise(b));

// --- helpers ---
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const byDate = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x.date, (m.get(x.date) || 0) + 1);
  return m;
};

const problems = [];
const rowDateSet = new Set(rows.map((r) => r.date));

// --- P1: block -> row (global + per-date counts equal) ---
// byDate reads `x.date` off its entries, so pass the OBJECT arrays — mapping to
// strings first would collapse every key to `undefined`.
const bd = byDate(userBlocks);
const rd = byDate(rows);
if (userBlocks.length !== rows.length) {
  problems.push(
    `P1 GLOBAL count mismatch: ${userBlocks.length} user blocks vs ${rows.length} rows`,
  );
}
for (const [d, n] of bd) {
  if ((rd.get(d) || 0) !== n)
    problems.push(`P1 per-date mismatch ${d}: ${n} blocks vs ${rd.get(d) || 0} rows`);
}
for (const [d, n] of rd) {
  if ((bd.get(d) || 0) !== n)
    problems.push(`P1 per-date mismatch ${d} (reverse): ${n} rows vs ${bd.get(d) || 0} blocks`);
}

// --- P2: row -> block (every row's timestamp exists among markers) ---
const allBlockDates = new Set(blocks.map((b) => b.date));
for (const r of rows) {
  if (!allBlockDates.has(r.date))
    problems.push(`P2 row ${r.date} has no dated marker in the archive body`);
}

// --- P3: row one-line is its block's OWN words (in order) ---
//     Match rows to same-date blocks in order (handles same-minute pairs like
//     the 09-22T11:00 [user]+[intent-mapped] blocks). Ordered token containment
//     over the FULL block: a row passes when almost all of its tokens occur in
//     the block's text in order — spelling fixes (01:00) and later-in-block
//     quotes (15:20 [ERROR]) pass, a row that is not the block's words fails.
{
  const tokenLcs = (a, b) => {
    const dp = Array(b.length + 1).fill(0);
    for (const x of a) {
      let prev = 0;
      for (let j = 1; j <= b.length; j++) {
        const cur = dp[j];
        dp[j] = x === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
        prev = cur;
      }
    }
    return dp[b.length];
  };
  const used = new Set();
  for (const r of rows) {
    const cands = userBlocks.filter((b) => b.date === r.date && !used.has(b.idx));
    if (cands.length === 0) {
      problems.push(`P3 row ${r.date} "${r.one.slice(0, 60)}…" has no matching user block`);
      continue;
    }
    const b = cands[0];
    used.add(b.idx);
    const key = `${r.date}:${r.who}`;
    if (COMPRESSED.has(r.date) || COMPRESSED.has(key)) continue; // allow-listed
    const rowTxt = norm(r.one.replace(/\.\.\.\s*$/, ""));
    if (rowTxt === "." || rowTxt === "") continue;
    const rowTok = rowTxt.split(" ");
    const blockTok = norm(stripWho(b.text)).split(" ");
    const ratio = tokenLcs(rowTok, blockTok) / rowTok.length;
    if (ratio < 0.7) {
      problems.push(
        `P3 row ${r.date} "${r.one.slice(0, 60)}…" is not its block's own words ` +
          `(match ${(ratio * 100).toFixed(0)}%) — block starts "${blockTok.join(" ").slice(0, 60)}…"`,
      );
    }
  }
}

// --- P4: strictly chronological order (dates non-decreasing) ---
for (let i = 1; i < rows.length; i++) {
  if (rows[i].date < rows[i - 1].date)
    problems.push(`P4 order violation at row ${i}: ${rows[i - 1].date} -> ${rows[i].date}`);
}

// --- P5: goals-index citations resolve to real archive blocks ---
let citations = 0;
if (GOALS) {
  const goalsText = readFileSync(G, "utf8");
  const citeRe = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d{3})?Z?)?/g;
  const seen = new Set();
  // Only VERBATIM citations — lines of the `- verbatim: "…" — TIMESTAMP (…)`
  // field. Event/evidence timestamps in goal entries (live-run times, commit
  // times) are NOT verbatim citations and are not expected to resolve.
  for (const line of goalsText.split("\n")) {
    if (!/^\s*-\s*verbatim:/.test(line.trimStart())) continue;
    for (const m of line.matchAll(citeRe)) {
      const d = m[1];
      if (seen.has(d)) continue;
      seen.add(d);
      citations++;
      if (!allBlockDates.has(d))
        problems.push(`P5 goals-index citation ${d} does not resolve to any archive block`);
    }
  }
}

// --- report ---
const perDate = [...bd.keys()].sort().map((d) => `${d}:${bd.get(d)}`).join(" ");
console.log(
  [
    `verify-verbatim-index: archive="${V}" (GOAL 74 / fold #26)`,
    `  blocks: ${blocks.length} dated markers (${blocks.length - userBlocks.length} noise excluded per fold #15)`,
    `  user blocks = ${userBlocks.length}  |  index rows = ${rows.length}`,
    `  per-date blocks: ${perDate}`,
    GOALS ? `  goals-index citations checked: ${citations}` : "  (pass --goals to cross-check the goals index citations)",
    problems.length ? `  FAIL — ${problems.length} problem(s):` : `  OK — all checks pass (P1..${GOALS ? "P5" : "P4"})`,
    ...problems.map((p) => `    - ${p}`),
  ].join("\n"),
);
process.exit(problems.length ? 1 : 0);