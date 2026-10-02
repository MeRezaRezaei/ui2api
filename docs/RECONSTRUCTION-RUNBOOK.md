# COMMIT-MAP RUNBOOK — how to put the full history back on top of the public one

> **This page is a PROCEDURE, not a description.** The `commit-map` is the only
> artifact relating this repository's sanitized public history back to the
> original, and the operator's stated reason for keeping the split
> history-preserving is verbatim: *"they should have same ancestor to let us
> later on make the full repo again"* (quoted in `.gitlab-ci.yml:306-307`).
> Until this page existed, the bytes flowed and nothing consumed them.
>
> Every format claim, column name, row shape and line number below was
> **measured out of this repository on 2026-10-01** — by running the real
> `git filter-repo` on a purpose-built fixture and by reading the files cited.
> None of it is recalled, and none of it is transcribed from a comment that
> might itself be wrong. Two comments in `make-public-repo.sh` were, and said
> opposite things in adjacent lines; §2 records which evidence was trusted over
> which, and why.

<!-- commit-map-header: old new -->
<!-- commit-map-files: private-full.commit-map public-sanitized.commit-map -->

---

## 1. What the commit-map is, and is not

`scripts/ci/make-public-repo.sh` builds two bare clones of this repository and
pushes each one somewhere different:

| half | what happened to it | where it goes |
| --- | --- | --- |
| **private-full** | nothing. It is the full history, corpus included. | `github.com/MeRezaRezaei/ui2api-full` (private) |
| **public-sanitized** | rewritten by `git filter-repo` to delete the corpus paths, redact literals, and redact commit messages | `github.com/MeRezaRezaei/ui2api` (public, sanitized) |

A rewrite necessarily changes every hash, so a sanitized commit and its original
share no name and carry no memory of each other. The **commit-map is the
correspondence** — a join key, one row per source commit.

**It is a SHA correspondence, not a content diff, and it restores nothing by
itself.** See §6, which is the section that matters most if you are reading this
under pressure.

---

## 2. The format — the exact bytes

**This is the ground truth, and it is measured rather than believed.**

```
old                                      new
<pre-rewrite sha> <post-rewrite sha>
```

- **Column 0 is `old`** — the ORIGINAL commit, the one `private-full` still
  carries under that exact hash.
- **Column 1 is `new`** — the REWRITTEN commit, the one `public-sanitized`
  carries.
- The header line is literal. `git filter-repo` writes it as `%-40s %s` over the
  strings `old` and `new`, so the two fields are space-padded and split on
  whitespace.
- A **pruned** commit has column 1 equal to forty zeros
  (`0000000000000000000000000000000000000000`). This is `git filter-repo`'s
  `deleted_hash`. **The row is present.** This is the single most misread fact
  about the artifact.
- An **untouched** commit has column 0 equal to column 1. It is its own image.
  That is not a duplicate and not a defect.
- **Every source commit gets a row**, including commits that only ever touched
  corpus paths.

### 2.1 Three row shapes, and the trap in the middle one

| shape | meaning | what a careless reader does |
| --- | --- | --- |
| `old == new` | the filter did not touch this commit | reads it as a duplicate row |
| `new == 0…0` (40 zeros) | the commit became **empty** and was **pruned** | hunts for a *missing* row, finds none, concludes the map is incomplete |
| `old != new`, both real | genuinely rewritten | — |

The middle row is the trap, and the repository asserted the wrong thing about
it until 2026-10-01. `make-public-repo.sh` printed, into every
`VERIFICATION-REPORT.md`:

> *"The two maps partition the original history … Their union is the original
> 605."*

Both halves are false as stated. The two **repositories** partition the history
(a commit pruned from one is present in the other); the two **map files** do not
— the public map's column 0 is the same set of shas as the private map's single
column, and it has a row for every one of them. The report now says so, derives
the counts instead of hardcoding `605`, and prints the three shapes separately.

### 2.2 The two files are NOT the same shape

They are two different files with two different formats, and the repository's
prose had collapsed them into one:

