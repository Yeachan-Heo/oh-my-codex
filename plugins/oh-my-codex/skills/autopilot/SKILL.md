---
name: autopilot
description: "[OMX] Strict autonomous loop: $ralplan -> $ralph -> $code-review"
---

<Purpose>
Autopilot is the strict autonomous delivery loop for non-trivial work. Its primary contract is exactly:

```text
$ralplan -> $ralph -> $code-review
```

If `$code-review` is not clean, Autopilot returns to `$ralplan` with the review findings as the next planning input, then continues again through `$ralph` and `$code-review` until the review is clean or a hard blocker is reported.
</Purpose>

<Use_When>
- User wants hands-off execution from a concrete idea, issue, PRD, or requirements artifact to reviewed code
- User says `$autopilot`, "autopilot", "auto pilot", "autonomous", "build me", "create me", "make me", "full auto", "handle it all", or "I want a/an..."
- Task needs planning, implementation, verification, and code review with automatic follow-up when review is not clean
</Use_When>

<Do_Not_Use_When>
- User wants to explore options or brainstorm -- use `$plan` / `$ralplan`
- User says "just explain", "draft only", or "what would you suggest" -- respond conversationally
- User wants a single focused code change -- use `$ralph` or direct executor work
- User wants only review/critique of existing code -- use `$code-review`
</Do_Not_Use_When>

<Strict_Loop_Contract>
Autopilot must not run a separate broad expansion/planning/execution/QA/validation lifecycle as its primary behavior. It delegates those concerns to the three canonical workflow phases below:

1. **Phase `ralplan`** — consensus planning gate
   - Ground the task with pre-context intake.
   - Run or resume `$ralplan` to produce/update PRD and test-spec artifacts.
   - When returning from a non-clean review, include `return_to_ralplan_reason` and the review findings as first-class planning input.
   - Required handoff artifact: an approved plan/test spec suitable for `$ralph`.

2. **Phase `ralph`** — implementation + verification loop
   - Run `$ralph` from the approved ralplan artifacts.
   - Ralph owns implementation, tests, build/lint/typecheck evidence, deslop where applicable, and architect verification.
   - Required handoff artifact: implementation evidence and changed-file summary suitable for `$code-review`.

3. **Phase `code-review`** — merge-readiness gate
   - Run `$code-review` on the diff/artifacts produced by `$ralph`.
   - A clean review means final recommendation `APPROVE` with architectural status `CLEAR`.
   - `COMMENT`, `REQUEST CHANGES`, any architectural `WATCH`/`BLOCK`, or any unresolved finding is not clean.
   - If not clean, increment the review cycle, persist `review_verdict`, set `return_to_ralplan_reason`, and transition back to Phase `ralplan`.

The only normal terminal state is `complete` after a clean code review. Cancellation, blocked credentials, unrecoverable repeated failures, or explicit user stop may terminate earlier with preserved state.
</Strict_Loop_Contract>

