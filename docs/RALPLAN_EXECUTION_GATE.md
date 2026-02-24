# Ralplan-first Execution Gate (Issue #239)

## Why this gate exists

Execution quality drops when implementation starts from vague requests. This gate makes planning artifacts explicit before handoff so execution loops ($ralph/$team/$autopilot) have stable scope and test intent.

**Policy:**
- Underspecified execution requests are redirected to `$ralplan` (via AGENTS.md instructions).
- Execution/handoff is blocked unless the latest plan in `.omx/plans/` has both:
  - `## PRD Scope`
  - `## Test Spec` (or `## Test Specification`)

## How enforcement works in OMX

OMX uses a two-layer gate:

1. **Soft gate (AGENTS.md overlay):** The runtime overlay injects `<pre_execution_gate>` instructions that tell the model to self-check before activating execution skills. This catches vague prompts at the intent level.

2. **Hard gate (team orchestrator):** The `transitionPhase()` function in `src/team/orchestrator.ts` calls `validateExecutionArtifacts()` before allowing `team-exec` phase. This prevents execution even if the model ignores soft instructions.

## Good vs Bad prompts

### Bad (underspecified)
- `fix it`
- `make this better`
- `do the thing`

### Good (execution-ready)
- `Implement OAuth callback in src/auth/callback.ts. Scope: login callback only, no social providers. Test spec: add unit tests for token parsing and one integration test for callback success/failure.`

### Good (planning-first)
- `$ralplan --interactive "Design and implement repository-level telemetry aggregation for CI diagnostics"`

## E2E example (copy-paste)

1) Start with planning:

```text
$ralplan --interactive "Add API key rotation workflow for admin users"
```

2) Ensure plan includes:

```markdown
## PRD Scope
- In scope: Admin UI + backend endpoint for key rotation
- Out of scope: self-serve user key rotation

## Test Spec
- Unit: key rotation service validates old/new key semantics
- Integration: endpoint auth + rotation happy path + invalid key failure
- E2E: admin rotates key and old key stops working
```

3) Approve execution handoff ($ralph/$team). Pre-execution gate now allows execution.

## Troubleshooting

### "PRE-EXECUTION GATE — Execution blocked"
- Cause: missing plan artifacts.
- Fix: update latest `.omx/plans/*.md` with `## PRD Scope` and `## Test Spec`.

### Model says "This request needs planning first"
- Cause: vague execution intent (soft gate triggered).
- Fix: either provide concrete scope+tests in the prompt, or run `$ralplan --interactive`.

### I already have an old plan
- Gate checks the latest plan file by mtime in `.omx/plans/`.
- Update the latest plan or create a fresh one via `$ralplan`.

### Team orchestrator throws on team-exec transition
- Cause: `transitionPhase()` hard gate rejected the transition.
- Fix: ensure `.omx/plans/` contains a plan with both required sections.
