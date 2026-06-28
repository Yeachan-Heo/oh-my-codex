---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over Codex goal mode artifacts.
---

# Ultragoal Workflow

Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`, durable multi-goal planning, or sequential execution over Codex `/goal`.

## Purpose

`ultragoal` turns a brief into repo-native artifacts and then drives a Codex goal safely through goal tools. New plans default to a stable pointer-style aggregate Codex goal for the whole durable plan in `.omx/ultragoal/goals.json`, including later accepted/appended stories under the original brief constraints, while OMX tracks G001/G002 story progress in the ledger. Ultragoal does not call Codex `/goal clear`; before multiple sequential ultragoal runs in one Codex session/thread, manually run `/goal clear` in the Codex UI so the previous completed aggregate goal does not block or confuse the next `create_goal`.

- `.omx/ultragoal/brief.md`
- `.omx/ultragoal/goals.json`
- `.omx/ultragoal/ledger.jsonl` (checkpoint and structured steering audit events)

Existing aggregate plans with the legacy enumerated objective are migrated to the stable pointer objective on read, persisted to `goals.json`, retained in `codexObjectiveAliases` for already-active hidden Codex goal reconciliation, and audited with an `aggregate_objective_migrated` ledger entry.


## State/HUD Phase Contract

Ultragoal is both a tracked workflow skill and the Autopilot durable-implementation child phase. Keep the phase/HUD contract explicit at workflow boundaries:

- **Standalone `$ultragoal` activation**: ensure `.omx/state[/sessions/<session>]/ultragoal-state.json` exists with `mode:"ultragoal"`, `active:true`, and a non-empty `current_phase` such as `planning` before or while goals are created. This state is a lightweight HUD/runtime declaration; `.omx/ultragoal/goals.json` and `ledger.jsonl` remain the durable goal source of truth.
- **During execution**: update `current_phase` to the smallest accurate phase (`planning`, `executing`, `verifying`, `reviewing`, `checkpointing`, or `blocked`) when the visible workflow phase changes.
- **Inside active Autopilot**: keep `mode:"autopilot"` active and set the supervised phase to `current_phase:"ultragoal"`; do not start a peer Autopilot replacement. Ultragoal's own mode state may still exist as child-phase detail, but Autopilot owns the parent phase.
- **On handoff to code-review**: persist implementation/test/ledger evidence under Autopilot `handoff_artifacts.ultragoal`, then set Autopilot `current_phase:"code-review"`.
- **On completion/blocker**: set standalone Ultragoal `active:false,current_phase:"complete"` only when all durable goals are complete; otherwise keep it active with a blocker/review-blocked phase and ledger evidence.

Minimal standalone phase declaration:

```sh
omx state write --input '{"mode":"ultragoal","active":true,"current_phase":"planning"}' --json
```

Minimal Autopilot child-phase declaration:

```sh
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ultragoal"}' --json
```

## Create goals

1. Run one of:
   - `omx ultragoal create-goals --brief "<brief>"`
   - `omx ultragoal create-goals --brief-file <path>`
   - `cat <brief> | omx ultragoal create-goals --from-stdin`
   - `omx ultragoal create-goals --codex-goal-mode per-story --brief "<brief>"` only when one Codex goal context per story is explicitly preferred
2. Inspect `.omx/ultragoal/goals.json` and refine if needed.

## Complete goals

Loop until `omx ultragoal status` reports all goals complete:

1. Run `omx ultragoal complete-goals`.
2. Read the printed handoff.
3. Call `get_goal`.
4. If no active Codex goal exists, call `create_goal` with the printed payload. In aggregate mode, if the same aggregate Codex objective is already active, continue the current OMX story without creating a new Codex goal.
5. Complete the current OMX story only.
6. Run a completion audit against the story objective and real artifacts/tests.
7. In aggregate mode, do **not** call `update_goal` for intermediate stories; checkpoint with a fresh `get_goal` snapshot whose aggregate objective is still `active`. On the final story only, first run the mandatory final cleanup/review gate below; call `update_goal({status: "complete"})` only after that gate is clean, then call `get_goal` again for a fresh `complete` snapshot.
8. Checkpoint the durable ledger with that snapshot. Intermediate aggregate checkpoints use only `--codex-goal-json`; final clean checkpoints also require `--quality-gate-json`:
   `omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --codex-goal-json <get_goal-json-or-path> [--quality-gate-json <quality-gate-json-or-path>]`
9. If blocked or failed, checkpoint failure:
   `omx ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
10. For legacy per-story completed-goal blockers, preserve the non-terminal blocker with:
   `omx ultragoal checkpoint --goal-id <id> --status blocked --evidence "<completed legacy Codex goal blocks create_goal in this thread>" --codex-goal-json <get_goal-json-or-path>`
11. Resume failed goals with `omx ultragoal complete-goals --retry-failed`.

## Dynamic steering

Use `omx ultragoal steer` when real findings or blockers prove the current story decomposition should change while the aggregate objective and constraints stay fixed. Steering is explicit-only and evidence-backed; broad natural-language requests are rejected instead of guessed.

Allowed mutation kinds are:

- `add_subgoal`
- `split_subgoal`
- `reorder_pending`
- `revise_pending_wording`
- `annotate_ledger`
- `mark_blocked_superseded`

Examples:

```sh
omx ultragoal steer --kind add_subgoal --title "Investigate blocker" --objective "Validate the blocker and report evidence." --evidence "log/test output" --rationale "The blocker changes the safe execution order." --json
omx ultragoal steer --directive-json ./steering.json --json
```

Steering invariants:

