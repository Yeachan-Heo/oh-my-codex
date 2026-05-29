---
name: goal-harness
description: "[OMX] Single-Codex-goal autonomy harness with prompt refinement, Ralph-style persistence, optional Team lanes, and annealing backpressure."
---

# Goal Harness

Use `$goal-harness` when the user wants one Codex goal to drive a long-running OMX-derived workflow without defaulting to heavy Ultragoal ledgers.

The same harness ships as the sibling product CLI `omg`:

```sh
npx -p oh-my-codex omg --help
npx -p oh-my-codex omg refine --objective "<user request>"
```

`omg <command>` is equivalent to `omx goal-harness <command>` and is the preferred product-level surface when the user asks for an npx-installable goal harness.

## Purpose

Goal Harness keeps Codex goal mode as the top-level runtime contract and uses lightweight OMX policy around it:

- deep-interview intake for ambiguity,
- prompt refinement before `create_goal`,
- Ralph-style persistent leader execution,
- optional Team lanes for evidence-producing exploration, implementation, testing, or critique,
- annealing/backpressure to avoid premature convergence,
- a strict completion gate before `update_goal({status: "complete"})`.

## Start

1. Refine the raw request:

   ```sh
   omx goal-harness refine --objective "<user request>"
   omx goal-harness interview --objective "<user request>"
   ```

2. When a durable handoff is useful, create a lightweight mission:

   ```sh
   omx goal-harness create --objective "<user request>" --slug <slug>
   omx goal-harness plan --slug <slug>
   omx goal-harness start --slug <slug>
   ```

3. Read the printed `create_goal` payload. The active leader may call `create_goal` only when `get_goal` reports no conflicting active goal.

## Canonical Lifecycle

For durable work, follow the same order the harness tests exercise:

```sh
omx goal-harness create --objective "<user request>" --slug <slug>
omx goal-harness interview --slug <slug>
omx goal-harness plan --slug <slug>
omx goal-harness start --slug <slug>
# leader calls get_goal, then create_goal only if no active goal conflicts
omx goal-harness record-trajectory --slug <slug> --summary "<strategy A>" --evidence "<evidence>" --score 80
omx goal-harness record-trajectory --slug <slug> --summary "<strategy B>" --evidence "<evidence>" --score 90 --novelty-score 70
omx goal-harness select --slug <slug> --trajectory-id <id> --evidence "<why this path wins>"
omx goal-harness step --slug <slug> --outcome needs-team-pressure --evidence "<why external pressure is needed>"
omx goal-harness team-plan --slug <slug> --task "<bounded worker pressure task>"
omx goal-harness team-packet --slug <slug>
omx goal-harness import-worker-result --slug <slug> --result .omx/goals/goal-harness/<slug>/team-packets/<plan-id>/<lane>-result.md
omx goal-harness step --slug <slug> --outcome ready-for-late-gate --evidence "<implementation and verification evidence ready>"
omx goal-harness gate --slug <slug> --evidence-json <completion-evidence-json>
# leader calls update_goal({status: "complete"}) only after the gate passes
omx goal-harness complete --slug <slug> --codex-goal-json <fresh-get_goal-json-or-path>
omx goal-harness summary --slug <slug>
```

This keeps Codex goal mode responsible for active focus, memory, token/budget accounting, and final completion status while the harness records prompt refinement, trajectory evidence, Team boundaries, phase pressure, and durable artifacts.

## Deep Interview & Ralplan

Use `interview` when ambiguity, non-goals, acceptance criteria, risk safeguards, Team lanes, or persistent-loop stop conditions are unclear. With `--slug`, it writes `.omx/goals/goal-harness/<slug>/intake.md`.

Use `plan --slug <slug>` before selecting the first trajectory on nontrivial work. It writes `.omx/goals/goal-harness/<slug>/plan.md` with conservative, persistent, Team-assisted, and novelty-seeking candidates plus a critique. Treat these as candidates, not completion evidence; record the winning candidate as a trajectory only after the leader has concrete evidence.

## Persistent Leader Loop

`create` also writes `.omx/goals/goal-harness/<slug>/runtime.json`. This is the lightweight Ralph-style state for the leader loop: current phase, active trajectory, candidate trajectories, leader steps, team lane plans, phase history, and bounded annealing budgets.

Use it during execution:

```sh
omx goal-harness status --slug <slug>
omx goal-harness sync-goal --slug <slug> --codex-goal-json <fresh-active-get_goal-json-or-path>
omx goal-harness summary --slug <slug>
omx goal-harness next --slug <slug>
omx goal-harness record-trajectory --slug <slug> --summary "<strategy A>" --evidence "<evidence>" --score 80 --novelty-score 20
omx goal-harness record-trajectory --slug <slug> --summary "<strategy B>" --evidence "<independent evidence>" --score 90 --novelty-score 55
omx goal-harness select --slug <slug> --trajectory-id <id> --evidence "<why this path wins after comparing independent alternatives>"
omx goal-harness step --slug <slug> --outcome progress --evidence "<what changed and how it was checked>"
omx goal-harness advance --slug <slug> --phase late --evidence "<implementation evidence ready>"
```

Use `sync-goal` after `get_goal` checkpoints during long-running work. It records active goal status, token budget, and remaining-token evidence in `codex-goal-status.json` without marking the local harness complete.

`next` and `summary` are artifact-aware: in early phase, they recommend `interview` first when deep-interview is required, then `plan` when ralplan is required, before trajectory recording.

The leader should keep the selected trajectory aligned with the Codex goal objective. A trajectory is not completion proof; it is a search path with evidence.

