# Unified Guidance Schema (AGENTS + Team Worker Surfaces)

Status: Canonical contract for instruction-surface alignment.

## Purpose

Define one shared schema that can be applied across:
- static AGENTS template surfaces,
- runtime AGENTS overlays,
- team worker overlays,
- worker protocol skill/inbox guidance.

This standard is additive and migration-safe: it does not change task-state APIs, marker contracts, or file-path ownership contracts.

## Canonical Schema Sections

### Required sections

1. **Role & Intent**
   - Who the agent/worker is and what success means.
2. **Operating Principles**
   - High-level decision rules (quality, speed, safety, verification).
3. **Execution Protocol**
   - Ordered workflow steps for task execution.
4. **Constraints & Safety**
   - Boundaries, prohibited actions, and compatibility constraints.
5. **Verification & Completion**
   - Evidence required before completion claims.
6. **Recovery & Lifecycle**
   - Cancel/cleanup/resume behavior and state transitions.

### Optional sections

- Tool catalogs and model routing guidance.
- Skill discovery/reference sections.
- Team composition/pipeline presets.
- Session/runtime context blocks (when injected by runtime overlays).

## Global Compatibility Contracts (Must Stay Stable)

### Marker contracts

- `<!-- OMX:RUNTIME:START --> ... <!-- OMX:RUNTIME:END -->`
- `<!-- OMX:TEAM:WORKER:START --> ... <!-- OMX:TEAM:WORKER:END -->`

### Worker task/mailbox contracts

- Task file path format: `.omx/state/team/<team>/tasks/task-<id>.json` (example: `task-3.json`)
- State/MCP API id format: `task_id: "<id>"` (example: `"3"`, never `"task-3"`)
- Mailbox path: `.omx/state/team/<team>/mailbox/<worker>.json`

## Mapping Matrix

| Surface | Role & Intent | Operating Principles | Execution Protocol | Constraints & Safety | Verification & Completion | Recovery & Lifecycle |
|---|---|---|---|---|---|---|
| `AGENTS.md` (workspace root) | Title + opening intro | `<operating_principles>` | delegation/model-routing/skills/team sections | keyword/cancellation/state sections | `<verification>` + continuation checklist | cancel + state lifecycle + runtime/team markers |
| `templates/AGENTS.md` | Title + opening intro | `<operating_principles>` | same canonical orchestration sections as root | same safety constraints | same verification section | runtime/team overlays added later via markers |
| Runtime AGENTS overlay block | session context identity | compaction protocol directives | checkpoint flow | overlay marker boundaries and size/lock gates | checkpoint evidence before compaction | runtime apply/strip lifecycle |
| Team worker overlay block | worker identity + team scope | worker protocol intent | ACK → read task → claim → execute → complete → idle | file ownership + blocked-state rules | write task result + status updates | mailbox polling + shutdown handling |
| `skills/worker/SKILL.md` + worker inbox | worker role framing | worker protocol principles | startup ACK/task lifecycle steps | claim-first + path/id safety rules | completion writeback requirements | mailbox/shutdown loop |

## Adoption Notes

- Prefer additive wording updates over structural removals during rollout.
- Preserve all marker-bounded overlay text contracts while aligning language to this schema.
- When guidance conflicts are found, fix wording while preserving existing behavioral semantics unless explicitly versioned.