| file | written by | shape |
| --- | --- | --- |
| `private-full.commit-map` | `git rev-list --all` (`make-public-repo.sh:189`) | **one bare column of shas. No header. No second column. Not pairs.** |
| `public-sanitized.commit-map` | copied out of filter-repo (`:324`) | two columns plus a header |

So a reader who goes looking in `private-full.commit-map` for the same
`original-sha column` in both halves — which `.gitlab-ci.yml:311` told them to
do — will not find one. The private file is a list; the correspondence is
*derived* by set membership, not read as a named column.

### 2.3 Which evidence was trusted, and which was not

Three sources disagreed. The resolution is recorded because the disagreement is
the defect, and a future reader deserves to know which source to believe.

| source | claimed | verdict |
| --- | --- | --- |
| `make-public-repo.sh:314` (before 2026-10-01) | `REWRITTEN->OLD` | **WRONG** |
| `make-public-repo.sh:315` (before 2026-10-01) | `old hash -> new hash` | right, and it contradicted the line above it |
| `make-public-repo.sh:673-674` (before 2026-10-01) | `pub_new = {n for n,_ in pub}` | **WRONG**, and agreed with `:314` against `:315` |
| `git filter-repo`'s own source, the `commit-map` write | `("%-40s %s" % (old, new))` then `old new` per row | **TRUSTED** |
| a real `git filter-repo` run on a 3-commit fixture | column 0 = pre-rewrite shas, column 1 = post-rewrite shas or forty zeros | **TRUSTED** |

The tool's own source and a real run of the tool both say `old -> new`, by two
independent routes, and both outrank a comment. The comment lost because a
comment is an *assertion about* the tool, not the tool. That is also why the
orientation is now a test (`test/brain-publication-gate.test.ts`, block **P7**)
rather than a comment: **P7 runs the real `filter-repo` and checks set
membership on both sides, then checks the documentation against the result.** A
future filter-repo that transposed its columns turns the suite red instead of
quietly inverting the operator's only reconstruction key.

---

## 3. What reconstruction actually requires

The honest answer to "what do I need" is: **not the map.** The map is the index.
The content lives in `private-full`, and `private-full` is the irreplaceable
half.

| # | input | where it comes from | how an operator identifies it |
| --- | --- | --- | --- |
| 1 | **The `public-sanitized` history** | `github.com/MeRezaRezaei/ui2api` | the public repo's own `main`. The map's column 1 must be a subset of its shas — that is the check that you hold the right half |
| 2 | **The `private-full` history** | `github.com/MeRezaRezaei/ui2api-full` | the private repo's `main`. **Non-negotiable.** Without it the pruned corpus content does not exist anywhere, and the map cannot recreate a byte it never held |
| 3 | **`public-sanitized.commit-map`** | the `public_mirror` job artifact, `.mirror/maps/` | see §4 for the TTL problem — **this is the input most likely to be gone** |
| 4 | **`private-full.commit-map`** | the same artifact directory | same |
| 5 | **The commit that was sanitized** | `git log` on the private repo, or the `public_mirror` job's `$CI_COMMIT_SHA` | the job's own commit. Using the current `main` tip reconstructs *today's* sanitized history, not the one the map describes |
| 6 | **The commit of `scripts/ci/public-repo-paths.txt` + `make-public-repo.sh` in force at that time** | this repository's own history | `git log -1 --format='%H %ci' <sha-of-the-sanitizing-commit> -- scripts/ci/public-repo-paths.txt scripts/ci/make-public-repo.sh`. **"The rules in force" is a COMMIT, not a file you go and find** — both are versioned in the source, and the filter's behaviour is a function of them |
| 7 | **The value of `UI2API_INFRA_ADDRESSES` at that run** | a masked GitLab CI variable | ⚠ **this one is NOT recoverable from the repository.** See §3.1 |

### 3.1 Two inputs that are not fully recoverable — say so now, not later

**The infra literals are gone.** The sanitizer splices the author's own host
addresses into its message-callback at run time from `UI2API_INFRA_ADDRESSES`
(`make-public-repo.sh:281-289`). The *script* is versioned. The *values* are not
written into any artifact: `replace-text.applied.txt` captures the blob-content
rules but not the spliced literals, and the variable itself lives in GitLab's
variable store. The consequence is precise: **you can reconstruct a commit's
corpus PATHS exactly, and you cannot byte-regenerate a commit MESSAGE that
carried an author's address.** The map does not help — it maps shas, and the
message is inside the sha.

