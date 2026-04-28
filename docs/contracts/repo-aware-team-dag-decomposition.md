# Repo-aware Team DAG decomposition contract

This contract documents the repo-aware Team decomposition gate planned by `.omx/plans/prd-repo-aware-team-decomposition.md`. It is intentionally a pre-runtime contract: Team may import or derive richer planning metadata before launch, but worker execution must continue to use the existing claim-safe task lifecycle.

## Contract boundary

- `omx team` may preflight the latest approved PRD/test-spec pair and a matching DAG handoff artifact before `startTeam()` launches workers only when the invocation is approved for that pair: either the CLI input matches the PRD's approved Team launch hint, or the user uses a short approved follow-up such as `omx team team` that resolves to that hint. Normal `omx team [N[:role]] "task"` startup must not consume ambient/stale `team-dag-*.json` files.
- The preflight output may change the startup task list, worker count, owner assignment, inbox text, and observability metadata.
- Runtime task mutation remains owned by the Team state APIs. Preflight must not bypass `assignTask()`, `claimTask()`, `transitionTaskStatus()`, or `update-task` lifecycle constraints.
- Existing `omx team [N[:role]] "task"` behavior remains the fallback when no valid approved DAG handoff exists.

## Artifact resolution

1. Select the latest PRD using the same slug semantics as `selectLatestPlanningArtifacts()`, then require at least one matching `test-spec-<slug>.md`/`testspec-<slug>.md`; a PRD without its matching test spec is not an approved pair for DAG activation.
2. Prefer `.omx/plans/team-dag-<slug>.json` over embedded markdown handoff JSON after the approved invocation gate passes.
3. If multiple matching JSON candidates are possible, choose the lexicographically latest path and record a `multiple_matches` warning in preflight metadata.
4. If the sidecar exists but is invalid, fall back to legacy text decomposition in v1 and persist the fallback reason. Do not silently ignore the invalid artifact.
5. If no valid sidecar exists, parse an optional fenced `Team DAG Handoff` block from the selected PRD.
6. If no valid handoff is found, set `decomposition_source=legacy_text` and use the existing `buildTeamExecutionPlan()` path.

## DAG node requirements

Each imported node should validate to a bounded data shape:

- stable symbolic `id`
- `subject` and `description`
- optional `role`
- optional `lane`
- optional `filePaths` and `domains`
- optional symbolic `depends_on`
- optional `requires_code_change`
- optional acceptance or verification notes

Validation must reject duplicate node IDs and cyclic dependencies before worker launch. Input order is the tie-breaker for topological sorting so generated task IDs are stable across runs.

## Runtime dependency remap

DAG dependencies are symbolic at plan time, but Team runtime readiness is based on concrete task IDs. The startup sequence must therefore be:

1. Validate and topologically sort DAG nodes.
2. Create Team tasks in stable order without symbolic dependency fields.
3. Build `node_id -> task_id` from created tasks.
4. Patch dependency fields through the supported state helper/API path so `depends_on`/`blocked_by` contains concrete task IDs only.
5. Persist the mapping in `decomposition-report.json` for inspection and debugging.
6. Generate worker inboxes after remapping so dependency summaries show real task IDs.

Do not persist symbolic IDs into runtime task dependencies; `claimTask()` cannot prove readiness from plan-only IDs.

## Persistence and observability

Preflight should keep rich planning data out of the claim lifecycle task payload unless the task schema explicitly supports the field.

| Data | Expected storage |
| --- | --- |
| `decomposition_source`, `dag_artifact_path`, `fallback_reason`, `worker_count_requested`, `worker_count_effective`, `worker_count_source`, `ready_lane_count` | team manifest/config metadata, via the top-level `team_decomposition` manifest block |
| node-to-task mapping, allocation reasons, file/domain/lane hints, warnings | `.omx/state/team/<team>/decomposition-report.json` and optional markdown summary |
| runtime dependencies | `TeamTask.depends_on` / `blocked_by` with concrete task IDs |
| `requires_code_change` | thread into `TeamTask` only through supported schema/API fields; otherwise reject or drop with an explicit validation warning |
| worker-facing ownership hints | initial inbox text for the assigned worker |

## Worker count policy

- CLI-explicit counts are user overrides and should be honored up to hard safety caps. If the count exceeds useful ready lanes, keep the count but record surplus support/idle capacity.
- Plan-suggested counts may be reduced to useful lanes when the DAG shows less parallel work than requested.
- Default-derived counts may be reduced to useful lanes.
- Reserve a verification lane only when there is code-changing implementation work to verify and the verification lane is not fully dependency-blocked.
- Never exceed `DEFAULT_MAX_WORKERS`.

## Allocation and role coherence

Allocation should prefer:

1. dependency-ready root lanes first;
2. same owner for implementation nodes touching the same file/domain;
3. specialist roles (`test-engineer`, `writer`, `security-reviewer`) kept coherent when there is enough lane capacity;
4. generic fallback only when mixed-role assignment is unavoidable, with `worker_runtime_role_reason=mixed_roles_fallback` recorded.

Allocation reasons should be short and stable enough for tests, startup summaries, and worker inboxes.

## Worker inbox UX

The initial inbox should include preflight data that materially affects worker behavior:

- assigned file paths and domains;
- lane label;
- dependency summary with concrete task IDs;
- allocation reason;
- exact assigned task IDs after symbolic remap.

This makes ownership constraints visible where workers actually operate instead of hiding them only in manifest metadata.

## Review risks to guard in implementation

- Do not put a large opaque DAG heuristic block directly into `src/cli/team.ts`; keep a small preflight module seam.
- Do not widen `TeamTask` with rich metadata unless state readers, API interop, and monitor snapshots are updated together.
- Do not treat RALPLAN-suggested worker counts as CLI-explicit overrides.
- Do not bypass claim-safety by directly writing in-progress/completed task state during preflight.
- Do not launch workers before symbolic dependencies are remapped to concrete Team task IDs.
