#!/usr/bin/env bash
# Install the ui2api skill family into any agent's skills directory.
#
# The family lives in the TRACKED `skills/` directory (source of truth) because
# `.agents/` is gitignored -- an agent on another machine would otherwise have
# no skill at all. This script copies from that source into the consumer, so the
# copy is generated and can never drift from the source.
#
# Usage:
#   scripts/install-skills.sh                 # install for the current user
#   scripts/install-skills.sh --target DIR    # extra target dir
#   scripts/install-skills.sh --project       # install into <project>/.agents/skills
#   scripts/install-skills.sh --link          # symlink instead of copy (dev)
#   scripts/install-skills.sh --list          # print targets, install nothing
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/skills"
MODE=copy
declare -a TARGETS=()
PROJECT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --link) MODE=link ;;
    --project) PROJECT=1 ;;
    --list) LIST=1 ;;
    --target) TARGETS+=("$2"); shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
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
for t in "${TARGETS[@]}"; do
  mkdir -p "$t"
  echo "-> $t"
  for d in "$SRC"/*/; do
    [ -f "$d/SKILL.md" ] || continue
    name="$(basename "$d")"
    dest="$t/$name"
    rm -rf "$dest"
    mkdir -p "$dest"
    if [ "$MODE" = link ]; then
      ln -s "$d" "$dest"
      echo "   linked  $name"
    else
      cp -R "$d/." "$dest/"
      echo "   copied  $name"
    fi
    installed=$((installed + 1))
  done
done

echo "installed $installed skill dirs into ${#TARGETS[@]} target(s)"
