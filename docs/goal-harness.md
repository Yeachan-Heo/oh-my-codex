# Goal Harness

`omx goal-harness` is a lightweight Codex goal-native workflow that adapts the useful parts of OMX without making heavy Ultragoal ledgers the default.

The same workflow is also exposed as the sibling product CLI **OMG / Oh My Goal**:

```sh
npx -p oh-my-codex omg --help
npx -p oh-my-codex omg refine --objective "Ship this safely"
```

Use `omg <command>` when you want the goal harness as the primary product surface. Use `omx goal-harness <command>` when you are already inside the broader OMX CLI.

## Boundary

- Codex goal mode owns the single top-level objective, memory continuity, token/budget accounting, and explicit completion state.
- Goal Harness owns prompt refinement, routing policy, worker boundaries, annealing challenges, and completion-gate evidence.
- Shell commands do not mutate hidden Codex goal state. The active leader agent must call `get_goal`, `create_goal`, and `update_goal` when appropriate.
- Team workers never own the Codex goal and must not call `create_goal` or `update_goal`.

## Flow

```sh
omx goal-harness refine --objective "Ship the feature safely"
omx goal-harness interview --objective "Ship the feature safely"
omx goal-harness create --objective "Ship the feature safely" --slug safe-feature
omx goal-harness plan --slug safe-feature
omx goal-harness start --slug safe-feature
```

`refine` returns a recommended Codex goal prompt and route: direct, goal-only, plan, Ralph loop, or team-assisted. `interview` emits Socratic intake questions for ambiguity, non-goals, verification, risk, Team lanes, and persistent-loop stop conditions. `create` writes a lightweight mission under `.omx/goals/goal-harness/<slug>/`. `plan --slug` writes a ralplan-style candidate/critique artifact under the same run. `start` prints a model-facing handoff and `create_goal` payload.

## Canonical Lifecycle

For durable work, keep one Codex goal in the leader session and let the harness track evidence around it:

```sh
omx goal-harness create --objective "Ship the feature safely" --slug safe-feature
omx goal-harness interview --slug safe-feature
omx goal-harness plan --slug safe-feature
omx goal-harness start --slug safe-feature
# leader calls get_goal, then create_goal only if no active goal conflicts
omx goal-harness record-trajectory --slug safe-feature --summary "Minimal patch" --evidence "Small diff, tests identified" --score 80
omx goal-harness record-trajectory --slug safe-feature --summary "Team-pressure path" --evidence "Adds critic/tester evidence" --score 90 --novelty-score 70
omx goal-harness select --slug safe-feature --trajectory-id T002-team-pressure-path --evidence "Best verified path"
omx goal-harness step --slug safe-feature --outcome needs-team-pressure --evidence "Independent pressure required"
omx goal-harness team-plan --slug safe-feature --task "Pressure-test the selected path"
omx goal-harness team-packet --slug safe-feature
omx goal-harness import-worker-result --slug safe-feature --result .omx/goals/goal-harness/safe-feature/team-packets/<plan-id>/03-critic-result.md
omx goal-harness step --slug safe-feature --outcome ready-for-late-gate --evidence "Implementation and verification evidence ready"
omx goal-harness gate --slug safe-feature --evidence-json completion-evidence.json
# leader calls update_goal({status: "complete"}) only after the gate passes
omx goal-harness complete --slug safe-feature --codex-goal-json get-goal-complete.json
omx goal-harness summary --slug safe-feature
```

This sequence demonstrates the intended ownership split: Codex goal mode owns focus, memory, token accounting, and final status; Goal Harness owns prompt refinement, trajectory evidence, Team boundaries, phase pressure, and durable completion artifacts.

## Intake & Ralplan

Use intake before creating or selecting a plan when scope, acceptance criteria, or risk boundaries are unclear:

```sh
omx goal-harness interview --slug safe-feature
```

The slug-aware form writes `.omx/goals/goal-harness/<slug>/intake.md`. For plan selection, use:

```sh
omx goal-harness plan --slug safe-feature
```

This writes `.omx/goals/goal-harness/<slug>/plan.md` with conservative, persistent, Team-assisted, and novelty-seeking candidates plus a critique. The plan artifact recommends a `record-trajectory` command, but the leader still selects only after evidence exists.

## Runtime State

Each created harness stores `.omx/goals/goal-harness/<slug>/runtime.json`. This file is the lightweight leader-loop memory for annealing:

- current phase: early, middle, late, or stuck,
- active trajectory id,
- candidate trajectories with source, role, evidence, score, and novelty score,
- leader steps with outcome and phase transition evidence,
- team lane plans with bounded worker instructions,
- stuck-phase perturbation artifacts,
- phase history,
- bounded alternative/critic budgets.

Useful commands:

