#!/usr/bin/env bash
# READ THIS FIRST AFTER ANY INTERRUPT. This file exists because the operator
# stopped the session several times and every stop cost a restart from nothing.
#
# Everything below is DERIVED from the tree, the CI API and the goals index —
# never from a subagent's memory, because subagent results do not survive an
# interrupt and a plan that lives only in a dead context is a plan that has to
# be reinvented. Run it and you are caught up in one command.
#
#   bash scripts/ops/resume-state.sh
#
set -uo pipefail
cd "$(dirname "$0")/../.."

export GITLAB_HOST=gitlab.pubg-sell.ir
say() { printf '%s\n' "$*"; }
q()   { timeout -k 15 40 "$@" 2>/dev/null; }

say "=============================================================="
say " ui2api — RESUME STATE      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "=============================================================="

say ""
say "TREE"
say "  HEAD        : $(git log --oneline -1 2>/dev/null)"
say "  dirty files : $(git status --porcelain | wc -l)"
if [ "$(git status --porcelain | wc -l)" -gt 0 ]; then
  git status --porcelain | head -10 | sed 's/^/    /'
  say "    ^ UNCOMMITTED. Another lane may be mid-write; do not git add -A."
fi
# MEASURED DEFECT, fixed here: the count came from
# `git log --oneline <ref>..HEAD 2>/dev/null | wc -l`. A MISSING ref makes git
# fail, stderr was swallowed, and `wc -l` printed 0 — so a ref that does not
# resolve at all was reported as "0 commit(s) unpushed", which asserts the exact
# opposite of the truth (measured: `git log --oneline gitlab/no-such-ref..HEAD
# 2>/dev/null | wc -l` -> 0, exit 0). An unpushed-commit count of zero is a
# green light on a remote that may not exist; it is now UNKNOWN with the reason.
if git rev-parse --verify --quiet gitlab/main >/dev/null 2>&1; then
  say "  unpushed    : $(git log --oneline gitlab/main..HEAD 2>/dev/null | wc -l) commit(s) vs gitlab/main"
else
  say "  unpushed    : UNKNOWN — gitlab/main does not resolve as a ref here, so the count CANNOT be computed"
  say "                (this is not '0 unpushed': a missing ref used to print 0 and read as green. Fix the remote, then re-run.)"
fi

say ""
say "CI (last 8 pipelines, newest first)"
q glab api "projects/5/pipelines?per_page=8" > /tmp/_rs_pipes.json 2>/dev/null
if [ -s /tmp/_rs_pipes.json ]; then
  python3 -c '
import json
for p in json.load(open("/tmp/_rs_pipes.json")):
    print("  %6d  %-9s %s  %s" % (p["id"], p["status"], p["sha"][:8], p["created_at"][:16]))' 2>/dev/null \
    || say "  (pipeline JSON unparseable)"
else
  say "  (GitLab API unreachable — check GITLAB_HOST and auth)"
fi

say ""
say "OPEN GOALS in .brain/verbatim-goals.md"
grep -c '^- \[ \] GOAL' .brain/verbatim-goals.md 2>/dev/null | sed 's/^/  open: /'
grep -o '^- \[ \] GOAL [0-9]*:.\{0,72\}' .brain/verbatim-goals.md 2>/dev/null | head -12 | sed 's/^/    /'

say ""
say "RECENT WORK (this is the part a lost context would forget)"
git log --oneline -14 | sed 's/^/  /'

say ""
say "TOPOLOGY (verify before touching any of it — this has bitten twice)"
say "  GitLab   MeRezaRezaei/ui2api      ACTOR, full history, .brain tracked"
say "  PUBLIC   MeRezaRezaei/ui2api      SANITIZED, public, verified 0 on every class"
say "  PRIVATE  MeRezaRezaei/ui2api-full  complete record: 3 branches, 30 tags, .brain intact"
say "  PRIVATE  MeRezaRezaei/operator-brain"

say ""
say "THE FIVE RULES THAT WERE LEARNED THE HARD WAY (each one cost a real failure)"
say "  1. 'origin' must NOT have a GitHub push URL. A direct push writes the full"
say "     corpus into the public destination and races the sanitized mirror."
say "     Check: git remote get-url --push --all origin   -> GitLab ONLY"
say "  2. Releases tag FULL-history SHAs, so they go to \$GITHUB_FULL_REPO. A tag"
say "     naming a SHA that filter-repo rewrote pins whatever was already there."
say "  3. Audit ALL refs of the public destination before any flip, and for ALL FOUR"
say "     corpus prefixes: .brain/ docs/verbatim* VERBATIM.md raw/VERBATIM*"
say "     A check narrower than the class it checks is a check that PASSES."
say "  4. This repo has TWO tsc projects. 'typecheck clean' is a claim about one."
say "     npx tsc --noEmit  AND  npx tsc --noEmit -p tsconfig.test.json"
say "  5. An empty CI variable is a REAL WEAKER STATE, never a pass. It prints and"
say "     it skips with a named reason."

say ""
say "VERIFICATION COMMANDS (bounded; run per-file, the full suite is slow here)"
say "  npx tsc --noEmit && npx tsc --noEmit -p tsconfig.test.json"
say "  npm run check:verbatim && npm run check:verbatim:goals"
say "  npm run test:unit          # ~2000 tests, several minutes"
say ""
say "NEXT: read the open goals above, then dispatch parallel lanes — do NOT"
say "re-derive this state by re-reading history. It is written down on purpose."
say "=============================================================="
