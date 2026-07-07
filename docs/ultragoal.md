# Ultragoal

`ultragoal` is a durable, repo-native multi-goal workflow layered over Codex goal mode. It keeps the long-range plan in files while Codex goal mode tracks the active thread focus.

## Why this shape

Codex CLI 0.128.0 exposes `goals` as an enabled feature, but `codex --help` has no `goal` shell subcommand. In this runtime, goal mode is exposed to the agent as model tools:

- `get_goal` reads the active thread goal.
- `create_goal` creates one active objective for a thread and fails if the thread already has a goal.
- `update_goal` can only mark the existing goal `complete`.

Upstream Codex goal source also constrains objectives to 4,000 characters, tracks token/time usage, emits `ThreadGoalUpdated` events, and uses continuation/budget-limit prompts to keep work focused. OMX therefore must not pretend a shell command can mutate hidden Codex thread state. Instead, `omx ultragoal complete-goals` checkpoints repo state and prints an explicit handoff for the active Codex agent to call goal tools safely.

New ultragoal plans default to **aggregate Codex goal mode**: Codex gets one objective for the whole ultragoal run, while OMX owns G001/G002 story state and ledger checkpoints. This avoids the impossible same-thread transition from a completed G001 Codex goal to a new G002 Codex goal. Legacy or explicitly requested **per-story** plans remain supported for users who want one Codex thread per story.

Ultragoal intentionally does **not** call Codex `/goal clear`. The interactive TUI/app-server may expose `thread/goal/clear`, but the agent/tool contract available to OMX is only `get_goal` / `create_goal` / `update_goal`; shell commands and hooks cannot clear hidden thread goal state. After completing one ultragoal run, manually run `/goal clear` in the Codex UI before `create_goal` for a new same-thread run. Otherwise `get_goal` may still report the previous completed aggregate objective, and the next same-thread `create_goal` can be blocked or confusing even though the OMX ledger for the previous run is complete.

## Artifacts

All artifacts live under `.omx/ultragoal/`:

- `brief.md` — original project/conversation brief.
- `goals.json` — ordered durable plan with status, attempts, evidence, and the active goal id.
- `ledger.jsonl` — append-only checkpoint and steering events (`plan_created`, `goal_started`, `goal_resumed`, `goal_completed`, `goal_blocked`, `goal_failed`, `goal_retried`, `aggregate_objective_migrated`, `goal_added`, `steering_accepted`, `steering_rejected`, `final_review_failed`, `goal_review_blocked`).

In aggregate mode, `goals.json` also stores:

- `codexGoalMode: "aggregate"`
- `codexObjective` — the exact deterministic pointer objective sent to `create_goal`: complete the durable plan in `.omx/ultragoal/goals.json`, including later accepted/appended stories, under the original brief constraints, using `.omx/ultragoal/ledger.jsonl` as the audit trail. It deliberately does not enumerate initial `G###` ids, so explicit steering can add or split pending stories without weakening the immutable end goal.

Existing aggregate plans with the legacy enumerated objective are migrated to this pointer objective when read; the migration is persisted to `goals.json`, the previous objective is retained in `codexObjectiveAliases` so an already-active hidden Codex goal can still reconcile, and the change is audited with an `aggregate_objective_migrated` ledger entry.

## Commands

Create a plan:

```sh
omx ultragoal create-goals --brief "Ship the feature in three safe milestones"
omx ultragoal create-goals --brief-file docs/my-brief.md
cat docs/my-brief.md | omx ultragoal create-goals --from-stdin
omx ultragoal create-goals --codex-goal-mode per-story --brief "Use one Codex goal context per story"
```

Start or resume the next goal:

```sh
omx ultragoal complete-goals
```

The command marks the next pending OMX story `in_progress`, appends a ledger entry, and prints a goal-tool handoff. In aggregate mode, the agent should call `get_goal`, then `create_goal` only if no active Codex goal exists. If the same aggregate objective is already active, the agent continues the next OMX story without creating a new Codex goal.

For intermediate stories, do **not** call `update_goal`; checkpoint the OMX story with a fresh `get_goal` snapshot whose objective matches `codexObjective` and whose status is still `active`:

```sh
omx ultragoal checkpoint --goal-id G001-example --status complete --evidence "npm test passed; docs updated" --codex-goal-json ./get-goal.json
```