- Do not edit the aggregate Codex objective, original brief constraints, quality gates, or completion status. The aggregate objective is a stable pointer to `.omx/ultragoal/goals.json` and `.omx/ultragoal/ledger.jsonl`, not an enumeration of initial goal ids.
- Do not hard-delete goals, auto-complete work, weaken verification, or silently mutate `.omx/ultragoal`.
- Accepted and rejected attempts append structured audit entries to `.omx/ultragoal/ledger.jsonl`.
- Superseded goals remain in `goals.json` with steering metadata and are skipped for scheduling.
- Blocked goals without replacements are skipped for scheduling but still block final completion until later explicit steering replaces or supersedes them.

UserPromptSubmit uses the same steering API only for structured directives such as `OMX_ULTRAGOAL_STEER: { ... }`, `omx.ultragoal.steer: { ... }`, or `omx ultragoal steer: { ... }`. Normal prose does not mutate state, and repeated prompt-submit directives dedupe by prompt signature or idempotency key.

## Use Ultragoal and Team together

Use ultragoal and team together for a durable Ultragoal story that benefits from parallel execution. Ultragoal remains leader-owned: `.omx/ultragoal/goals.json` stores the story plan and `.omx/ultragoal/ledger.jsonl` stores checkpoints. Team is the parallel execution engine and returns task/evidence status to the leader.

The leader checkpoints Ultragoal from Team evidence with a fresh `get_goal` snapshot:

```sh
omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .omx/ultragoal and <id>>" --codex-goal-json <fresh-get_goal-json-or-path>
```

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Team launch remains explicit; Ultragoal does not auto-launch Team and performs no hidden Codex goal mutation.

## Mandatory final cleanup and review gate

The final ultragoal story is not complete until the active agent has run the final quality gate:

1. Run targeted verification for the story.
2. Run `ai-slop-cleaner` on changed files only; if there are no relevant edits, the cleaner still runs and records a passed/no-op report.
3. Rerun verification after the cleaner pass.
4. Run the architecture-invariant audit: derive non-negotiable architecture/domain invariants from the brief/spec/interview/accepted steering/goal artifacts, list the source artifacts, and prove each required invariant with implementation, test, and independent review evidence.
5. Run `$code-review` through the independent review path. Clean means `codeReview.recommendation: "APPROVE"`, `codeReview.architectStatus: "CLEAR"`, `codeReview.independentReview` contains distinct completed `code-reviewer` and `architect` subagent evidence, and `architectureInvariantGate.status: "passed"` proves every required invariant. `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, missing subagent evidence, unavailable delegation, same-lane/self-review, and unproved architecture invariants are non-clean.
6. If review or invariant proof is non-clean, do **not** call `update_goal`. Record durable blocker work instead:


   ```sh
   omx ultragoal record-review-blockers --goal-id <id> --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --codex-goal-json <active-get-goal-json-or-path>
   ```

   This marks the current story `review_blocked`, appends a pending blocker-resolution story, keeps the Codex goal active, and lets `omx ultragoal complete-goals` start the blocker next. In legacy per-story mode, the blocker may need an available Codex goal context because the old per-story Codex goal remains active/incomplete.

7. If review and invariant proof are clean, call `update_goal({status: "complete"})`, call `get_goal`, and checkpoint with a structured final gate:


   ```sh
   omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<tests/files/review evidence>" --codex-goal-json <fresh-complete-get-goal-json-or-path> --quality-gate-json <quality-gate-json-or-path>
   ```

`--quality-gate-json` must include:

```json
{
  "aiSlopCleaner": { "status": "passed", "evidence": "cleaner report" },
  "verification": { "status": "passed", "commands": ["npm test"], "evidence": "post-cleaner verification" },
  "codeReview": {
    "recommendation": "APPROVE",
    "architectStatus": "CLEAR",
    "evidence": "final review synthesis",
    "independentReview": {
      "codeReviewer": { "agentRole": "code-reviewer", "evidence": "code-reviewer subagent APPROVE evidence" },
      "architect": { "agentRole": "architect", "evidence": "architect subagent CLEAR evidence" }
    }
  },
  "architectureInvariantGate": {
    "status": "passed",
    "sourceArtifacts": [".omx/ultragoal/brief.md", ".omx/ultragoal/goals.json"],
    "evidence": "final invariant audit proved all required architecture/domain invariants",
    "invariants": [
      {
        "invariant": "Preserve the existing parser boundary.",
        "source": ".omx/ultragoal/brief.md#architecture-invariants",
        "status": "proved",
        "implementationEvidence": "changed files preserve the parser boundary",
        "testEvidence": "parser-boundary regression passed",
        "reviewEvidence": "architect review confirmed the boundary is intact"
      }
    ]
  }
}
```

## Constraints

- The shell command cannot directly invoke Codex interactive `/goal`; it emits a model-facing handoff for the active Codex agent.
- Ultragoal intentionally does not invoke `/goal clear` or hidden `thread/goal/clear`; the model-facing tool surface only provides `get_goal`, `create_goal`, and `update_goal`.
- After a completed aggregate ultragoal run, `/goal clear` is the explicit terminal cleanup step before starting another goal in the same Codex thread/session: `create_goal` starts, `update_goal({status: "complete"})` marks terminal success, and `/goal clear` removes the completed thread goal for the next same-thread goal. OMX prints this next step but does not invoke hidden clear routes.
- Never call `create_goal` when `get_goal` reports a different active goal.
- Never call `update_goal` unless the aggregate run or legacy per-story goal is actually complete.
- In aggregate mode, intermediate story checkpoints require a matching `active` Codex snapshot; final story completion requires a matching `complete` snapshot after `update_goal`.
- Completion checkpoints require read-only Codex snapshot reconciliation: pass fresh `get_goal` JSON/path with `--codex-goal-json`; shell commands and hooks must not mutate Codex goal state.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
