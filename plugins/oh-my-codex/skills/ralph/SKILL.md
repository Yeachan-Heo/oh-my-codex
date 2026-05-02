---
name: ralph
description: Self-referential loop until task completion with architect verification
---

[RALPH + ULTRAWORK - ITERATION {{ITERATION}}/{{MAX}}]

Your previous attempt did not output the completion promise. Continue working on the task.

<Purpose>
Ralph is a persistence loop that keeps working on a task until it is fully complete and architect-verified. It wraps ultrawork's parallel execution with session persistence, automatic retry on failure, and mandatory verification before completion.
</Purpose>

<Use_When>
- Task requires guaranteed completion with verification (not just "do your best")
- User says "ralph", "don't stop", "must complete", "finish this", or "keep going until done"
- Work may span multiple iterations and needs persistence across retries
- Task benefits from parallel execution with architect sign-off at the end
</Use_When>

<Do_Not_Use_When>
- User wants a full autonomous pipeline from idea to code -- use `autopilot` instead
- User wants to explore or plan before committing -- use `plan` skill instead
- User wants a quick one-shot fix -- delegate directly to an executor agent
- User wants manual control over completion -- use `ultrawork` directly
</Do_Not_Use_When>

<Why_This_Exists>
Complex tasks often fail silently: partial implementations get declared "done", tests get skipped, edge cases get forgotten. Ralph prevents this by looping until work is genuinely complete, requiring fresh verification evidence before allowing completion, and using tiered architect review to confirm quality.
</Why_This_Exists>

<Execution_Policy>
- Fire independent agent calls simultaneously -- never wait sequentially for independent work
- Use `run_in_background: true` for long operations (installs, builds, test suites)
- Always pass the `model` parameter explicitly when delegating to agents
- Read `docs/shared/agent-tiers.md` before first delegation to select correct agent tiers
- Deliver the full implementation: no scope reduction, no partial completion, no deleting tests to make them pass
- Apply the shared workflow guidance pattern: outcome-first framing, concise visible updates for multi-step execution, local overrides for the active workflow branch, validation proportional to risk, explicit stop rules, and automatic continuation for safe reversible steps. Ask only for material, destructive, credentialed, external-production, or preference-dependent branches.
- Integrate with Codex goal mode when goal tools are available: inspect the active thread goal with `get_goal`, preserve it as the top-level stop condition, and only call `update_goal({status: "complete"})` after a Ralph completion audit proves the objective is actually achieved.
</Execution_Policy>

<Steps>
0. **Pre-context intake (required before planning/execution loop starts)**:
   - Assemble or load a context snapshot at `.omx/context/{task-slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`).
   - Minimum snapshot fields:
     - task statement
     - desired outcome
     - known facts/evidence
     - constraints
     - unknowns/open questions
     - likely codebase touchpoints
   - If an existing relevant snapshot is available, reuse it and record the path in Ralph state.
   - If request ambiguity is high, gather brownfield facts first. When session guidance enables `USE_OMX_EXPLORE_CMD`, prefer `omx explore` for simple read-only repository lookups with narrow, concrete prompts; otherwise use the richer normal explore path. Then run `$deep-interview --quick <task>` to close critical gaps.
   - Do not begin Ralph execution work (delegation, implementation, or verification loops) until snapshot grounding exists. If forced to proceed quickly, note explicit risk tradeoffs.
1. **Review progress**: Check TODO list and any prior iteration state
2. **Continue from where you left off**: Pick up incomplete tasks
3. **Delegate in parallel**: Route tasks to specialist agents at appropriate tiers
   - Simple lookups: LOW tier -- "What does this function return?"
   - Standard work: STANDARD tier -- "Add error handling to this module"
   - Complex analysis: THOROUGH tier -- "Debug this race condition"
   - When Ralph is entered as a ralplan follow-up, start from the approved **available-agent-types roster** and make the delegation plan explicit: implementation lane, evidence/regression lane, and final sign-off lane using only known agent types
