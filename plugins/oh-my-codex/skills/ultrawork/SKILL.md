---
name: ultrawork
description: Parallel execution engine for high-throughput task completion
---

<Purpose>
Ultrawork is a parallel execution engine for high-throughput task completion. It is a component, not a standalone persistence mode: it provides parallelism, context discipline, and smart delegation guidance, but not Ralph's persistence loop, architect sign-off, or long-running completion guarantees.
</Purpose>

<Use_When>
- Multiple independent tasks can run simultaneously
- User says "ulw", "ultrawork", or explicitly wants parallel execution
- Task benefits from concurrent execution plus lightweight evidence before wrap-up
- You need a direct-tool lane plus optional background evidence lanes without entering Ralph
</Use_When>

<Do_Not_Use_When>
- Task requires guaranteed completion with persistence, architect verification, or deslop/reverification -- use `ralph` instead (Ralph includes ultrawork)
- Task requires a full autonomous pipeline -- use `autopilot` instead (autopilot includes Ralph which includes ultrawork)
- There is only one sequential task with no parallelism opportunity -- execute directly or delegate to a single `executor`
- The request is still in plan-consensus mode -- keep planning artifacts in `ralplan` until execution is explicitly authorized
- User needs session persistence for resume -- use `ralph`, which adds persistence on top of ultrawork
</Do_Not_Use_When>

<Why_This_Exists>
Sequential task execution wastes time when tasks are independent. Ultrawork keeps the execution branch fast while tightening the protocol: gather enough context first, define pass/fail acceptance criteria before editing, decide deliberately between local execution and delegation, and finish with evidence rather than vibes.
</Why_This_Exists>

<Execution_Policy>
- Gather enough context before implementation. Start with the task intent, desired outcome, constraints, likely touchpoints, and any uncertainty that would change the execution path.
- If uncertainty is still material after a quick repo read, do a focused evidence pass first instead of immediately editing.
- Define pass/fail acceptance criteria before launching execution lanes. Include the command, artifact, or manual check that will prove success.
- Prefer direct tool work when the task is small, coupled, or blocked on immediate local context. Delegate only when the work is independent enough to benefit from parallel execution.
- When useful, run a direct-tool lane and one or more background evidence lanes at the same time. Evidence lanes can cover docs, tests, regression mapping, or bounded repo analysis.
- Fire independent agent calls simultaneously -- never serialize independent work.
- Always pass the `model` parameter explicitly when delegating.
- Read `docs/shared/agent-tiers.md` before first delegation for agent selection guidance.
- Auto-delegate `researcher` when official docs, version-aware framework guidance, best practices, or external dependency behavior materially affect task correctness; treat it as an evidence lane, not a replacement primary workflow.
- Use `run_in_background: true` for operations over ~30 seconds (installs, builds, tests).
- Run quick commands (git status, file reads, simple checks) in the foreground.
- Default to concise, evidence-dense progress and completion reporting. If a lane is speculative or blocked, say so explicitly.
- Treat newer user task updates as local overrides for the active workflow branch while preserving earlier non-conflicting constraints.
- If the user says `continue` after ultrawork already has a clear next step, continue the current execution branch instead of restarting planning or asking for reconfirmation.
</Execution_Policy>

<Steps>
1. **Read agent reference**: Load `docs/shared/agent-tiers.md` for tier selection.
2. **Context + certainty check**:
   - State the task intent in one sentence.
   - List the constraints and unknowns that could invalidate a quick fix.
   - If confidence is low, explore first and narrow the task before editing.
3. **Define acceptance criteria before execution**:
   - What must be true at the end?
   - Which command or artifact proves it?
   - Which manual QA check is required, if any?
4. **Classify the work by dependency shape**:
   - Independent tasks -> parallel lanes.
   - Shared-file or prerequisite-heavy tasks -> local execution or staged lanes.
5. **Choose self vs delegate deliberately**:
   - Work locally when the next step depends on immediate repo context, shared files, or tight iteration.
   - Delegate when the task slice is bounded, independent, and materially improves throughput.
6. **Run execution lanes**:
   - Direct-tool lane for immediate implementation or verification work.
   - Background evidence lanes for tests, docs, repo analysis, or regression checks.
7. **Run dependent tasks sequentially**: Wait for prerequisites before launching dependent work.
8. **Close with lightweight evidence**:
   - Build/typecheck passes when relevant.
   - Affected tests pass.
   - Manual QA notes are recorded when the task needs a human-visible or behavior-level check.
   - No new errors introduced.
