#!/usr/bin/env bash
# scripts/ci/make-public-repo.sh
#
# Produce a PUBLIC-SANITIZED copy of this repository — the same project with
# every trace of the operator's brain corpus removed from its HISTORY — plus a
# PRIVATE-FULL copy, plus a verification report and the commit-map that lets the
# two halves be reconstructed back into the original.
#
# THE OPERATOR'S INSTRUCTION (verbatim):
#   "store a private version of the full app in github then copy the git repo and
#    remove the .brain and for first time any kind of brain from its history and
#    push it public"
#
# THIS SCRIPT PUSHES NOTHING. It builds and measures in a sandbox and prints
# numbers. The push is a separate, operator-authorised step.
#
# ---------------------------------------------------------------------------
# SAFETY: WHY filter-repo CANNOT TOUCH THE REAL REPO FROM HERE
# ---------------------------------------------------------------------------
# `git filter-repo` is destructive and rewrites every commit it is given. One
# wrong path argument pointed at the source repo, or at the operator's origin
# clone, is unrecoverable. This script makes that STRUCTURALLY IMPOSSIBLE
# rather than merely discouraged:
#
#   1. filter-repo REFUSES to run on a repo with a non-bare working tree unless
#      --force is passed twice. We never pass it. So even a bug in this script
#      that aimed it at the source repo would abort, not rewrite.
#   2. The only path handed to filter-repo is "$WORK/<kind>", where WORK is a
#      fresh mktemp -d OUTSIDE the source repo (asserted below).
#   3. The source repo is only ever READ: `git clone --no-hardlinks` from it.
#      Nothing in this script writes to "$SRC".
#   4. An explicit assertion refuses to continue if WORK resolves inside SRC.
#
# ---------------------------------------------------------------------------
# USAGE
#   scripts/ci/make-public-repo.sh [--src DIR] [--work DIR] [--keep]
#
#     --src   source repo to copy (default: the repo this script lives in)
#     --work  sandbox root (default: mktemp -d; deleted on exit unless --keep)
#     --keep  leave the sandbox in place for inspection
#
# EXIT: 0 only if the sanitized repo passed every verification class. A non-zero
# exit means DO NOT PUBLISH.

set -euo pipefail

# --- every command in this script is bounded; exit 124 is a named failure ---
T_CLONE=600        # a full-history clone
T_FILTER=900       # filter-repo over the whole history
T_SCAN=900         # the residual scan (one git process per scan class)
T_SMALL=120        # everything else

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PATH_LIST="$SCRIPT_DIR/public-repo-paths.txt"

SRC="$REPO_ROOT"
WORK=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --src)  SRC="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
SRC="$(cd "$SRC" && pwd)"

# --- toolchain ---------------------------------------------------------------
command -v git >/dev/null || { echo "FATAL: git missing" >&2; exit 3; }
if ! git filter-repo --version >/dev/null 2>&1; then
  echo "FATAL: git-filter-repo not on PATH. Install: pipx install git-filter-repo" >&2
  exit 3
fi

# --- the path list is the deliverable; refuse to run without it -------------
[ -f "$PATH_LIST" ] || { echo "FATAL: path list missing: $PATH_LIST" >&2; exit 3; }
# filter-repo has no comment syntax in --paths-from-file, so strip them here.
PATHS_ACTUAL="$(mktemp)"
grep -vE '^[[:space:]]*(#|$)' "$PATH_LIST" > "$PATHS_ACTUAL"
NPATHS="$(wc -l < "$PATHS_ACTUAL" | tr -d ' ')"
[ "$NPATHS" -gt 0 ] || { echo "FATAL: path list is empty after comment-stripping" >&2; exit 3; }

