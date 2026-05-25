---
name: autopilot
description: "[OMX] Strict autonomous loop: $deep-interview -> $ralplan -> $ultragoal (+ $team if needed) -> $code-review -> $ultraqa"
---

<Purpose>
Autopilot is the strict autonomous delivery loop for non-trivial work. Its recommended/default contract is exactly:

```text
$deep-interview -> $ralplan -> $ultragoal (+ $team if needed) -> $code-review -> $ultraqa
```

If `$code-review` or `$ultraqa` is not clean, Autopilot returns to `$ralplan` with the findings as the next planning input, then continues again through `$ultragoal`, `$code-review`, and `$ultraqa` until the gates are clean or a hard blocker is reported. Ralph is a legacy/explicit alternate execution loop only; do not advertise Ralph as the default Autopilot path.
</Purpose>

<Use_When>
- User wants hands-off execution from a concrete idea, issue, PRD, or requirements artifact to reviewed and QA-checked code
- User says `$autopilot`, "autopilot", "auto pilot", "autonomous", "build me", "create me", "make me", "full auto", "handle it all", or "I want a/an..."
- Task needs clarification, planning, durable execution, verification, code review, and QA with automatic follow-up when gates are not clean
</Use_When>

<Do_Not_Use_When>
- User wants to explore options or brainstorm -- use `$plan` / `$ralplan`
- User says "just explain", "draft only", or "what would you suggest" -- respond conversationally
- User wants a single focused code change -- use `$ultragoal`, `$ralph` only when explicitly requested, or direct executor work
- User wants only review/critique of existing code -- use `$code-review`
</Do_Not_Use_When>

<Strict_Loop_Contract>
Autopilot must not run a separate broad expansion/planning/execution/QA/validation lifecycle as its primary behavior. It delegates those concerns to the canonical workflow phases below:

1. **Phase `deep-interview`** — Socratic requirements clarification gate
   - Run or resume `$deep-interview` to clarify intent, scope, non-goals, constraints, and decision boundaries.
   - Required handoff artifact: a clarified spec or concise requirements summary suitable for `$ralplan`.

2. **Phase `ralplan`** — consensus planning gate
   - Ground the task with pre-context intake and the deep-interview artifact.
   - Run or resume `$ralplan` to produce/update PRD and test-spec artifacts.
   - PRD/test-spec files alone are not completion evidence. Ralplan may hand off only after durable consensus evidence records a subsequent `Architect` approval first and a subsequent `Critic` approval second.
   - When returning from a non-clean review or QA pass, include `return_to_ralplan_reason` and the findings as first-class planning input.
   - If either review is missing, blocked, out of order, or non-approving, remain in `ralplan` or report an explicit blocker/max-iteration outcome; do not progress to `$ultragoal`, `$team`, `$ralph`, or implementation.
   - Required handoff artifact: an approved plan/test spec plus `ralplan_consensus_gate` evidence suitable for `$ultragoal`.

3. **Phase `ultragoal`** — durable implementation + verification loop
   - Run `$ultragoal` from the approved ralplan artifacts.
   - Ultragoal owns durable Codex goal handoffs, `.omx/ultragoal` ledger checkpoints, implementation, tests, build/lint/typecheck evidence, cleanup, and final review gate discipline.
   - Use `$team` only inside an active Ultragoal story when the story clearly benefits from coordinated parallel execution (for example independent file/module lanes, broad test matrix work, or multi-domain implementation). Team remains explicit and leader-owned; Ultragoal keeps the goal/ledger state.
   - Required handoff artifact: implementation evidence, changed-file summary, verification evidence, and Ultragoal ledger/checkpoint references suitable for `$code-review`.

4. **Phase `code-review`** — merge-readiness gate
   - Run `$code-review` on the diff/artifacts produced by `$ultragoal`.
   - A clean review means final recommendation `APPROVE` with architectural status `CLEAR`.
   - `COMMENT`, `REQUEST CHANGES`, any architectural `WATCH`/`BLOCK`, or any unresolved finding is not clean.
   - If not clean, increment the review cycle, persist `review_verdict`, set `return_to_ralplan_reason`, and transition back to Phase `ralplan`.

5. **Phase `ultraqa`** — adversarial QA gate
   - Run `$ultraqa` after a clean code review when user-facing behavior, workflows, CLI/runtime behavior, integration surfaces, or regression risk warrant adversarial QA.
   - For docs-only or trivially non-runtime changes, record `ultraqa` as skipped with an explicit condition and evidence.
   - If UltraQA finds issues, persist the QA verdict/evidence, set `return_to_ralplan_reason`, and transition back to Phase `ralplan`.

The only normal terminal state is `complete` after clean code review and a passed or explicitly skipped UltraQA gate. Cancellation, blocked credentials, unrecoverable repeated failures, or explicit user stop may terminate earlier with preserved state.
</Strict_Loop_Contract>