</Steps>

<Tool_Usage>
- Use LOW-tier delegation for simple lookups and bounded evidence gathering.
- Use STANDARD-tier delegation for standard implementation and regression work.
- Use THOROUGH-tier delegation for complex analysis, architectural review, or risky multi-file changes.
- Prefer a direct-tool lane when the immediate next step is blocked on local context.
- Prefer background evidence lanes when you can learn something useful in parallel with implementation.
- Use `run_in_background: true` for package installs, builds, and test suites.
- Use foreground execution for quick status checks and file operations.
</Tool_Usage>

## State Management

Use `omx_state` MCP tools for ultrawork lifecycle state.

- **On start**:
  `state_write({mode: "ultrawork", active: true, reinforcement_count: 1, started_at: "<now>"})`
- **On each reinforcement/loop step**:
  `state_write({mode: "ultrawork", reinforcement_count: <current>})`
- **On completion**:
  `state_write({mode: "ultrawork", active: false})`
- **On cancellation/cleanup**:
  run `$cancel` (which should call `state_clear(mode="ultrawork")`)

<Examples>
<Good>
Two-track execution with acceptance criteria up front:
```
Acceptance criteria:
- `npm run build` passes
- `node --test dist/scripts/__tests__/codex-native-hook.test.js` passes
- Manual QA: verify `$ultrawork` activation message still points to the session state file

Direct-tool lane:
- update `skills/ultrawork/SKILL.md`

Background evidence lane:
- delegate(role="test-engineer", tier="STANDARD", task="Map which hook tests cover ultrawork activation messaging", model="...")
```
Why good: Context is grounded first, acceptance criteria are explicit, and the direct-tool lane runs alongside a bounded evidence lane.
</Good>

<Good>
Correct use of self-vs-delegate judgment:
```
Shared-file edit in progress across `src/scripts/codex-native-hook.ts` and its test -> keep implementation local.
Independent regression mapping for keyword-detector coverage -> delegate to a test-engineer lane.
```
Why good: Shared-file work stays local; independent evidence work fans out.
</Good>

<Bad>
Parallelizing before the task is grounded:
```
delegate(role="executor", tier="STANDARD", task="Implement whatever seems necessary", model="...")
delegate(role="test-engineer", tier="STANDARD", task="Figure out how to test it later", model="...")
```
Why bad: No context snapshot, no pass/fail target, and delegation starts before the work is shaped.
</Bad>

<Bad>
Claiming success without evidence or manual QA:
```
Made the changes. Ultrawork should be updated now.
```
Why bad: No verification output, no acceptance evidence, and no manual QA note when the behavior is user-visible.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- When ultrawork is invoked directly (not via Ralph), apply lightweight verification only -- build/typecheck passes when relevant, affected tests pass, and manual QA notes are captured when needed.
- Ralph owns persistence, architect verification, deslop, and the full verified-completion promise. Do not claim those guarantees from direct ultrawork alone.
- If a task fails repeatedly across retries, report the issue rather than retrying indefinitely.
- Escalate to the user when tasks have unclear dependencies, conflicting requirements, or a materially branching acceptance target.
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Task intent and constraints were grounded before editing
- [ ] Pass/fail acceptance criteria were stated before execution
- [ ] Parallel lanes were used only for independent work
- [ ] Build/typecheck passes when relevant
- [ ] Affected tests pass
- [ ] Manual QA notes recorded when behavior is user-visible
- [ ] No new errors introduced
- [ ] Completion claim stays inside ultrawork's lightweight-verification boundary
</Final_Checklist>

<Advanced>
## Relationship to Other Modes

```
ralph (persistence + verified completion wrapper)
 \-- includes: ultrawork (this skill)
     \-- provides: high-throughput execution + lightweight evidence

autopilot (autonomous execution)
 \-- includes: ralph
     \-- includes: ultrawork (this skill)

ecomode (token efficiency)
 \-- modifies: ultrawork's model selection
```

Ultrawork is the parallelism and execution-discipline layer. Ralph adds persistence, architect verification, deslop, and retry-until-done behavior. Autopilot adds the broader autonomous lifecycle pipeline. Ecomode adjusts ultrawork's model routing to favor cheaper models.
</Advanced>