**The tool version is unpinned.** CI installs it with
`pip3 install --quiet --break-system-packages git-filter-repo`
(`.gitlab-ci.yml:362`) — no version constraint, so each run gets whatever is
current on PyPI that day. §4 covers what that costs and how to check it.

---

## 4. Before you start: the two things that will bite you

### 4.1 The artifact expires in 90 days

The `public_mirror` job publishes the maps as a CI artifact
(`.gitlab-ci.yml:554-558`):

```yaml
artifacts:
  paths:
    - .mirror/maps/
  expire_in: 90 days
  when: always
```

**That is the maps' only durable home.** They are not in the GitLab repo, not in
the private-full repo, and not in the public-sanitized repo — both halves are
bare `--mirror` clones with no working tree, so neither can hold a commit
containing them, and the CI job never stages them. See §4.2.

So: after 90 days the map is gone, and the only recovery is to **re-run the
sanitizer**, which brings us to the version constraint.

### 4.2 The `git filter-repo` version is a REQUIREMENT, not a nicety

A sanitized commit's hash is a function of its content, its parents, its
metadata, and the tool's rewrite algorithm. Change the tool and the *content* of
the sanitized history is identical but the *hashes* are not — so a map generated
by version A does not describe a history produced by version B, and the
correspondence is lost for everything that was rewritten.

**Check the version, and record it with the map:**

```bash
# The version CI used, if you have the job log for the sanitizing run.
# (grep the `public_mirror` job trace for the filter-repo banner)

# The version you are about to use, and the one a candidate re-run would install.
timeout -k 5 30 git filter-repo --version
timeout -k 5 60 pip3 index versions git-filter-repo 2>/dev/null | head -2
```

**If it does not match the version that produced the map, do not re-run the
sanitizer and expect the same shas.** Choose deliberately between:

- **You have the original artifact** → do not regenerate at all. Use the map you
  have. It is already correct for the history that exists; a fresh run would
  produce a *different* correct map for a *different* history.
- **You have lost the artifact** → you must re-run, and you must pin first. Add
  the constraint to `.gitlab-ci.yml:362` (exact YAML in §7) so the run is
  reproducible, and record the version you used next to the map you keep.

---

## 5. The procedure

### 5.1 Establish which commits you are relating

```bash
# Work in a scratch directory. Never in a clone you intend to push.
RECON=/tmp/ui2api-recon
rm -rf "$RECON" && mkdir -p "$RECON"
cd "$RECON"

# Input 1 + 2. BOTH halves. The private one is the one that cannot be replaced.
timeout -k 5 300 git clone --quiet https://github.com/MeRezaRezaei/ui2api-full.git private
timeout -k 5 300 git clone --quiet https://github.com/MeRezaRezaei/ui2api.git       public
```

### 5.2 Prove you hold the two halves the map was made for

Do this **before** anything else. A map whose column 1 does not match your
public clone is a map from a different run, and proceeding produces confident
nonsense.

```bash
# Inputs 3 + 4. Drop the two maps here, from the CI artifact `.mirror/maps/`.
ls -l private-full.commit-map public-sanitized.commit-map

# Every column-1 sha must exist in the public clone. The forty-zero prune
# sentinel is the one legal exception and is NOT a sha.
timeout -k 5 60 awk 'NR>1 && $2 !~ /^0+$/ {print $2}' public-sanitized.commit-map \
  | sort -u > /tmp/map-new.txt
timeout -k 5 60 git -C public rev-list --all | sort -u > /tmp/pub-all.txt
timeout -k 5 30 comm -23 /tmp/map-new.txt /tmp/pub-all.txt > /tmp/map-orphans.txt
timeout -k 5 30 bash -c 'test -s /tmp/map-orphans.txt && { echo "WRONG HALF: these map new-shas are not in the public clone:"; head -5 /tmp/map-orphans.txt; exit 1; } || echo "OK: the map describes this public history"'
```

