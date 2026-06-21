---
name: performance-goal
description: "Run an evaluator-gated performance optimization workflow over Codex goal mode with durable OMX artifacts and safe goal handoffs."
---

# Performance Goal Workflow

Use this skill when a user asks OMX to optimize performance and wants a goal-oriented loop rather than a one-off review.

## Contract

- OMX owns durable workflow state under `.omx/goals/performance/<slug>/`.
- Codex goal mode owns only the active-thread focus/accounting primitive.
- Shell commands do **not** mutate hidden Codex goal state. They write artifacts and emit model-facing handoff text.
- No optimization work may start until an evaluator command and pass/fail contract exist.
- Do not call `update_goal({status: "complete"})` until the evaluator has a passing checkpoint and a completion audit proves the objective is done; then call `get_goal` again and pass that fresh snapshot to `omx performance-goal complete --codex-goal-json`.

## CLI

Create the workflow and evaluator contract:

```sh
omx performance-goal create \
  --objective "Reduce CLI startup latency by 20%" \
  --evaluator-command "npm run perf:startup" \
  --evaluator-contract "PASS when p95 latency improves by 20% and regression tests pass" \
  --slug startup-latency
```

Emit the Codex goal handoff:

```sh
omx performance-goal start --slug startup-latency
```

Record evaluator evidence:

```sh
omx performance-goal checkpoint --slug startup-latency --status pass --evidence "benchmark + tests passed"
omx performance-goal checkpoint --slug startup-latency --status fail --evidence "benchmark regressed"
omx performance-goal checkpoint --slug startup-latency --status blocked --evidence "missing fixture"
```

Complete only after a passing checkpoint:

```sh
omx performance-goal complete --slug startup-latency --evidence "final evaluator evidence" --codex-goal-json <get_goal-json-or-path>
```

## Agent Loop

1. Run `omx performance-goal create` if no workflow exists.
2. Run `omx performance-goal start` and follow the handoff:
   - call `get_goal`;
   - call `create_goal` only when no active goal exists and the objective is explicit;
   - work only against the evaluator contract;
   - after evaluator pass and completion audit, call `update_goal({status: "complete"})`, call `get_goal` again, and pass that snapshot to `omx performance-goal complete --codex-goal-json`;
   - after `omx performance-goal complete` succeeds, run `/goal clear` in the Codex UI before starting another goal in this same thread/session; OMX prints this terminal cleanup step but does not invoke hidden clear routes;
3. Optimize in small reversible patches.
4. Run the evaluator and related regression tests.
5. Record each pass/fail/blocker with `checkpoint`.
6. Complete only when the pass artifact exists and no required work remains.

## Completion Gate

A performance goal is incomplete unless `.omx/goals/performance/<slug>/state.json` contains a `lastValidation.status` of `pass` and `omx performance-goal complete` receives a matching complete Codex `get_goal` snapshot via `--codex-goal-json`. Passing ordinary tests alone is not sufficient unless they are the declared evaluator contract.

Lifecycle: `create_goal` starts the Codex thread goal, `update_goal({status: "complete"})` marks terminal success after the evaluator and audit pass, and `/goal clear` removes the completed thread goal when another same-thread goal is needed. OMX shell commands and hooks reconcile snapshots and print the cleanup instruction; they must not mutate hidden Codex goal state.
