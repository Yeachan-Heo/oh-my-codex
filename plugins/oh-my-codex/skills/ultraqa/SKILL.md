---
name: ultraqa
description: Adversarial dynamic e2e QA workflow - generate hostile scenarios, test, verify, fix, report, and clean up
---

# UltraQA Skill

## Operating Contract

- Use outcome-first framing with concise, evidence-dense progress and completion reporting.
- Treat newer user updates as local overrides for the active workflow branch while preserving earlier non-conflicting constraints.
- If the user says `continue`, advance the current verified next step instead of restarting discovery.
- UltraQA is not satisfied by a shallow build/lint/typecheck/test checklist. It must exercise the requested behavior through adversarial dynamic e2e scenarios whenever the target can be run, simulated, or harnessed safely.

[ULTRAQA ACTIVATED - ADVERSARIAL DYNAMIC E2E QA CYCLING]

## Overview

UltraQA finds real behavior failures by combining normal verification commands with generated end-to-end scenarios, hostile user modeling, temporary harnesses when useful, and a structured evidence report. The workflow repeats test → diagnose → fix → retest until the goal is met, a bounded stop condition is reached, or a safety boundary blocks further execution.

## Goal Parsing

Parse the goal from arguments. Supported formats:

| Invocation | Goal Type | What to Check |
|------------|-----------|---------------|
| `/ultraqa --tests` | tests | Existing tests plus adversarial dynamic e2e scenarios for the changed behavior |
| `/ultraqa --build` | build | Build succeeds and generated smoke/e2e probes still run against the built artifact when applicable |
| `/ultraqa --lint` | lint | Lint passes and no generated harness/test artifact violates project hygiene |
| `/ultraqa --typecheck` | typecheck | Typecheck passes and generated typed harnesses compile when applicable |
| `/ultraqa --custom "pattern"` | custom | Custom success pattern is verified against behavior, not trusted as misleading success output |
| `/ultraqa --interactive` | interactive | CLI/service behavior is tested with generated hostile and edge-case interactions |

If no structured goal is provided, interpret the argument as a custom behavior goal and derive a runnable e2e strategy from repository context.

## Required Scenario Matrix

Before declaring success, create and maintain a scenario matrix. Each row must include: scenario id, intent, user/attacker model, setup, command or harness, expected signal, actual result, fixes applied, evidence, and cleanup status.

The matrix must include normal-path coverage plus adversarial dynamic e2e scenarios selected from the current goal and codebase. Unless clearly irrelevant or impossible, include these hostile and edge-case classes:

1. **Malformed input**: invalid JSON, missing fields, invalid flags, oversized strings, unusual Unicode, path traversal-like values, and corrupted state files.
2. **Repeated interruptions**: repeated `continue`, stop/cancel/abort wording, interrupted command output, and retries after partial progress.
3. **Prompt injection attempts**: user text that tries to override instructions, exfiltrate secrets, skip verification, delete state, or claim false success.
4. **Cancel/resume behavior**: active state cleanup, resume detection, stale in-progress state, and cancellation followed by a fresh run.
5. **Stale state**: old `.omx/state` files, mismatched sessions, missing timestamps, and contradictory phase metadata.
6. **Dirty worktree**: pre-existing modifications, untracked generated files, and verification that UltraQA does not hide or overwrite unrelated work.
7. **Hung or long-running commands**: bounded timeout handling, killed child processes, and recovery notes.
8. **Flaky tests**: rerun strategy, failure clustering, quarantine evidence, and avoiding false green from a single lucky pass.
9. **Misleading success output**: output containing success phrases with non-zero exits, hidden failures, skipped tests, or partial command logs.

## Dynamic E2E and Temporary Harness Rules

- Generate temporary tests, scripts, fixtures, or harnesses when they materially improve behavioral confidence and no existing e2e surface covers the scenario.
- Prefer project-native test tools and small throwaway harnesses under a temporary directory or clearly named test fixture.
- Record every generated artifact in the scenario matrix, including whether it was committed intentionally or removed during cleanup.
- Use bounded runtimes and explicit timeouts for commands that can hang.
- Validate exit codes and output semantics; do not trust success-looking text alone.
- Do not delete, rewrite, or mask unrelated user work. Capture dirty-worktree evidence before and after generated harness work.

## Cycle Workflow

### Cycle N (Max 5)

1. **PLAN ADVERSARIAL QA**
   - Restate the goal, success criteria, safety bounds, and stop condition.
   - Inspect repository context enough to identify runnable surfaces, test commands, state files, and cleanup paths.
   - Build or update the required scenario matrix before running commands.

