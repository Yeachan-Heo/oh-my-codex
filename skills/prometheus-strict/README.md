# Prometheus Strict

`$prometheus-strict` is a clean-room OMX planning skill for rigorous interview-driven planning before execution.

It is inspired by the high-level OMO Prometheus concept only. It does not copy OMO source text, prompts, runtime code, or workflow implementation.

Credit: Inspired by OMO Prometheus (`code-yeongyu/oh-my-openagent`), reimplemented from concept under MIT.

## Roles

- **Metis** clarifies requirements, constraints, non-goals, and acceptance criteria.
- **Momus** challenges assumptions, scope, handoff risks, and missing verification.
- **Oracle** synthesizes the approved plan and recommends the OMX-native handoff.

## OMX Handoff

Prometheus Strict is planning-only by default. It should hand off to:

1. `$ultragoal` for durable goal execution.
2. `$team` only when the Oracle plan identifies independent parallel lanes.

## Non-Goals

- No hook implementation.
- No Sisyphus or `start-work` port.
- No direct implementation unless a downstream execution workflow is explicitly invoked.
- No verbatim source copying from the inspiration project.

## Expected Output

The skill returns a Prometheus Strict Plan with clarified requirements, resolved critique, an Oracle execution plan, a verification matrix, an optional durable artifact path under `.omx/plans/prometheus-strict/`, and clean-room credit.

## Durable Plan Artifacts

When the plan should survive handoff or review, write the final Oracle synthesis to `.omx/plans/prometheus-strict/<slug>.md` and include that path in the plan before invoking `$ultragoal` or `$team`. Inline-only plans may set the artifact path to `N/A - inline plan only`.