<Pre-context Intake>
Before Phase `deep-interview` or `ralplan` starts or resumes:
1. Derive a task slug from the request.
2. Reuse the latest relevant `.omx/context/{slug}-*.md` snapshot when available.
3. If none exists, create `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) with:
   - task statement
   - desired outcome
   - known facts/evidence
   - constraints
   - unknowns/open questions
   - likely codebase touchpoints
4. If brownfield facts are missing, run `explore` first before or during `$deep-interview` (`$deep-interview --quick <task>` remains acceptable for bounded low-ambiguity intake); do not skip the clarification gate merely because the task sounds actionable.
5. Carry the snapshot path in Autopilot state and all handoff artifacts.
</Pre-context Intake>

<Execution_Policy>
- Always execute the recommended phases in order: `deep-interview`, then `ralplan`, then `ultragoal`, then `code-review`, then `ultraqa`.
- `$team` is conditional and explicit: use it only within an Ultragoal story when parallel execution materially improves throughput, quality, or safety.
- Never skip directly from vague/freeform expansion to implementation; unclear input must be clarified and planned through `$deep-interview` and `$ralplan`.
- A non-clean `$code-review` or failed `$ultraqa` always returns to `$ralplan`; do not patch findings ad hoc outside the loop.
- Each phase must write/update Autopilot state before handing off.
- Use existing hooks, `.omx/state`, `$deep-interview`, `$ralplan`, `$ultragoal`, optional `$team`, `$code-review`, `$ultraqa`, and pipeline primitives; do not invent a separate execution framework.
- Preserve legacy compatibility: if a user explicitly requests the old Ralph execution lane, use `$ralph` as an intentional alternate execution phase, but do not present it as Autopilot's default recommended loop.
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
  "current_phase": "deep-interview",
  "iteration": 1,
  "review_cycle": 0,
  "max_iterations": 10,
  "phase_cycle": ["deep-interview", "ralplan", "ultragoal", "code-review", "ultraqa"],
  "handoff_artifacts": {
    "context_snapshot_path": ".omx/context/<slug>-<timestamp>.md",
    "deep_interview": null,
    "ralplan": null,
    "ralplan_consensus_gate": {
      "required": true,
      "sequence": ["architect-review", "critic-review"],
      "planning_artifacts_are_not_consensus": true,
      "required_review_roles": ["architect", "critic"],
      "ralplan_architect_review": null,
      "ralplan_critic_review": null,
      "complete": false
    },
    "ultragoal": null,
    "code_review": null,
    "ultraqa": null
  },
  "review_verdict": null,
  "qa_verdict": null,
  "return_to_ralplan_reason": null
}
```

- **On start**: `omx state write --input '{"mode":"autopilot","active":true,"current_phase":"deep-interview","iteration":1,"review_cycle":0,"state":{"phase_cycle":["deep-interview","ralplan","ultragoal","code-review","ultraqa"],"handoff_artifacts":{"context_snapshot_path":"<snapshot-path>","deep_interview":null,"ralplan":null,"ralplan_consensus_gate":{"required":true,"sequence":["architect-review","critic-review"],"planning_artifacts_are_not_consensus":true,"required_review_roles":["architect","critic"],"ralplan_architect_review":null,"ralplan_critic_review":null,"complete":false},"ultragoal":null,"code_review":null,"ultraqa":null},"review_verdict":null,"qa_verdict":null,"return_to_ralplan_reason":null}}' --json`
- **On deep-interview -> ralplan**: set `current_phase:"ralplan"`, persist the clarified spec/requirements under `handoff_artifacts.deep_interview`.
- **On ralplan -> ultragoal**: only after `ralplan_consensus_gate.complete:true`, with `ralplan_architect_review.agent_role:"architect"` and `ralplan_architect_review.verdict:"approve"` recorded before `ralplan_critic_review.agent_role:"critic"` and `ralplan_critic_review.verdict:"approve"`; set `current_phase:"ultragoal"` and persist the plan/test-spec paths under `handoff_artifacts.ralplan`.
- **On missing ralplan consensus evidence**: keep `current_phase:"ralplan"`, persist `ralplan_consensus_gate.complete:false` with `blocked_reason`, and report an explicit blocker or max-iteration outcome instead of handing off to execution.
- **On ultragoal -> code-review**: set `current_phase:"code-review"`, persist implementation/test/ledger evidence under `handoff_artifacts.ultragoal`.
- **On code-review -> ultraqa**: set `current_phase:"ultraqa"`, persist the clean review under `handoff_artifacts.code_review`.
- **On clean review + passed/skipped QA**: set `active:false`, `current_phase:"complete"`, persist `review_verdict:{recommendation:"APPROVE", architectural_status:"CLEAR", clean:true}`, `qa_verdict:{clean:true, skipped:<boolean>, reason:<string|null>}`, and `completed_at`.
- **On non-clean review or failed QA**: increment `iteration` and `review_cycle`, set `current_phase:"ralplan"`, persist `review_verdict` or `qa_verdict`, persist the phase handoff, and set `return_to_ralplan_reason` to a concise findings-driven reason.
- **Legacy Ralph state**: if a user explicitly selected the legacy Ralph execution lane, phase names and handoff keys may include `ralph`; preserve and resume them rather than rewriting history to Ultragoal.
- **On cancellation**: run `$cancel`; preserve progress for resume rather than deleting handoff artifacts.
</State_Management>