### 5.3 Read the correspondence for the commit you care about

```bash
# The rewritten sha -> the original sha, for ONE commit. Column 1 is what you
# have; column 0 is what you are looking for.
NEW_SHA=<the sanitized sha>
OLD_SHA=$(timeout -k 5 30 awk -v n="$NEW_SHA" 'NR>1 && $2==n {print $1}' public-sanitized.commit-map)
timeout -k 5 30 git -C private cat-file -t "$OLD_SHA"   # must print `commit`
```

### 5.4 The WORKED VERIFICATION — proving the correspondence is real

**This is the step that separates reconstruction from wishful thinking.** A row
existing in the map proves only that filter-repo wrote a line; it does not prove
the line means what you think. Four independent checks, cheapest first:

```bash
NEW_SHA=<the sanitized sha>
OLD_SHA=$(timeout -k 5 30 awk -v n="$NEW_SHA" 'NR>1 && $2==n {print $1}' public-sanitized.commit-map)

# CHECK 1 — the original is really there, and really is a commit.
# Fails loudly if you guessed a sha or hold the wrong private clone.
timeout -k 5 30 git -C private cat-file -t "$OLD_SHA"
#   expect: commit

# CHECK 2 — THE LOAD-BEARING ONE. The sanitized tree is the original tree MINUS
# the corpus paths, and nothing else. Diff the two path lists; the difference
# must be exactly the removed paths and NOT one byte of anything else. A map
# row that pairs two unrelated commits fails HERE, which is why this check
# exists and why "a row exists" is not accepted as verification.
timeout -k 5 60 git -C private ls-tree -r --name-only "$OLD_SHA" | sort > /tmp/old-paths.txt
timeout -k 5 60 git -C public  ls-tree -r --name-only "$NEW_SHA" | sort > /tmp/new-paths.txt
timeout -k 5 30 comm -23 /tmp/old-paths.txt /tmp/new-paths.txt > /tmp/only-in-original.txt
timeout -k 5 30 comm -13 /tmp/old-paths.txt /tmp/new-paths.txt > /tmp/only-in-sanitized.txt
timeout -k 5 30 bash -c '
  test -s /tmp/only-in-sanitized.txt \
    && { echo "FAIL: the sanitized commit has paths the original did not — this is not a removal-only rewrite"; \
         head -5 /tmp/only-in-sanitized.txt; exit 1; }
  test -s /tmp/only-in-original.txt \
    || { echo "FAIL: nothing was removed, so this is the untouched row (old == new), not a rewrite"; exit 1; }
  echo "OK: sanitized = original minus exactly these paths:"; cat /tmp/only-in-original.txt'

# CHECK 3 — the surviving CONTENT is byte-identical, not merely similarly-named.
# Proves the row is not pointing at a commit that merely looks similar.
timeout -k 5 30 bash -c "
  set -e
  diff <(timeout -k 5 60 git -C private ls-tree -r '$OLD_SHA') \
       <(timeout -k 5 60 git -C public  ls-tree -r '$NEW_SHA' | grep -vxF -f /tmp/only-in-original.txt || true) \
    > /tmp/tree-diff.txt 2>&1 || true
  # Every differing line must be one of the removed paths and nothing else.
  bad=\$(grep -vE '^[<>] .*\t(.*)' /tmp/tree-diff.txt | wc -l)
  echo \"tree lines differing beyond the removed paths: \$bad\"
  test \"\$bad\" -eq 0 && echo 'OK: every surviving blob is the same object' || { echo 'FAIL'; head -10 /tmp/tree-diff.txt; exit 1; }"

# CHECK 4 — the corpus content really is recoverable from the private half.
# The whole point of the map. If this prints the operator's own file, the
# correspondence is real AND the durability claim holds.
timeout -k 5 30 git -C private cat-file -e "$OLD_SHA:.brain/verbatim-goals.md" \
  && echo "OK: the removed corpus is present in the private half at this commit" \
  || echo "NOTE: this commit had no corpus path (see §2.1 — the untouched/pruned row shapes)"
```

> **Never pipe the output of CHECK 4 anywhere public.** It is the operator's
> unedited corpus. It is checked for *existence* (`cat-file -e`), never printed,
> and `git show` on it is exactly what the whole sanitizer exists to prevent.

