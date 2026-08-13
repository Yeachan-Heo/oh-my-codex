---
name: autopilot
description: "[OMX] Canonical autonomous orchestrator: $deep-interview -> $ralplan -> $ultragoal"
---

# Autopilot

<Purpose>
Autopilot is the first-class canonical orchestrator for hands-off delivery. Its defining default chain is mandatory:

```text
$deep-interview -> $ralplan -> $ultragoal
```

The chain is not a list of optional hints and Autopilot is not an alias for direct execution. Autopilot supervises each child stage in one recoverable session, carries durable artifacts forward, and continues through implementation verification until the requested outcome is complete or a genuine blocker is recorded.
</Purpose>

<Use_When>
- The user explicitly invokes `$autopilot`.
- The user asks for end-to-end autonomous delivery from an idea, issue, or requirements seed.
- The work needs requirements clarification, consensus planning, durable execution, and evidence-backed completion as one supervised workflow.
</Use_When>

<Default_Chain>
Run or resume these stages in order:

1. **`deep-interview`** — clarify intent, scope, non-goals, constraints, acceptance criteria, and unresolved decisions. Produce a durable requirements/specification handoff. Deep Interview is a real stage; do not replace it with a one-question check or skip it merely because the task looks actionable.
2. **`ralplan`** — turn the clarified requirements into an execution-ready consensus plan with architecture, sequencing, test, and verification guidance. Preserve review evidence as lifecycle evidence, not host-issued security authority.
3. **`ultragoal`** — execute the approved plan through durable goals and ledger receipts, implementation, focused verification, cleanup, review, and terminal evidence.

`$team`, `$code-review`, and `$ultraqa` may be used inside the supervised execution when the active Ultragoal plan or verification boundary requires them. They do not replace or weaken the defining three-stage chain.

When review or QA proves the requirements or plan wrong, keep Autopilot active, return its supervised phase to `ralplan`, attach the findings, and continue through `ultragoal` again. Implementation-only review fixes may remain within Ultragoal's blocker/review loop.
</Default_Chain>

<Execution_Policy>
- Autopilot MUST begin at `deep-interview` for a new run and MUST preserve the phase order `deep-interview -> ralplan -> ultragoal`.
- Child stages are supervised phases, not peer workflow activations. Keep `mode:"autopilot"` active and update `current_phase` rather than replacing Autopilot with standalone child state.
- Use the current CLI state SSOT (`omx state ... --json`) and the current session-scoped state root. Do not create a second writer or revive legacy root-state authority.
- Local artifacts, prompts, trackers, transcripts, environment values, and role labels are lifecycle evidence only. Do not reintroduce the retired unrecoverable host-receipt lock or terminalize the workflow because host provenance is unavailable.
- Authority-decreasing operations are always recoverable: `$cancel`, state clear, hook disable/uninstall recovery, and stale-state repair must remain available without completion receipts or child-stage approval.
- Continue automatically through safe, reversible stage transitions. Stop only for an explicit user cancellation, a human-only dependency, or a verified terminal result.
</Execution_Policy>

<State_Management>
Autopilot state is session-scoped and owned by the canonical state writer. A new run records at least:

```json
{
  "mode": "autopilot",
  "active": true,
  "current_phase": "deep-interview",
  "iteration": 1,
  "phase_cycle": ["deep-interview", "ralplan", "ultragoal"],
  "handoff_artifacts": {
    "deep_interview": null,
    "ralplan": null,
    "ultragoal": null
  },
  "return_to_ralplan_reason": null
}
```

Start or update state only through the CLI-first state surface:

```bash
omx state write --input '{"mode":"autopilot","active":true,"current_phase":"deep-interview","state":{"phase_cycle":["deep-interview","ralplan","ultragoal"],"handoff_artifacts":{"deep_interview":null,"ralplan":null,"ultragoal":null},"return_to_ralplan_reason":null}}' --json
```

Stage transitions:

- **`deep-interview -> ralplan`**: require a durable clarified requirements/specification artifact and a non-empty completion rationale. Preserve same-session question evidence when a question surface was used.
- **`ralplan -> ultragoal`**: require durable planning artifacts, sequential Architect then Critic approvals, and a session/review-cycle-bound `ralplan_execution_handoff`. For supervised Autopilot, the explicit Autopilot request is the source of that bound handoff. Ordinary progression MUST NOT depend on a host-issued consensus receipt; missing host provenance is not a blocker.
- **`ultragoal -> complete`**: require durable goal/ledger completion receipts and fresh verification evidence matching the requested outcome.
- **review/QA loopback**: keep Autopilot active, set `current_phase:"ralplan"`, and persist `return_to_ralplan_reason` plus the findings.
- **cancellation**: run `$cancel`; preserve handoff artifacts for inspection or resume and mark the exact session terminal without deleting unrelated state.
- **clear/recovery**: exact-session clear may remove corrupt or stale Autopilot state. It must not require forward-progression evidence and must not clear other skills or sessions.
</State_Management>

<Continuation_And_Resume>
When the user says `continue`, `resume`, or `keep going`, read the current session's `autopilot-state.json` and continue from `current_phase`:

- `deep-interview`: resume clarification and produce the requirements handoff.
- `ralplan`: resume consensus planning from the deep-interview artifact and any loopback findings.
- `ultragoal`: resume durable execution from the approved plan and ledger.
- `complete`: report the terminal evidence; do not restart.
- `cancelled`, `cleared`, or `failed`: report preserved artifacts and start a new run only on a new explicit Autopilot request.

Never discard valid handoff artifacts or restart discovery merely because the conversation resumed.
</Continuation_And_Resume>

<Recovery_Contract>
Autopilot continuation hooks may nudge an active non-terminal run, but they MUST fail open for recovery:

- A stale, malformed, cancelled, cleared, complete, or foreign-session state must not keep Stop blocked.
- `$cancel`, exact-session state clear, and setup hook disable/uninstall paths must remain executable while Autopilot is active or damaged.
- Continuation must be bounded and session-scoped; never recreate an unconditional hook lock.
</Recovery_Contract>

<Final_Checklist>
- [ ] A new run started with `deep-interview`.
- [ ] Deep Interview produced a durable clarified requirements/specification handoff.
- [ ] Ralplan produced an execution-ready plan with lifecycle review evidence.
- [ ] Ultragoal completed the plan with durable goals and ledger receipts.
- [ ] Verification evidence covers the requested behavior, failure paths, and recovery paths.
- [ ] Missing host provenance did not block ordinary progression, cancel, clear, or hook recovery.
- [ ] Autopilot state is terminal and exact-session artifacts remain coherent.
</Final_Checklist>

<Examples>
<Good>
User: `$autopilot implement issue #42`
Flow: activate Autopilot at `deep-interview`, crystallize requirements, continue to supervised `ralplan`, then supervised `ultragoal`, verify the completed outcome, and mark the exact session complete.
</Good>

<Good>
User: `continue`
Context: Autopilot state has `current_phase:"ralplan"`.
Flow: resume the existing plan from the deep-interview handoff; do not create a separate standalone Ralplan run.
</Good>

<Bad>
Flow: treat `$deep-interview`, `$ralplan`, and `$ultragoal` as optional suggestions and jump directly to implementation.
Why bad: this hollows out Autopilot's defining orchestration contract.
</Bad>
</Examples>

Task: {{ARGUMENTS}}