4. **Run long operations in background**: Builds, installs, test suites use `run_in_background: true`
5. **Visual task gate (when screenshot/reference images are present)**:
   - Run `$visual-verdict` **before every next edit**.
   - Require structured JSON output: `score`, `verdict`, `category_match`, `differences[]`, `suggestions[]`, `reasoning`.
   - Persist verdict to `.omx/state/{scope}/ralph-progress.json` including numeric + qualitative feedback.
   - Default pass threshold: `score >= 90`.
   - **URL-based visual cloning tasks**: When the task description contains a target URL (e.g., "clone https://example.com"), route the work through `$visual-ralph`. `$web-clone` is hard-deprecated; Visual Ralph owns the migrated live-URL visual implementation use case and uses `$visual-verdict` for measured visual scoring.
6. **Verify completion with fresh evidence**:
   - If Codex goal mode is available, call `get_goal` before final verification to restate the active objective and include it in the evidence checklist.
   a. Identify what command proves the task is complete
   b. Run verification (test, build, lint)
   c. Read the output -- confirm it actually passed
   d. Check: zero pending/in_progress TODO items
7. **Architect verification** (tiered):
   - <5 files, <100 lines with full tests: STANDARD tier minimum (architect role)
   - Standard changes: STANDARD tier (architect role)
   - >20 files or security/architectural changes: THOROUGH tier (architect role)
   - Ralph floor: always at least STANDARD, even for small changes
7.5 **Mandatory Deslop Pass**:
   - After Step 7 passes, run `oh-my-codex:ai-slop-cleaner` on **all files changed during the Ralph session**.
   - Scope the cleaner to **changed files only**; do not widen the pass beyond Ralph-owned edits.
   - Run the cleaner in **standard mode** (not `--review`).
   - If the prompt contains `--no-deslop`, skip Step 7.5 entirely and proceed with the most recent successful verification evidence.
7.6 **Regression Re-verification**:
   - After the deslop pass, re-run all tests/build/lint and read the output to confirm they still pass.
   - If post-deslop regression fails, roll back cleaner changes or fix and retry. Then rerun Step 7.5 and Step 7.6 until the regression is green.
   - Do not proceed to completion until post-deslop regression is green (unless `--no-deslop` explicitly skipped the deslop pass).
8. **On approval**: If Codex goal mode is active, call `update_goal({status: "complete"})` before `/cancel`; report final elapsed time and token-budget usage when the tool returns it. Then run `/cancel` to cleanly exit and clean up all state files.
9. **On rejection**: Fix the issues raised, then re-verify at the same tier
</Steps>

<Tool_Usage>
- Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools
- Use `ask_codex` with `agent_role: "architect"` for verification cross-checks when changes are security-sensitive, architectural, or involve complex multi-system integration
- Skip Codex consultation for simple feature additions, well-tested changes, or time-critical verification
- If ToolSearch finds no MCP tools or Codex is unavailable, proceed with architect agent verification alone -- never block on external tools
- Use `state_write` / `state_read` for ralph mode state persistence between iterations
- Use Codex goal tools when present: `get_goal` to discover or re-check the active objective, `create_goal` only when the user/system explicitly requested a new goal and no active goal exists, and `update_goal` only after the audited objective is fully achieved.
- Persist context snapshot path in Ralph mode state so later phases and agents share the same grounding context
- If an `omx_state` MCP tool call reports that its stdio transport is unavailable/closed, do **not** retry the same MCP call. Retry once through the supported CLI parity surface with the same payload, preserving `workingDirectory` and `session_id`: `omx state write --input '<json>' --json`, `omx state read --input '<json>' --json`, or `omx state clear --input '<json>' --json`. If the CLI path also fails, continue with `.omx/context` / `.omx/plans` file-backed artifacts and report the state persistence blocker.
</Tool_Usage>

## Goal Mode Integration