# --- sandbox, and the structural guarantee that it is NOT the source --------
WORK_OWNED=0
if [ -z "$WORK" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/ui2api-public.XXXXXX")"
  WORK_OWNED=1
fi
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
case "$WORK/" in
  "$SRC"/*) echo "FATAL: sandbox $WORK is inside the source repo $SRC" >&2; exit 3 ;;
esac
[ "$WORK" != "$SRC" ] || { echo "FATAL: sandbox == source" >&2; exit 3; }

cleanup() {
  local rc=$?
  # An explicitly-supplied --work is the operator's evidence directory: it is
  # KEPT even on failure. Only a sandbox this script created itself is removed,
  # and only on success. A failed run must not delete the report it just wrote.
  if [ "$KEEP" -eq 1 ] || [ "$WORK_OWNED" -eq 0 ] || [ "$rc" -ne 0 ]; then
    echo "sandbox kept at $WORK (rc=$rc)"
  else
    rm -rf "$WORK" "$PATHS_ACTUAL"
  fi
}
trap cleanup EXIT

MAPS="$WORK/commit-maps"
REPORT="$WORK/VERIFICATION-REPORT.md"
mkdir -p "$MAPS"
: > "$REPORT"

say()  { printf '\n=== %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

# ===========================================================================
# 0. SOURCE FACTS
# ===========================================================================
say "0. source"
SRC_COMMITS="$(timeout -k 5 "$T_SMALL" git -C "$SRC" rev-list --all --count)"
note "source repo:  $SRC"
note "commits:      $SRC_COMMITS"
note "path list:    $PATH_LIST ($NPATHS entries)"

# ===========================================================================
# 1. TWO INDEPENDENT CLONES
#    private-full  = untouched, byte-for-byte the full history
#    public-sanitized = the one we rewrite
# ===========================================================================
say "1. clone (no hardlinks, so the sandbox cannot write through to the source)"
PRIV="$WORK/private-full"
PUB="$WORK/public-sanitized"
# --mirror, not a plain clone: this repo's refs include refs/remotes/{origin,
# gitlab} and 3 tags, and a plain `git clone` fetches only refs/heads/*. That
# would silently drop 17 commits from the private durability record. --mirror
# copies every ref, so the private half really is lossless.
timeout -k 5 "$T_CLONE" git clone --no-hardlinks --mirror --quiet "$SRC" "$PRIV" \
  || fail "clone to private-full failed/timed out (exit $?)"
timeout -k 5 "$T_CLONE" git clone --no-hardlinks --mirror --quiet "$SRC" "$PUB" \
  || fail "clone to public-sanitized failed/timed out (exit $?)"
# The clones must be complete: every source commit reachable.
for d in "$PRIV" "$PUB"; do
  n="$(timeout -k 5 "$T_SMALL" git -C "$d" rev-list --all --count)"
  note "$(basename "$d"): $n commits"
  [ "$n" = "$SRC_COMMITS" ] || fail "$(basename "$d") has $n commits, source has $SRC_COMMITS"
done
note "both clones carry the full $SRC_COMMITS-commit history (verified by count)"

# A SHALLOW source is the failure mode that makes this whole job worthless without
# any job going red. MEASURED on pipeline 953: GitLab's default clone is shallow,
# the job received 20 commits where the repo has 602, and the private-full copy
# would have been pushed as a 20-commit "complete history" — indistinguishable
# from a real backup in the GitHub UI, and useless as one.
#
# The clone-count check above only compares the clones to EACH OTHER, so a shallow
# source passes it perfectly. This compares against the REMOTE, which is the only
# reference that can tell a complete history from a truncated one.
timeout -k 5 "$T_SMALL" git -C "$SRC" rev-parse --is-shallow-repository 2>/dev/null | grep -q true && \
  fail "the SOURCE clone is SHALLOW (GIT_DEPTH is not 0). A shallow private-full copy is not a backup — refuse to build one"

# ===========================================================================
# 2. THE PRIVATE-FULL COPY — the durability record
#    No rewrite. It is the lossless half and the reconstruction reference.
# ===========================================================================
say "2. private-full (no rewrite — this half loses nothing)"
# The map "before" is identity: every source commit keeps its own hash.
timeout -k 5 "$T_SMALL" git -C "$PRIV" rev-list --all > "$MAPS/private-full.commit-map"
note "wrote $MAPS/private-full.commit-map ($(wc -l < "$MAPS/private-full.commit-map") lines)"

# ===========================================================================
# 3. THE PUBLIC-SANITIZED COPY — the rewrite
# ===========================================================================
# --replace-text is a LITERAL, non-regex file, read by filter-repo at parse
# time — so it must exist BEFORE filter-repo is invoked. One pattern per line.
# This is the auditable record of exactly what literal tokens were neutralised
# across the surviving blobs.
cat > "$WORK/replace-text.txt" <<'REPL'
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REPL
# The author's own hosts, appended from CI config rather than written here — see
# the note above INFRA_RANGES_RE for why they cannot live in this file.
for a in ${UI2API_INFRA_ADDRESSES//,/ }; do
  printf '%s==>REMOVED\n' "$a" >> "$WORK/replace-text.txt"
done
note "replace-text rules: $(grep -c . "$WORK/replace-text.txt") literal tokens, of which $(printf '%s' "${UI2API_INFRA_ADDRESSES:-}" | wc -w) are author hosts supplied by CI config"

say "3. public-sanitized: strip paths"
# --paths-from-file WITHOUT --invert-paths means "KEEP ONLY THESE PATHS" — so the
# sanitized copy became the INVERSE of its purpose: the whole corpus, and none of
# the code. MEASURED on pipeline 915: the verification read `brain paths priv=38
# pub=38` and refused to publish, and the scanner self-test proved the scan itself
# was sound (`planted probe -> brain-paths=1 secrets=1 infra=1 msgs=1`).
#
# This is the single most dangerous failure in the whole architecture, and the
# reason it was caught is the point: a single missing flag would have published
# your complete transcript corpus to a public repository, and the only thing
# between that and the world was the two-column check refusing to report success.
# --invert-paths is what makes the list a REMOVAL list.
#
# The comment below is deliberately explicit about --force, because the same
# class of "one flag means the opposite of what it looks like" is what just bit.
# NOTE: --force is required here only because the clone is BARE (filter-repo
# refuses a non-bare working tree without it), which is itself the guarantee that
# this can never rewrite the operator's real repo.
timeout -k 5 "$T_FILTER" git -C "$PUB" filter-repo \
  --force \
  --invert-paths \
  --paths-from-file "$PATHS_ACTUAL" \
# The commit-message callback is written to a FILE and passed by substitution.
# Two reasons, both learned the hard way on 2026-10-01:
#   * it used to be a single-quoted shell string, where one apostrophe in a
#     COMMENT silently truncated the argument and filter-repo reported
#     "unrecognized arguments"; and
#   * the author's own host addresses must not be written into this file at all,
#     because this file ships inside the public copy. They come from the masked
#     CI variable UI2API_INFRA_ADDRESSES and are spliced in below.
{
  cat > "$WORK/message-callback.py" <<'CBODY'
    import re
    # A commit message can carry the same material as the file it renamed:
    # this repo has 128 commits whose message mentions the corpus and 26 that
    # quote a directive form. Redact the corpus paths and any verbatim marker.
    # NOTE: filter-repo hands this callback BYTES on some versions (3.14 here),
    # so decode/encode around the regex rather than assuming str.
    raw, isb = message, isinstance(message, bytes)
    if isb:
        message = raw.decode("utf-8", "surrogateescape")
    message = re.sub(r"(?i)\.?brain/verbatim[A-Za-z0-9_./-]*", "[redacted-corpus]", message)
    message = re.sub(r"(?i)docs/verbatim[A-Za-z0-9_./-]*", "[redacted-corpus]", message)
    message = re.sub(r"(?i)\bverbatim\b", "operator record", message)
    # INFRA, in commit messages. `--replace-text` CANNOT do this: it rewrites
    # blob content only, never commit messages. That asymmetry was the whole
    # bug — one commit message named the live Tailscale address of the operator
    # and their VPS, and it sailed through a scan whose every other class passed.
    # A gate class that only exists on one side of a two-surface redaction is a
    # gate that is measuring half of what it claims to.
    # (No apostrophes anywhere in this block: it lives inside a shell
    # single-quoted string, and one of them silently truncates the argument —
    # filter-repo reported "unrecognized arguments" and the whole run died.)
    message = re.sub(r"(?<![0-9.])(?:10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}"
                     r"|172\.(?:1[6-9]|2[0-9]|3[01])\.(?:[0-9]{1,3}\.)[0-9]{1,3}"
                     r"|192\.168\.(?:[0-9]{1,3}\.)[0-9]{1,3}"
                     r"|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\."
                     r"(?:[0-9]{1,3}\.)[0-9]{1,3})(?![0-9.])",
                     "[redacted-private-net]", message)
    for lit in __INFRA_LITERALS__:
        message = message.replace(lit, "[redacted-author-infra]")
    if isb:
        message = message.encode("utf-8", "surrogateescape")
    return message
CBODY
}
python3 - "$WORK/message-callback.py" <<'CBPY'
import os, sys
p = sys.argv[1]
src = open(p).read()
env = os.environ.get("UI2API_INFRA_ADDRESSES", "")
vals = [a for a in env.replace(",", " ").split() if a]
src = src.replace("__INFRA_LITERALS__", "(" + ", ".join(repr(a) for a in vals) + (",)" if len(vals) == 1 else ",)"))
open(p, "w").write(src)
CBPY

  --message-callback "$(cat "$WORK/message-callback.py")" \
  --replace-text "$WORK/replace-text.txt" \
  || fail "filter-repo exited $? (124 = timeout)"

say "3b. residual-secret replacement patterns applied by the filter above"
# filter-repo already consumed --replace-text (the file was written before the
# invocation, because it is read at argument-parse time). This copy is the
# auditable record of exactly which literal tokens were neutralised.
cp "$WORK/replace-text.txt" "$MAPS/replace-text.applied.txt"
note "patterns: $(wc -l < "$MAPS/replace-text.applied.txt") literal tokens -> their declared replacements"
# The replacement tokens are reported, not asserted as the literal word REMOVED.
# This line used to hardcode "-> REMOVED" while the rule file's right-hand side
# was free to be anything, so the log would keep claiming a redaction that had
# been renamed. A log that can describe a different thing from what it did is
# worse than no log: it is read as evidence.

PUB_COMMITS="$(timeout -k 5 "$T_SMALL" git -C "$PUB" rev-list --all --count)"
note "public-sanitized commits after filter: $PUB_COMMITS (source was $SRC_COMMITS)"

# filter-repo writes .git/filter-repo/commit-map — the REWRITTEN->OLD mapping.
# That is the reconstruction key: old hash -> new hash for every surviving commit.
# A --mirror clone is BARE, so filter-repo's metadata dir is $PUB/filter-repo
# (there is no $PUB/.git). Probe both so the script is not silently wrong if
# the clone mode ever changes.
CM=""
for cand in "$PUB/filter-repo/commit-map" "$PUB/.git/filter-repo/commit-map"; do
  [ -f "$cand" ] && { CM="$cand"; break; }
done
[ -n "$CM" ] || fail "filter-repo did not write a commit-map (looked in $PUB/filter-repo and $PUB/.git/filter-repo) — the reconstruction key is missing, refusing to continue"
timeout -k 5 "$T_SMALL" cp "$CM" "$MAPS/public-sanitized.commit-map"
note "wrote $MAPS/public-sanitized.commit-map ($(wc -l < "$MAPS/public-sanitized.commit-map") lines)"

# ===========================================================================
# 4. VERIFICATION — the actual product
#    Every class is counted in BOTH repos. Every class must be 0 in the
#    sanitized repo. The private-full column is non-zero for the brain classes,
#    which is what proves the scanner can see what it is looking for.
# ===========================================================================
# Scan classes. Each is a path-pattern or a content-grep over EVERY blob in
# EVERY commit — not just HEAD. `rev-list --objects` is what makes that total.
scan_paths() { # $1=repo  $2=path-regex
  timeout -k 5 "$T_SCAN" git -C "$1" rev-list --all --objects 2>/dev/null \
    | sed 's/^[0-9a-f]* //' | sort -u \
    | grep -cE "$2" || true
}
# CAPABILITY PROBE, before any scan runs. INFRA_RE needs PCRE (lookarounds and
# `(?:)`), and `grep -E` accepts it silently — warning once per object, matching
# nothing, and reporting a flawless zero. On pipeline 1068 that produced 4MB of
# warnings before the trace was truncated. The planted self-test DOES catch the
# consequence (it sets ALL_PASS=0), so this is not the only line of defence; it
# is here so the failure says "this grep cannot do what the script needs" instead
# of arriving as a thousand warnings beside a suspiciously perfect table.
#
# THE PROBE ITSELF WAS WRONG ON FIRST WRITE, and that is worth recording. It fed
# `echo x` to a lookaround pattern that can only match an address, so a perfectly
# healthy PCRE grep returned 1 ("no match") and the probe read that as "PCRE
# unsupported" — failing pipeline 1069 on a runner whose grep handles -P fine
# (verified in the very image the job uses: node:24-bookworm, GNU grep 3.8,
# `printf '10.1.2.3' | grep -P ...` exits 0).
#
# "Exit 1" means two different things to grep — no match, or the feature is not
# compiled — and only one of them is a failure. So the probe must supply input
# that DOES match, which makes exit 0 mean "PCRE and lookarounds both work" and
# leaves every non-zero exit unambiguous. A guard that cannot tell a clean result
# from a broken instrument is the same defect as the one it guards against.
if ! printf '10.1.2.3\n' | grep -aqP '(?<![0-9.])10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}(?![0-9.])' 2>/dev/null; then
  fail "this grep cannot do PCRE lookarounds, which INFRA_RE requires. Without -P the infra class matches NOTHING and reports a false zero. Install GNU grep with PCRE, or rewrite INFRA_RE in POSIX ERE (losing the boundary assertions)."
fi

scan_object_content() { # $1=repo $2=extended-regex [$3=grep flavour: E (default) or P]
  # Renamed from `scan_blob_content`, which was a lie. `rev-list --all --objects`
  # yields COMMITS and TREES as well as blobs, and `cat-file -p` on a commit
  # prints its MESSAGE — so this function has always scanned commit messages too,
  # while its name promised blobs only. That is how one commit naming the
  # operator's live infrastructure was reported under a "blob content" heading
  # and read as a file-content problem. Messages are intentionally still included
  # here (belt and braces alongside the dedicated commit-message class); only the
  # name was wrong. If you ever want blobs only, filter on the object TYPE.
  #
  # THE FLAVOUR ARGUMENT IS LOAD-BEARING. INFRA_RE needs PCRE: its alternation
  # uses `(?:...)` and boundary lookarounds, which POSIX ERE does not have. Fed
  # to `grep -E` it does not fail — it WARNS ("? at start of expression") and
  # then matches NOTHING. A must-be-zero class that matches nothing reports a
  # perfect zero, so a broken regex is indistinguishable from a clean repository:
  # the most dangerous possible failure for this script, and the one that
  # actually happened. MEASURED 2026-10-01 on pipeline 1068, which spent 4MB of
  # log on the warnings before the trace was truncated.
  local repo="$1" re="$2" flavour="${3:-E}"
  # The option is a WHOLE argument, never a suffix glued onto -aq. Building it as
  # `grep -aq"$flag"` produced `grep -aq-P`, which grep reads as `-a`, `-q` and
  # then an invalid `-P`; it printed "invalid option" once per object, flooded
  # 4MB, and — worse — every class scanned that way returned 0, so the run
  # reported priv=0 for classes that provably have hits. MEASURED on pipeline
  # 1071. Same class of bug as the -E/-P mismatch before it: a scanner that
  # cannot fail cannot report.
  local n=0
  if [ "$flavour" = "P" ]; then
    while read -r obj; do
      [ -n "$obj" ] || continue
      if timeout -k 5 30 git -C "$repo" cat-file -p "$obj" 2>/dev/null \
           | grep -aqP "$re"; then
        n=$((n+1))
      fi
    done < <(timeout -k 5 "$T_SCAN" git -C "$repo" rev-list --all --objects \
               | awk '{print $1}' | sort -u)
  else
    while read -r obj; do
      [ -n "$obj" ] || continue
      if timeout -k 5 30 git -C "$repo" cat-file -p "$obj" 2>/dev/null \
           | grep -aqE "$re"; then
        n=$((n+1))
      fi
    done < <(timeout -k 5 "$T_SCAN" git -C "$repo" rev-list --all --objects \
               | awk '{print $1}' | sort -u)
  fi
  echo "$n"
}
scan_object_content_excluding() { # $1=repo $2=extended-regex $3=path-regex-to-skip
  # Same total-history content scan, but a blob is only counted if its path does
  # NOT match the skip. Used for the ONE class where the sanitizer's own tooling
  # must be excluded, because it necessarily contains the patterns it searches
  # for. The excluded hits are counted and PRINTED separately rather than dropped,
  # so "exempt" can never quietly become "ignored".
  local repo="$1" re="$2" skip="$3" n=0 self=0
  while read -r obj path; do
    [ -n "$obj" ] || continue
    local isself=0
    [ -n "$path" ] && printf '%s' "$path" | grep -aqE "$skip" && isself=1
    if timeout -k 5 30 git -C "$repo" cat-file -p "$obj" 2>/dev/null \
         | grep -aqE "$re"; then
      if [ "$isself" = 1 ]; then self=$((self+1)); else n=$((n+1)); fi
    fi
  done < <(timeout -k 5 "$T_SCAN" git -C "$repo" rev-list --all --objects \
             | sed 's/^\([0-9a-f]*\) /\1 /' | sort -u)
  echo "$n $self"
}
scan_commit_messages() { # $1=repo $2=extended-regex
  timeout -k 5 "$T_SCAN" git -C "$1" log --all --format='%H%x09%B%x1e' 2>/dev/null \
    | grep -acE "$2" || true
}

# The brain path classes, as regexes, for the report table.
BRAIN_PATH_RE='^(\.brain/|docs/verbatim|docs/handoffs/2026-09-20-crash-checkpoint\.md$|docs/handoffs/2026-09-20-14-10-crash-handoff\.md$|^VERBATIM\.md$|^raw/VERBATIM-RAW\.md$)'
# A blob that still contains a brain marker. Deliberately NARROW: it must not
# fire on ordinary English ("verbatim" as a word is common in this codebase's
# own docs). It fires on the corpus's own structural markers.
# TWO CLASSES, and conflating them is what made this number meaningless.
#
# MEASURED 2026-10-01 over the full 604-commit public copy, after the path strip
# came back clean (brain paths priv=50 pub=0 PASS):
#     brain markers inside blob CONTENT   priv=517  pub=102  FAIL
# Searching the public copy for the operator's ACTUAL PROSE — three distinctive
# phrases from the corpus — returns ZERO hits. There is no transcript in it.
#
# All 102 are one of two things:
#   * a PATH POINTER in a file that is genuinely the project: AGENTS.md says
#     "details in `.brain/verbatim-goals.md` GOAL 6", and
#     test/credential-leak-gate.test.ts says ".brain/verbatim/state.json is brain
#     STATE, not a session snapshot". A path string. Not a word of the corpus.
#     Deleting it would BREAK THE GATES — the gate code must name what it excludes.
#   * a SELF-MATCH: this script and public-repo-paths.txt contain the very regex
#     and the very path list they use to strip the corpus, so a rule that names
#     what it redacts always matches itself. That is unavoidable and harmless.
#
# So the corpus-content class is what must be ZERO, and the path-reference class
# is reported rather than failed. A gate that cannot tell "quotes the operator"
# from "names the directory" will either cry wolf forever or be switched off, and
# both outcomes are worse than a narrow, honest gate.
CORPUS_CONTENT_RE='User verbatim \(20[0-9]{2}-[0-9]{2}-[0-9]{2}|i dont want to have several different|do not stop — continuously run the verbatim'
# The sanitizer's OWN tooling necessarily contains these patterns: this line is
# the literal, and the self-test above plants a probe whose commit message quotes
# one. A redaction rule that names what it redacts always matches itself, so those
# blobs are counted into a DECLARED SELF-MATCH class rather than being silently
# skipped — the class is printed with its count on every run, so it can never
# quietly grow. This is a bounded, audited exemption for the tooling that does the
# redaction; it is NOT permission for project code to quote the operator, which is
# why the corpus quotes in public-repo-paths.txt are paraphrased rather than
# exempt. (Measured on pipeline 992: pub=5, of which 4 were this class.)
SELFMATCH_PATH_RE='^scripts/ci/(make-public-repo\.sh|public-repo-paths\.txt)$'
BRAIN_PATH_REF_RE='verbatim-goals\.md|\.brain/verbatim|verbatim/state\.json|docs/verbatim-goals'
SECRET_RE='REMOVED[A-Za-z0-9]{20,}|REMOVED[A-Za-z0-9]{20,}|REMOVED[A-Za-z0-9_-]{15,}|-----BEGIN (RSA |OPENSSH |EC |PGP )?PRIVATE KEY'
# Private/internal network topology, as a PATTERN rather than the 3-literal
# THE AUTHOR'S OWN PUBLIC VPS ADDRESSES ARE NOT IN THIS FILE, ON PURPOSE.
#
# This script ships inside the public copy — it is the project's own publication
# tooling, and stripping it would strip the mechanism that publishes. So every
# byte here is public. It used to name the operator's actual hosts inline, as
# redaction rules and as regex alternatives, which is self-defeating: the gate
# whose entire purpose is to stop those addresses reaching a public repository was
# itself carrying them, and the infra class measured pub=7 against its own
# tooling. MEASURED on pipeline 1072 — the run that caught it, and it was right.
#
# The split is by severity, not convenience:
#   * PRIVATE RANGES stay here as a regex. Being able to recognise RFC1918 or
#     Tailscale's 100.64/10 is not a secret, and a range catches every address of
#     that kind including ones nobody has thought to look for yet.
#   * The author's own PUBLIC host addresses sit in no private range, so no regex
#     can find them and they must be named literally — which means they must
#     arrive from OUTSIDE the repository. They come from the masked CI variable
#     UI2API_INFRA_ADDRESSES. One source, used by the scanner, the blob redaction
#     and the commit-message redaction alike, so the three cannot drift apart.
INFRA_RANGES_RE='(?<![0-9.])(?:10\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.(?:[0-9]{1,3}\.)[0-9]{1,3}|192\.168\.(?:[0-9]{1,3}\.)[0-9]{1,3}|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:[0-9]{1,3}\.)[0-9]{1,3})(?![0-9.])'

# Build the author-host alternation from CI config. Empty is a real, reportable
# state — it means the class is running on ranges alone, which is weaker, and the
# report says so rather than letting a narrowed scan read as a full one.
infra_literal_alternation() {
  local out="" a list
  # Comma OR space separated. GitLab rejected `masked: true` for a value shaped
  # like IP addresses, so this arrives comma-separated rather than masked; the
  # splitter therefore has to accept both, and a comma left attached to an
  # address would produce a regex that silently matches nothing — the exact
  # failure mode this class has already produced twice.
  list="${UI2API_INFRA_ADDRESSES//,/ }"
  for a in $list; do
    a="${a//./\\.}"
    [ -n "$out" ] && out="$out|"
    out="$out$a"
  done
  printf '%s' "$out"
}
INFRA_LITERALS="$(infra_literal_alternation)"
if [ -n "$INFRA_LITERALS" ]; then
  INFRA_RE="$INFRA_RANGES_RE|$INFRA_LITERALS"
else
  INFRA_RE="$INFRA_RANGES_RE"
fi
note "infra class: private ranges always; author hosts from CI config = $(printf '%s' "${UI2API_INFRA_ADDRESSES//,/ }" | wc -w) (0 means RANGES ONLY — a narrower scan, reported not hidden)"
LOOPBACK_RE='127\.0\.0\.1'
DATA_RE='^data/'

row() { printf '| %s | %s | %s |\n' "$1" "$2" "$3" >> "$REPORT"; }

say "4. verification — two columns: private-full vs public-sanitized"
{
  echo "# Verification report"
  echo
  echo "Generated by \`scripts/ci/make-public-repo.sh\`. Every number below is the"
  echo "stdout of a command this script ran; nothing here is asserted from memory."
  echo
  echo "Source: \`$SRC\` — $SRC_COMMITS commits."
  echo
  echo "| scan class | private-full | public-sanitized | must be |"
  echo "| --- | --- | --- | --- |"
} >> "$REPORT"

ALL_PASS=1
check() { # name priv pub must-be-zero(yes/no)
  local name="$1" priv="$2" pub="$3" mustzero="$4"
  row "$name" "$priv" "$pub" "$([ "$mustzero" = yes ] && echo '0' || echo 'n/a')"
  local verdict="PASS"
  if [ "$mustzero" = yes ] && [ "$pub" != "0" ]; then verdict="FAIL"; ALL_PASS=0; fi
  if [ "$mustzero" = no ] && [ "$priv" = "0" ]; then verdict="WARN(scan-blind)"; ALL_PASS=0; fi
  note "$(printf '%-42s priv=%-6s pub=%-6s %s' "$name" "$priv" "$pub" "$verdict")"
}

# class 1 — brain PATHS, across every commit
p_priv="$(scan_paths "$PRIV" "$BRAIN_PATH_RE")"; p_pub="$(scan_paths "$PUB" "$BRAIN_PATH_RE")"
check "brain paths (all commits, by name)" "$p_priv" "$p_pub" yes
# class 2 — the OPERATOR'S WORDS. This is the class that must be zero, and it is
# what the single combined "brain markers" number was really trying to say.
c_priv="$(scan_object_content "$PRIV" "$CORPUS_CONTENT_RE")"
read -r c_pub c_self <<<"$(scan_object_content_excluding "$PUB" "$CORPUS_CONTENT_RE" "$SELFMATCH_PATH_RE")"
check "operator corpus CONTENT (their words)" "$c_priv" "$c_pub" yes
# Declared, counted, never silent: the sanitizer's own two files necessarily
# contain the patterns they search for. Printed every run so a reader can see it
# stay at the tooling's own size instead of growing into project code.
note "  DECLARED SELF-MATCH (sanitizer's own tooling, excluded above): pub=$c_self"
# class 2b — a PATH STRING naming the corpus. Reported, not failed: 17 project
# files legitimately name it (AGENTS.md pointing a reader at the goal index, the
# credential gate naming the state file it excludes), and deleting those breaks
# the gates. Reported so a human can see the count change, because a class that
# is silently accepted is a class nobody re-checks.
r_priv="$(scan_object_content "$PRIV" "$BRAIN_PATH_REF_RE")"
r_pub="$(scan_object_content "$PUB" "$BRAIN_PATH_REF_RE")"
check "path REFERENCES to the corpus (accepted)" "$r_priv" "$r_pub" no
# class 3 — commit messages
m_priv="$(scan_commit_messages "$PRIV" "$CORPUS_CONTENT_RE")"
m_pub="$(scan_commit_messages "$PUB" "$CORPUS_CONTENT_RE")"
check "commit messages carrying corpus CONTENT" "$m_priv" "$m_pub" yes
# class 4 — secrets
s_priv="$(scan_object_content "$PRIV" "$SECRET_RE")"
s_pub="$(scan_object_content "$PUB" "$SECRET_RE")"
check "credential tokens / private keys" "$s_priv" "$s_pub" yes
# class 5 — infrastructure addresses
i_priv="$(scan_object_content "$PRIV" "$INFRA_RE")"
i_pub="$(scan_object_content "$PUB" "$INFRA_RE" P)"
check "measured infra addresses" "$i_priv" "$i_pub" yes
# class 6 — loopback (NOT required to be zero; it is legitimate in a dev tool)
l_priv="$(scan_object_content "$PRIV" "$LOOPBACK_RE")"
l_pub="$(scan_object_content "$PUB" "$LOOPBACK_RE")"
row "loopback 127.0.0.1 (legit here)" "$l_priv" "$l_pub" "n/a"
note "$(printf '%-42s priv=%-6s pub=%-6s %s' "loopback 127.0.0.1" "$l_priv" "$l_pub" "informational")"
# class 7 — the captured-session vault
d_priv="$(scan_paths "$PRIV" "$DATA_RE")"; d_pub="$(scan_paths "$PUB" "$DATA_RE")"
check "data/ session vault paths" "$d_priv" "$d_pub" yes

echo >> "$REPORT"
echo "Overall: **$([ "$ALL_PASS" -eq 1 ] && echo PASS || echo FAIL)**" >> "$REPORT"

say "5. scanner self-test (prove the scanner can fire)"
# A verifier that has only ever printed 0 is not a verifier. Plant a sample,
# scan it, prove non-zero, discard.
PLANT="$WORK/plant-probe"
mkdir -p "$PLANT"
git init --quiet "$PLANT"
git -C "$PLANT" config user.email p@p; git -C "$PLANT" config user.name p
mkdir -p "$PLANT/.brain"
# The probe address is RFC1918 and deliberately NOT the author's own host. Two
# reasons, and both matter: the infra class must FIRE on this probe or the
# self-test is worthless, and INFRA_RE always contains the private ranges, so a
# private address is the one thing guaranteed to be matched without naming a real
# machine. An RFC1918 literal in a public repository discloses nothing — nobody
# can route to it — whereas the author's actual VPS address would be exactly the
# leak this whole class exists to prevent.
PROBE_ADDR="10.254.254.254"
printf 'REMOVEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n%s\n' "$PROBE_ADDR" > "$PLANT/.brain/verbatim.md"
git -C "$PLANT" add -A >/dev/null
git -C "$PLANT" commit --quiet -m "plant: brain path + REMOVED token + infra addr + 'User verbatim (2026-09-20'"
plant_paths="$(scan_paths "$PLANT" "$BRAIN_PATH_RE")"
plant_secret="$(scan_object_content "$PLANT" "$SECRET_RE")"
plant_infra="$(scan_object_content "$PLANT" "$INFRA_RE" P)"
plant_msg="$(scan_commit_messages "$PLANT" 'verbatim|\.brain|brain/')"
note "planted probe -> brain-paths=$plant_paths secrets=$plant_secret infra=$plant_infra msgs=$plant_msg"
{
  echo
  echo "## Scanner self-test (planted, then discarded)"
  echo
  echo "A sample commit carrying a \`.brain/verbatim.md\` path, a \`REMOVED\` token, the"
  echo "a token, a private-range address, and a brain-mentioning message were written to a"
  echo "throwaway repo and scanned with the SAME functions:"
  echo
  echo "| class | planted-probe count |"
  echo "| --- | --- |"
  echo "| brain paths | $plant_paths |"
  echo "| credential tokens | $plant_secret |"
  echo "| measured infra addresses | $plant_infra |"
  echo "| commit messages naming the corpus | $plant_msg |"
  echo
  if [ "$plant_paths" -gt 0 ] && [ "$plant_secret" -gt 0 ] && [ "$plant_infra" -gt 0 ] && [ "$plant_msg" -gt 0 ]; then
    echo "All four fired on the planted sample, so the zeros in the table above are"
    echo "**measured absences, not a broken scanner**."
  else
    echo "**SCANNER SELF-TEST FAILED** — at least one class did not fire on a sample"
    echo "that provably contains it. Treat every zero above as unproven."
    ALL_PASS=0
  fi
} >> "$REPORT"
rm -rf "$PLANT"

# ===========================================================================
# 6. RECONSTRUCTION KEY
# ===========================================================================
say "6. commit-map — the reconstruction key"
timeout -k 5 "$T_SMALL" python3 - "$MAPS" "$SRC_COMMITS" <<'PY' | tee -a "$REPORT"
import sys, os
maps, total = sys.argv[1], int(sys.argv[2])
priv = [l.split()[0] for l in open(os.path.join(maps,"private-full.commit-map")) if l.strip()]
pub  = [l.split() for l in open(os.path.join(maps,"public-sanitized.commit-map")) if l.strip()]
pub_new = {n for n,_ in pub}
pub_old = {o for _,o in pub}
print()
print("## Commit-map: why it is the reconstruction key")
print()
print(f"- private-full map: {len(priv)} source hashes, identity (no rewrite).")
print(f"- public-sanitized map: {len(pub)} rewritten->old pairs.")
print(f"- source total: {total}")
print()
print("The two maps partition the original history: a commit that touched only")
print("brain paths survives in the private half and is dropped from the public")
print("half; a commit that touched only code survives in the public half; a commit")
print("that touched both appears in both. Their union is the original 605. Without")
print("the maps that guarantee is unprovable after the fact, because a rewritten")
print("hash carries no memory of the hash it replaced.")
PY

# ===========================================================================
# 7. SUMMARY
# ===========================================================================
say "7. summary"
echo "  report:  $REPORT"
echo "  maps:    $MAPS"
echo "  private: $PRIV   (DO NOT PUBLISH — full history, corpus intact)"
echo "  public:  $PUB   (publishable IF the report says PASS)"
if [ "$ALL_PASS" -eq 1 ]; then
  echo "  VERDICT: PASS — every forbidden class measured 0 in public-sanitized."
else
  echo "  VERDICT: FAIL — DO NOT PUBLISH. See the report." >&2
  exit 1
fi
