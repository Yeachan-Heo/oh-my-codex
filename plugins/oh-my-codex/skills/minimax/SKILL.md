---
name: minimax
description: "[OMX] One-step-ahead adversarial oversight workflow. Use when the user explicitly asks for `$minimax` or a minimax workflow to run a proposer, lookahead reviewer, arbiter loop, with optional file-council or code-review escalation for risky diffs."
---

# Minimax

Minimax is a guarded execution workflow for tasks that are clear enough to start but risky enough that each next move needs adversarial pressure. It runs a stateful loop: **MAX proposes or executes one bounded move, LOOKAHEAD predicts the next move, MIN reviews the transition, and ARBITER decides whether to continue, revise, block, escalate, or complete**.

## Fit

Use Minimax when:
- The user wants autonomous progress with a one-step-ahead reviewer.
- The task can drift in scope, public API shape, safety posture, or verification quality.
- A local executor would move fast, but a conservative critic should guard each transition.
- External review such as file-council should run only on high-risk or disputed steps.

Do not use Minimax for unclear requirements. Use `$deep-interview` first. Use `$ralplan` first when architecture, product tradeoffs, or acceptance criteria are not settled. Use `$team` when independent implementation lanes matter more than step-by-step oversight.

## Roles

- **MAX**: proposes the highest-value next action and executes only one bounded, reversible step at a time.
- **LOOKAHEAD**: predicts the next likely move, expected evidence, and failure modes before the workflow commits to another step.
- **MIN**: reviews the transition from current state to proposed next state. It tries to minimize damage: drift, unsafe changes, missing tests, hidden assumptions, and user-contract expansion.
- **ARBITER**: makes the final step decision: `continue`, `revise`, `block`, `escalate`, or `complete`.
- **COUNCIL**: optional high-cost review. Prefer file-council when installed and the review is file-grounded; otherwise use `$code-review`, `critic`, `code-reviewer`, or `verifier` as the available review surface.

The same model context may perform multiple roles for small tasks, but keep the role outputs separate. For meaningful code changes, use role-specific native subagents when available: `executor` for MAX, `critic` for MIN, and `verifier` or `code-reviewer` for ARBITER/COUNCIL.

## State packet

Minimax is a native-hook stateful workflow. Prompt activation seeds `.omx/state/.../minimax-state.json`; bare `continue`, `resume`, or `keep going` resumes the active Minimax state for the current session.

The mode state tracks the current step and completion gate:

```json
{
  "active": true,
  "mode": "minimax",
  "current_phase": "planning",
  "step": 1,
  "packet_dir": ".omx/minimax",
  "last_packet_path": null,
  "lookahead_policy": {
    "schema_version": "minimax-lookahead-policy-v1",
    "depth": 2,
    "branch_factor_by_risk": {
      "low": 1,
      "medium": 2,
      "high": 3
    },
    "max_branches": 3,
    "scoring": {
      "value_weight": 1,
      "evidence_weight": 1,
      "reversibility_bonus": 2,
      "risk_weight": 1,
      "scope_expansion_weight": 1
    },
    "progressive_widening": {
      "add_branch_when_min_rejects": true,
      "add_branch_when_risk_high": true,
      "add_branch_when_verification_weak": true,
      "add_branch_when_public_contract_changes": true
    }
  },
  "max_next_action": null,
  "lookahead": null,
  "min_verdict": "pending",
  "arbiter_decision": "pending",
  "last_arbiter_decision": null,
  "arbiter_history": [],
  "escalation_history": [],
  "escalated": false,
  "verification_evidence": [],
  "verification_evidence_step": null,
  "verification_evidence_path": null,
  "council_evidence_step": null,
  "completion_gate": {
    "arbiter_decision_required": "complete",
    "verification_evidence_required": true,
    "fresh_verification_evidence_required": true,
    "council_artifact_required_when_escalated": true
  },
  "state": {
    "role_loop": ["MAX", "LOOKAHEAD", "MIN", "ARBITER"],
    "council": {
      "required": false,
      "preferred_surface": "file-council",
      "artifact_path": null,
      "verdict": null
    }
  }
}
```

Before each edit or external action, create a compact packet in the working notes or `.omx/minimax/step-<n>.md` when durable evidence is useful:

```yaml
step: <n>
goal: <user-visible objective>
current_state: <what is true now>
max_next_action: <one bounded action>
lookahead: <what this enables next>
expected_evidence:
  - <test/check/output that would prove the step>
risk: low | medium | high
reversible: true | false
lookahead_policy:
  depth: 2
  branch_factor: 1 | 2 | 3
branches:
  - id: A
    max_action: <candidate bounded action>
    next_state: <expected state after that action>
    value: 0-10
    risk: 0-10
    evidence_strength: 0-10
    reversible: true | false
    scope_expansion: 0-10
    score: <value + evidence + reversibility bonus - risk - scope expansion>
selected_branch: A
min_verdict: pending | continue | revise | block | escalate
arbiter_decision: pending | continue | revise | block | escalate | complete
```

Keep packets short. They are guardrails, not planning essays. If a packet is written to disk, update the same packet with MIN and ARBITER decisions before moving to the next step. Keep `minimax-state.json` in sync with the latest packet when the workflow will rely on continuation.

## Bounded branched lookahead

LOOKAHEAD may compare more than one candidate branch when risk justifies it:

- low risk: 1 branch
- medium risk: 2 branches
- high risk, public API, security, compatibility, or irreversible work: 3 branches

