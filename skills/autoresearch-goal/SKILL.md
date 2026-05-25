---
name: autoresearch-goal
description: Durable professor-critic research workflow over Codex goal mode without reviving deprecated omx autoresearch
---

# Autoresearch Goal

Use this workflow when a research mission should be bound to Codex goal-mode focus while OMX remains the durable state owner. This is for research projects that need Codex goal-mode management plus professor/critic-style validation; it is not the default answer for ordinary pre-planning best-practice lookup.

## Boundary
- Do **not** use or revive the deprecated `omx autoresearch` direct launch surface.
- Do **not** claim shell commands mutate hidden Codex `/goal` state.
- Do **not** edit upstream `../../codex` or add dependencies.
- Use `get_goal`, `create_goal`, and `update_goal({status: "complete"})` only through the active Codex thread when those tools are available.

## Artifacts
`omx autoresearch-goal` writes:
- `.omx/goals/autoresearch/<slug>/mission.json`
- `.omx/goals/autoresearch/<slug>/rubric.md`
- `.omx/goals/autoresearch/<slug>/ledger.jsonl`
- `.omx/goals/autoresearch/<slug>/completion.json`

## Flow
1. Create the mission and professor-critic rubric:
   `omx autoresearch-goal create --topic "..." --rubric "..." --critic-command "..."`
2. Emit the model-facing handoff:
   `omx autoresearch-goal handoff --slug <slug>`
3. In the active Codex thread, call `get_goal`; call `create_goal` only if no active goal exists and the printed payload is the intended objective.
4. Research iteratively against the rubric. Record every critic outcome:
   `omx autoresearch-goal verdict --slug <slug> --verdict <pass|fail|blocked> --evidence "..."`
5. Completion is blocked until professor-critic validation records `verdict=pass`. After the mission audit passes, call `update_goal({status: "complete"})`, call `get_goal` again, then run:
   `omx autoresearch-goal complete --slug <slug> --codex-goal-json <get_goal-json-or-path>`
6. Treat the completion command as read-only reconciliation plus durable OMX state update; hooks and shell commands must not mutate Codex goal state.

## Completion gate
A passing professor-critic artifact and a matching complete Codex `get_goal` snapshot are required. Assistant prose, partial tests, or a failed/blocked verdict are not sufficient.
