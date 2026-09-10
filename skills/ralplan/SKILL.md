---
name: ralplan
description: Consensus planning stage for Planner -> Architect -> Critic handoff to $ultragoal
---

# Ralplan (Consensus Planning Alias)

Ralplan is the canonical consensus-planning stage used by Autopilot between `$deep-interview` and `$ultragoal`. It drives Planner, Architect, and Critic planning and records their review lifecycle with **RALPLAN-DR structured deliberation** (short mode by default, deliberate mode for high-risk work). Local lifecycle evidence is not host-issued security authority, but ordinary progression to Ultragoal must remain reachable after the execution-ready plan and sequential review evidence are durable; missing host provenance must not terminalize Ralplan or block cancel, clear, or recovery.

## Usage

```
$ralplan "task description"
```

Standalone advisory planning is explicitly opt-in:

```text
$ralplan --advisory "task description"
```

Advisory runs the same sequential Planner → Architect → Critic review lifecycle, binds the plan and both review artifacts to exact bytes and one tracker-backed iteration, then returns to the caller with `active:false`. It is a cooperative workflow pause, not a security fence or permission system. It never emits a `PreToolUse` allow/block decision, never completes the host consensus gate, never authorizes execution, and never suppresses unrelated host behavior. Terminal state must carry explicit `false` values for the consensus gate, host verification, and execution handoff rather than omitting them. A later concrete affirmative execution request may produce non-authoritative routing context, but it does not persist a permission, rewrite terminal evidence, or create an automatic handoff; quotations, code, examples, documentation, questions, modal requests, negations, and vague approval remain classifier negatives. `approved+proven` requires complete lifecycle digests plus post-write revalidation. Administrative abandonment is append-only, idempotent for prepared or committed journals, and records a separate byte-bound admin event without rewriting the original closeout journal. Real enforcement requires an explicit host-issued, host-verified receipt or capability on a non-user-mintable surface; local Advisory files, prompts, session/thread fields, tracker records, and HERDR observability cannot substitute for it. On Darwin, each Advisory evidence artifact is limited to 128 KiB by the pinned-directory reader; other supported platforms allow up to 8 MiB.

## Flags

- `--interactive`: Enables user prompts at key decision points (draft review in step 2 and final approval in step 6). Without this flag the workflow runs fully automated — Planner → Architect → Critic loop — and outputs the final plan without asking for confirmation.
- `--deliberate`: Forces deliberate mode for high-risk work. Adds pre-mortem (3 scenarios) and expanded test planning (unit/integration/e2e/observability). Without this flag, deliberate mode can still auto-enable when the request explicitly signals high risk (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage).
- `--advisory`: Standalone only. It cannot be combined with Autopilot, Pipeline, Team, Ralph, Ultragoal, execution flags, or unknown flags. Activation requires canonical session, root thread, and turn identity.

## Ontology-heavy review

For requirements semantics, taxonomy, prompt/spec design, policy distinctions, or category-risk architecture, cite the `architect` role agent's read-only review as advisory evidence. Its findings can inform the plan or follow-up evidence when explicitly used, but `$ralplan` itself records Architect→Critic lifecycle evidence only, and advisory review is never a durable execution authorization.

## Usage with interactive mode

```
$ralplan --interactive "task description"
```

## Behavior

## GPT-5.6 Guidance Alignment

Use the shared workflow guidance pattern: outcome-first framing, concise visible updates for multi-step planning, local overrides for the active workflow branch, evidence-backed planning and validation expectations, explicit stop rules, right-sized implementation/PRD shape, and automatic continuation for safe reversible steps. Ask only for material, destructive, credentialed, external-production, or preference-dependent branches.

This skill runs its own consensus runtime; it does not delegate to a nonexistent Plan consensus mode:

```
omx ralplan run --task <arguments> [--session <id>]
```

The consensus workflow:
1. **Planner** creates an adaptive plan (right-sized to task scope; do not default to exactly five steps) and a compact **RALPLAN-DR summary** before review. Current `[main]` vs `[planner]` behavior: standalone `$ralplan` may be authored by the active main planning lane unless the caller/runtime supplies a dedicated planner routing record; inside `$autopilot`, state field `planning_routing.owner:"planner"` means the initial Planner draft/decomposition must use dedicated `[planner]`. Set `.omx-config.json` `agentModels.planner` to opt into a specific planner model and force dedicated planner ownership for complex Autopilot planning even when `[main]` is not cheap/mini. The RALPLAN-DR summary includes:
   - Principles (3-5)
   - Decision Drivers (top 3)
   - Viable Options (>=2) with bounded pros/cons
   - If only one viable option remains, explicit invalidation rationale for alternatives
   - Deliberate mode only: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)