Codex goal mode is the thread-level completion contract for long-running Ralph work. Ralph state tracks workflow mechanics; goal mode tracks whether the user objective is truly done. When the goal tools are available:

1. Call `get_goal` during intake or before the first execution loop when the prompt/hook says an active thread goal exists.
2. If no goal exists, call `create_goal` only when the user or system explicitly asked for goal tracking; otherwise continue with Ralph state alone.
3. Treat `goal.objective` as binding acceptance scope. Newer user updates can refine the current branch, but do not silently narrow the goal.
4. Before completion, perform a prompt-to-artifact checklist and completion audit against real evidence:
   - restate the objective as deliverables/success criteria
   - map every prompt requirement, named workflow (`$ralplan`, `$ralph`), file, command, test, gate, and deliverable to evidence
   - inspect the actual files, command output, state, and tests behind each checklist item
   - identify missing, weakly verified, or uncovered requirements and continue if any remain
5. Call `update_goal({status: "complete"})` only when the audit shows no required work remains. Do not use passing tests, Ralph state, or architect approval as proxy proof unless they cover the whole goal.
6. If goal tools are unavailable, keep working through Ralph state and mention the missing goal-mode evidence in the final report.

## State Management

Use the `omx_state` MCP server tools (`state_write`, `state_read`, `state_clear`) for Ralph lifecycle state.

- **On start**:
  `state_write({mode: "ralph", active: true, iteration: 1, max_iterations: 10, current_phase: "executing", started_at: "<now>", state: {context_snapshot_path: "<snapshot-path>"}})`
- **On each iteration**:
  `state_write({mode: "ralph", iteration: <current>, current_phase: "executing"})`
- **On verification/fix transition**:
  `state_write({mode: "ralph", current_phase: "verifying"})` or `state_write({mode: "ralph", current_phase: "fixing"})`
- **On completion**:
  `state_write({mode: "ralph", active: false, current_phase: "complete", completed_at: "<now>"})`
- **On cancellation/cleanup**:
  run `$cancel` (which should call `state_clear(mode="ralph")`)


## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.

<Examples>
<Good>
Correct parallel delegation:
```
delegate(role="executor", tier="LOW", task="Add type export for UserConfig")
delegate(role="executor", tier="STANDARD", task="Implement the caching layer for API responses")
delegate(role="executor", tier="THOROUGH", task="Refactor auth module to support OAuth2 flow")
```
Why good: Three independent tasks fired simultaneously at appropriate tiers.
</Good>

<Good>
Correct verification before completion:
```
1. Run: npm test           → Output: "42 passed, 0 failed"
2. Run: npm run build      → Output: "Build succeeded"
3. Run: lsp_diagnostics    → Output: 0 errors
4. Delegate to architect at STANDARD tier  → Verdict: "APPROVED"
5. Run /cancel
```
Why good: Fresh evidence at each step, architect verification, then clean exit.
</Good>

<Bad>
Claiming completion without verification:
"All the changes look good, the implementation should work correctly. Task complete."
Why bad: Uses "should" and "look good" -- no fresh test/build output, no architect verification.
</Bad>

<Bad>
Sequential execution of independent tasks:
```
delegate(executor, LOW, "Add type export") → wait →
delegate(executor, STANDARD, "Implement caching") → wait →
delegate(executor, THOROUGH, "Refactor auth")
```
Why bad: These are independent tasks that should run in parallel, not sequentially.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- Stop and report when a fundamental blocker requires user input (missing credentials, unclear requirements, external service down)
- Stop when the user says "stop", "cancel", or "abort" -- run `/cancel`
- Continue working when the hook system sends "The boulder never stops" -- this means the iteration continues
- If architect rejects verification, fix the issues and re-verify (do not stop)
- If the same issue recurs across 3+ iterations, report it as a potential fundamental problem
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] All requirements from the original task are met (no scope reduction)
- [ ] Zero pending or in_progress TODO items
- [ ] Fresh test run output shows all tests pass
- [ ] Fresh build output shows success
- [ ] lsp_diagnostics shows 0 errors on affected files
- [ ] Architect verification passed (STANDARD tier minimum)
- [ ] Codex goal-mode completion audit passed, and `update_goal({status: "complete"})` was called when an active goal exists
- [ ] ai-slop-cleaner pass completed on changed files (or --no-deslop specified)
- [ ] Post-deslop regression tests pass
- [ ] `/cancel` run for clean state cleanup
</Final_Checklist>