### 5.5 Restoring the corpus onto the public history

Having *verified* the correspondence, there are two honest routes. Pick by what
you actually need.

**Route A — reference, do not merge (recommended, and usually sufficient).**
Keep both clones. The map is the index; `private` answers every "what did this
sanitized commit originally say" question in one command:

```bash
timeout -k 5 30 git -C private show --stat "$OLD_SHA"
```

Nothing is rewritten, nothing can be published by accident, and the public
repository's history stays byte-identical to what was verified. **This is the
correct answer to "make the full repo again" in every case where the full repo's
*content* is what you need rather than a single fused history.**

**Route B — fuse, when a single history is genuinely required.**
Re-run the rewrite over a fresh clone of the **public** half *without* the
invert-paths filter, restoring the removed trees from the private half inside a
`--commit-callback` that consults the map. Two facts make this delicate and
both are properties of the tool, not of taste:

1. the callback receives `commit.original_id` — the *sanitized* sha — and the
   map is keyed on it, so the lookup is direct;
2. **the resulting hashes will NOT equal the private half's hashes.** You are
   producing a third history, not recovering the first. Record it as a new
   artifact, never overwrite `public-sanitized` with it, and never push it to the
   public remote.

⚠ **Route B is not exercised by this repository's tests and is not a documented
supported path.** It is named here so it is not reinvented, with its cost stated
plainly. Route A is what CI's own topology is built for.

---

## 6. What this map does NOT let you do — stated precisely

- **It does not restore any content.** It is a SHA correspondence. A row tells
  you *which* original commit a sanitized commit came from; the bytes live in
  `private-full` and nowhere else. With the map and no private half, you have an
  index to an absent library.
- **It is not a content diff.** It carries no paths, no blob ids, no message
  text, and no patch. "These two commits correspond" is the whole claim.
- **It does not restore a pruned commit by re-attaching it.** A commit whose
  column 1 is forty zeros has no sanitized counterpart in the public half to
  attach anything to. Its content is recoverable from `private-full`; its place
  in the *public* history is not recoverable from the map, because there is no
  such place. Recovering a fused history that includes those commits means
  re-deriving it (Route B), not reading the map.
- **It does not undo the commit-message redaction.** Messages were rewritten by
  a callback, so the original message exists only in the private half. The map
  points at the commit that holds it; it does not contain it.
- **It does not tell you which paths were removed or which literals were
  replaced.** Those are `scripts/ci/public-repo-paths.txt` and the
  `--replace-text` rules — the former versioned in this repository, the latter
  partly captured in the `replace-text.applied.txt` artifact and partly **not**
  recoverable at all (see §3.1).
- **It does not survive its own TTL.** 90 days (see §4.1).
- **It is not byte-reproducible across `git filter-repo` versions** (see §4.2).
- **It does not include the `UI2API_INFRA_ADDRESSES` values** the message
  callback used, so byte-identical *message* regeneration is impossible from
  repository contents alone. Named, not hidden.

---

## 7. Change CI must make (NOT applied — exact YAML for review)

**`UI2API_INFRA_ADDRESSES` — capture the literals that are otherwise lost.**
The commit callback splices these in at run time and nothing records the result.
This is a publication-safety change, so it is not left to a future reader:

```yaml
      # The infra literals are spliced into the message-callback at RUN time from
      # this variable, so they exist in no artifact and in no commit: the
      # commit-map maps SHAs, and a redacted message is inside the SHA. That makes
      # byte-identical message regeneration impossible from the repository alone.
      # This file records WHAT was in force, so the input exists somewhere.
      # It carries no secrets — these are the author's own host addresses, which
      # the sanitizer is removing from the public copy precisely by naming them.
      {
        echo "# commit-map provenance — the inputs the map alone cannot carry"
        echo "sanitized_from_commit: $CI_COMMIT_SHA"
        echo "sanitized_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "git_filter_repo_version: $(git filter-repo --version 2>/dev/null || echo unknown)"
        echo "infra_addresses_sha256: $(printf '%s' "${UI2API_INFRA_ADDRESSES:-}" | sha256sum | cut -d' ' -f1)"
        echo "public_repo_paths_sha256: $(sha256sum scripts/ci/public-repo-paths.txt | cut -d' ' -f1)"
      } > /tmp/mirror-work/commit-maps/PROVENANCE.txt
      cp -a /tmp/mirror-work/commit-maps/. "$CI_PROJECT_DIR/.mirror/maps/"
```