Use `summary` as the lightweight aggregate status surface. It counts mission, intake, plan, trajectory, phase-pressure, completion-gate, and Codex-goal reconciliation stages without creating heavy Ultragoal ledgers. Hook/HUD surfaces show active `$goal-harness` work as `harness:<phase>`.

Use `step` after meaningful leader-loop cycles. `blocked` enters stuck perturbation, `ready-for-late-gate` enters the late completion challenge, and `needs-team-pressure` asks for an explicit worker plan. Early selection requires at least two candidate trajectories and one independent alternative with distinct source, role, or novelty evidence. Late phase requires implementation evidence, a selected active trajectory, middle-phase exploitation, and at least one critic/tester pressure trajectory:

```sh
omx goal-harness step --slug <slug> --outcome needs-team-pressure --evidence "<why external pressure is needed>"
omx goal-harness team-plan --slug <slug> --task "<bounded worker pressure task>"
omx goal-harness team-packet --slug <slug>
```

## Runtime Policy

- One Codex goal owns the whole mission. Do not create per-subtask Codex goals.
- The leader owns `get_goal`, `create_goal`, and `update_goal`.
- Workers must not call `create_goal` or `update_goal`.
- Workers return evidence: diffs, risks, blockers, commands, test results, and trajectory scores.
- Use `$team` only when independent lanes are worth the coordination cost.
- Use Ralph-style persistence for long execution, but keep completion tied to the Codex goal objective.

## Annealing Backpressure

Treat execution as search over trajectories. A working-looking result may be a local optimum. Before commitment points, especially completion, run:

```sh
omx goal-harness challenge --phase late --objective "<objective>"
```

The late challenge must attack the completion claim with missed requirements, edge cases, independent alternatives, and external verification coverage. Prefer the current solution only when it survives evidence.

When the leader hits a repeated blocker, enter stuck phase and perturb the plan:

```sh
omx goal-harness step --slug <slug> --outcome blocked --evidence "<repeated blocker>"
omx goal-harness perturb --slug <slug> --blocker "<repeated blocker>"
omx goal-harness team-plan --slug <slug> --task "Run stuck perturbation <id>"
```

`perturb` writes `.omx/goals/goal-harness/<slug>/perturbations/<id>.md` with a constraint-preserving reframe, distant implementation path, disconfirming verification probe, and Team pressure command. It should never weaken the completion gate.

## Team Boundary

Generate worker instructions with:

```sh
omx goal-harness worker-instruction --role critic --task "<assigned lane>"
```

Every worker instruction must include the boundary that workers do not own the Codex goal and must not call `create_goal` or `update_goal`.

For multiple lanes, prefer the runtime-backed plan:

```sh
omx goal-harness team-plan --slug <slug> --task "<bounded task>"
omx goal-harness team-packet --slug <slug>
```

`team-plan` emits lane-specific worker instructions and an `omx team N:executor` launch hint. `team-packet` writes a manifest plus lane instruction/result-template files under `.omx/goals/goal-harness/<slug>/team-packets/<plan-id>/` and returns a packet-aware Team launch command. The leader still decides whether to launch Team.

After workers fill result templates, import the evidence:

```sh
omx goal-harness import-worker-result --slug <slug> --result .omx/goals/goal-harness/<slug>/team-packets/<plan-id>/<lane>-result.md
```

Imports require the worker to confirm that it did not call `create_goal`, did not call `update_goal`, and did not mark the whole mission complete. The command records accepted worker output as a trajectory with the worker role, score, novelty score, risk/blocker text, and evidence.

If a worker did not use a packet template, record the evidence manually:

```sh
omx goal-harness record-trajectory --slug <slug> --source worker --role critic --summary "<critique>" --evidence "<findings>" --score 65
```

Manual worker trajectories must include `--role <role>` and `--score <0-100>` unless the trajectory is explicitly recorded as `--status blocked`.

## Completion Gate

Do not call `update_goal({status: "complete"})` until the leader has:

1. objective audit,
2. implementation evidence,
3. passing external verification,
4. clear adversarial review,
5. passed basin-escape convergence challenge.

Passing verification must include inspected evidence plus either a concrete `command` or `artifactPath`; self-asserted pass text is not enough. The convergence challenge must compare at least two alternatives before the current path can be treated as complete.

Check structured evidence with:

```sh
omx goal-harness gate --slug <slug> --evidence-json <json-or-path>
```

The slug-aware gate requires `late` phase, writes `.omx/goals/goal-harness/<slug>/completion-gate.json`, updates the latest gate summary in `runtime.json`, and marks the local workflow `validation_passed` only when clean. It does not mutate hidden Codex goal state.

Minimal gate evidence:

```json
{
  "actor": "leader",
  "objectiveAudit": "Every requirement maps to evidence.",
  "implementationEvidence": ["src/goal-harness/policy.ts tightened completion checks"],
  "externalVerification": [
    { "command": "npm run build", "status": "pass", "evidence": "build completed and output was inspected" }
  ],
  "adversarialReview": { "status": "clear", "evidence": "critic pass found no unresolved blockers" },
  "convergenceChallenge": { "status": "passed", "alternativesConsidered": 2, "evidence": "two independent alternatives were compared and rejected by evidence" }
}
```

After the gate passes, the leader may call `update_goal({status: "complete"})`. Then call `get_goal` again and reconcile the fresh complete snapshot:

```sh
omx goal-harness complete --slug <slug> --codex-goal-json <fresh-get_goal-json-or-path>
```

`complete` writes `.omx/goals/goal-harness/<slug>/codex-goal-snapshot.json`, requires the Codex goal objective to match the harness objective, requires status `complete`, records token budget fields when present, and marks the local workflow `complete`. If either gate or reconciliation is not clean, continue the leader loop or launch bounded critic/tester/replanner passes.