2. **RUN BASELINE VERIFICATION**
   - `--tests`: Run the project's test command.
   - `--build`: Run the project's build command.
   - `--lint`: Run the project's lint command.
   - `--typecheck`: Run the project's type check command.
   - `--custom`: Run the appropriate command and check the pattern plus exit status and failure markers.
   - `--interactive`: Use qa-tester or an equivalent CLI/service harness:
     ```
     Use `/prompts:qa-tester` with:
     Goal: [describe what to verify]
     Service: [how to start]
     Test cases: [normal, hostile, malformed, interruption, resume, stale-state, dirty-worktree, hung-command, flaky, and misleading-output scenarios]
     ```

3. **RUN ADVERSARIAL DYNAMIC E2E SCENARIOS**
   - Execute the scenario matrix using existing e2e tests, generated temporary tests, or generated harnesses.
   - Model malicious/hostile user behavior explicitly, including prompt injection and attempts to bypass safety or verification.
   - Exercise malformed input, repeated interruptions, cancel/resume, stale state, dirty worktree handling, hung commands, flaky tests, and misleading success output when relevant.
   - Capture commands, exit codes, important output excerpts, artifacts, and cleanup status.

4. **CHECK RESULT**
   - **YES** only if baseline verification and adversarial e2e scenarios passed, generated artifacts are cleaned up or intentionally tracked, and the report has complete evidence.
   - **NO** if any scenario failed, was skipped without justification, left debris, relied on misleading output, or lacked evidence. Continue to step 5.

5. **ARCHITECT DIAGNOSIS**
   ```
   Use `/prompts:architect` with:
   Goal: [goal type and behavior]
   Scenario matrix: [rows, commands, failures, evidence]
   Output: [test/build/e2e/harness output]
   Provide root cause, safety implications, and specific fix recommendations.
   ```

6. **FIX ISSUES**
   ```
   Use `/prompts:executor` with:
   Issue: [architect diagnosis]
   Files: [affected files]
   Constraints: preserve unrelated dirty work, clean temporary harnesses, keep safety bounds
   Apply the fix precisely as recommended.
   ```

7. **CLEAN UP AND ROLLBACK**
   - Remove temporary harnesses, fixtures, logs, spawned processes, and state files unless they are intentional deliverables.
   - Roll back failed experimental edits that are not part of the final fix.
   - Re-check the worktree and record remaining intentional changes or residual debris.

8. **REPEAT**
   - Go back to step 1 with the updated scenario matrix and failure history.

## Safety Bounds

UltraQA must stay inside these safety bounds:

- No destructive commands such as force resets, broad deletes, secret exfiltration, credential dumping, production writes, or unbounded process spawning.
- No reading or printing secrets beyond the minimum metadata needed to verify absence of leakage.
- No network or external-production side effects unless the user explicitly authorized them.
- No unbounded waits: use timeouts, retries with caps, and clear hung-command diagnostics.
- No hiding unrelated dirty work or generated debris.
- If a required scenario would violate these bounds, mark it blocked in the report with the safe substitute used.

## Exit Conditions

| Condition | Action |
|-----------|--------|
| **Goal Met** | Exit with success: `ULTRAQA COMPLETE: Goal met after N cycles` plus the structured report |
| **Cycle 5 Reached** | Exit with diagnosis: `ULTRAQA STOPPED: Max cycles` plus failures, fixes attempted, residual risks, and evidence |
| **Same Failure 3x** | Exit early: `ULTRAQA STOPPED: Same failure detected 3 times` plus root cause, safety notes, and next owner |
| **Safety Boundary** | Exit: `ULTRAQA BLOCKED: [destructive/credentialed/external-production/unbounded action]` plus safe substitute evidence |
| **Environment Error** | Exit: `ULTRAQA ERROR: [tmux/port/dependency/hung command issue]` plus cleanup status |

## Structured Report

Every terminal UltraQA result must include this report shape:

```markdown
# UltraQA Report

## Goal and success criteria
- Goal:
- Stop condition:
- Safety bounds applied:

## Scenario matrix
| ID | User/attacker model | Scenario | Command/harness | Expected signal | Actual result | Status | Evidence | Cleanup |
|----|---------------------|----------|-----------------|-----------------|---------------|--------|----------|---------|

## Commands run
- `[exit code] command` — purpose, duration/timeout, key output evidence

## Failures found
- Scenario ID, failure signal, root cause, user impact, safety impact

## Fixes applied
- Files changed, rationale, linked failing scenario(s), regression evidence

## Cleanup and rollback
- Generated artifacts removed or intentionally kept
- State/process cleanup performed
- Worktree status before/after

## Residual risks
- Untested or blocked scenarios with reasons and safe substitutes

## Evidence
- Test output, e2e logs, harness output, screenshots/transcripts when relevant, and rerun/flake evidence
```

