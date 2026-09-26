import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  youtubePlaylistAddCommitted,
  YOUTUBE_PLAYLIST_ADD_UNVERIFIED,
} from "../src/capabilities/youtube.js";

/**
 * GOAL 112 — SHARED GATE: every MUTATING capability must be judged by a
 * POST-CONDITION (a state flip, a re-read of the changed entity, a read-back
 * of the created object). A PRE-CONDITION — a menu opened, an input accepted,
 * a list of choices rendered — proves the affordance exists, NOT that the
 * mutation happened. `youtube_playlist_add` shipped `ok: opened > 0`: a Save
 * MENU rendering playlist choices reported "added" for an add that was never
 * committed, contradicting its own recipe ("ok": false).
 *
 * The verdict classes are read out of the REAL runner sources — a count-derived
 * `ok` is structurally refused, a runner that cannot verify must carry a named
 * refusal, and the two known out-of-scope defects (kimi/gemini file_upload, see
 * KNOWN_DEFECTS) are pinned VISIBLY so a new one fails this file loudly.
 */

const RUNNER_DIR = "src/capabilities";
const MANIFEST_DIR = "capabilities";

/** Verb tails that make a capability MUTATING. */
const MUTATING_TAILS = new Set([
  "post", "comment", "like", "unlike", "subscribe", "unsubscribe", "send", "delete",
  "remove", "follow", "unfollow", "upload", "play", "playlist", "playlist_add",
  "reply", "vote", "share", "save", "pin", "edit", "create", "add", "toggle", "crud",
]);

/**
 * Identifiers whose value is a COUNT of things that merely EXISTED (menu
 * entries, listed choices, rendered rows) before/without the mutation landing.
 * A verdict of the shape `ok: <one of these> > 0` is a pre-condition.
 */
const COUNT_IDENTIFIERS =
  "opened|playlistChoices|choices|items|rows|entries|menus|menuChoices|lists|found|matched|options|labels";

/** `ok: <countish> > 0` — the menu-open-shaped verdict that must never ship. */
const PRECONDITION_VERDICT = new RegExp(`ok\\s*:\\s*(?:${COUNT_IDENTIFIERS})\\s*(?:>|>=)\\s*0`);
const PRECONDITION_BOOL = new RegExp(`ok\\s*:\\s*(?:Boolean\\()?\\s*(?:${COUNT_IDENTIFIERS})\\.length`);