2. **User feedback** *(--interactive only)*: If `--interactive` is set, use the structured question UI (`omx question` in attached tmux; native structured input outside tmux when available) to present the draft plan **plus the Principles / Drivers / Options summary** before review (Proceed to review / Request changes / Skip review). Otherwise, automatically proceed to review.
**Native role-routing preflight:** Keyword routing may already have selected Ralplan, but it is not authority. Run `omx ralplan preflight --json` only when the native task surface reports `role_routing_unavailable` and this workflow attempts adapted Ralplan Planner, Architect, or Critic authority, adapted role-intent, or adapted consensus authority. On `unsupported_documented_leader_proof`, stop before that adapted authority and use a Codex surface with documented root proof or a reviewed alternative workflow. Do not infer root identity from `session_id`, undocumented `thread_id`, session/pointer/transcript/cwd state, absence of child data, or a prompt label. Ordinary native planning, lifecycle, state, status, health, HUD, runtime, setup, install, sync, and unrelated delegation are outside this preflight boundary and remain governed by existing controls.

**Native role-routing rule:** When the native surface exposes `agent_type` role routing, set `agent_type` to an installed OMX role and never omit it for OMX work. When it does not (`role_routing_unavailable`), do not fabricate `agent_type`. On the exact reviewed Codex releases 0.144.5, 0.145.0, 0.146.1, and 0.148.0-alpha.5, adapted Ralplan Planner, Architect, Critic, role-intent, and consensus authority are unavailable because they lack documented root proof; every other version remains unknown and fails closed. Do not silently weaken routing with a prompt role label or inferred carrier. Use a Codex surface with documented root proof or a reviewed alternative workflow for that authority. A direct `omx ralplan role-intent write` attempt is denied with machine reason `unsupported_documented_leader_proof`.

3. **Architect** reviews for architectural soundness and must provide the strongest steelman antithesis, at least one real tradeoff tension, and (when possible) synthesis — **await completion before step 4**. Launch this as a subsequent role-specific `Architect` subagent and pass the full task statement, context snapshot, PRD/test-spec paths, and relevant prior findings; do not substitute an unvalidated reviewer identity or a short improvised reviewer prompt. In deliberate mode, Architect should explicitly flag principle violations.
4. **Critic** evaluates against quality criteria — run only after step 3 completes. Launch this as a subsequent role-specific `Critic` subagent with the full task statement, context snapshot, PRD/test-spec paths, and the completed Architect review; do not ask the Architect subagent to perform the Critic gate and do not substitute an unvalidated reviewer identity or a short improvised reviewer prompt. Critic must enforce principle-option consistency, fair alternatives, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. In deliberate mode, Critic must reject missing/weak pre-mortem or expanded test plan.
5. **Re-review loop** (max 5 iterations): Any non-`APPROVE` Critic verdict (`ITERATE` or `REJECT`) MUST run the same full closed loop:
   a. Collect Architect and Critic feedback
   b. Revise the plan with Planner
   c. Return to Architect review
   d. Return to Critic evaluation
   e. Repeat this loop until Critic returns `APPROVE` or 5 iterations are reached
   f. If 5 iterations are reached without `APPROVE`, present the best version to the user
6. On Critic approval, persist the execution-ready planning artifacts and sequential Architect→Critic evidence. In standalone interactive Ralplan, present the requested future execution lane. Inside Autopilot, the existing explicit `$autopilot` invocation authorizes the supervised transition to its defining next stage, `$ultragoal`; persist an Autopilot-owned `ralplan_execution_handoff` bound to the same session and review cycle.
7. Record `ralplan_execution_handoff` with `{authorized: true, reason, authorized_at, session_id, review_cycle, source: "autopilot"|"user"}`. `source:"autopilot"` is valid only for a supervised active Autopilot run whose current phase is `ralplan`; it does not claim host-consensus authority.
8. Transition to `$ultragoal` after the durable plan, sequential approvals, and bound execution handoff exist. Do not implement directly inside Ralplan.

> **Important:** Steps 3 and 4 MUST run sequentially as role-specific subagents. Do NOT issue both agent calls in the same parallel batch. Always await the subsequent `Architect` result before invoking the subsequent `Critic`; their completed approvals establish local lifecycle evidence only and cannot satisfy the durable execution gate.

## Planning/Execution Boundary

`$ralplan` is a planning mode. While ralplan is active and no explicit execution handoff is active, implementation-focused write tools are out of scope. Ralplan may inspect the repository and may write only planning artifacts such as `.omx/context/`, `.omx/plans/`, `.omx/specs/`, and required `.omx/state/` records.

The canonical flow is:

```
$ralplan -> local Architect→Critic lifecycle evidence -> bound execution handoff -> $ultragoal
```

