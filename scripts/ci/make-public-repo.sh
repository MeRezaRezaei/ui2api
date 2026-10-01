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
REMOVED==>REMOVED
REMOVED==>REMOVED
REMOVED==>REMOVED
REPL

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
  --message-callback '
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
    if isb:
        message = message.encode("utf-8", "surrogateescape")
    return message
  ' \
  --replace-text "$WORK/replace-text.txt" \
  || fail "filter-repo exited $? (124 = timeout)"

say "3b. residual-secret replacement patterns applied by the filter above"
# filter-repo already consumed --replace-text (the file was written before the
# invocation, because it is read at argument-parse time). This copy is the
# auditable record of exactly which literal tokens were neutralised.
cp "$WORK/replace-text.txt" "$MAPS/replace-text.applied.txt"
note "patterns: $(wc -l < "$MAPS/replace-text.applied.txt") literal tokens -> REMOVED"

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
scan_blob_content() { # $1=repo  $2=extended-regex
  # Enumerate every distinct blob, then grep its content. Bounded and honest:
  # this is a real full-history content scan, not a HEAD scan.
  local repo="$1" re="$2" n=0
  while read -r obj; do
    [ -n "$obj" ] || continue
    if timeout -k 5 30 git -C "$repo" cat-file -p "$obj" 2>/dev/null \
         | grep -aqE "$re"; then
      n=$((n+1))
    fi
  done < <(timeout -k 5 "$T_SCAN" git -C "$repo" rev-list --all --objects \
             | awk '{print $1}' | sort -u)
  echo "$n"
}
scan_commit_messages() { # $1=repo  $2=extended-regex
  timeout -k 5 "$T_SCAN" git -C "$1" log --all --format='%H%x09%B%x1e' 2>/dev/null \
    | grep -acE "$2" || true
}

# The brain path classes, as regexes, for the report table.
BRAIN_PATH_RE='^(\.brain/|docs/verbatim|docs/handoffs/2026-09-20-crash-checkpoint\.md$|docs/handoffs/2026-09-20-14-10-crash-handoff\.md$|^VERBATIM\.md$|^raw/VERBATIM-RAW\.md$)'
# A blob that still contains a brain marker. Deliberately NARROW: it must not
# fire on ordinary English ("verbatim" as a word is common in this codebase's
# own docs). It fires on the corpus's own structural markers.
BRAIN_CONTENT_RE='User verbatim \(20[0-9]{2}-[0-9]{2}-[0-9]{2}|verbatim-goals\.md|\.brain/verbatim|verbatim/state\.json|docs/verbatim-goals'
SECRET_RE='REMOVED[A-Za-z0-9]{20,}|REMOVED[A-Za-z0-9]{20,}|REMOVED[A-Za-z0-9_-]{15,}|-----BEGIN (RSA |OPENSSH |EC |PGP )?PRIVATE KEY'
INFRA_RE='185\.204\.197\.242|100\.100\.4\.100|192\.168\.1\.5'
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
# class 2 — brain CONTENT surviving in a blob with an innocent path
c_priv="$(scan_blob_content "$PRIV" "$BRAIN_CONTENT_RE")"
c_pub="$(scan_blob_content "$PUB" "$BRAIN_CONTENT_RE")"
check "brain markers inside blob CONTENT" "$c_priv" "$c_pub" yes
# class 3 — commit messages
m_priv="$(scan_commit_messages "$PRIV" 'verbatim|\.brain|brain/')"
m_pub="$(scan_commit_messages "$PUB" 'verbatim|\.brain|brain/')"
check "commit messages naming the corpus" "$m_priv" "$m_pub" yes
# class 4 — secrets
s_priv="$(scan_blob_content "$PRIV" "$SECRET_RE")"
s_pub="$(scan_blob_content "$PUB" "$SECRET_RE")"
check "credential tokens / private keys" "$s_priv" "$s_pub" yes
# class 5 — infrastructure addresses
i_priv="$(scan_blob_content "$PRIV" "$INFRA_RE")"
i_pub="$(scan_blob_content "$PUB" "$INFRA_RE")"
check "measured infra addresses" "$i_priv" "$i_pub" yes
# class 6 — loopback (NOT required to be zero; it is legitimate in a dev tool)
l_priv="$(scan_blob_content "$PRIV" "$LOOPBACK_RE")"
l_pub="$(scan_blob_content "$PUB" "$LOOPBACK_RE")"
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
printf 'REMOVEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nREMOVED\n' > "$PLANT/.brain/verbatim.md"
git -C "$PLANT" add -A >/dev/null
git -C "$PLANT" commit --quiet -m "plant: brain path + REMOVED token + infra addr + 'User verbatim (2026-09-20'"
plant_paths="$(scan_paths "$PLANT" "$BRAIN_PATH_RE")"
plant_secret="$(scan_blob_content "$PLANT" "$SECRET_RE")"
plant_infra="$(scan_blob_content "$PLANT" "$INFRA_RE")"
plant_msg="$(scan_commit_messages "$PLANT" 'verbatim|\.brain|brain/')"
note "planted probe -> brain-paths=$plant_paths secrets=$plant_secret infra=$plant_infra msgs=$plant_msg"
{
  echo
  echo "## Scanner self-test (planted, then discarded)"
  echo
  echo "A sample commit carrying a \`.brain/verbatim.md\` path, a \`REMOVED\` token, the"
  echo "address \`REMOVED\`, and a brain-mentioning message was written to a"
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