For the final story, run the whole-run audit plus the mandatory final `ai-slop-cleaner`, post-cleaner verification, architecture-invariant audit, and independent `$code-review` gate. If review is clean (`APPROVE` + `CLEAR` with distinct `code-reviewer` and `architect` subagent evidence) and every required architecture/domain invariant from the brief/spec/planning artifacts is proved with implementation, test, and review evidence, call `update_goal({status: "complete"})`, call `get_goal` again, and checkpoint with the fresh complete aggregate snapshot plus `--quality-gate-json`. If review is non-clean or any invariant is unproved, do not call `update_goal`; use `omx ultragoal record-review-blockers` to append a durable blocker-resolution story and continue.


Failure handling:

```sh
omx ultragoal checkpoint --goal-id G001-example --status failed --evidence "blocked on missing credential"
omx ultragoal complete-goals --retry-failed
```

Failed goals remain durable retry/blocker evidence in `.omx/ultragoal`; they
are not a live execution mode by themselves. `omx status` reports a durable
failed Ultragoal plan as `FAILED` rather than `ACTIVE`, while `omx cancel`
continues to cancel only active mode-state entries. HUD and state API readers
may still expose failed goals as active unresolved durable artifacts; that
`active` field is a visibility/lifecycle signal, not proof of a cancellable
runtime mode.

Completed legacy thread-goal blocker handling:

```sh
omx ultragoal checkpoint --goal-id G001-example --status blocked --evidence "completed legacy Codex goal blocks create_goal in this thread" --codex-goal-json ./get-goal.json
```

`--status blocked` is a non-terminal ledger checkpoint for legacy per-story or pre-aggregate sessions: a previous, different Codex thread goal is already `complete`, and the current `get_goal`/`create_goal` tool surface has no reset/new-goal operation that can clear that completed goal from the same thread. This writes a `goal_blocked` event, preserves the ultragoal as `in_progress`, and records that the agent must continue the same repo/worktree only from a Codex goal context where `create_goal` can start the active ultragoal objective.

Status:

```sh
omx ultragoal status
omx ultragoal status --codex-goal-json ./get-goal.json
omx ultragoal status --json
```

## Dynamic steering

`omx ultragoal steer` lets an agent revise the OMX story decomposition when real findings or blockers prove the current sub-goals are no longer the best route to the unchanged aggregate objective. Steering is explicit-only and evidence-backed; broad natural-language requests such as “make the goal easier” are rejected instead of guessed.

Allowed mutation kinds are:

- `add_subgoal`
- `split_subgoal`
- `reorder_pending`
- `revise_pending_wording`
- `annotate_ledger`
- `mark_blocked_superseded`

Examples:

```sh
omx ultragoal steer --kind add_subgoal --title "Investigate blocker" --objective "Validate the new blocker and report evidence." --evidence "log/test output" --rationale "The blocker changes the safe execution order." --json
omx ultragoal steer --directive-json ./steering.json --json
```

Steering invariants:

- The aggregate Codex objective, original brief constraints, quality gates, and completion status are immutable.
- Steering cannot hard-delete goals, auto-complete work, weaken tests/reviews/verification, or silently mutate state.
- Accepted and rejected attempts append structured audit evidence to `.omx/ultragoal/ledger.jsonl`.
- Superseded goals stay in `goals.json` with steering metadata; they are skipped for scheduling but remain audit-visible.
- A blocked goal without replacements is skipped for scheduling but still blocks final completion until a later explicit steering mutation replaces or supersedes it.

UserPromptSubmit integration uses the same core steering API. Only explicit structured directives such as `OMX_ULTRAGOAL_STEER: { ... }` / `omx.ultragoal.steer: { ... }` / `omx ultragoal steer: { ... }` are parsed. Normal prose is ignored for mutation, and repeated prompt-submit directives dedupe by prompt signature/idempotency key.

## Use Ultragoal and Team together

Use ultragoal and team together when one durable Ultragoal story needs parallel execution lanes. Ultragoal remains the leader-owned durable goal wrapper: `.omx/ultragoal/goals.json` stores story state and `.omx/ultragoal/ledger.jsonl` stores the audit trail. Team is the parallel execution engine: workers own Team tasks, mailbox updates, verification notes, and terminal task evidence.

The leader checkpoints Ultragoal from Team evidence only after reconciling the Codex goal state. For an intermediate aggregate story, the leader calls `get_goal`, confirms the aggregate objective is still `active`, then runs:

