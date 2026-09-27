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
//
// Unlike COMPRESSED above, this list is NOT a defect exemption: it is the
// archive's own specification of which blocks are machine output, so it is
// deliberately NOT liveness-gated (a noise string that matches nothing today is
// still the right rule for tomorrow's archive) and it is deliberately NOT given a
// size budget (a legitimate new machine-output shape must be addable).
//
// What IS bounded is the blast radius. `isNoise` below is PREFIX-based, so a real
// user block that happened to BEGIN with one of these strings would be dropped from
// the completeness count with no row, no problem, and no signal — a silently
// understated total. test/scripts-compressed-budget.test.ts pins the four machine
// CLASSES this filter is allowed to catch (a `<…>` tool tag, the two goal-plugin
// echoes, the continuation auto-echo) against the real archive, so a human sentence
// caught by the filter FAILS LOUD. The residual risk it cannot remove — a user who
// literally opens a block with the words "New active goal:" — is stated there.
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
//
// This list is a data-quality EXEMPTION over the P3 own-words check, and every
// entry weakens exactly that check. It is also the one suppression in this file
// that could grow without limit, so it carries a size budget and a per-entry
// neededness probe, both owned by test/scripts-compressed-budget.test.ts:
//
//   * BUDGET: the set may not exceed COMPRESSED_BUDGET entries (measured 1 on
//     2026-09-27). The budget is the current value, not a round number above it,
//     so the list cannot grow by one "harmless" entry.
//   * NEEDEDNESS: each entry must still suppress a REAL P3 violation. The probe
//     neutralises one entry at a time in a copy of THIS file, re-runs it against
//     the real archive, and requires a new P3 problem naming a row that entry
//     covers. An entry that suppresses nothing FAILS LOUD, because a suppression
//     that suppresses nothing is debt with a comment on it.
//
// Raising the budget, or adding an entry that is not needed, is a DELIBERATE act
// that the gate will name. Nothing here is a suggestion the gate can route around.
const COMPRESSED_BUDGET = 1; // measured size on 2026-09-27 after the 3 obsolete entries were removed; the ceiling, not a target
// 3 of the original 4 entries were proved OBSOLETE and removed, not tolerated:
// with each neutralised, P3's own-words ratio is 75%, 92% and 100% against a 70%
// threshold, so the rows they excused now pass on their own words. The gate proved
// it end-to-end (neutralise the entry, re-run the real verifier, diff the problems),
// because P3's ratio depends on the row->block pairing walk and a second
// reimplementation of that walk could disagree with the gate and rot unnoticed.
const COMPRESSED = new Set([
  "2026-09-24T00:00",
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

// noise-class-probe: anchor — the exclusion seam the NOISE false-positive probe in
// test/scripts-compressed-budget.test.ts instruments (it re-derives the excluded set
// through THIS expression, not through a second copy of the rule). If this line
// moves, that probe fails LOUD rather than silently measuring nothing.
const userBlocks = blocks.filter((b) => !isNoise(b));

// --- helpers ---
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const byDate = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x.date, (m.get(x.date) || 0) + 1);
  return m;
};

const problems = [];

// --- P6: the COMPRESSED allow-list stays inside its budget ---
// The set is a data-quality exemption over P3, so its size is a live liability:
// every entry weakens the own-words proof. The budget is the MEASURED size, so
// the list cannot grow by one entry that "looks harmless". Shrinking is always
// allowed (a fixed violation should drop its exemption); growing is not.
if (COMPRESSED.size > COMPRESSED_BUDGET) {
  problems.push(
    `P6 COMPRESSED allow-list has grown past its budget: ${COMPRESSED.size} entries ` +
      `> COMPRESSED_BUDGET ${COMPRESSED_BUDGET} — each entry is an exemption from the P3 own-words check, ` +
      `so a fifth one is a fifth hole. Fix the row's one-line to be its block's own words instead; ` +
      `if a row genuinely cannot be, raise the budget DELIBERATELY and say why.`,
  );
}
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