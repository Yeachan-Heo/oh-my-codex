---
name: runingteam
description: First-class dynamic planning + team orchestration mode; replaces manual ralplan -> team chaining with checkpoint-gated Plan/Team/Evidence/Critic/Planner loops.
---

# RuningTeam Skill

RuningTeam is the dynamic planning workflow for OMX. Use it when the user wants `ralplan`-quality planning and `team`-style parallel execution without manually running `$ralplan` and then `$team`.

## Core Contract

RuningTeam is not a static pre-plan. It is a checkpoint-gated controller:

```text
Plan vN -> Team batch -> Evidence collection -> Critic review -> Planner revision -> Plan vN+1 -> Next batch
```

## Invocation

Preferred CLI launch, equivalent to an interactive OMX launch profile:

```bash
omx --runingteam --madmax "ship the feature"
```

Alternative command form:

```bash
omx runingteam "ship the feature"
```

Prompt-side activation:

```text
$runingteam ship the feature
```

## Behavior

When RuningTeam is active:

1. Establish task, scope, acceptance criteria, and lane split.
2. Launch or drive `omx team` only after a checkpoint-ready plan exists.
3. Require workers to report evidence: claim, files changed, tests run, blockers, next needed.
4. Review each batch through Critic before revising the plan.
5. Revise only at checkpoints; never mutate worker instructions mid-batch.
6. Keep state in existing OMX state surfaces and RuningTeam controller state.
7. Require final synthesis and verification evidence before completion.

## Safety Rules

- Do not require a separate `$ralplan` first; RuningTeam owns dynamic planning.
- Do not silently weaken acceptance criteria to fit failed work.
- Do not ignore failed tests or missing worker evidence.
- Do not spawn nested team sessions from worker panes.
- Do not declare complete without final synthesis.

## Output Contract

Report concisely:

- current checkpoint / plan version;
- active lanes and owners;
- evidence received;
- Critic verdict;
- next batch or final synthesis status.