```sh
omx ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .omx/ultragoal and <id>>" --codex-goal-json <fresh-get_goal-json-or-path>
```

For the final aggregate story, run the mandatory final cleanup/review gate first, call `update_goal({status: "complete"})` only when it is clean, call `get_goal` again, and checkpoint with `--quality-gate-json`.

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Team launch is explicit operator action; `omx ultragoal` does not auto-launch Team and performs no hidden Codex goal mutation.

## Mandatory final cleanup and review gate

The final ultragoal story is not complete until the active agent has run the final quality gate:

1. Run targeted verification for the story.
2. Run `ai-slop-cleaner` on changed files only; if there are no relevant edits, the cleaner still runs and records a passed/no-op report.
3. Rerun verification after the cleaner pass.
4. Run the architecture-invariant audit: derive non-negotiable architecture/domain invariants from the brief/spec/interview/accepted steering/goal artifacts, list the source artifacts, and prove each required invariant with implementation, test, and independent review evidence.
5. Run `$code-review` through the independent review path. Clean means `codeReview.recommendation: "APPROVE"`, `codeReview.architectStatus: "CLEAR"`, `codeReview.independentReview` contains distinct completed `code-reviewer` and `architect` subagent evidence, and `architectureInvariantGate.status: "passed"` proves every required invariant. `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, missing subagent evidence, unavailable delegation, same-lane/self-review, and unproved architecture invariants are non-clean. If the approved plan already used Scholastic for ontology-heavy review, carry that advisory evidence into the quality gate; non-clean Scholastic findings should be treated as blocker evidence rather than a completion claim.
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

When Scholastic advisory evidence exists for ontology-heavy goals, add it alongside the required fields:

```json
{
  "scholasticReview": { "recommendation": "APPROVE", "ontologyStatus": "SOUND", "evidence": "terms normalized; no category mistake; modal claims separated" }
}
```

## Integration constraints

- One Codex thread can have at most one goal focus.
- `create_goal` starts the active objective; it is not a general plan store.
- `update_goal` is completion-only; pause/resume/budget state is controlled by Codex/user/system, not OMX.
- Aggregate mode is the default: one Codex objective covers the whole ultragoal run, and G001/G002 are OMX ledger stories.
- Ultragoal does not invoke `/goal clear` or any hidden `thread/goal/clear` route. For multiple sequential ultragoal runs in one Codex session/thread, clear the completed Codex goal manually with `/goal clear` before creating the next run's aggregate goal.
- Intermediate aggregate story checkpoints require a matching `active` Codex snapshot. A `complete` snapshot before the final story is rejected to prevent premature `update_goal`. A non-clean final review records the old story as `review_blocked` and appends a pending blocker story before any completion checkpoint.
- Final aggregate story checkpoints require a matching `complete` Codex snapshot captured after `update_goal({status: "complete"})`.
- There is currently no Codex goal-tool reset/new-goal surface for replacing a completed legacy thread goal. In per-story mode, if `get_goal` returns a different completed objective and `create_goal` rejects because the thread already has a goal, record `omx ultragoal checkpoint --status blocked` with that `get_goal` JSON, then continue only from a Codex goal context with no active/completed conflicting goal on the same branch/worktree and call `create_goal` there for the ultragoal payload.
- Ultragoal owns durable plan and ledger state; Codex goal mode owns active-thread focus and accounting.
- OMX never edits upstream Codex source such as `../../codex`, never shells out to a hidden `/goal` mutator, and never claims that `omx ultragoal checkpoint` changes Codex's active thread goal. The only Codex goal-mode handoff is explicit: `get_goal`, then `create_goal` when no active goal exists, then `update_goal({status: "complete"})` after the real completion audit passes.
- Completion checkpoints require a fresh `get_goal` snapshot. Save or pass the JSON from `get_goal` with `--codex-goal-json <json-or-path>`; OMX compares the objective and enforces the mode-specific status (`active` for intermediate aggregate stories, `complete` for final aggregate or per-story completion).
- Active or incomplete wrong Codex goals remain strict mismatch errors. The `--status blocked` workaround only applies when the blocking Codex snapshot is `complete` and has a different objective from the active ultragoal; it must not be used to bypass active-goal mismatch protection.
- A goal is not complete merely because tests pass or a ledger entry exists. The agent must audit the objective against files, commands, tests, PR state, or other concrete evidence.