<Pre-context Intake>
Before Phase `ralplan` starts or resumes:
1. Derive a task slug from the request.
2. Reuse the latest relevant `.omx/context/{slug}-*.md` snapshot when available.
3. If none exists, create `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) with:
   - task statement
   - desired outcome
   - known facts/evidence
   - constraints
   - unknowns/open questions
   - likely codebase touchpoints
4. If ambiguity remains high, run `explore` first for brownfield facts, then run the Socratic `$deep-interview --quick <task>` before `$ralplan`.
5. Carry the snapshot path in Autopilot state and all handoff artifacts.
</Pre-context Intake>

<Execution_Policy>
- Always execute phases in order: `ralplan`, then `ralph`, then `code-review`.
- Never skip directly from vague/freeform expansion to implementation; unclear input must be clarified or planned through `$ralplan`.
- A non-clean `$code-review` always returns to `$ralplan`; do not patch findings ad hoc outside the loop.
- Each phase must write/update Autopilot state before handing off.
- Use existing hooks, `.omx/state`, `$ralplan`, `$ralph`, `$code-review`, and pipeline primitives; do not invent a separate execution framework.
- Continue automatically through safe reversible phase transitions. Ask only for destructive, credential-gated, or materially preference-dependent branches.
- Apply the shared workflow guidance pattern: outcome-first framing, concise visible updates for multi-step execution, local overrides for the active workflow branch, validation proportional to risk, explicit stop rules, and automatic continuation for safe reversible steps. Ask only for material, destructive, credentialed, external-production, or preference-dependent branches.
</Execution_Policy>

<State_Management>
Use the CLI-first state surface (`omx state ... --json`) for Autopilot lifecycle state. State must be session-aware when a session id exists. If the explicit MCP compatibility surface is already available, equivalent `omx_state` tool calls remain acceptable but are not required.

Required fields:

```json
{
  "mode": "autopilot",
  "active": true,
  "current_phase": "ralplan",
  "iteration": 1,
  "review_cycle": 0,
  "max_iterations": 10,
  "phase_cycle": ["ralplan", "ralph", "code-review"],
  "handoff_artifacts": {
    "context_snapshot_path": ".omx/context/<slug>-<timestamp>.md",
    "ralplan": null,
    "ralph": null,
    "code_review": null
  },
  "review_verdict": null,
  "return_to_ralplan_reason": null
}
```

- **On start**: `omx state write --input '{"mode":"autopilot","active":true,"current_phase":"ralplan","iteration":1,"review_cycle":0,"state":{"phase_cycle":["ralplan","ralph","code-review"],"handoff_artifacts":{"context_snapshot_path":"<snapshot-path>","ralplan":null,"ralph":null,"code_review":null},"review_verdict":null,"return_to_ralplan_reason":null}}' --json`
- **On ralplan -> ralph**: set `current_phase:"ralph"`, persist the plan/test-spec paths under `handoff_artifacts.ralplan`.
- **On ralph -> code-review**: set `current_phase:"code-review"`, persist implementation/test evidence under `handoff_artifacts.ralph`.
- **On clean review**: set `active:false`, `current_phase:"complete"`, persist `review_verdict:{recommendation:"APPROVE", architectural_status:"CLEAR", clean:true}` and `completed_at`.
- **On non-clean review**: increment `iteration` and `review_cycle`, set `current_phase:"ralplan"`, persist `review_verdict:{..., clean:false}`, persist `handoff_artifacts.code_review`, and set `return_to_ralplan_reason` to a concise review-driven reason.
- **On cancellation**: run `$cancel`; preserve progress for resume rather than deleting handoff artifacts.
</State_Management>

<Continuation_And_Resume>
When the user says `continue`, `resume`, or `keep going` while Autopilot is active, read `autopilot-state.json` and continue from `current_phase`:
- `ralplan`: run/update consensus planning from current handoffs and any `return_to_ralplan_reason`.
- `ralph`: execute the approved plan and record verification evidence.
- `code-review`: review the current diff and decide clean vs return-to-ralplan.
- `complete`: report completion evidence; do not restart.

Do not restart discovery or discard handoff artifacts on continuation.
</Continuation_And_Resume>

<Pipeline_Orchestrator>
Autopilot may be represented by the configurable pipeline orchestrator (`src/pipeline/`) when useful. The Autopilot pipeline contract is:

```text
ralplan -> ralph -> code-review
```

Pipeline state should use `current_phase` values that match the same phase names (`ralplan`, `ralph`, `code-review`, `complete`, `failed`) and should carry `iteration`, `review_cycle`, `handoff_artifacts`, `review_verdict`, and `return_to_ralplan_reason` alongside stage results.
</Pipeline_Orchestrator>

<Escalation_And_Stop_Conditions>
- Stop and report a blocker when required credentials/authority are missing.
- Stop and report when the same review or verification failure recurs across 3 review cycles with no meaningful new plan.
- Stop when the user says "stop", "cancel", or "abort" and run `$cancel`.
- Otherwise, continue the loop until `$code-review` is clean.
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Phase `ralplan` produced/updated approved planning artifacts
- [ ] Phase `ralph` implemented and verified the plan with fresh evidence
- [ ] Phase `code-review` returned a clean verdict (`APPROVE` + `CLEAR`)
- [ ] `review_verdict.clean` is true and `return_to_ralplan_reason` is null
- [ ] Tests/build/lint/typecheck evidence from Ralph is available in handoff artifacts
- [ ] Autopilot state is marked `complete` or cancellation state is preserved coherently
- [ ] User receives a concise summary with plan, implementation, verification, and review evidence
</Final_Checklist>

<Examples>
<Good>
User: `$autopilot implement GitHub issue #42`
Flow: create/load context snapshot -> `$ralplan` issue plan -> `$ralph` implementation + tests -> `$code-review`; if review requests changes, return to `$ralplan` with findings.
</Good>

<Good>
User: `continue`
Context: Autopilot state says `current_phase:"code-review"`.
Flow: run `$code-review` on current diff, persist verdict, finish if clean or transition to `ralplan` with findings if not clean.
</Good>

<Bad>
Autopilot invents independent "Expansion", "QA", and "Validation" phases and treats them as the primary lifecycle.
Why bad: this bypasses the strict `$ralplan -> $ralph -> $code-review` contract.
</Bad>
</Examples>
