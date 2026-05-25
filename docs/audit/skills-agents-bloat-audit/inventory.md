# Inventory — skills + agents (omx)

Generated 2026-05-23. Data sources: `src/catalog/manifest.json`, `src/agents/definitions.ts`, `git log -1 -- skills/<name>/`, and `rg -l --no-messages -F '<name>' skills/ src/ prompts/ templates/`.

- **Total skills**: 50 (46 on disk + 4 merged-only in manifest).
- **Total agents**: 36 (33 in `AGENT_DEFINITIONS` + 3 non-installable prompt assets: `explore-harness`, `sisyphus-lite`, `team-orchestrator`).
- **Catalog statuses** (`src/catalog/schema.ts`): `active` | `internal` | `alias` | `merged` | `deprecated`.
- **Shipped surface** is `plugins/oh-my-codex/skills/` (29 dirs). Anything in `./skills/` but not in `./plugins/oh-my-codex/skills/` is a *catalog-only shadow* (kept on disk to preserve the public/catalog contract while no longer being installed).

Conventions in the tables below:

- `ref_count` = number of files (outside the skill/agent's own directory and outside its own prompts/*.md) matching the literal name via `rg -l -F`. False positives are possible for short, English-word names (e.g. `ask`, `plan`, `note`, `help`, `review`, `team`). Treat these as upper bounds; structural references in `src/catalog/*`, `templates/`, and `src/cli/*` are the most load-bearing.
- `shipped` = directory exists under `plugins/oh-my-codex/skills/`.
- `last_commit` = `%cs %s` of the newest commit that touched the skill directory (`git log -1 --format='%cs|%s' -- skills/<name>/`). For agents, the relevant signal lives in `src/agents/definitions.ts` (single file) plus the agent's `prompts/<name>.md`; per-agent commit dates were not separately rolled up because the central `definitions.ts` aggregates them.

## Skills

Sorted alphabetically. All paths relative to repo root.

| # | skill | status | canonical | category | shipped | LOC | last_commit (date \| msg head) | refs | description (head) |
|---|-------|--------|-----------|----------|---------|-----|--------------------------------|------|--------------------|
| 1 | `ai-slop-cleaner` | active | — | shortcut | yes | 148 | 2026-05-08 \| docs: add UI design anti-slop signals (#2168) | 16 | Run an anti-slop cleanup/refactor/deslop workflow |
| 2 | `analyze` | active | — | shortcut | yes | 146 | 2026-05-10 \| chore(skills): prune obsolete catalog entries | 28 | Run read-only deep repository analysis and return a ranked synthesis with explic |
| 3 | `ask` | active | — | shortcut | yes | 58 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 295 | Ask a local external advisor CLI (Claude or Gemini) and capture a reusable artif |
| 4 | `ask-claude` | deprecated | — | shortcut | no | 12 | 2026-05-10 \| chore(skills): prune obsolete catalog entries | 9 | Deprecated compatibility shim for Claude advisor requests |
| 5 | `ask-gemini` | deprecated | — | shortcut | no | 12 | 2026-05-10 \| chore(skills): prune obsolete catalog entries | 10 | Deprecated compatibility shim for Gemini advisor requests |
| 6 | `autopilot` | active | — | execution | yes | 205 | 2026-05-22 \| Guard autopilot ralplan consensus handoff (review fixes) (#2 | 65 | [OMX] Strict autonomous loop: $deep-interview -> $ralplan -> $ultragoal (+ $team |
| 7 | `autoresearch` | active | — | execution | yes | 72 | 2026-05-22 \| Clarify research planning boundaries | 72 | Stateful validator-gated research loop with native-hook persistence |
| 8 | `autoresearch-goal` | active | — | execution | yes | 36 | 2026-05-22 \| Clarify research planning boundaries | 20 | Durable professor-critic research workflow over Codex goal mode without reviving |
| 9 | `best-practice-research` | active | — | planning | yes | 83 | 2026-05-22 \| Clarify research planning boundaries | 12 | [OMX] Bounded best-practice research wrapper using official/upstream evidence fi |
| 10 | `build-fix` | deprecated | — | shortcut | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 8 | Build Fix deprecated shim |
| 11 | `cancel` | active | — | utility | yes | 399 | 2026-05-20 \| Make autopilot default to Ultragoal | 67 | Cancel any active OMX mode (autopilot; ralph; ultrawork; ecomode; ultraqa; swarm |
| 12 | `code-review` | active | code-reviewer | shortcut | yes | 288 | 2026-05-11 \| Prefer CLI-first OMX setup over MCP defaults (#2258) | 54 | Run a comprehensive code review |
| 13 | `configure-discord` | merged | configure-notifications | utility | — | — | — (no dir) | 0 |  |
| 14 | `configure-notifications` | active | — | utility | yes | 287 | 2026-04-13 \| Release 0.12.6 | 6 | Configure OMX notifications - unified entry point for all platforms |
| 15 | `configure-openclaw` | merged | configure-notifications | utility | — | — | — (no dir) | 0 |  |
| 16 | `configure-slack` | merged | configure-notifications | utility | — | — | — (no dir) | 0 |  |
| 17 | `configure-telegram` | merged | configure-notifications | utility | — | — | — (no dir) | 0 |  |
| 18 | `deep-interview` | active | — | planning | yes | 490 | 2026-05-21 \| Prefer Ultragoal for durable follow-up guidance | 74 | Socratic deep interview with mathematical ambiguity gating before execution |
| 19 | `deepsearch` | deprecated | — | shortcut | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 5 | Deepsearch deprecated shim |
| 20 | `design` | active | designer | shortcut | yes | 180 | 2026-05-11 \| Establish DESIGN.md as the canonical design workflow | 62 | Canonical repo-local DESIGN.md workflow for product; UI/UX; and frontend decisio |
| 21 | `doctor` | active | — | utility | yes | 239 | 2026-05-11 \| Prefer CLI-first OMX setup over MCP defaults (#2258) | 34 | Diagnose and fix oh-my-codex installation issues |
| 22 | `ecomode` | deprecated | — | execution | no | 114 | 2026-05-11 \| Prefer CLI-first OMX setup over MCP defaults (#2258) | 10 | Ecomode deprecated shim |
| 23 | `frontend-ui-ux` | deprecated | — | shortcut | no | 16 | 2026-05-11 \| Establish DESIGN.md as the canonical design workflow | 10 | Deprecated compatibility shim for frontend UI/UX work; use $design or $visual-ra |
| 24 | `git-master` | alias | git-master | shortcut | no | 27 | 2026-05-10 \| chore(skills): prune obsolete catalog entries | 8 | Git expert for atomic commits; rebasing; and history management |
| 25 | `help` | deprecated | — | utility | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 161 | Help deprecated skill |
| 26 | `hud` | active | — | utility | yes | 98 | 2026-03-11 \| draft: bootstrap Rust CLI parity harness and initial omx com | 86 | Show or configure the OMX HUD (two-layer statusline) |
| 27 | `note` | deprecated | — | utility | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 74 | Note deprecated shim |
| 28 | `omx-setup` | active | — | utility | yes | 135 | 2026-05-21 \| Unblock plugin-scoped hooks from verifier | 15 | Setup and configure oh-my-codex using current CLI behavior |
| 29 | `performance-goal` | active | — | execution | yes | 65 | 2026-05-05 \| Protect goal workflows with snapshot reconciliation | 18 | Run an evaluator-gated performance optimization workflow over Codex goal mode wi |
| 30 | `pipeline` | active | — | execution | yes | 97 | 2026-05-22 \| Guard autopilot ralplan consensus handoff (review fixes) (#2 | 32 | Configurable pipeline orchestrator for sequencing stages |
| 31 | `plan` | active | — | planning | yes | 277 | 2026-05-22 \| Clarify research planning boundaries | 204 | Strategic planning with optional interview workflow |
| 32 | `prometheus-strict` | active | — | planning | yes | 219 | 2026-05-23 \| feat(prometheus-strict): require second planning round | 11 | [OMX] Clean-room interview-driven planner: Metis clarifies; Momus challenges; Or |
| 33 | `ralph` | active | — | execution | yes | 294 | 2026-05-19 \| fix(ralph): enforce completion audit state contract (#2385) | 141 | Self-referential loop until task completion with architect verification |
| 34 | `ralph-init` | deprecated | — | utility | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 6 | Ralph Init deprecated skill |
| 35 | `ralplan` | active | plan | planning | yes | 187 | 2026-05-23 \| Merge branch 'dev' into omx-issue-2453-ralplan-ultragoal-doc | 77 | Alias for $plan --consensus |
| 36 | `review` | deprecated | — | shortcut | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 163 | Deprecated standalone review skill |
| 37 | `security-review` | deprecated | — | shortcut | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 8 | Deprecated standalone security review skill |
| 38 | `skill` | active | — | utility | yes | 836 | 2026-05-11 \| Establish DESIGN.md as the canonical design workflow | 160 | Manage local skills - list; add; remove; search; edit; setup wizard |
| 39 | `swarm` | deprecated | — | execution | no | 12 | 2026-05-10 \| chore(skills): prune obsolete catalog entries | 17 | Deprecated compatibility shim for team execution |
| 40 | `tdd` | deprecated | — | shortcut | no | 104 | 2026-05-11 \| Prefer CLI-first OMX setup over MCP defaults (#2258) | 6 | TDD deprecated shim |
| 41 | `team` | active | — | execution | yes | 520 | 2026-05-21 \| Prefer Ultragoal for durable follow-up guidance | 270 | N coordinated agents on shared task list using tmux-based orchestration |
| 42 | `trace` | deprecated | — | utility | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 41 | Trace deprecated shim |
| 43 | `ultragoal` | active | — | execution | yes | 131 | 2026-05-20 \| Avoid noisy fresh-session guidance in Ultragoal | 68 | Create and execute durable repo-native multi-goal plans over Codex goal mode art |
| 44 | `ultraqa` | active | — | execution | yes | 254 | 2026-05-11 \| Ensure UltraQA catches adversarial e2e regressions (#2276) | 36 | Adversarial dynamic e2e QA workflow - generate hostile scenarios; test; verify;  |
| 45 | `ultrawork` | active | — | execution | yes | 175 | 2026-05-20 \| Make autopilot default to Ultragoal | 46 | Parallel execution engine for high-throughput task completion |
| 46 | `visual-ralph` | active | designer | shortcut | yes | 161 | 2026-05-11 \| Establish DESIGN.md as the canonical design workflow | 17 | Visual Ralph orchestration for frontend UI from generated references; static ref |
| 47 | `visual-verdict` | deprecated | — | shortcut | no | 10 | 2026-05-06 \| Retire obsolete OMX skills (#2132) | 9 | Visual Verdict deprecated skill |
| 48 | `web-clone` | deprecated | — | shortcut | no | 357 | 2026-05-10 \| chore(skills): prune obsolete catalog entries | 10 | Web Clone deprecated shim |
| 49 | `wiki` | NOT_IN_MANIFEST | — | — | yes | 57 | 2026-05-11 \| Prefer CLI-first OMX setup over MCP defaults (#2258) | 43 | Persistent markdown project wiki stored under repository omx_wiki with keyword s |
| 50 | `worker` | internal | — | utility | yes | 106 | 2026-03-17 \| fix: stop generating skill agents (#897) | 165 | Team worker protocol (ACK; mailbox; task lifecycle) for tmux-based OMX teams |

### Skill cross-reference detail

Selected breakdowns of skill → referencing files. Skills with ref_count ≤ 15 are fully expanded; high-ref skills are summarized as counts-by-kind to keep the table digestible.

| skill | status | refs_total | in_other_skills | in_prompts | in_src_ts | in_src_tests | in_templates | full_list (only if ≤ 15) |
|-------|--------|------------|-----------------|------------|-----------|--------------|--------------|---------------------------|
| `ai-slop-cleaner` | active | 16 | 2 | 0 | 5 | 8 | 1 | *(>15, see refs_by_kind columns)* |
| `analyze` | active | 28 | 3 | 5 | 8 | 11 | 1 | *(>15, see refs_by_kind columns)* |
| `ask` | active | 295 | 40 | 36 | 112 | 106 | 1 | *(>15, see refs_by_kind columns)* |
| `ask-claude` | deprecated | 9 | 1 | 0 | 3 | 4 | 1 | `skills/ask/SKILL.md`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/__tests__/schema.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-scope.test.ts`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/scripts/ask-claude.sh`<br>`templates/catalog-manifest.json` |
| `ask-gemini` | deprecated | 10 | 1 | 0 | 3 | 5 | 1 | `skills/ask/SKILL.md`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/__tests__/schema.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/ask.test.ts`<br>`src/cli/__tests__/setup-scope.test.ts`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/scripts/ask-gemini.sh`<br>`templates/catalog-manifest.json` |
| `autopilot` | active | 65 | 9 | 1 | 24 | 30 | 1 | *(>15, see refs_by_kind columns)* |
| `autoresearch` | active | 72 | 4 | 1 | 34 | 32 | 1 | *(>15, see refs_by_kind columns)* |
| `autoresearch-goal` | active | 20 | 3 | 1 | 6 | 9 | 1 | *(>15, see refs_by_kind columns)* |
| `best-practice-research` | active | 12 | 4 | 0 | 3 | 4 | 1 | `skills/autoresearch/SKILL.md`<br>`skills/deep-interview/SKILL.md`<br>`skills/plan/SKILL.md`<br>`skills/ralplan/SKILL.md`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/best-practice-research-skill.test.ts`<br>`src/hooks/__tests__/keyword-detector.test.ts`<br>`src/hooks/__tests__/research-workflow-boundaries.test.ts`<br>`src/hooks/keyword-registry.ts`<br>`src/scripts/__tests__/docs-site-contract.test.ts`<br>`templates/catalog-manifest.json` |
| `build-fix` | deprecated | 8 | 0 | 1 | 4 | 2 | 1 | `prompts/build-fixer.md`<br>`src/agents/__tests__/definitions.test.ts`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/team/role-router.ts`<br>`src/utils/__tests__/agents-model-table.test.ts`<br>`templates/catalog-manifest.json` |
| `cancel` | active | 67 | 8 | 2 | 33 | 23 | 1 | *(>15, see refs_by_kind columns)* |
| `code-review` | active | 54 | 6 | 8 | 21 | 18 | 1 | *(>15, see refs_by_kind columns)* |
| `configure-notifications` | active | 6 | 1 | 0 | 2 | 2 | 1 | `skills/omx-setup/SKILL.md`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-skills-overwrite.test.ts`<br>`src/hooks/__tests__/openclaw-setup-contract.test.ts`<br>`templates/catalog-manifest.json` |
| `deep-interview` | active | 74 | 8 | 0 | 26 | 39 | 1 | *(>15, see refs_by_kind columns)* |
| `deepsearch` | deprecated | 5 | 1 | 0 | 2 | 1 | 1 | `skills/doctor/SKILL.md`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/task-size-detector.test.ts`<br>`templates/catalog-manifest.json` |
| `design` | active | 62 | 8 | 17 | 21 | 15 | 1 | *(>15, see refs_by_kind columns)* |
| `doctor` | active | 34 | 2 | 0 | 16 | 15 | 1 | *(>15, see refs_by_kind columns)* |
| `ecomode` | deprecated | 10 | 3 | 0 | 3 | 3 | 1 | `skills/cancel/SKILL.md`<br>`skills/hud/SKILL.md`<br>`skills/ultrawork/SKILL.md`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/codex-plugin-layout.test.ts`<br>`src/cli/__tests__/setup-skills-overwrite.test.ts`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/modes/base.ts`<br>`templates/catalog-manifest.json` |
| `frontend-ui-ux` | deprecated | 10 | 1 | 0 | 4 | 4 | 1 | `skills/skill/SKILL.md`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-skills-overwrite.test.ts`<br>`src/hooks/__tests__/design-skill.test.ts`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/hooks/keyword-detector.ts`<br>`src/hooks/keyword-registry.ts`<br>`templates/catalog-manifest.json` |
| `git-master` | alias | 8 | 1 | 0 | 4 | 2 | 1 | `skills/skill/SKILL.md`<br>`src/agents/__tests__/definitions.test.ts`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `help` | deprecated | 161 | 6 | 9 | 49 | 96 | 1 | *(>15, see refs_by_kind columns)* |
| `hud` | active | 86 | 3 | 0 | 42 | 40 | 1 | *(>15, see refs_by_kind columns)* |
| `note` | deprecated | 74 | 15 | 8 | 24 | 26 | 1 | *(>15, see refs_by_kind columns)* |
| `omx-setup` | active | 15 | 1 | 0 | 2 | 11 | 1 | `skills/help/SKILL.md`<br>`src/catalog/__tests__/plugin-bundle-ssot.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/codex-plugin-layout.test.ts`<br>`src/cli/__tests__/setup-agents-overwrite.test.ts`<br>`src/cli/__tests__/setup-gh-star.test.ts`<br>`src/cli/__tests__/setup-hooks-shared-ownership.test.ts`<br>`src/cli/__tests__/setup-install-mode.test.ts`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/cli/__tests__/setup-refresh.test.ts`<br>`src/cli/__tests__/setup-scope.test.ts`<br>`src/cli/__tests__/setup-skill-validation.test.ts`<br>`src/cli/__tests__/setup-skills-overwrite.test.ts`<br>`templates/catalog-manifest.json` |
| `performance-goal` | active | 18 | 3 | 1 | 6 | 7 | 1 | *(>15, see refs_by_kind columns)* |
| `pipeline` | active | 32 | 7 | 1 | 14 | 9 | 1 | *(>15, see refs_by_kind columns)* |
| `plan` | active | 204 | 24 | 18 | 74 | 84 | 3 | *(>15, see refs_by_kind columns)* |
| `prometheus-strict` | active | 11 | 0 | 1 | 4 | 5 | 1 | `prompts/prometheus-strict-metis.md`<br>`src/agents/__tests__/definitions.test.ts`<br>`src/agents/__tests__/native-config.test.ts`<br>`src/agents/definitions.ts`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/keyword-detector.test.ts`<br>`src/hooks/__tests__/prometheus-strict-contract.test.ts`<br>`src/hooks/keyword-registry.ts`<br>`templates/catalog-manifest.json` |
| `ralph` | active | 141 | 20 | 1 | 43 | 76 | 1 | *(>15, see refs_by_kind columns)* |
| `ralph-init` | deprecated | 6 | 0 | 0 | 2 | 3 | 1 | `src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/ralph-prd-deep-interview.test.ts`<br>`src/cli/__tests__/setup-skills-overwrite.test.ts`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`templates/catalog-manifest.json` |
| `ralplan` | active | 77 | 13 | 2 | 29 | 32 | 1 | *(>15, see refs_by_kind columns)* |
| `review` | deprecated | 163 | 18 | 23 | 61 | 59 | 1 | *(>15, see refs_by_kind columns)* |
| `security-review` | deprecated | 8 | 0 | 1 | 3 | 3 | 1 | `prompts/security-reviewer.md`<br>`src/agents/__tests__/definitions.test.ts`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/keyword-detector.test.ts`<br>`src/utils/__tests__/agents-model-table.test.ts`<br>`templates/catalog-manifest.json` |
| `skill` | active | 160 | 37 | 3 | 50 | 68 | 1 | *(>15, see refs_by_kind columns)* |
| `swarm` | deprecated | 17 | 2 | 0 | 6 | 8 | 1 | *(>15, see refs_by_kind columns)* |
| `tdd` | deprecated | 6 | 0 | 0 | 3 | 2 | 1 | `src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/hooks/__tests__/task-size-detector.test.ts`<br>`src/team/role-router.ts`<br>`templates/catalog-manifest.json` |
| `team` | active | 270 | 17 | 15 | 108 | 128 | 1 | *(>15, see refs_by_kind columns)* |
| `trace` | deprecated | 41 | 4 | 3 | 16 | 17 | 1 | *(>15, see refs_by_kind columns)* |
| `ultragoal` | active | 68 | 8 | 4 | 26 | 28 | 1 | *(>15, see refs_by_kind columns)* |
| `ultraqa` | active | 36 | 4 | 0 | 19 | 12 | 1 | *(>15, see refs_by_kind columns)* |
| `ultrawork` | active | 46 | 7 | 1 | 22 | 15 | 1 | *(>15, see refs_by_kind columns)* |
| `visual-ralph` | active | 17 | 6 | 0 | 3 | 7 | 1 | *(>15, see refs_by_kind columns)* |
| `visual-verdict` | deprecated | 9 | 1 | 0 | 4 | 3 | 1 | `skills/web-clone/SKILL.md`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/notify-hook-session-scope.test.ts`<br>`src/hooks/__tests__/notify-hook-visual-verdict.test.ts`<br>`src/hooks/__tests__/visual-verdict-loop.test.ts`<br>`src/imagegen/continuation.ts`<br>`src/scripts/notify-hook.ts`<br>`templates/catalog-manifest.json` |
| `web-clone` | deprecated | 10 | 2 | 0 | 3 | 4 | 1 | `skills/ralph/SKILL.md`<br>`skills/visual-ralph/SKILL.md`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-skills-overwrite.test.ts`<br>`src/cli/setup.ts`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/hooks/__tests__/visual-ralph-skill.test.ts`<br>`templates/catalog-manifest.json` |
| `wiki` | NOT_IN_MANIFEST | 43 | 0 | 0 | 20 | 23 | 0 | *(>15, see refs_by_kind columns)* |
| `worker` | internal | 165 | 7 | 2 | 77 | 78 | 1 | *(>15, see refs_by_kind columns)* |

## Agents

Sorted alphabetically. The 3 entries with `status = NOT_IN_MANIFEST` are non-installable prompt assets (see `NON_NATIVE_AGENT_PROMPT_ASSETS` in `src/agents/policy.ts`).

`reasoningEffort`, `posture`, `modelClass`, `routingRole`, `tools` come from `src/agents/definitions.ts`. Description is the one-line `description` field there.

| # | agent | status | canonical | category | posture | modelClass | routingRole | tools | refs | description |
|---|-------|--------|-----------|----------|---------|------------|-------------|-------|------|-------------|
| 1 | `analyst` | active | — | build | frontier-orchestrator | frontier | leader | analysis | 15 | Requirements clarity, acceptance criteria, hidden constraints |
| 2 | `api-reviewer` | merged | code-reviewer | review | frontier-orchestrator | standard | leader | read-only | 9 | API contracts, versioning, backward compatibility |
| 3 | `architect` | active | — | build | frontier-orchestrator | frontier | leader | read-only | 111 | System design, boundaries, interfaces, long-horizon tradeoffs |
| 4 | `build-fixer` | deprecated | — | domain | deep-worker | standard | executor | execution | 5 | Build/toolchain/type failures resolution |
| 5 | `code-reviewer` | active | — | review | frontier-orchestrator | frontier | leader | read-only | 21 | Comprehensive review across all concerns |
| 6 | `code-simplifier` | internal | — | domain | deep-worker | frontier | executor | execution | 11 | Simplifies recently modified code for clarity and consistency without changing behavior |
| 7 | `critic` | active | — | coordination | frontier-orchestrator | frontier | leader | read-only | 56 | Plan/design critical challenge and review |
| 8 | `debugger` | active | — | build | deep-worker | standard | executor | analysis | 25 | Root-cause analysis, regression isolation, failure diagnosis |
| 9 | `dependency-expert` | active | — | domain | frontier-orchestrator | standard | specialist | analysis | 14 | External SDK/API/package evaluation |
| 10 | `designer` | active | — | domain | deep-worker | standard | executor | execution | 24 | UX/UI architecture, interaction design |
| 11 | `executor` | active | — | build | — | — | — | — | 114 | — |
| 12 | `explore` | active | — | build | fast-lane | fast | specialist | read-only | 99 | Fast codebase search and file/symbol mapping |
| 13 | `explore-harness` | NOT_IN_MANIFEST | — | — | — | — | — | — | 12 | — |
| 14 | `git-master` | active | — | domain | deep-worker | standard | executor | execution | 8 | Commit strategy, history hygiene, rebasing |
| 15 | `information-architect` | merged | designer | product | frontier-orchestrator | standard | specialist | analysis | 7 | Taxonomy, navigation, findability |
| 16 | `performance-reviewer` | merged | code-reviewer | review | frontier-orchestrator | standard | leader | read-only | 13 | Hotspots, complexity, memory/latency optimization |
| 17 | `planner` | active | — | build | frontier-orchestrator | frontier | leader | analysis | 35 | Task sequencing, execution plans, risk flags |
| 18 | `product-analyst` | merged | analyst | product | frontier-orchestrator | standard | specialist | analysis | 8 | Product metrics, funnel analysis, experiments |
| 19 | `product-manager` | merged | analyst | product | frontier-orchestrator | standard | leader | analysis | 11 | Problem framing, personas/JTBD, PRDs |
| 20 | `prometheus-strict-metis` | active | — | coordination | frontier-orchestrator | frontier | leader | analysis | 7 | Prometheus Strict requirements interviewer and ambiguity mapper |
| 21 | `prometheus-strict-momus` | active | — | coordination | frontier-orchestrator | frontier | leader | analysis | 7 | Prometheus Strict adversarial plan critic and risk challenger |
| 22 | `prometheus-strict-oracle` | active | — | coordination | frontier-orchestrator | standard | leader | analysis | 7 | Prometheus Strict implementation readiness verifier and handoff judge |
| 23 | `qa-tester` | merged | test-engineer | domain | deep-worker | standard | executor | execution | 9 | Interactive CLI/service runtime validation |
| 24 | `quality-reviewer` | merged | code-reviewer | review | frontier-orchestrator | standard | leader | read-only | 17 | Logic defects, maintainability, anti-patterns |
| 25 | `quality-strategist` | merged | verifier | domain | frontier-orchestrator | standard | leader | analysis | 6 | Quality strategy, release readiness, risk assessment |
| 26 | `researcher` | active | — | domain | fast-lane | standard | specialist | analysis | 33 | External documentation and reference research |
| 27 | `security-reviewer` | deprecated | — | review | frontier-orchestrator | frontier | leader | read-only | 5 | Vulnerabilities, trust boundaries, authn/authz |
| 28 | `sisyphus-lite` | NOT_IN_MANIFEST | — | — | — | — | — | — | 5 | — |
| 29 | `style-reviewer` | merged | code-reviewer | review | fast-lane | fast | specialist | read-only | 15 | Formatting, naming, idioms, lint conventions |
| 30 | `team-executor` | internal | — | build | — | — | — | — | 9 | — |
| 31 | `team-orchestrator` | NOT_IN_MANIFEST | — | — | — | — | — | — | 2 | — |
| 32 | `test-engineer` | active | — | domain | deep-worker | frontier | executor | execution | 28 | Test strategy, coverage, flaky-test hardening |
| 33 | `ux-researcher` | merged | designer | product | frontier-orchestrator | standard | specialist | analysis | 8 | Heuristic audits, usability, accessibility |
| 34 | `verifier` | active | — | build | frontier-orchestrator | standard | leader | analysis | 23 | Completion evidence, claim validation, test adequacy |
| 35 | `vision` | active | — | coordination | fast-lane | frontier | specialist | read-only | 17 | Image/screenshot/diagram analysis |
| 36 | `writer` | active | — | domain | fast-lane | standard | specialist | execution | 21 | Documentation, migration notes, user guidance |

### Agent cross-reference detail

Selected breakdowns of agent → referencing files. Agents with ref_count ≤ 15 are fully expanded; the rest are summarized.

| agent | status | refs_total | in_skills | in_other_prompts | in_src_ts | in_src_tests | in_templates | full_list (only if ≤ 15) |
|-------|--------|------------|-----------|------------------|-----------|--------------|--------------|---------------------------|
| `analyst` | active | 15 | 1 | 4 | 6 | 3 | 1 | `prompts/critic.md`<br>`prompts/product-analyst.md`<br>`prompts/product-manager.md`<br>`prompts/ux-researcher.md`<br>`skills/plan/SKILL.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/__tests__/prompt-orchestration-boundary.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`src/pipeline/__tests__/orchestrator.test.ts`<br>`src/team/orchestrator.ts`<br>`src/team/role-router.ts`<br>`templates/catalog-manifest.json` |
| `api-reviewer` | merged | 9 | 0 | 3 | 4 | 1 | 1 | `prompts/performance-reviewer.md`<br>`prompts/quality-reviewer.md`<br>`prompts/style-reviewer.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `architect` | active | 111 | 20 | 19 | 30 | 41 | 1 | *(>15, see refs_by_kind columns)* |
| `build-fixer` | deprecated | 5 | 0 | 0 | 3 | 1 | 1 | `src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/utils/__tests__/agents-model-table.test.ts`<br>`templates/catalog-manifest.json` |
| `code-reviewer` | active | 21 | 1 | 6 | 7 | 6 | 1 | *(>15, see refs_by_kind columns)* |
| `code-simplifier` | internal | 11 | 0 | 0 | 7 | 3 | 1 | `src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/code-simplifier/__tests__/index.test.ts`<br>`src/hooks/code-simplifier/index.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`src/scripts/notify-hook.ts`<br>`src/team/__tests__/role-router.test.ts`<br>`src/team/role-router.ts`<br>`templates/catalog-manifest.json` |
| `critic` | active | 56 | 11 | 3 | 24 | 17 | 1 | *(>15, see refs_by_kind columns)* |
| `debugger` | active | 25 | 1 | 0 | 8 | 15 | 1 | *(>15, see refs_by_kind columns)* |
| `dependency-expert` | active | 14 | 1 | 2 | 6 | 4 | 1 | `prompts/explore.md`<br>`prompts/researcher.md`<br>`skills/best-practice-research/SKILL.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/best-practice-research-skill.test.ts`<br>`src/hooks/__tests__/prompt-guidance-wave-two.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`src/team/__tests__/followup-planner.test.ts`<br>`src/team/__tests__/role-router.test.ts`<br>`src/team/followup-planner.ts`<br>`src/team/role-router.ts`<br>`templates/catalog-manifest.json` |
| `designer` | active | 24 | 2 | 4 | 11 | 6 | 1 | *(>15, see refs_by_kind columns)* |
| `executor` | active | 114 | 11 | 11 | 28 | 63 | 1 | *(>15, see refs_by_kind columns)* |
| `explore` | active | 99 | 12 | 28 | 26 | 31 | 2 | *(>15, see refs_by_kind columns)* |
| `explore-harness` | NOT_IN_MANIFEST | 12 | 0 | 0 | 5 | 7 | 0 | `src/agents/policy.ts`<br>`src/cli/__tests__/doctor-warning-copy.test.ts`<br>`src/cli/__tests__/explore.test.ts`<br>`src/cli/__tests__/package-bin-contract.test.ts`<br>`src/cli/__tests__/packaged-explore-harness-lock.ts`<br>`src/cli/explore.ts`<br>`src/cli/native-assets.ts`<br>`src/hooks/__tests__/explore-sparkshell-guidance-contract.test.ts`<br>`src/scripts/__tests__/verify-native-agents.test.ts`<br>`src/scripts/build-explore-harness.ts`<br>`src/scripts/cleanup-explore-harness.ts`<br>`src/verification/__tests__/explore-harness-release-workflow.test.ts` |
| `git-master` | active | 8 | 2 | 0 | 4 | 1 | 1 | `skills/git-master/SKILL.md`<br>`skills/skill/SKILL.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/skill-catalog-hygiene.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `information-architect` | merged | 7 | 0 | 1 | 4 | 1 | 1 | `prompts/ux-researcher.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `performance-reviewer` | merged | 13 | 0 | 7 | 4 | 1 | 1 | `prompts/api-reviewer.md`<br>`prompts/debugger.md`<br>`prompts/quality-reviewer.md`<br>`prompts/quality-strategist.md`<br>`prompts/security-reviewer.md`<br>`prompts/style-reviewer.md`<br>`prompts/test-engineer.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `planner` | active | 35 | 5 | 4 | 14 | 11 | 1 | *(>15, see refs_by_kind columns)* |
| `product-analyst` | merged | 8 | 0 | 2 | 4 | 1 | 1 | `prompts/product-manager.md`<br>`prompts/ux-researcher.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `product-manager` | merged | 11 | 0 | 4 | 5 | 1 | 1 | `prompts/information-architect.md`<br>`prompts/product-analyst.md`<br>`prompts/quality-strategist.md`<br>`prompts/ux-researcher.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`src/team/orchestrator.ts`<br>`templates/catalog-manifest.json` |
| `prometheus-strict-metis` | active | 7 | 1 | 0 | 3 | 2 | 1 | `skills/prometheus-strict/SKILL.md`<br>`src/agents/definitions.ts`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/prometheus-strict-contract.test.ts`<br>`templates/catalog-manifest.json` |
| `prometheus-strict-momus` | active | 7 | 1 | 0 | 3 | 2 | 1 | `skills/prometheus-strict/SKILL.md`<br>`src/agents/definitions.ts`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/prometheus-strict-contract.test.ts`<br>`templates/catalog-manifest.json` |
| `prometheus-strict-oracle` | active | 7 | 1 | 0 | 3 | 2 | 1 | `skills/prometheus-strict/SKILL.md`<br>`src/agents/definitions.ts`<br>`src/catalog/__tests__/generator.test.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/hooks/__tests__/prometheus-strict-contract.test.ts`<br>`templates/catalog-manifest.json` |
| `qa-tester` | merged | 9 | 1 | 1 | 4 | 2 | 1 | `prompts/quality-strategist.md`<br>`skills/ultraqa/SKILL.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/__tests__/explore-sparkshell-guidance-contract.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `quality-reviewer` | merged | 17 | 1 | 5 | 7 | 3 | 1 | *(>15, see refs_by_kind columns)* |
| `quality-strategist` | merged | 6 | 0 | 0 | 4 | 1 | 1 | `src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `researcher` | active | 33 | 6 | 7 | 10 | 9 | 1 | *(>15, see refs_by_kind columns)* |
| `security-reviewer` | deprecated | 5 | 0 | 0 | 3 | 1 | 1 | `src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/utils/__tests__/agents-model-table.test.ts`<br>`templates/catalog-manifest.json` |
| `sisyphus-lite` | NOT_IN_MANIFEST | 5 | 0 | 0 | 2 | 3 | 0 | `src/agents/policy.ts`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/__tests__/explore-sparkshell-guidance-contract.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`src/team/__tests__/worker-runtime-identity.test.ts` |
| `style-reviewer` | merged | 15 | 0 | 5 | 5 | 4 | 1 | `prompts/api-reviewer.md`<br>`prompts/debugger.md`<br>`prompts/performance-reviewer.md`<br>`prompts/quality-reviewer.md`<br>`prompts/security-reviewer.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`src/scripts/__tests__/verify-native-agents.test.ts`<br>`src/team/__tests__/model-contract.test.ts`<br>`src/team/__tests__/worker-runtime-identity.test.ts`<br>`src/team/model-contract.ts`<br>`templates/catalog-manifest.json` |
| `team-executor` | internal | 9 | 0 | 0 | 4 | 4 | 1 | `src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/cli/__tests__/team-decompose.test.ts`<br>`src/cli/team.ts`<br>`src/team/__tests__/followup-planner.test.ts`<br>`src/team/__tests__/repo-aware-decomposition.test.ts`<br>`templates/catalog-manifest.json` |
| `team-orchestrator` | NOT_IN_MANIFEST | 2 | 0 | 0 | 2 | 0 | 0 | `src/agents/policy.ts`<br>`src/hooks/agents-overlay.ts` |
| `test-engineer` | active | 28 | 2 | 3 | 9 | 13 | 1 | *(>15, see refs_by_kind columns)* |
| `ux-researcher` | merged | 8 | 0 | 2 | 4 | 1 | 1 | `prompts/information-architect.md`<br>`prompts/product-manager.md`<br>`src/agents/definitions.ts`<br>`src/catalog/generated/public-catalog.json`<br>`src/catalog/manifest.json`<br>`src/cli/__tests__/setup-prompts-overwrite.test.ts`<br>`src/hooks/prompt-guidance-contract.ts`<br>`templates/catalog-manifest.json` |
| `verifier` | active | 23 | 1 | 2 | 11 | 8 | 1 | *(>15, see refs_by_kind columns)* |
| `vision` | active | 17 | 2 | 2 | 8 | 4 | 1 | *(>15, see refs_by_kind columns)* |
| `writer` | active | 21 | 1 | 1 | 6 | 12 | 1 | *(>15, see refs_by_kind columns)* |

## Skill → agent reference matrix

Rows = skills that mention agent names in their `SKILL.md` body. Columns = agents (only those mentioned by at least one skill). A cell is `●` when the skill's SKILL.md textually contains the agent's bare name (`rg -F`).

This is the *narrative* coupling, not the runtime call graph. It tells you whether a skill's documentation orients the model toward a specific agent; it does NOT mean the skill executes that agent automatically.

| skill \ agent | `analyst` | `architect` | `code-reviewer` | `critic` | `debugger` | `dependency-expert` | `designer` | `executor` | `explore` | `git-master` | `planner` | `prometheus-strict-metis` | `prometheus-strict-momus` | `prometheus-strict-oracle` | `qa-tester` | `quality-reviewer` | `researcher` | `test-engineer` | `verifier` | `vision` | `writer` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ai-slop-cleaner` |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `analyze` |   | ● |   |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `autopilot` |   | ● |   | ● |   |   |   | ● | ● |   |   |   |   |   |   |   |   |   |   |   |   |
| `autoresearch` |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `autoresearch-goal` |   |   |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `best-practice-research` |   | ● |   |   |   | ● |   | ● | ● |   |   |   |   |   |   |   | ● |   |   |   |   |
| `code-review` |   | ● | ● | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `deep-interview` |   | ● |   | ● |   |   |   |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |
| `deepsearch` |   |   |   |   |   |   |   |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |
| `design` |   | ● |   | ● |   |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `doctor` |   | ● |   |   |   |   |   | ● | ● |   |   |   |   |   |   |   | ● |   |   |   |   |
| `ecomode` |   | ● |   |   |   |   |   | ● | ● |   | ● |   |   |   |   |   |   |   |   |   | ● |
| `git-master` |   |   |   |   |   |   |   |   |   | ● |   |   |   |   |   |   |   |   |   |   |   |
| `hud` |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `pipeline` |   | ● |   | ● |   |   |   | ● |   |   | ● |   |   |   |   |   |   |   |   |   |   |
| `plan` | ● | ● |   | ● |   |   |   | ● | ● |   | ● |   |   |   |   | ● |   |   | ● |   |   |
| `prometheus-strict` |   |   |   |   |   |   |   | ● | ● |   | ● | ● | ● | ● |   |   | ● |   |   |   |   |
| `ralph` |   | ● |   | ● |   |   |   | ● | ● |   |   |   |   |   |   |   |   |   |   |   |   |
| `ralplan` |   | ● |   | ● |   |   |   |   | ● |   |   |   |   |   |   |   | ● |   |   |   |   |
| `skill` |   |   |   |   |   |   |   |   |   | ● | ● |   |   |   |   |   |   |   |   |   |   |
| `tdd` |   | ● |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   | ● |   |   |   |
| `team` |   |   |   | ● |   |   |   | ● | ● |   |   |   |   |   |   |   | ● |   |   | ● |   |
| `ultragoal` |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |
| `ultraqa` |   | ● |   |   |   |   |   | ● |   |   |   |   |   |   | ● |   |   |   |   |   |   |
| `ultrawork` |   | ● |   |   |   |   |   | ● | ● |   |   |   |   |   |   |   | ● | ● |   |   |   |
| `visual-ralph` |   |   |   |   |   |   | ● |   |   |   |   |   |   |   |   |   |   |   |   | ● |   |
| `wiki` |   | ● |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |   |

Skills not appearing as a row above mention zero agent names verbatim (19 skills). That is itself a connectivity signal (covered in `connectivity-roadmap.md`).

**Skills with zero agent mentions in their SKILL.md body**:

- `ask`
- `ask-claude`
- `ask-gemini`
- `build-fix`
- `cancel`
- `configure-notifications`
- `frontend-ui-ux`
- `help`
- `note`
- `omx-setup`
- `performance-goal`
- `ralph-init`
- `review`
- `security-review`
- `swarm`
- `trace`
- `visual-verdict`
- `web-clone`
- `worker`

## Catalog ↔ disk consistency

- **On disk but not in `src/catalog/manifest.json`** (1): `wiki`
- **In manifest but not on disk** (4): `configure-discord`, `configure-openclaw`, `configure-slack`, `configure-telegram`
- **On disk but not shipped via `plugins/oh-my-codex/skills/`** (17): `ask-claude`, `ask-gemini`, `build-fix`, `deepsearch`, `ecomode`, `frontend-ui-ux`, `git-master`, `help`, `note`, `ralph-init`, `review`, `security-review`, `swarm`, `tdd`, `trace`, `visual-verdict`, `web-clone`

These three lines are the most actionable consistency findings — see `bloat-audit.md` § *Inventory anomalies* for proposed fixes.

---

*Generated for owner review. Do not edit by hand without re-running `notes/audit-*` data collection.*