<Advanced>
## PRD Mode (Optional)

When the user provides the `--prd` flag, initialize a Product Requirements Document before starting the ralph loop.

### Detecting PRD Mode
Check if `{{PROMPT}}` contains `--prd` or `--PRD`.

Prompt-side `$ralph` workflow activation is lighter-weight than `omx ralph --prd ...`.
It seeds Ralph workflow state and guidance, but it does not implicitly launch the
CLI entrypoint or apply the PRD startup gate. Treat `omx ralph --prd ...` as the
explicit PRD-gated path.

### Detecting `--no-deslop`
Check if `{{PROMPT}}` contains `--no-deslop`.
If `--no-deslop` is present, skip the deslop pass entirely after Step 7 and continue using the latest successful pre-deslop verification evidence.

### Visual Reference Flags (Optional)
Ralph execution supports visual reference flags for screenshot tasks:
- Repeatable image inputs: `-i <image-path>` (can be used multiple times)
- Image directory input: `--images-dir <directory>`

Example:
`ralph -i refs/hn.png -i refs/hn-item.png --images-dir ./screenshots "match HackerNews layout"`

### PRD Workflow
1. Run deep-interview in quick mode before creating PRD artifacts:
   - Execute: `$deep-interview --quick <task>`
   - Complete a compact requirements pass (context, goals, scope, constraints, validation)
   - Persist interview output to `.omx/interviews/{slug}-{timestamp}.md`
2. Create canonical PRD/progress artifacts:
   - PRD: `.omx/plans/prd-{slug}.md`
   - Progress ledger: `.omx/state/{scope}/ralph-progress.json` (session scope when available, else root scope)
3. Parse the task (everything after `--prd` flag)
4. Break down into user stories:

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name]",
  "description": "[Feature description]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Short title]",
      "description": "As a [user], I want to [action] so that [benefit].",
      "acceptanceCriteria": ["Criterion 1", "Typecheck passes"],
      "priority": 1,
      "passes": false
    }
  ]
}
```

5. Initialize canonical progress ledger at `.omx/state/{scope}/ralph-progress.json`
6. Guidelines: right-sized stories (one session each), verifiable criteria, independent stories, priority order (foundational work first)
7. Proceed to normal ralph loop using user stories as the task list

### Example
User input: `--prd build a todo app with React and TypeScript`
Workflow: Detect flag, extract task, create `.omx/plans/prd-{slug}.md`, create `.omx/state/{scope}/ralph-progress.json`, begin ralph loop.

### Legacy compatibility
- During the compatibility window, Ralph `--prd` startup still validates machine-readable story state from `.omx/prd.json`.
- `.omx/plans/prd-{slug}.md` remains the canonical storage/documentation artifact, but it is not yet the startup validation source.
- If `.omx/prd.json` exists and canonical PRD is absent, migrate one-way into `.omx/plans/prd-{slug}.md`.
- If `.omx/progress.txt` exists and canonical progress ledger is absent, import one-way into `.omx/state/{scope}/ralph-progress.json`.
- Keep legacy files unchanged for one release cycle.

## Background Execution Rules

**Run in background** (`run_in_background: true`):
- Package installation (npm install, pip install, cargo build)
- Build processes (make, project build commands)
- Test suites
- Docker operations (docker build, docker pull)

**Run blocking** (foreground):
- Quick status checks (git status, ls, pwd)
- File reads and edits
- Simple commands
</Advanced>

Original task:
{{PROMPT}}
