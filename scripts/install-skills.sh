#!/usr/bin/env bash
# Install the ui2api skill family into any agent's skills directory.
#
# The family lives in the TRACKED `skills/` directory (source of truth) because
# `.agents/` is gitignored -- an agent on another machine would otherwise have
# no skill at all. This script copies from that source into the consumer, so the
# copy is generated and can never drift from the source.
#
# --- usage-begin ---
# Usage:
#   scripts/install-skills.sh                 # install for the current user
#   scripts/install-skills.sh --target DIR    # extra target dir
#   scripts/install-skills.sh --project       # install into <project>/.agents/skills
#   scripts/install-skills.sh --link          # symlink instead of copy (dev)
#   scripts/install-skills.sh --list          # print targets, install nothing
# --- usage-end ---
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/skills"
MODE=copy
declare -a TARGETS=()
PROJECT=0

# `--help` extracts the block BETWEEN THE MARKERS, not a line range. It used to run
# `sed -n '2,16p'`, which reached past the comment and printed `set -euo pipefail` as
# if it were usage — and any header edit would have silently shifted the range again,
# which is the same "a number in a script rots" defect class this repo keeps gates
# for. Markers move with the text they wrap, so editing the header cannot leak code.
usage() {
  local text
  text="$(awk '
    /^# --- usage-begin ---$/ { inside = 1; next }
    /^# --- usage-end ---$/   { inside = 0 }
    inside { sub(/^# ?/, ""); print }
  ' "${BASH_SOURCE[0]}")"
  # An empty extraction means the markers are gone or renamed. Printing nothing and
  # exiting 0 would be a help that silently teaches nothing, so fail LOUD instead.
  if [ -z "$text" ]; then
    echo "install-skills.sh: usage markers not found in this script's header" >&2
    return 1
  fi
  printf '%s\n' "$text"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --link) MODE=link ;;
    --project) PROJECT=1 ;;
    --list) LIST=1 ;;
    --target) TARGETS+=("$2"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# Skills are named so an agent's loader picks them up by directory name; every
# install target receives the whole family, not a subset.
[ ${#TARGETS[@]} -eq 0 ] && TARGETS+=(
  "$HOME/.config/opencode/skills"
  "$HOME/.claude/skills"
  "$HOME/.codex/skills"
)
[ "$PROJECT" = 1 ] && TARGETS+=("$ROOT/.agents/skills")

# --list must install NOTHING. It used to fall through and install anyway, which
# is the worst possible failure for a flag whose whole promise is "install
# nothing" -- and piping it to `head` made it die mid-run, leaving a PARTIAL
# install that looked complete.
if [ "${LIST:-0}" = 1 ]; then
  echo "would install into ${#TARGETS[@]} target(s):"
  for t in "${TARGETS[@]}"; do echo "  $t"; done
  echo "skills: $(cd "$SRC" && ls -1d */SKILL.md 2>/dev/null | sed 's#/SKILL.md##' | tr '\n' ' ')"
  exit 0
fi

installed=0
failed=0
for t in "${TARGETS[@]}"; do
  mkdir -p "$t"
  echo "-> $t"
  for d in "$SRC"/*/; do
    [ -f "$d/SKILL.md" ] || continue
    name="$(basename "$d")"
    # The glob leaves a trailing slash on $d; `ln -s` must be handed the DIRECTORY
    # itself, or the link it creates is named after the slash-trailing form.
    src="${d%/}"
    dest="$t/$name"
    # `rm -rf` on an existing symlink removes the LINK, not the source it points at,
    # so re-running over a linked target is idempotent instead of nesting.
    rm -rf "$dest"
    if [ "$MODE" = link ]; then
      # The destination must BE the symlink. `mkdir -p "$dest"` first (as this did)
      # made it a real directory CONTAINING a nested link, so `dest/SKILL.md` never
      # resolved and the script printed `linked <name>` over a destination no agent
      # could load. Linking straight onto $dest is what makes <dest>/SKILL.md resolve.
      if ln -s "$src" "$dest" && [ -f "$dest/SKILL.md" ]; then
        echo "   linked  $name"
      else
        # Never claim success over a destination that does not resolve, and never
        # leave the half-made entry behind for the next run to trip over.
        rm -rf "$dest"
        echo "   FAILED  $name (symlink into $t does not resolve — nothing installed)" >&2
        failed=$((failed + 1))
        continue
      fi
    else
      mkdir -p "$dest"
      cp -R "$src/." "$dest/"
      echo "   copied  $name"
    fi
    installed=$((installed + 1))
  done
done

echo "installed $installed skill dirs into ${#TARGETS[@]} target(s)"

# A destination that would not resolve is a FAILED install, and reporting success
# over one is how `--link` shipped broken for so long: exit nonzero so a caller
# cannot mistake a partial install for a complete one.
if [ "$failed" -gt 0 ]; then
  echo "FAILED $failed skill dir(s) — nothing was installed for them; see the FAILED lines above" >&2
  exit 1
fi