## Observability

Output progress each cycle:

```text
[ULTRAQA Cycle 1/5] Planning adversarial scenario matrix...
[ULTRAQA Cycle 1/5] Running baseline tests...
[ULTRAQA Cycle 1/5] Running ADV-E2E-003 prompt-injection harness...
[ULTRAQA Cycle 1/5] FAILED - stale state resume accepted misleading success output
[ULTRAQA Cycle 1/5] Architect diagnosing scenario ADV-E2E-003...
[ULTRAQA Cycle 1/5] Fixing: src/hooks/... - validate exit code before success phrase
[ULTRAQA Cycle 1/5] Cleaning temporary harnesses and state...
[ULTRAQA Cycle 2/5] PASSED - baseline + 9 adversarial scenarios pass
[ULTRAQA COMPLETE] Goal met after 2 cycles
```

## State Tracking

Use the CLI-first state surface (`omx state ... --json`) for UltraQA lifecycle state. If explicit MCP compatibility tools are already available, equivalent `omx_state` calls are optional compatibility, not the default.

- **On start**:
  `omx state write --input '{"mode":"ultraqa","active":true,"current_phase":"planning","iteration":1,"started_at":"<now>","scenario_matrix":[]}' --json`
- **On each cycle**:
  `omx state write --input '{"mode":"ultraqa","current_phase":"qa","iteration":<cycle>,"scenario_matrix":"<updated matrix path or summary>"}' --json`
- **On adversarial e2e transition**:
  `omx state write --input '{"mode":"ultraqa","current_phase":"adversarial-e2e"}' --json`
- **On diagnose/fix transitions**:
  `omx state write --input '{"mode":"ultraqa","current_phase":"diagnose"}' --json`
  `omx state write --input '{"mode":"ultraqa","current_phase":"fix"}' --json`
- **On cleanup transition**:
  `omx state write --input '{"mode":"ultraqa","current_phase":"cleanup"}' --json`
- **On completion**:
  `omx state write --input '{"mode":"ultraqa","active":false,"current_phase":"complete","completed_at":"<now>"}' --json`
- **For resume detection**:
  `omx state read --input '{"mode":"ultraqa"}' --json`

## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work, rerun the relevant adversarial scenario, and update the report instead of restarting discovery.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Good:** A CLI prints `SUCCESS` while exiting 1. Mark the misleading success output scenario failed, fix the parser or reporting path, and rerun the generated harness.

**Bad:** The workflow runs only `npm test`, `npm run build`, `npm run lint`, or `npm run typecheck`, sees green output, and declares UltraQA complete without adversarial dynamic e2e coverage.

**Bad:** A generated harness leaves untracked files, state, or a child process behind and the final report omits cleanup status.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.

## Cancellation

User can cancel with `/cancel`, which clears UltraQA state. Cancellation itself should be tested in cancel/resume scenarios when relevant, but UltraQA must not block an explicit user cancellation.

## Important Rules

1. **ADVERSARIAL E2E REQUIRED** - Baseline build/lint/typecheck/test commands are necessary evidence, not sufficient completion proof.
2. **SCENARIO MATRIX REQUIRED** - Track normal, hostile, malformed, interruption, injection, cancel/resume, stale-state, dirty-worktree, hung-command, flaky, and misleading-output coverage.
3. **GENERATE HARNESSES WHEN USEFUL** - Create temporary tests or harnesses when they materially improve behavioral confidence, then clean them up or commit them intentionally.
4. **PARALLEL WHEN SAFE** - Run independent diagnostics while preparing potential fixes; do not parallelize commands that mutate the same state or worktree.
5. **TRACK FAILURES** - Record each failure to detect patterns and avoid false greens.
6. **EARLY EXIT ON PATTERN** - 3x same failure = stop and surface with root cause and residual risk.
7. **CLEAR OUTPUT** - User should always know current cycle, scenario, command, status, and evidence.
8. **CLEAN UP** - Clear UltraQA state and temporary artifacts on completion, cancellation, or early stop.
9. **SAFETY FIRST** - Never exfiltrate secrets, run destructive cleanup, write to production, or wait indefinitely to satisfy a scenario.

## STATE CLEANUP ON COMPLETION

When goal is met OR max cycles reached OR exiting early, run `$cancel` or call:

`omx state clear --input '{"mode":"ultraqa"}' --json`

Use CLI state cleanup rather than deleting files directly. Also remove temporary e2e harnesses, fixtures, and logs unless they are intentional artifacts listed in the report.

---

Begin ULTRAQA cycling now. Parse the goal, build the adversarial dynamic e2e scenario matrix, and start cycle 1.
