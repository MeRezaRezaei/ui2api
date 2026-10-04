#!/usr/bin/env bash
# CONSUMER for the commit-map — the artifact PRODUCE-side scripts only wrote.
#
# WHY THIS EXISTS. scripts/ci/make-public-repo.sh PRODUCES the commit-map and
# docs/RECONSTRUCTION-RUNBOOK.md DESCRIBES how to consume it, but nothing in the
# tree ever EXECUTED the documented format check. That is why the producer's own
# ORIENTATION COMMENT was wrong before 2026-10-01: an unexecuted prose claim is
# an assertion, and an assertion can rot silently. This script is the assertion
# made executable, so a transposed map fails NAMED instead of quietly inverting
# the operator's only reconstruction key.
#
# IT VERIFIES ONE FILE. It runs no git, touches no repository, and mutates
# nothing: it reads the bytes of the map path given as $1 and checks the shape
# docs/RECONSTRUCTION-RUNBOOK.md §2 documents. (It deliberately does NOT run
# filter-repo against the real repo — that is the producer's and P7's job, and
# this consumer must stay safe to run anywhere.)
#
# FORMAT, per the runbook §2 (ground truth, measured rather than believed):
#
#   old                                      new
#   <pre-rewrite sha> <post-rewrite sha>
#
#   * column 0 is `old` — the ORIGINAL commit, the one private-full still carries
#   * column 1 is `new` — the REWRITTEN commit, the one public-sanitized carries
#   * the header is literal: filter-repo writes "%-40s %s" over the strings
#     `old` and `new`, so it is space-padded and split on whitespace
#   * three row shapes are LEGAL: old == new (untouched), new == 40 zeros
#     (PRUNED — the row is PRESENT, this is filter-repo's deleted_hash and the
#     single most misread fact about the artifact), and old != new (rewritten)
#
# A forty-zero column 1 is ACCEPTED here on purpose. It is a real state that a
# real filter-repo run emits, not a corruption; refusing it would make this gate
# fire on good maps and train the operator to ignore it.
#
# NOT VERIFIED HERE, deliberately: that the shas exist, that the two columns are
# the two repositories' histories, and that every source commit has a row. Those
# need the repositories, not the file, and are P7's (test/brain-publication-gate
# .test.ts block P7) job. This script checks the FILE, so it invents no check it
# cannot honestly make.
#
# EXIT: 0 the map conforms; 1 the map does not (with a NAMED reason on stderr);
#      2 usage error. 124 is never produced here — this script runs no unbounded
#      subprocess, so callers still wrap it in `timeout -k 5`.

set -uo pipefail

fail() { printf 'verify-commit-map: %s\n' "$*" >&2; exit 1; }

[ $# -eq 1 ] || { printf 'usage: %s <commit-map-file>\n' "$0" >&2; exit 2; }
MAP="$1"
[ -f "$MAP" ] || fail "not a readable file: \"$MAP\""
[ -r "$MAP" ] || fail "not readable: \"$MAP\""

# --- line 1: the header, and its ORIENTATION -------------------------------
# The header is the whole reason this consumer exists. `old new` is the
# orientation filter-repo's own source emits ("%-40s %s" % (old, new)) and the
# orientation a real run on a 3-commit fixture measured; `new old` is what the
# pre-2026-10-01 comment claimed and is WRONG. Because the header is space
# padded, compare the whitespace-split fields, never the raw line.
IFS=$' \t' read -r -a hdr < "$MAP" || true
[ "${#hdr[@]}" -eq 2 ] || \
  fail "header-orientation (line 1 has ${#hdr[@]} field(s), expected exactly 2): expected \"old  new\", got $(head -n 1 "$MAP" | cat -A | head -c 120)"
[ "${hdr[0]}" = "old" ] || \
  fail "header-orientation (column 0 of line 1 is \"${hdr[0]}\", expected \"old\"): the map is transposed or is not a filter-repo commit-map"
[ "${hdr[1]}" = "new" ] || \
  fail "header-orientation (column 1 of line 1 is \"${hdr[1]}\", expected \"new\"): the map is transposed or is not a filter-repo commit-map"

# --- data rows: exactly 2 sha-shaped fields --------------------------------
# "sha-shaped" = exactly 40 hex chars. This covers all three legal row shapes
# uniformly, INCLUDING the pruned shape (new == 40 zeros, which is hex) — so
# pruning is accepted by construction and needs no exemption, only this comment
# so a future reader does not "fix" it into a rejection.
# Consume line 1 (already read as the header above) so the data loop never
# re-reads it; `exec` keeps the file descriptor and readline sees from line 2.
exec 3< "$MAP"
IFS= read -r _ <&3

n=1; rows=0; untouched=0; pruned=0; rewritten=0
while IFS= read -r line <&3 || [ -n "$line" ]; do
  n=$((n + 1))
  case "$line" in
    ''|' '*|*$'\t') continue ;;   # blank / whitespace-only trailing line: not a row
  esac
  IFS=$' \t' read -r -a f <<< "$line"
  if [ "${#f[@]}" -ne 2 ]; then
    fail "row-shape (line $n has ${#f[@]} field(s), expected exactly 2 — old sha then new sha): \"$line\""
  fi
  for i in 0 1; do
    v="${f[$i]}"
    if [ "${#v}" -ne 40 ] || ! printf '%s' "$v" | grep -qiE '^[0-9a-f]{40}$'; then
      fail "row-shape (line $n column $i is not a 40-char hex sha): \"$v\""
    fi
  done
  rows=$((rows + 1))
  if [ "${f[0]}" = "${f[1]}" ]; then
    untouched=$((untouched + 1))
  elif [ "${f[1]}" = "0000000000000000000000000000000000000000" ]; then
    pruned=$((pruned + 1))     # REAL STATE, not an error — see the header comment
  else
    rewritten=$((rewritten + 1))
  fi
done

[ "$rows" -gt 0 ] || fail "empty-map (header present, zero data rows): this is not a commit-map of any history"

# The counts are reported, not enforced: the runbook's count claim is the very
# prose that was wrong before 2026-10-01, so this consumer prints what it
# measured and trusts the CALLER to derive its own expectation.
printf 'verify-commit-map: OK %s — %d row(s): %d untouched (old==new), %d pruned (new==40 zeros), %d rewritten\n' \
  "$MAP" "$rows" "$untouched" "$pruned" "$rewritten"
exit 0