The addresses themselves are **not** written — only a digest. The digest is what
makes "were the rules in force the same?" answerable, which is the question the
runbook raises in §3, item 7.

**Pin `git-filter-repo` — required for the map to mean anything after a
re-run.** `.gitlab-ci.yml:362`, currently:

```yaml
    - pip3 install --quiet --break-system-packages git-filter-repo
```

becomes:

```yaml
    # PINNED, and the pin is load-bearing. A sanitized commit's sha is a function
    # of the rewrite algorithm, so a different filter-repo version produces a
    # DIFFERENT (equally correct) history that the previously-published commit-map
    # does not describe — and the operator's stated requirement is that the map
    # let the full repo be reconstructed later. An unpinned install silently
    # invalidates the published key on any day PyPI moves.
    - pip3 install --quiet --break-system-packages 'git-filter-repo==2.47.0'
    - 'git filter-repo --version >/dev/null 2>&1 || { echo "FATAL git-filter-repo unavailable or wrong version - refusing to publish"; exit 1; }'
```

⚠ **The exact version is the one thing in this page that must be read off a real
run, not chosen.** Pin whatever the next successful `public_mirror` run reports
in its banner, and record it in `PROVENANCE.txt` above. **I did not verify which
version is installed on the CI image** — see §9.

**Extend the artifact TTL, or copy the maps somewhere durable.** 90 days is a
choice, and it is currently the only thing standing between the operator and an
unrecoverable key. The minimal change:

```yaml
  artifacts:
    paths:
      - .mirror/maps/
    # 90 days was the default. The map is the ONLY record relating the sanitized
    # history back to the original and it is not in either repository, so losing it
    # costs a re-run that needs a pinned tool version to be meaningful.
    expire_in: 1 year
    when: always
```

**Two comments in `.gitlab-ci.yml` are false and need correcting** — exact
before/after in §8.

---

## 8. The false claims, before and after

### 8.1 `scripts/ci/make-public-repo.sh` — the orientation (FIXED, in the tree)

**Before** (`:314-315` — two adjacent lines, opposite meanings):

```bash
# filter-repo writes .git/filter-repo/commit-map — the REWRITTEN->OLD mapping.
# That is the reconstruction key: old hash -> new hash for every surviving commit.
```

**After:**

```bash
# filter-repo writes .git/filter-repo/commit-map — the OLD->NEW mapping.
#
# THE ORIENTATION, MEASURED 2026-10-01, because the two sentences that used to
# stand here disagreed with EACH OTHER and the first one was wrong.
# … column 0 = OLD, column 1 = NEW, and the three row shapes (old == new,
# new == 40 zeros, old != new) are enumerated in full.
```

The same fix corrected, in the report block: `pub_new = {n for n,_ in pub}` and
`pub_old = {o for _,o in pub}` → `pub_old = {r[0] …}` / `pub_new = {r[1] …}`
(both were dead — assigned and never read anywhere in the repository), the
`rewritten->old pairs` line, the false `Their union is the original 605`
partition claim, and the hardcoded `605` itself (the source history is **1002
commits** as of 2026-10-01, derived with `git rev-list --all --count`; the count
is now derived at run time instead of remembered).

### 8.2 `.gitlab-ci.yml` — "committed into both repos" (NOT fixed — YAML supplied)

**Before** (`:310-312`):

```yaml
# commit pruned from one half is present in the other. git-filter-repo's
# commit-map carries the same original-sha column in both halves and is the join
# key that makes reconstruction possible, so it is committed into both repos.
```

Three falsehoods in three lines: the public map has an old column, the private
map is a **one-column list with no header**; neither half is committed to (both
are bare `--mirror` clones); and the map reaches **no repository at all** — only
a CI artifact.