```sh
omx goal-harness status --slug safe-feature
omx goal-harness sync-goal --slug safe-feature --codex-goal-json get-goal-active.json
omx goal-harness summary --slug safe-feature
omx goal-harness next --slug safe-feature
omx goal-harness record-trajectory --slug safe-feature --summary "Minimal patch" --evidence "Smallest diff and tests pass" --score 85 --novelty-score 20
omx goal-harness record-trajectory --slug safe-feature --summary "Critic-pressure path" --evidence "Adds independent review before completion" --score 90 --novelty-score 55
omx goal-harness select --slug safe-feature --trajectory-id T002-critic-pressure-path --evidence "Best verified path after comparing independent alternatives"
omx goal-harness step --slug safe-feature --outcome needs-team-pressure --evidence "Needs independent critic/tester pressure"
omx goal-harness team-plan --slug safe-feature --task "Pressure-test the selected path"
omx goal-harness team-packet --slug safe-feature
omx goal-harness import-worker-result --slug safe-feature --result .omx/goals/goal-harness/safe-feature/team-packets/<plan-id>/<lane>-result.md
omx goal-harness advance --slug safe-feature --phase late --evidence "Implementation and verification ready"
```

`sync-goal` records a fresh `get_goal` snapshot in `.omx/goals/goal-harness/<slug>/codex-goal-status.json` during long-running work. Use it to keep active goal status, token budget, and remaining-token evidence visible without marking the local harness complete.

`next` and `summary` are artifact-aware. In early phase, they recommend `interview` first when deep-interview is required, then `plan` when ralplan is required, before moving on to trajectory recording.

`step` records a leader-loop cycle. `blocked` moves the runtime to stuck perturbation; `ready-for-late-gate` moves to the late completion challenge; `needs-team-pressure` asks for a bounded `team-plan`. Early selection requires at least two candidate trajectories and one independent alternative with distinct source, role, or novelty evidence. Late phase requires implementation evidence, a selected active trajectory, middle-phase exploitation, and at least one critic/tester pressure trajectory. `team-plan` emits worker lanes and an `omx team N:executor` launch hint. `team-packet` writes lane instruction files, result templates, a manifest, and a packet-aware Team launch command under `.omx/goals/goal-harness/<slug>/team-packets/<plan-id>/`. It still does not launch workers automatically; the leader decides when Team coordination is worth the cost.

After workers fill result templates, use `import-worker-result` to convert returned evidence into runtime trajectories. Imports require the worker to confirm that it did not call `create_goal`, did not call `update_goal`, and did not mark the mission complete. Blocked worker results become blocked trajectories; passing or issue-bearing results become candidate trajectories unless the leader overrides `--status`.

Manual worker trajectories must include both `--role <role>` and `--score <0-100>` unless they are explicitly recorded as `--status blocked`. This keeps worker output comparable for trajectory selection.

`summary` is the lightweight aggregate status surface. It counts mission, intake, plan, trajectory selection, phase pressure, completion gate, and Codex goal snapshot reconciliation stages without creating a heavy Ultragoal ledger.

When `$goal-harness` is activated through hooks, the HUD/status line can show the active harness phase as `harness:<phase>` so the leader has a compact status surface while Codex goal mode remains the source of active focus and completion state.

## Annealing Backpressure

The harness treats execution as search over trajectories. A converged-looking answer can still be a local optimum, so commitment points should run bounded pressure:

- early: broad prompt and plan candidates,
- middle: exploit the best path while tester/critic pressure remains active,
- stuck: perturb the plan or reframe without weakening acceptance criteria,
- late: run the basin-escape challenge before completion.

```sh
omx goal-harness challenge --phase late --objective "<active objective>"
```

For repeated blockers, enter stuck phase and write a perturbation artifact:

```sh
omx goal-harness step --slug safe-feature --outcome blocked --evidence "Same verification blocker repeated"
omx goal-harness perturb --slug safe-feature --blocker "Same verification blocker repeated"
omx goal-harness team-plan --slug safe-feature --task "Run stuck perturbation B001-same-verification-blocker-repeated"
```

`perturb` writes `.omx/goals/goal-harness/<slug>/perturbations/<id>.md` with a constraint-preserving reframe, distant implementation path, disconfirming verification probe, and Team pressure command. It does not weaken completion gates; it creates a bounded way to escape a local optimum and collect new evidence.

## Completion

The leader may call `update_goal({status: "complete"})` only after `omx goal-harness gate` accepts structured evidence for objective audit, implementation evidence, passing external verification, clear adversarial review, and a passed basin-escape challenge. Passing verification must include inspected evidence plus either a command or artifact path; the convergence challenge must compare at least two alternatives.

For durable harness runs, include the slug:

```sh
omx goal-harness gate --slug safe-feature --evidence-json completion-evidence.json
```

Slug-aware gates require the runtime to be in `late` phase, write `.omx/goals/goal-harness/<slug>/completion-gate.json`, store the latest gate summary in `runtime.json`, and mark the local workflow `validation_passed` only when all evidence is clean. This still does not mutate Codex goal state; the leader calls `update_goal` after local validation passes.

Minimal evidence shape:

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

After `update_goal({status: "complete"})` succeeds, call `get_goal` again and reconcile the fresh complete snapshot:

```sh
omx goal-harness complete --slug safe-feature --codex-goal-json get-goal-complete.json
```

`complete` writes `.omx/goals/goal-harness/<slug>/codex-goal-snapshot.json`, checks that the Codex goal objective matches the harness objective and status is `complete`, records token budget/remaining-token fields when present, and only then marks the local workflow `complete`.