<Continuation_And_Resume>
When the user says `continue`, `resume`, or `keep going` while Autopilot is active, read `autopilot-state.json` and continue from `current_phase`:
- `deep-interview`: clarify requirements and record the handoff artifact.
- `ralplan`: run/update consensus planning from current handoffs and any `return_to_ralplan_reason`.
- `ultragoal`: execute the approved plan durably and record verification/ledger evidence.
- `team`: continue explicit team work only when it is nested under the active Ultragoal story and report evidence back to the leader.
- `code-review`: review the current diff and decide clean vs return-to-ralplan.
- `ultraqa`: run or explicitly skip adversarial QA based on the documented condition, then finish if clean or transition to `ralplan` with findings if not clean.
- `ralph`: resume only for explicit legacy Ralph-path Autopilot state.
- `complete`: report completion evidence; do not restart.

Do not restart discovery or discard handoff artifacts on continuation.
</Continuation_And_Resume>

<Pipeline_Orchestrator>
Autopilot may be represented by the configurable pipeline orchestrator (`src/pipeline/`) when useful. The default Autopilot pipeline contract is:

```text
deep-interview -> ralplan -> ultragoal -> code-review -> ultraqa
```

Pipeline state should use `current_phase` values that match the same phase names (`deep-interview`, `ralplan`, `ultragoal`, `code-review`, `ultraqa`, `complete`, `failed`) and should carry `iteration`, `review_cycle`, `handoff_artifacts`, `review_verdict`, `qa_verdict`, and `return_to_ralplan_reason` alongside stage results. `$team` is not a default pipeline stage; it is an explicit conditional execution engine inside an Ultragoal story.
</Pipeline_Orchestrator>

<Escalation_And_Stop_Conditions>
- Stop and report a blocker when required credentials/authority are missing.
- Stop and report when the same review or QA failure recurs across 3 review cycles with no meaningful new plan.
- Stop when the user says "stop", "cancel", or "abort" and run `$cancel`.
- Otherwise, continue the loop until `$code-review` is clean and `$ultraqa` has passed or been explicitly skipped with evidence.
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Phase `deep-interview` produced/updated clarified requirements or a concise spec
- [ ] Phase `ralplan` produced/updated approved planning artifacts and durable sequential evidence from a subsequent `Architect` approval followed by a subsequent `Critic` approval
- [ ] Phase `ultragoal` implemented and verified the plan with fresh evidence and durable ledger/checkpoint references
- [ ] `$team` was used only if the active Ultragoal story needed coordinated parallel work, or explicitly recorded as not needed
- [ ] Phase `code-review` returned a clean verdict (`APPROVE` + `CLEAR`)
- [ ] Phase `ultraqa` passed, or was explicitly skipped because the change was docs-only/trivially non-runtime with evidence
- [ ] `review_verdict.clean` is true, `qa_verdict.clean` is true, and `return_to_ralplan_reason` is null
- [ ] Tests/build/lint/typecheck evidence from Ultragoal is available in handoff artifacts
- [ ] Autopilot state is marked `complete` or cancellation state is preserved coherently
- [ ] User receives a concise summary with clarification, plan, implementation, verification, review, and QA evidence
</Final_Checklist>

<Examples>
<Good>
User: `$autopilot implement GitHub issue #42`
Flow: create/load context snapshot -> `$deep-interview` requirements check -> `$ralplan` issue plan -> `$ultragoal` durable implementation + tests (launch `$team` only if a story needs parallel lanes) -> `$code-review` -> `$ultraqa`; if review or QA requests changes, return to `$ralplan` with findings.
</Good>

<Good>
User: `continue`
Context: Autopilot state says `current_phase:"code-review"`.
Flow: run `$code-review` on current diff, persist verdict, transition to `ultraqa` if clean or to `ralplan` with findings if not clean.
</Good>

<Good>
User: `$autopilot --legacy-ralph finish the migration`
Flow: preserve the explicit legacy Ralph execution choice and run the old Ralph execution lane as an alternate, without changing the documented default Autopilot recommendation.
</Good>

<Bad>
Autopilot invents independent "Expansion", "QA", and "Validation" phases and treats them as the primary lifecycle.
Why bad: this bypasses the strict `$deep-interview -> $ralplan -> $ultragoal -> $code-review -> $ultraqa` contract.
</Bad>
</Examples>