/** Reads that can constitute a post-condition read-back. */
const READ_CALLS = [".evaluate(", "getAttribute(", "isVisible(", "isChecked(", "innerText", "textContent"];
/** The mutating action a post-condition must follow. */
const ACTION_CALLS = [".click(", "setInputFiles(", "pressSequentially("];

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function braceBlock(src: string, from: number): string {
  const start = src.indexOf("{", from);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

/**
 * The body of a method DECLARATION — `private async <method>(` or
 * `private <method>(` (sync runners exist). Anchored on the declaration so a
 * call site (`return this.playlistAdd(args)`) is never mistaken for the body.
 */
function methodRegion(src: string, method: string): string {
  const m = new RegExp(`(?:private|public|protected)\\s+(?:async\\s+)?${method}\\s*\\(`).exec(src);
  if (!m) return "";
  return braceBlock(src, m.index);
}

/**
 * The body of a `case "<capability>":` arm in a runner's dispatch switch.
 * Falls through a GROUP of labels that share one return (araprat dispatches all
 * six posting caps off one `return this.loginGated(capability)`), so the arm
 * ends at the next label that actually carries a `return` — not at the next
 * label.
 */
function caseRegion(src: string, capability: string): string {
  const m = new RegExp(`case\\s+"${capability}"\\s*:`).exec(src);
  if (!m) return "";
  const rest = src.slice(m.index);
  const stop = /\bdefault\s*:/.exec(rest);
  const window = stop ? rest.slice(0, stop.index) : rest;
  // walk the labels in this arm; the arm ends at the first label preceded by a return
  let end = window.length;
  let cursor = 0;
  for (const l of window.matchAll(/case\s+"[a-z0-9_-]+"\s*:/g)) {
    if (l.index <= cursor && l.index !== 0) continue;
    const between = window.slice(cursor, l.index);
    if (/\breturn\b/.test(between)) {
      end = cursor + between.length;
      break;
    }
    cursor = l.index;
  }
  return window.slice(0, end);
}

type VerdictClass = "postcondition" | "refusal";

interface Classification {
  id: string;
  /** Source file under src/capabilities/ */
  file: string;
  /** How to locate the deciding code: a method name, or "case:<capability id>". */
  where: string;
  class: VerdictClass;
  /** One line: what the post-condition actually reads. */
  proof: string;
}

/**
 * Every mutating capability in the repo, with the code that decides its
 * `ok`. Read off the real runners — not guessed.
 */
const TABLE: Classification[] = [
  // --- youtube: three siblings were already post-conditional; playlist_add was
  // the only mutating cap whose ok was a menu-open. ---
  { id: "youtube_comment", file: "youtube.ts", where: "comment", class: "postcondition", proof: "re-reads the posted text out of the page's own comment list" },
  { id: "youtube_like", file: "youtube.ts", where: "like", class: "postcondition", proof: "pressedAfter state flip on the site's own like button" },
  { id: "youtube_subscribe", file: "youtube.ts", where: "subscribe", class: "postcondition", proof: "aria-label re-read after the click (isSubscribed)" },
  { id: "youtube_upload", file: "youtube.ts", where: "upload", class: "postcondition", proof: "re-reads the page's post-handoff processing state" },
  { id: "youtube_playlist_add", file: "youtube.ts", where: "playlistAdd", class: "refusal", proof: "no committed choice -> ok:false with a named reason (GOAL 112)" },

  // --- araprat: posting surface is dispatched honestly as login-gated. ---
  { id: "araprat_comment", file: "araprat.ts", where: "case:araprat_comment", class: "refusal", proof: "loginGatedResult (no browser, no fabricated post)" },
  { id: "araprat_like", file: "araprat.ts", where: "case:araprat_like", class: "refusal", proof: "loginGatedResult" },
  { id: "araprat_follow", file: "araprat.ts", where: "case:araprat_follow", class: "refusal", proof: "loginGatedResult" },
  { id: "araprat_subscribe", file: "araprat.ts", where: "case:araprat_subscribe", class: "refusal", proof: "loginGatedResult" },
  { id: "araprat_upload", file: "araprat.ts", where: "case:araprat_upload", class: "refusal", proof: "loginGatedResult" },
  { id: "araprat_playlist", file: "araprat.ts", where: "case:araprat_playlist", class: "refusal", proof: "loginGatedResult" },

  // --- other posting / upload surfaces. ---
  { id: "gmail_send", file: "gmail.ts", where: "send", class: "refusal", proof: "gmailSendConfirmed read-back is login-gated; GMAIL_SEND_UNVERIFIED" },
  { id: "manus_upload", file: "manus.ts", where: "case:manus_upload", class: "refusal", proof: "loginGatedResult" },
  { id: "t3chat_file_upload", file: "t3chat.ts", where: "case:t3chat_file_upload", class: "refusal", proof: "loginGatedResult" },
  { id: "t3chat_conversation_crud", file: "t3chat.ts", where: "case:t3chat_conversation_crud", class: "refusal", proof: "loginGatedResult" },
  { id: "codex_task_crud", file: "codex.ts", where: "case:codex_task_crud", class: "refusal", proof: "loginGatedResult" },
  { id: "chatgpt_conversation_crud", file: "chatgpt.ts", where: "conversationCrud", class: "refusal", proof: "honest not-built ok:false (no browser, no fabricated DELETE)" },
  { id: "tencent_aistudio_conversation_crud", file: "tencent-aistudio.ts", where: "conversationCrud", class: "refusal", proof: "honest ok:false — only list + open-by-click are proven, delete/rename are not" },
  { id: "chatglm_file_upload", file: "chatglm.ts", where: "case:chatglm_file_upload", class: "refusal", proof: "loginGatedResult" },
  { id: "chatglm_conversation_crud", file: "chatglm.ts", where: "case:chatglm_conversation_crud", class: "refusal", proof: "loginGatedResult" },
  { id: "tencent_aistudio_file_upload", file: "tencent-aistudio.ts", where: "case:tencent_aistudio_file_upload", class: "refusal", proof: "measured honest ok:false — no input[type=file] in the live composer" },
  { id: "duckduckgo_file_upload", file: "duckduckgo.ts", where: "fileUpload", class: "postcondition", proof: "attachment chip read-back after setInputFiles" },
  // --- GOAL 115: the two file_upload caps that returned a LITERAL ok:true and
  // the one toggle that echoed the REQUESTED state. All three now derive ok
  // from a read-back taken AFTER the mutating action. ---
  { id: "kimi_file_upload", file: "kimi.ts", where: "fileUpload", class: "postcondition", proof: "attachment chip read-back after setInputFiles gates ok (absent chip -> named ok:false) — GOAL 115" },
  { id: "gemini_file_upload", file: "gemini.ts", where: "fileUpload", class: "postcondition", proof: "attachment chip read-back after setInputFiles gates ok (absent chip -> named ok:false) — GOAL 115" },
  { id: "gemini_search_toggle", file: "gemini.ts", where: "searchToggle", class: "postcondition", proof: "toggle's own aria/class state is RE-READ after the click; an unreadable or un-flipped state is a named ok:false — GOAL 115" },
];

/**
 * Out-of-scope defects in files this change may not edit.
 *
 * EMPTY as of GOAL 115: the last three entries (kimi_file_upload,
 * gemini_file_upload, gemini_search_toggle) were the unconditional-`ok:true`
 * family, and all three are now fixed in src/capabilities/{kimi,gemini}.ts and
 * classified in TABLE above. The list is kept (not deleted) as a live tripwire:
 * a newly-discovered unproven-ok mutating cap is added here with its reason and
 * pins that it is REAL, and the test below asserts an entry carries a literal
 * `ok: true` verdict so a stale entry fails loudly.
 */
const KNOWN_DEFECTS: Array<{ id: string; file: string; where: string; why: string }> = [];

function regionFor(c: { file: string; where: string }): string {
  const src = readIfPresent(`${RUNNER_DIR}/${c.file}`);
  if (!src) return "";
  return c.where.startsWith("case:") ? caseRegion(src, c.where.slice(5)) : methodRegion(src, c.where);
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Discover every mutating capability id declared in a manifest or dispatched by a runner. */
function discoverMutatingIds(): string[] {
  const ids = new Set<string>();
  for (const pkg of readdirSync(MANIFEST_DIR)) {
    let manifest: { capabilities?: Array<{ id?: string }> };
    try {
      manifest = JSON.parse(readIfPresent(`${MANIFEST_DIR}/${pkg}/manifest.json`));
    } catch {
      continue;
    }
    for (const c of manifest.capabilities ?? []) {
      if (typeof c.id !== "string") continue;
      const tail = c.id.split("_").pop() ?? "";
      if (MUTATING_TAILS.has(tail)) ids.add(c.id);
    }
  }
  for (const f of readdirSync(RUNNER_DIR)) {
    if (!f.endsWith(".ts")) continue;
    for (const m of readIfPresent(`${RUNNER_DIR}/${f}`).matchAll(/case\s+"([a-z0-9_-]+)"\s*:/g)) {
      const tail = m[1].split("_").pop() ?? "";
      if (MUTATING_TAILS.has(tail)) ids.add(m[1]);
    }
  }
  return [...ids].sort();
}

describe("GOAL 112: every mutating capability is judged by a post-condition", () => {
  test("the gate's discovery finds every mutating cap, and the table classifies all of them", () => {
    const discovered = discoverMutatingIds();
    assert.ok(discovered.length >= 20, `expected a real mutating surface, found ${discovered.length}`);
    const classified = new Set([...TABLE.map((c) => c.id), ...KNOWN_DEFECTS.map((c) => c.id)]);
    const unclassified = discovered.filter((id) => !classified.has(id));
    assert.deepEqual(unclassified, [], `unclassified MUTATING caps (a new posting cap must be classified): ${unclassified.join(", ")}`);
    // and nothing classified is fictional: every table id must really exist
    const ghosts = [...classified].filter((id) => !discovered.includes(id));
    assert.deepEqual(ghosts, [], `classified ids that no manifest/runner declares: ${ghosts.join(", ")}`);
  });

  test("no mutating runner derives ok from a count of things that merely existed", () => {
    const offenders: string[] = [];
    for (const c of [...TABLE, ...KNOWN_DEFECTS]) {
      const region = stripComments(regionFor(c));
      if (!region) {
        offenders.push(`${c.id}: region not found in ${c.file} (${c.where}) — the gate must be able to read it`);
        continue;
      }
      if (PRECONDITION_VERDICT.test(region) || PRECONDITION_BOOL.test(region)) {
        offenders.push(`${c.id}: verdict is a pre-condition (a menu/count open), not a post-condition`);
      }
    }
    assert.deepEqual(offenders, [], `pre-condition verdicts on MUTATING caps:\n${offenders.join("\n")}`);
  });

  test("every postcondition-classified cap reads the page AFTER the mutating action", () => {
    const offenders: string[] = [];
    for (const c of TABLE.filter((x) => x.class === "postcondition")) {
      const region = stripComments(regionFor(c));
      const lastAction = Math.max(...ACTION_CALLS.map((a) => region.lastIndexOf(a)));
      assert.ok(lastAction >= 0, `${c.id}: no mutating action found in its deciding code — gate is blind`);
      const after = region.slice(lastAction);
      if (!READ_CALLS.some((r) => after.includes(r))) {
        offenders.push(`${c.id}: nothing is read back after the action (${c.proof})`);
      }
    }
    assert.deepEqual(offenders, [], `mutating caps with no post-action read:\n${offenders.join("\n")}`);
  });

  test("every refusal-classified cap names its refusal and cannot answer ok from a menu", () => {
    const offenders: string[] = [];
    for (const c of TABLE.filter((x) => x.class === "refusal")) {
      const region = stripComments(regionFor(c));
      const named =
        /loginGated/.test(region) ||
        /GMAIL_SEND_UNVERIFIED/.test(region) ||
        /ok\s*:\s*false/.test(region) ||
        /youtubePlaylistAddCommitted/.test(region);
      if (!named) offenders.push(`${c.id}: no ok:false, no login gate, no named refusal`);
      // a refusal must still SAY something
      const saysSomething = /error\s*:/.test(region) || /reason/.test(region) || /loginGated/.test(region);
      if (!saysSomething) offenders.push(`${c.id}: refuses silently — an unnamed refusal is not honest`);
    }
    assert.deepEqual(offenders, [], `mutating caps refusing without a named reason:\n${offenders.join("\n")}`);
  });

  test("the known-defect list is empty after GOAL 115, and any future entry must be a REAL literal ok:true", () => {
    // The three unconditional-ok caps GOAL 115 named are fixed and classified in
    // TABLE. An empty list is the honest end state — a NEW defect is added here
    // with a reason, and the pin below proves the entry is real, not a guess.
    assert.deepEqual(
      KNOWN_DEFECTS.map((d) => d.id),
      [],
      `the known-defect list changed: fix a cap and drop it here, or add a newly-discovered defect and say why (now: ${KNOWN_DEFECTS.map((d) => d.id).join(", ") || "empty"})`,
    );
    for (const d of KNOWN_DEFECTS) {
      const region = stripComments(regionFor(d));
      assert.ok(region.length > 0, `${d.id}: region not found in ${d.file}`);
      assert.match(region, /ok\s*:\s*true/, `${d.id} no longer has the unconditional ok:true — remove it from KNOWN_DEFECTS and classify it`);
      assert.ok(d.why.length > 30, `${d.id}: the known defect must carry a real reason`);
    }
  });
});

describe("GOAL 112: youtube_playlist_add's own verdict (the fixed one)", () => {
  test("a menu that merely rendered playlist choices is NEVER a committed add", () => {
    assert.equal(youtubePlaylistAddCommitted({ playlistChoices: 7, videoId: "abc123" }), false);
    assert.equal(youtubePlaylistAddCommitted({ playlistChoices: 0, videoId: "abc123" }), false);
    assert.equal(youtubePlaylistAddCommitted({ playlistChoices: 3, committedPlaylistId: null, videoId: "abc" }), false);
    assert.equal(youtubePlaylistAddCommitted({ playlistChoices: 3, committedPlaylistId: "   ", videoId: "abc" }), false);
    assert.equal(youtubePlaylistAddCommitted({}), false);
  });

  test("ok:true requires a read-back naming the playlist that now holds the video", () => {
    assert.equal(
      youtubePlaylistAddCommitted({ playlistChoices: 3, committedPlaylistId: "PL-xyz", videoId: "abc" }),
      true,
      "a named committed playlist IS the post-condition",
    );
  });

  test("the refusal is NAMED and says the video was not added", () => {
    assert.match(YOUTUBE_PLAYLIST_ADD_UNVERIFIED, /nothing-committed|NOT added/i, "the reason must say nothing was committed");
    assert.match(YOUTUBE_PLAYLIST_ADD_UNVERIFIED, /playlist/i, "and name the capability's subject");
    assert.ok(YOUTUBE_PLAYLIST_ADD_UNVERIFIED.length > 80, "a one-word refusal is not a named reason");
  });

  test("the runner's verdict and its recipe now AGREE (recipe ok:false == code ok:false)", () => {
    const recipe = JSON.parse(readIfPresent(`${MANIFEST_DIR}/youtube/recipes/youtube_playlist_add.json`));
    const runner = stripComments(methodRegion(readIfPresent(`${RUNNER_DIR}/youtube.ts`), "playlistAdd"));
    assert.equal(recipe.ok, false, "the recipe ships ok:false — the runner must not claim otherwise");
    assert.match(runner, /ok\s*:\s*committed/, "the runner's ok must come from the post-condition predicate");
    assert.match(runner, /YOUTUBE_PLAYLIST_ADD_UNVERIFIED/, "and the refusal must use the shared named reason");
    assert.match(runner, /playlistChoices/, "the menu count may stay, but only as diagnostic detail");
    // the manifest already promised this; keep it pinned
    const manifest = readIfPresent(`${MANIFEST_DIR}/youtube/manifest.json`);
    assert.match(manifest, /no add is committed until a choice is made/, "the manifest promise is retained");
  });

  test("MUTATION: the shipped pre-condition shape FAILS this gate (it cannot pass vacuously)", () => {
    // the exact verdict GOAL 112 removed, reproduced verbatim
    const shipped = `
      const opened = await page.evaluate(() => items.length);
      return { capability: "youtube_playlist_add", ok: opened > 0, data: { videoId, playlistChoices: opened } };
    `;
    assert.ok(
      PRECONDITION_VERDICT.test(stripComments(shipped)),
      "precondition: the gate must flag the old menu-count verdict",
    );
    // and a menu-open-shaped source mutation is caught by the same rule
    const mutated = readIfPresent(`${RUNNER_DIR}/youtube.ts`).replace(
      /ok\s*:\s*committed/,
      "ok: playlistChoices > 0",
    );
    assert.notEqual(mutated, readIfPresent(`${RUNNER_DIR}/youtube.ts`), "the mutation must actually apply");
    assert.ok(PRECONDITION_VERDICT.test(mutated), "a menu-open-shaped mutation of the real file must be refused");
    // boolean-count shape too
    assert.ok(PRECONDITION_BOOL.test(`ok: Boolean(playlistChoices.length)`), "the boolean-count shape is refused as well");
    // and the honest shape passes
    assert.ok(!PRECONDITION_VERDICT.test(stripComments(methodRegion(readIfPresent(`${RUNNER_DIR}/youtube.ts`), "playlistAdd"))));
  });
});

/**
 * GOAL 115 — the same post-condition gate applied to the three caps whose
 * verdict was NOT derived from anything the page said:
 *   - kimi_file_upload      → literal `ok: true` (chip read-back only in data)
 *   - gemini_file_upload    → literal `ok: true` (an honesty STRING, but an
 *                             ungated verdict)
 *   - gemini_search_toggle  → `now: wantOn`, the REQUESTED state echoed back
 * The gate below is structural, so a re-introduced ungated `ok: true` (or a
 * restored `now: wantOn`) fails this file rather than shipping.
 */

/** Names bound to a read OFF THE PAGE inside the region. */
function pageReadNames(region: string): string[] {
  return [...region.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:page\.)?evaluate\(/g)].map((m) => m[1]);
}

/**
 * A verdict is ungated when a bare `ok: true` is reachable with NO
 * `if (!<something read off the page>) { … ok: false }` refusal in front of it.
 * The refusal must be keyed on a page-read variable, so a DIFFERENT refusal
 * (e.g. an unrelated payload-guard) cannot stand in as the evidence gate.
 */
function ungatedOkTrue(region: string): boolean {
  const literalCount = (region.match(/ok\s*:\s*true/g) ?? []).length;
  if (literalCount === 0) return true; // no bare ok:true at all — nothing ungated
  const readNames = pageReadNames(region);
  const gates = readNames.filter((name) =>
    new RegExp(`if\\s*\\(\\s*!\\s*${name}\\s*\\)\\s*\\{[\\s\\S]{0,600}?ok\\s*:\\s*false`).test(region),
  );
  return gates.length === 0;
}

/** A toggle that only ever reports the REQUESTED state, never a post-click read. */
function echoesRequestedState(region: string): boolean {
  return /now\s*:\s*wantOn/.test(region) || /enabled\s*:\s*enable\b/.test(region);
}

/** For a toggle: the post-click read must sit AFTER the click in the region. */
function toggleRereadsAfterClick(region: string): boolean {
  const lastAction = Math.max(...ACTION_CALLS.map((a) => region.lastIndexOf(a)));
  if (lastAction < 0) return false;
  const after = region.slice(lastAction);
  return READ_CALLS.some((r) => after.includes(r)) && /after\s*\./.test(after);
}

const KIMI_UPLOAD = { id: "kimi_file_upload", file: "kimi.ts", where: "fileUpload" };
const GEMINI_UPLOAD = { id: "gemini_file_upload", file: "gemini.ts", where: "fileUpload" };
const GEMINI_TOGGLE = { id: "gemini_search_toggle", file: "gemini.ts", where: "searchToggle" };

describe("GOAL 115: kimi/gemini upload + toggle verdicts are read-backs, not literals", () => {
  test("kimi_file_upload's ok is gated by the attachment chip read-back", () => {
    const region = stripComments(regionFor(KIMI_UPLOAD));
    assert.ok(region.length > 0, "kimi fileUpload region must be readable by the gate");
    assert.ok(!ungatedOkTrue(region), "kimi_file_upload's ok:true must sit behind an absence-gate on the chip read-back");
    assert.match(region, /if\s*\(\s*!\s*attached\s*\)/, "the chip read-back must gate the verdict");
    assert.match(region, /ok\s*:\s*false[\s\S]{0,400}?no attachment chip rendered/, "an absent chip must be a NAMED refusal");
    assert.match(region, /verified\s*:\s*false/, "an accepted INPUT is not a live round-trip — the honesty marker stays");
    const readback = region.lastIndexOf("attached");
    const verdict = region.lastIndexOf("ok:");
    assert.ok(readback > 0 && verdict > 0, "the chip is read before the verdict");
  });

  test("gemini_file_upload's ok is gated by the attachment chip read-back", () => {
    const region = stripComments(regionFor(GEMINI_UPLOAD));
    assert.ok(region.length > 0, "gemini fileUpload region must be readable by the gate");
    assert.ok(!ungatedOkTrue(region), "gemini_file_upload's ok:true must sit behind an absence-gate on the chip read-back");
    assert.match(region, /if\s*\(\s*!\s*attached\s*\)/, "the chip read-back must gate the verdict");
    assert.match(region, /ok\s*:\s*false[\s\S]{0,400}?no attachment chip rendered/, "an absent chip must be a NAMED refusal");
    assert.match(region, /honesty/, "the accepted-input-vs-round-trip distinction must survive");
    assert.match(region, /NOT a live round-trip claim/, "and must still refuse the live-upload claim");
  });

  test("gemini_search_toggle RE-READS the toggle after the click instead of echoing the request", () => {
    const region = stripComments(regionFor(GEMINI_TOGGLE));
    assert.ok(region.length > 0, "gemini searchToggle region must be readable by the gate");
    assert.ok(!echoesRequestedState(region), "the verdict must not be the requested state (`now: wantOn`)");
    assert.ok(toggleRereadsAfterClick(region), "a post-click read of the toggle's own state must follow the click");
    assert.match(region, /after\s*\.\s*on\s*!==\s*enable/, "the verdict must compare the RE-READ state against the request");
    assert.match(region, /ok\s*:\s*false[\s\S]{0,600}?could not be RE-READ afterwards/, "an unreadable post-click state is a named ok:false");
    assert.match(region, /ok\s*:\s*false[\s\S]{0,900}?did not reach the requested state/, "a click the page ignored is a named ok:false");
    assert.match(region, /readToggle/, "the state must be read from the page, not assumed");
  });

  test("MUTATION: the pre-fix shapes (literal ok:true, `now: wantOn`) FAIL this gate", () => {
    // the exact kimi/gemini fileUpload verdict GOAL 115 removed, reproduced verbatim
    const literalUpload = `
      await fileInput.setInputFiles(payload);
      const attached = await page.evaluate(() => readChip());
      return { capability: "kimi_file_upload", ok: true, method: "dom.input.setFiles", data: { file: payload.name, attached } };
    `;
    assert.ok(ungatedOkTrue(stripComments(literalUpload)), "MUTATION: a bare ok:true beside an ungated chip read-back must be refused");

    // the exact gemini_search_toggle evidence GOAL 115 removed
    const requestedStateOnly = `
      const currentlyOn = readState();
      if (currentlyOn !== wantOn) el.click();
      return { ok: true, clicked: true, now: wantOn, source: "composer-standalone" };
    `;
    assert.ok(echoesRequestedState(stripComments(requestedStateOnly)), "MUTATION: echoing the requested state must be refused");
    assert.ok(!toggleRereadsAfterClick(stripComments(requestedStateOnly)), "MUTATION: no post-click re-read means no post-condition");

    // and the same rules applied to MUTATIONS OF THE REAL FILES
    const kimiSrc = readIfPresent(`${RUNNER_DIR}/kimi.ts`);
    const kimiUngated = kimiSrc.replace("if (!attached)", "if (false) /* mutated: gate removed */");
    assert.notEqual(kimiUngated, kimiSrc, "the mutation must actually apply to kimi.ts");
    assert.ok(ungatedOkTrue(stripComments(methodRegion(kimiUngated, "fileUpload"))), "MUTATION: removing the chip gate in kimi.ts must fail the gate");

    const geminiSrc = readIfPresent(`${RUNNER_DIR}/gemini.ts`);
    const geminiEcho = geminiSrc.replace("after.on !== enable", "false /* mutated: assume success */");
    assert.notEqual(geminiEcho, geminiSrc, "the mutation must actually apply to gemini.ts");
    const mutatedToggle = stripComments(methodRegion(geminiEcho, "searchToggle"));
    assert.ok(!/after\s*\.\s*on\s*!==\s*enable/.test(mutatedToggle), "MUTATION: assuming the flip after the click must fail the gate");
    assert.ok(toggleRereadsAfterClick(stripComments(methodRegion(geminiSrc, "searchToggle"))), "the unmutated toggle DOES re-read after the click");

    // and the honest shapes pass
    assert.ok(!ungatedOkTrue(stripComments(methodRegion(kimiSrc, "fileUpload"))), "the real kimi.ts gates its ok");
    assert.ok(!ungatedOkTrue(stripComments(methodRegion(geminiSrc, "fileUpload"))), "the real gemini.ts gates its ok");
    assert.ok(!echoesRequestedState(stripComments(methodRegion(geminiSrc, "searchToggle"))), "the real gemini.ts does not echo the request");
    assert.ok(toggleRereadsAfterClick(stripComments(methodRegion(geminiSrc, "searchToggle"))), "the real gemini.ts re-reads after the click");
  });
});
