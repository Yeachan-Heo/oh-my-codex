---
name: autoresearch
description: Stateful validator-gated research loop with native-hook persistence
---

# Autoresearch

Autoresearch is the skill-first replacement for the deprecated `omx autoresearch` command.
It keeps the useful measured-research loop, but it now runs as a native-hook stateful workflow instead of a direct CLI or tmux launch surface.

## Use when
- You want a Ralph-ish persistent research loop
- The task should keep nudging until explicit validation evidence exists
- You want init-time choice between script validation and prompt+architect validation

## Do not use when
- You want the old `omx autoresearch` command surface (hard-deprecated)
- You want detached tmux or split-pane launch parity
- You have not decided the validation regime yet

## Core contract
1. **Init chooses validation mode.** Pick exactly one:
   - `mission-validator-script`
   - `prompt-architect-artifact`
2. **Persist mode state** in `.omx/state/.../autoresearch-state.json` including:
   - `validation_mode`
   - `completion_artifact_path`
   - `mission_validator_command` **or** `validator_prompt`
   - optional `output_artifact_path`
3. **Completion is artifact-gated.** The loop does not stop because the model says “done”, because a stop hook fired once, or because several turns were no-ops.
4. **Direct CLI launch is gone.** Use `$deep-interview --autoresearch` for intake and `$autoresearch` for execution.

## Completion artifact contract

### `mission-validator-script`
The completion artifact must exist and record a passing validator result, for example:

```json
{
  "status": "passed",
  "passed": true,
  "summary": "metric improved beyond baseline"
}
```

### `prompt-architect-artifact`
The completion artifact must include both an architect approval verdict and an output artifact path, for example:

```json
{
  "validator_prompt": "Review the research output against the mission.",
  "architect_review": { "verdict": "approved" },
  "output_artifact_path": ".omx/specs/autoresearch-demo/report.md"
}
```

## Recommended flow
1. Run `$deep-interview --autoresearch` to clarify mission + evaluator.
2. Materialize `.omx/specs/autoresearch-{slug}/mission.md`, `sandbox.md`, and `result.json`.
3. Start `$autoresearch` with the chosen validation mode stored in mode state.
4. Let stop-hook / auto-nudge continue until the completion artifact satisfies the chosen validation mode.
5. Finish only after the validator artifact is complete.

## Migration note
- `omx autoresearch` is hard-deprecated.
- No direct CLI launch.
- No tmux split-pane launch.
- No noop-count completion gate.