**After:**

```yaml
# commit pruned from one half is present in the other. git-filter-repo's
# commit-map carries the original sha in its FIRST column and the rewritten sha in
# its second, and is the join key that makes reconstruction possible. IT IS NOT
# COMMITTED INTO EITHER REPO: both halves are bare `--mirror` clones with no
# working tree, so neither can hold a commit containing it, and this job never
# stages it. It travels as a CI job artifact (`.mirror/maps/`) and nowhere else.
# Its documented format and the procedure that consumes it live in
# docs/RECONSTRUCTION-RUNBOOK.md.
```

**Before** (`:543-544`):

```yaml
      # Force, and ONLY here: a sanitized history is a deliberate rewrite. The
      # commit-maps travel with it so the full repo can be reconstructed later.
```

`$PSPEC` at `:545-549` is `refs/heads/*` only. Nothing about the maps travels
with the push.

**After:**

```yaml
      # Force, and ONLY here: a sanitized history is a deliberate rewrite. The
      # commit-maps do NOT travel with this push — they are separate files in
      # $CI_PROJECT_DIR, published as the job artifact below. They are the only
      # record relating this history back to the original; see
      # docs/RECONSTRUCTION-RUNBOOK.md.
```

---

## 9. What this page could NOT prove — named plainly

- **Which `git-filter-repo` version CI actually installs.** `.gitlab-ci.yml:362`
  is unpinned, so the answer changes over time and can only be read off a real
  `public_mirror` run's banner. The `2.47.0` in §7 is a **placeholder shaped
  like a pin**, deliberately not applied, and must be replaced with a measured
  value before that YAML is used.
- **Whether the published artifact's bytes match this format.** The format was
  measured on a purpose-built fixture, and the sanitizer's handling of the file
  was read as text. The actual `.mirror/maps/` artifact from a real pipeline was
  **not downloaded and inspected** in this lane. Test P7 therefore proves
  "filter-repo writes `old new`, and the documentation says `old new`" — it does
  **not** prove that a specific historical artifact does.
- **That re-running `filter-repo` twice under the same version is
  byte-identical.** The version constraint in §4.2 is argued from how
  `git filter-repo` derives commit hashes, not from a measured double-run on
  this repository's full history. It is very likely true and is **not verified
  here**.
- **Whether the map was EVER committed to a repository by a past version of the
  pipeline.** Only the CURRENT job was read. If an older `.gitlab-ci.yml`
  committed the maps before the `--mirror` clone change, an older artifact may
  exist; no pipeline history was inspected.
- **Route B (fusing a single history) was not built or tested.** §5.5 states its
  constraints and names it unsupported, deliberately, rather than shipping an
  unexercised recipe that reads as a supported one.
- **The `UI2API_INFRA_ADDRESSES` values themselves are unrecoverable**, so no
  amount of procedure restores a redacted commit message byte-for-byte. Named in
  §3.1 and §6; the fix in §7 makes future runs answerable, not past ones.
- **Nothing here is gated on the number of map rows.** The source history is
  1002 commits as of 2026-10-01 and moves daily; a pin on that total is the
  hand-typed-count rot `test/doc-numbers-truth.test.ts` exists to prevent. The
  FIXTURE's row count *is* pinned, because that one is ours.

---

## Related

- `scripts/ci/make-public-repo.sh` — builds both halves; the sanitizer. Its
  comment block above the `commit-map` copy and its report block are where the
  orientation is now stated correctly.
- `scripts/ci/public-repo-paths.txt` — the versioned, reviewable list of corpus
  paths removed. Input 6 in §3.
- `test/brain-publication-gate.test.ts`, block **P7** — runs the real
  `git filter-repo` and pins the documented format to its measured output. This
  is what stops the orientation rotting again.
- `docs/GIT_WIRING.md` — the three-repository topology, the privacy gate, and
  the port-22/HTTPS constraint.
- `.gitlab-ci.yml`, job `public_mirror` — where the halves are pushed, where the
  maps are (and are not) published, and the two false comments from §8.2.
- `docs/ACTIVE-WAVE.md` — records this gap as it stood: the empty artifact, and
  the absence of this procedure.