The default limit is depth 2 and max 3 branches. Use progressive widening only when MIN rejects a branch, risk is high, verification is weak, or the branch changes a public contract. Score branches with the simple policy in the packet: higher user value and stronger evidence help; higher risk and scope expansion hurt; reversible actions get a small bonus. Branch metrics are interpreted on the documented 0-10 range. The scoring weights and progressive widening flags are fixed workflow defaults, not caller configuration knobs.

Select one branch before MAX executes. Do not grow a tree, spawn a team, or convert Minimax into `$ralplan`. If more than three branches or deeper planning seems needed, hand off to `$ralplan` or `$team`.

## Loop

1. **Frame the objective**
   - Restate the target result, constraints, validation evidence, and stop condition.
   - If the request is underspecified, hand off to `$deep-interview` or `$ralplan` instead of inventing scope.

2. **MAX step**
   - Select one bounded next action.
   - Prefer reversible local edits, targeted tests, and existing repo patterns.
   - Do not batch unrelated changes to sneak past MIN.

3. **LOOKAHEAD step**
   - Predict the likely next action after MAX succeeds.
   - For medium or high risk, compare the bounded branch set from `lookahead_policy` and choose one `selected_branch`.
   - Name the evidence that should exist before continuing.
   - Name one plausible failure mode or drift vector.

4. **MIN review**
   - Compare original intent, current evidence, MAX action, and LOOKAHEAD proposal.
   - Reject transitions that widen public contracts, skip tests, hide failed evidence, use unsafe automation casually, or create irreversible work without authority.
   - Prefer minimal repair instructions over broad criticism.

5. **ARBITER decision**
   - `continue`: MAX may execute the bounded step.
   - `revise`: MAX must adjust the step before execution.
   - `block`: stop and report the blocker.
   - `escalate`: run COUNCIL before changing or submitting.
   - `complete`: no pending work remains and verification evidence is fresh.

   Store the decision in `arbiter_decision`. Do not mark `complete` until `verification_evidence_path` points to a passing `minimax-verification-v1` JSON artifact for the current `step`, `verification_evidence` summarizes the checks or artifacts that prove the final claim, and `verification_evidence_step` is at least the current `step`. If ARBITER chooses `escalate`, set the sticky `escalated: true`, append `escalate` to `arbiter_history`, and set `state.council.required: true` or `last_arbiter_decision: "escalate"`. Do not clear `escalated` after later `continue` or `revise` steps; a prior escalation keeps the council gate active until a passing council artifact is recorded.

6. **Execute and verify**
   - Execute only the accepted step.
   - Run the smallest validation that proves the claim.
   - Feed the result into the next packet.
   - Increment `step` after a completed bounded move.

## Continuation and completion

On `continue`, resume from `.omx/state/.../minimax-state.json` instead of starting over. Read the latest `step`, `last_packet_path`, `min_verdict`, `arbiter_decision`, and `verification_evidence` before choosing the next MAX action.

Completion is gated. These gates are invariants; persisted state cannot weaken them. The workflow should remain active if the assistant says it is done but the state lacks:
- `arbiter_decision: "complete"`
- non-empty `verification_evidence`
- a passing JSON `verification_evidence_path` artifact with `schema_version: "minimax-verification-v1"`, `step` at or after the current `step`, and `status: "passed"` or `passed: true`
- `verification_evidence_step` at or after the current `step`
- a passing JSON `state.council.artifact_path` or `council_artifact_path` when council review was required or escalation history exists
- `council_evidence_step` at or after the current `step` when council review is required

For public API, security, package-export, or compatibility-contract changes, create a file-council artifact before final completion unless the tool is unavailable and the fallback review surface is recorded. When council is required, use the aggregated file-council `summary.json` with `schema_version: "file-council-summary-v1"`, `verdict.status: "no_blockers"`, no blockers, no degraded council status, and `scorecard.blocker_count: 0`. Do not rely on a single member output, prose note, scalar verdict, top-level status, or assistant-authored JSON without the file-council summary schema.

## Council escalation

Escalate when any condition is true:
- Public API, package exports, security, auth, sandboxing, secrets, data migration, destructive operations, or external production effects are involved.
- MIN and MAX disagree on safety or scope.
- A diff is large enough that local review is likely to miss interactions.
- The step would become user-facing documentation or compatibility contract.
- Verification is inconclusive but the workflow would otherwise continue.

When file-council is available and the review is file-grounded, run a targeted prompt over only the relevant files. Use a stronger or adversarial file-council preset only when that local installation supports it or when the user explicitly asks for maximum review. Treat file-council findings as claims to verify, not as automatic truth. If file-council is unavailable, use `$code-review` or role-specific `critic`/`code-reviewer`/`verifier` agents.

## Stop rules

Stop when:
- ARBITER marks `complete` with fresh verification evidence.
- ARBITER marks `block` and no safe local repair remains.
- The next step needs destructive, irreversible, credential-gated, external-production, or materially scope-changing authority that the user has not granted.
- The workflow has repeated the same `revise` or `block` condition twice; switch to `$ralplan` for redesign.

## Output shape

For progress updates, keep it short:

```text
Minimax: step <n>
MAX: <accepted action/result>
MIN: <main risk or pass reason>
ARBITER: <continue|revise|block|escalate|complete>
Evidence: <test/check/artifact>
```

For the final response, report changed files, verification evidence, council/reviewer outcome when used, and remaining risks.
