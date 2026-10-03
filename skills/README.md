# The ui2api agent-skill family

Four skills that teach an AI agent to **use** ui2api. Not to work on the repo —
that is what the repo's `AGENTS.md` is for. These are for an agent on the other
side of the HTTP API that has never seen this codebase.

## Why they live here and not in `.agents/`

`.agents/` is **gitignored** (`.gitignore:6`). The one skill that used to live
there was never in git, so an agent on any other machine had no ui2api skill at
all — and the untracked copy had already gone stale without anything noticing.

So: `skills/` is the **tracked source of truth**, and `scripts/install-skills.sh`
copies it into whatever agent's skills directory you use. The installed copy is
generated, so it cannot drift from the source. Full rationale, including the
alternatives rejected: `docs/decisions.md` (2026-10-03 entry).

## The family

| Skill | Load it when the agent needs to |
|---|---|
| [`ui2api`](ui2api/SKILL.md) | orient at all — what the tool is, the rules that must never break, and which sibling to read next |
| [`ui2api-chat`](ui2api-chat/SKILL.md) | pick a model, send a prompt, read the answer, pick an account (`/v1/models`, `/prompt`, `/v1/chat/completions`) |
| [`ui2api-capabilities`](ui2api-capabilities/SKILL.md) | use the non-chat tool surface — `/registry` discovery, `/capability/<site>`, honest status |
| [`ui2api-operate`](ui2api-operate/SKILL.md) | run and integrate — daemon lifecycle, readiness, MCP install, and the recovery paths when a site challenges |

Read `ui2api` first; it routes to the other three by name. An agent debugging a
capability runner never has to load the Xvfb posture material, and one choosing a
model never has to read a package manifest.

## Install

```bash
scripts/install-skills.sh              # current user: opencode + claude + codex
scripts/install-skills.sh --project    # also into <project>/.agents/skills
scripts/install-skills.sh --link       # symlink instead of copy (dev)
scripts/install-skills.sh --list       # print targets, install nothing
```

## What keeps them true

`test/skills-truth.test.ts` — five checks, run by `npm run test:unit`:

1. frontmatter is exactly `name` + `description`, and `name` equals the directory
2. every route a skill names is a route the daemon actually registers
3. every `UI2API_*` knob it names exists as a literal in `src/` or `scripts/`
4. every site id it names resolves to a real package or builtin profile
5. no bare count claims, and the anti-rot contract line is present

Each expected set is **derived from the repo at test time** — never hand-typed.
The gate carries mutation tests proving every check fires on a bad input and
stays quiet on honest prose, because a gate that cries wolf gets skipped.

**Rule for authors:** if a fact can be derived, give the command. Never write a
count.