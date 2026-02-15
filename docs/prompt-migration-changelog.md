# Prompt Migration Changelog

## Scope

- Migration window: `e21cb5e` -> `ff7ee14`
- Surface: `prompts/*.md` (30 files)
- Goal: adapt prompt authoring style from XML-like wrappers to Codex-friendly Markdown while preserving role intent and operational constraints.

## Global Changes (Applied to All Prompt Files)

- Preserved frontmatter metadata (`description`, `argument-hint`).
- Replaced wrapper tags such as `<Agent_Prompt>`, `<Role>`, `<Constraints>`, `<Output_Format>`, `<Final_Checklist>` with Markdown section headings.
- Flattened nested XML-like sections into readable Markdown bullets/numbered steps.
- Kept role semantics, tool usage intent, guardrails, and checklist expectations functionally equivalent.

## Behavior Notes

- No intentionally introduced functional behavior changes were made in this migration commit.
- Behavior-relevant content (constraints, verification expectations, output templates) was preserved while syntax/formatting was normalized.
- Any post-migration behavior differences are expected to come from readability and parser-compatibility improvements, not policy changes.

## Per-File Matrix

| Prompt File | Added | Removed | Structural Highlights | Behavior Delta |
|---|---:|---:|---|---|
| `prompts/analyst.md` | 102 | 105 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/api-reviewer.md` | 90 | 93 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/architect.md` | 102 | 104 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/build-fixer.md` | 81 | 84 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/code-reviewer.md` | 98 | 100 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/critic.md` | 79 | 82 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/debugger.md` | 85 | 88 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/deep-executor.md` | 105 | 107 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/dependency-expert.md` | 91 | 94 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/designer.md` | 96 | 98 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/executor.md` | 92 | 94 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/explore.md` | 104 | 107 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/git-master.md` | 84 | 87 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/information-architect.md` | 28 | 29 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/performance-reviewer.md` | 86 | 89 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/planner.md` | 108 | 111 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/product-analyst.md` | 28 | 29 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/product-manager.md` | 33 | 34 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/qa-tester.md` | 90 | 93 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/quality-reviewer.md` | 98 | 100 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/quality-strategist.md` | 33 | 34 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/researcher.md` | 88 | 91 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/scientist.md` | 84 | 87 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/security-reviewer.md` | 119 | 121 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/style-reviewer.md` | 79 | 82 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/test-engineer.md` | 96 | 98 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/ux-researcher.md` | 28 | 29 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/verifier.md` | 87 | 90 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/vision.md` | 67 | 70 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |
| `prompts/writer.md` | 78 | 81 | XML-like wrapper blocks converted to Markdown section hierarchy; output/checklist sections normalized. | No intentional functional delta in migration commit. |

## Validation

- Commit diff summary: `30 files changed, 2439 insertions(+), 2511 deletions(-)`
- Spot-checks performed on role-heavy prompts (`planner`, `executor`, `explore`) confirmed semantic parity with formatting normalization.

---

## Orchestration Brain Migration (`AGENTS.md`, `templates/AGENTS.md`)

### Summary

These files are the instruction root that OMX expects Codex to follow across a workspace.
Changes here are primarily about aligning instructions with Codex CLI tool contracts.

### Key Deltas

- Updated child-agent delegation guidance to reflect the Codex `spawn_agent` API:
  - Use `spawn_agent(message: "<role prompt>\n\nTask: ...")` conventions.
  - Removed legacy "instructions" phrasing.
- Expanded MCP tooling catalog and mode lifecycle expectations so orchestrators can use the full MCP surface correctly.
- `templates/AGENTS.md` header normalized to match `AGENTS.md` and removed the non-compliant template opener.

### Diff Stats

| File | Added | Removed | Notes |
|---|---:|---:|---|
| `AGENTS.md` | 42 | 10 | Tooling + delegation guidance expanded; semantics preserved. |
| `templates/AGENTS.md` | 7 | 7 | Header/tone normalized; still intended as a template copy. |

### Unified Guidance Schema Follow-Up (AGENTS + Runtime/Worker Alignment)

- Added canonical schema document: `docs/guidance-schema.md`.
- Added explicit schema-contract sections to:
  - `AGENTS.md`
  - `templates/AGENTS.md`
- Normalized worker task guidance in `AGENTS.md` runtime worker overlay:
  - file path now uses `tasks/task-<id>.json`
  - API id rule now explicitly requires bare id `task_id: "<id>"` (never `"task-<id>"`).
- Marker contracts remain unchanged:
  - `<!-- OMX:RUNTIME:START --> ... <!-- OMX:RUNTIME:END -->`
  - `<!-- OMX:TEAM:WORKER:START --> ... <!-- OMX:TEAM:WORKER:END -->`

Behavior note: this follow-up is additive and wording-focused; no task-state model or MCP API contract changes were introduced.

---

## Skill Prompt Migration (`skills/*/SKILL.md`)

### Summary

Skill docs are operational runbooks. The migration focused on:
- Removing Claude-era paths/terminology
- Aligning config guidance with Codex-first paths (`~/.codex/…`, `CODEX_HOME`)
- Preserving each skill's contract/intent while improving correctness for Codex CLI users

### Behavior Notes

- These are documentation / instruction changes; they do not directly change runtime logic.
- One meaningful correction was made: the "agent teams" enablement guidance in `skills/omx-setup/SKILL.md` was updated to enable Codex features via `~/.codex/config.toml` rather than legacy `settings.json` env vars.

### Per-File Matrix

| Skill File | Added | Removed | Structural Highlights | Behavior Delta |
|---|---:|---:|---|---|
| `skills/analyze/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/autopilot/SKILL.md` | 11 | 16 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/code-review/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/configure-discord/SKILL.md` | 6 | 6 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/configure-telegram/SKILL.md` | 6 | 6 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/doctor/SKILL.md` | 47 | 45 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/ecomode/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/frontend-ui-ux/SKILL.md` | 2 | 2 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/help/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/learner/SKILL.md` | 5 | 5 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/omx-setup/SKILL.md` | 144 | 156 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/plan/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/project-session-manager/SKILL.md` | 5 | 5 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/release/SKILL.md` | 3 | 3 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/research/SKILL.md` | 10 | 15 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/security-review/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/skill/SKILL.md` | 20 | 20 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/tdd/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/ultrapilot/SKILL.md` | 11 | 16 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |
| `skills/writer-memory/SKILL.md` | 1 | 1 | Codex path/terminology normalization; examples updated to Codex-first conventions. | No direct runtime behavior change; instruction correctness improved. |

### Hotspots Worth Reviewing

- `skills/omx-setup/SKILL.md`: largest edit surface; includes team enablement guidance (`~/.codex/config.toml` `[features]` flags) and teammate display preference storage (`~/.codex/.omx-config.json`).
- `skills/doctor/SKILL.md`: updated hook/config inspection language; still contains optional legacy remediation guidance.
- `skills/autopilot/SKILL.md`, `skills/research/SKILL.md`, `skills/ultrapilot/SKILL.md`: config examples updated to TOML.
