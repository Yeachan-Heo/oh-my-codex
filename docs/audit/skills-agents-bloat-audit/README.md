# Skills + agents bloat audit (omx) — 2026-05-23

This directory contains a read-only audit of the `./skills/` and `./src/agents/` surfaces of `oh-my-codex`, produced in response to an owner verbal request for a "comprehensive bloat-audit + connectivity-improvement roadmap." Audit ran on branch `chore/skills-agents-bloat-audit` rooted on `origin/dev`.

## How this audit was produced

1. Enumerated all canonical skills via `find ./skills -maxdepth 2 -name 'SKILL.md'` (46 on disk).
2. Enumerated agents from `src/agents/definitions.ts` (`AGENT_DEFINITIONS`) plus the 3 non-installable prompt assets in `src/agents/policy.ts` (`NON_NATIVE_AGENT_PROMPT_ASSETS`) → 36 total.
3. Pulled authoritative status (`active` / `internal` / `alias` / `merged` / `deprecated`) from `src/catalog/manifest.json` (49 skill rows + 33 agent rows).
4. Per skill: file LOC, last-touched commit (`git log -1 --format='%cs|%s' -- skills/<name>/`), frontmatter description.
5. Per skill and per agent: reference count via `rg -l --no-messages -F '<name>' skills/ src/ prompts/ templates/`, excluding the entry's own directory and own `prompts/<name>.md`.
6. Per skill: which agent names appear textually in its `SKILL.md` body (narrative coupling matrix).
7. Per agent: which skill names appear textually in its `prompts/<name>.md` body.
8. Classified each entry deterministically per the rules in `bloat-audit.md` § header.

Raw intermediate data (per-skill metrics CSV, reference CSVs, the flattened catalog dump, and the combined JSON) was generated in a scratch `notes/` directory during the audit; it is intentionally not committed (those files are reproducible from this repo at any commit by re-running the data collection described above).

## Contents

| File | Purpose | Approx size |
|------|---------|-------------|
| [`inventory.md`](inventory.md) | Deliverable 1 — full table-heavy enumeration of skills + agents, with status, LOC, last-commit, reference counts, and a skill ↔ agent narrative coupling matrix. | ~280 lines |
| [`bloat-audit.md`](bloat-audit.md) | Deliverable 2 — every skill and agent classified into one of: KEEP-AS-IS, CONSOLIDATE, STREAMLINE, DEPRECATE, or AMBIGUOUS. Each entry carries evidence, action, and risk. | ~970 lines |
| [`connectivity-roadmap.md`](connectivity-roadmap.md) | Deliverable 3 — orphan analysis + concrete connectivity-fix proposals (quick wins / medium / strategic) + the suggested PR-by-PR sequence to actually land the cleanup. | ~280 lines |

## Top-line numbers

From `bloat-audit.md` § Summary:

- **Skills (50 catalog entries, 46 on disk):**
  - 18 KEEP-AS-IS (incl. alias + internal)
  - 7 STREAMLINE (optional)
  - 4 CONSOLIDATE — already collapsed
  - 16 DEPRECATE (all already tombstoned to ~10 LOC)
  - 5 AMBIGUOUS — owner decision needed
- **Agents (36 total, 33 in `AGENT_DEFINITIONS`):**
  - 23 KEEP-AS-IS (incl. internal + non-installable asset)
  - 10 CONSOLIDATE (already-merged entries)
  - 2 DEPRECATE
  - 1 AMBIGUOUS — owner decision needed

After the suggested PR-1 + PR-2 land, the surface contracts to ~30 on-disk skills and ~21 agents. See `connectivity-roadmap.md` § 6 — Quick reference.

## Important caveats

- **This audit is opinion + evidence, not a unilateral mandate.** Every classification can be argued against the data. Owner reviews PR-by-PR; nothing is to be deleted in this PR.
- **No files in `./skills/`, `./src/agents/`, `./prompts/`, or any other production surface were modified.** The committed delta is limited to this `docs/audit/skills-agents-bloat-audit/` directory.
- **Reference counts are upper bounds.** Short, English-word names (`ask`, `plan`, `team`, `note`, `review`, `help`) inflate via false positives. The classifier weights structural references (catalog, templates, CLI surfaces) above prose mentions.
- **Tests, benchmarks, and the full suite were NOT run.** Per the audit's scope guardrails. The next PR (PR-1 in the roadmap) is where verification gets reattached.

## Re-running this audit

The data sources listed in § *How this audit was produced* are the entire input set. To re-run on a future commit:

1. Re-execute the 7 enumeration steps (1–7 above) against the new repo state.
2. Re-apply the classifier rules documented at the head of `bloat-audit.md`.
3. Diff the new `inventory.md` against the committed one to see what moved.

Because every classification is a deterministic function of catalog status + LOC + reference counts, the same inputs at a future commit will produce the same labels (modulo new entries appearing or old entries being deleted).

## Next step

Read `bloat-audit.md` for the per-entry triage, then `connectivity-roadmap.md` § 3 for the proposed PR sequence. The owner picks which PRs to authorize; this audit only proposes.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