Before any execution lane begins, ralplan must emit terminal planning state (complete, paused, failed, or waiting for input) and the durable handoff record below. Do not continue from consensus planning into direct code edits in the same ralplan session.

## Durable Consensus Handoff Contract

Ralplan is not complete, skippable, or ready for execution merely because `.omx/plans/prd-*.md` and `.omx/plans/test-spec-*.md` exist. Those files are planning artifacts, not consensus evidence.

Before any Autopilot, Ultragoal, Team, or implementation handoff, persist a durable handoff record that distinguishes:

- `planning_artifacts`: PRD/test-spec paths.
- `ralplan_architect_review`: the completed Architect review with an approving verdict.
- `ralplan_critic_review`: the completed Critic review with an approving verdict, recorded only after the Architect review.
- `ralplan_execution_handoff`: persist `{authorized: true, reason: "<rationale>", authorized_at: "<ISO timestamp>", session_id: "<current session>", review_cycle: <matching lifecycle cycle>, source: "autopilot"|"user"}`. Autopilot may issue this only for its own supervised `ralplan` phase; standalone Ralplan uses `source:"user"`.
- `ralplan_consensus_gate.complete` records lifecycle completion after the sequential Architect and Critic approvals. It is not a host-security claim. Locally authored JSON/env/prompt/tracker/transcript/receipt-shaped evidence must never be described as host-issued authority.

If Architect is missing/blocked, keep the workflow in Architect review or report that blocker. If Critic is missing/blocked/non-approving, keep the workflow in Critic/re-review or report the max-iteration outcome. After both reviews approve, execution begins only when the matching `ralplan_execution_handoff` is durable. Existing plan/test-spec files alone are never permission to skip Ralplan or execute.

Follow the Plan skill's full documentation for consensus mode details.

## Goal-Mode Follow-up Suggestions

When a bound `ralplan_execution_handoff` permits execution, include product-facing goal-mode suggestions alongside coordinated Team execution. Record the requested lane and persist the handoff without claiming host-issued authority.

- `$ultragoal` — **default goal-mode follow-up** for implementation or general goal-oriented follow-up plans that should become durable Codex/OMX goals with sequential completion tracking.
- `$autoresearch` — research-project follow-up when the plan centers on a question, literature/reference gathering, evaluator-backed research, or a professor/critic-style research deliverable. (`$autoresearch-goal` was retired to a sunset stub in OMX 0.21.)
- `$performance-goal` — optimization/performance follow-up when the plan centers on speed, latency, throughput, memory, benchmark, or other measurable performance work.

Use `$ultragoal` for durable goal tracking and `$team` for coordinated parallel implementation. When combined, Ultragoal owns the ledger and Team returns checkpoint-ready execution evidence.
Use the available-agent-types roster to produce explicit role/staffing allocation, reasoning-by-lane guidance, concrete launch hints (including `omx team` when parallel delivery is justified), and team verification responsibilities for any future receipt-authorized execution path.

## Pre-context Intake

Before consensus planning or execution handoff, ensure a grounded context snapshot exists:

1. Derive a task slug from the request.
2. Reuse the latest relevant snapshot in `.omx/context/{slug}-*.md` when available.
3. If none exists, create `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) with:
   - task statement
   - desired outcome
   - known facts/evidence
   - constraints
   - unknowns/open questions
   - likely codebase touchpoints
4. If ambiguity remains high, gather brownfield facts first. `omx explore` is deprecated; use normal repository inspection tools/subagents for simple read-only repository lookups and `omx sparkshell` only for explicit shell-native read-only evidence. Then run `$deep-interview --quick <task>` before continuing.
5. If the plan depends on official docs, version-aware framework guidance, best practices, or external dependency behavior, use `$best-practice-research` as the bounded evidence wrapper and auto-delegate `researcher` for the official/upstream lookup before finalizing the planning handoff so execution does not start from repo-local recall alone.
6. If a prior `$autoresearch` run exists, treat its approved artifact as evidence for the plan. Read historical artifacts from `$autoresearch-goal` only as compatibility input. Do not include Autoresearch as a final architecture or runtime component unless the user explicitly requested ongoing research automation; otherwise synthesize the evidence into the `$ralplan` ADR, risks, and verification steps.

Do not hand off to execution modes until this intake is complete; if urgency forces progress, explicitly document the risk tradeoffs.

## Routing boundary

Ordinary scoped tasks stay in the direct execution lane described by `templates/AGENTS.md`.
Explicit workflow requests follow the keyword registry (`src/hooks/keyword-registry.ts`) and their owning skill contracts; this card does not define a second activation table.
Once Ralplan is active, preserve the planning/execution and consensus handoff requirements above. A conversational “just do it” is not a substitute for the required review evidence.

## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.
