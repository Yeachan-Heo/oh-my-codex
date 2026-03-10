# Issue Draft: Make `ralplan` first-class for `team` follow-up planning

## Title
[Feature] Make `ralplan` emit explicit `team` follow-up guidance (for example `--followup team`)

## Problem
OMX already has the ingredients for a strong high-control workflow: `ralplan` for scoped planning, `team` for durable multi-worker execution, and `ralph` for persistence plus verification. What is still under-explained and under-productized is the handoff between planning and team execution.

Today, experienced users can manually infer the pattern: run `ralplan`, then launch `team`, then keep the work alive with `ralph`. But the workflow's biggest advantage is not just parallelism. It is coordinated execution: teammates can surface blockers early, redistribute work, and stay inspectable through panes plus runtime state. That benefit should be reflected directly in planning output.

## Proposed solution
Teach `ralplan` to support an explicit team-oriented follow-up mode, such as `--followup team`, that produces:

1. a normal implementation plan and acceptance criteria
2. recommended worker lanes / role allocation
3. suggested reasoning levels by lane
4. explicit follow-up commands or launch hints for `omx team` / `$team`
5. verification expectations that fit a `team -> ralph` execution path

This would make the intended workflow clearer:

```text
ralplan -> team -> ralph
```

## Why this is good
- Clarifies why `team` exists alongside `ultrawork`: team mode is about coordination and runtime control, not only fanout.
- Reduces the gap between planning output and actual orchestration.
- Makes one of OMX's strongest workflows more discoverable for advanced users.
- Improves execution quality on runtime-edge-case and orchestration-edge-case work, where durable coordination matters more than raw task splitting.
- Fits OMX's architecture well because the runtime already supports worker roles, mixed CLIs, runtime state, and inspectable team lifecycle commands.

## Alternatives considered
- Keep the pattern implicit in docs only. This helps discovery, but still leaves users to translate plans into worker lanes manually.
- Fold everything into `autopilot`. Useful for default automation, but weaker for users who want direct control over planning, staffing, and verification.

## Additional context
Expected user outcome: a user runs `ralplan`, sees a plan that is already shaped for team execution, launches `team` with less guesswork, and uses `ralph` to keep the workflow honest until evidence-backed completion.
