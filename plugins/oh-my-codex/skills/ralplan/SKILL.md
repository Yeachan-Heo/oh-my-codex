---
name: ralplan
description: Alias for $plan --consensus
---

# Ralplan (Consensus Planning Alias)

Ralplan is a shorthand alias for `$plan --consensus`. It triggers iterative planning with Planner, Architect, and Critic agents until consensus is reached, with **RALPLAN-DR structured deliberation** (short mode by default, deliberate mode for high-risk work). Scholastic is available as a separate advisory native agent/persona for ontology-heavy planning evidence, but it is not part of the durable consensus gate.

## Usage

```
$ralplan "task description"
```

## Flags

- `--interactive`: Enables user prompts at key decision points (draft review in step 2 and final approval in step 6). Without this flag the workflow runs fully automated — Planner → Architect → Critic loop — and outputs the final plan without asking for confirmation.
- `--deliberate`: Forces deliberate mode for high-risk work. Adds pre-mortem (3 scenarios) and expanded test planning (unit/integration/e2e/observability). Without this flag, deliberate mode can still auto-enable when the request explicitly signals high risk (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage).

## Ontology-heavy review

For requirements semantics, taxonomy, prompt/spec design, policy distinctions, or category-risk architecture, subagent `Scholastic` may be cited as an available advisory ontology reviewer/persona. Its findings can inform the plan or follow-up evidence when explicitly used, but `$ralplan` itself remains the Planner → Architect → Critic consensus workflow and the durable gate remains Architect→Critic only.

## Usage with interactive mode

```
$ralplan --interactive "task description"
```

## Behavior

## GPT-5.5 Guidance Alignment

Use the shared workflow guidance pattern: outcome-first framing, concise visible updates for multi-step planning, local overrides for the active workflow branch, evidence-backed planning and validation expectations, explicit stop rules, right-sized implementation/PRD shape, and automatic continuation for safe reversible steps. Ask only for material, destructive, credentialed, external-production, or preference-dependent branches.

This skill invokes the Plan skill in consensus mode:

```
$plan --consensus <arguments>
$plan --consensus --interactive <arguments>
```

The consensus workflow:
1. **Planner** creates an adaptive plan (right-sized to task scope; do not default to exactly five steps) and a compact **RALPLAN-DR summary** before review:
   - Principles (3-5)
   - Decision Drivers (top 3)
   - Viable Options (>=2) with bounded pros/cons
   - If only one viable option remains, explicit invalidation rationale for alternatives
   - Deliberate mode only: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)
2. **User feedback** *(--interactive only)*: If `--interactive` is set, use the structured question UI (`omx question` in attached tmux; native structured input outside tmux when available) to present the draft plan **plus the Principles / Drivers / Options summary** before review (Proceed to review / Request changes / Skip review). Otherwise, automatically proceed to review.
3. **Architect** reviews for architectural soundness and must provide the strongest steelman antithesis, at least one real tradeoff tension, and (when possible) synthesis — **await completion before step 4**. Launch this as a subsequent `Architect` subagent (`agent_type: "architect"`) and pass the full task statement, context snapshot, PRD/test-spec paths, and relevant prior findings; do not use a default subagent with only a short improvised reviewer prompt. In deliberate mode, Architect should explicitly flag principle violations.
4. **Critic** evaluates against quality criteria — run only after step 3 completes. Launch this as a subsequent `Critic` subagent (`agent_type: "critic"`) with the full task statement, context snapshot, PRD/test-spec paths, and the completed Architect review; do not ask the Architect subagent to perform the Critic gate and do not substitute a default subagent fantasy prompt for the packaged Critic role. Critic must enforce principle-option consistency, fair alternatives, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. In deliberate mode, Critic must reject missing/weak pre-mortem or expanded test plan.
5. **Re-review loop** (max 5 iterations): Any non-`APPROVE` Critic verdict (`ITERATE` or `REJECT`) MUST run the same full closed loop:
   a. Collect Architect and Critic feedback
   b. Revise the plan with Planner
   c. Return to Architect review
   d. Return to Critic evaluation
   e. Repeat this loop until Critic returns `APPROVE` or 5 iterations are reached
   f. If 5 iterations are reached without `APPROVE`, present the best version to the user
6. On Critic approval *(--interactive only)*: If `--interactive` is set, use the structured question UI to present the plan with approval options (Approve durable goal execution via ultragoal / Approve and implement via team / Explicit Ralph fallback / Start specialized goal-mode follow-up / Request changes / Reject). Final plan must include ADR (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups), an explicit available-agent-types roster, concrete follow-up staffing guidance for `$ultragoal` and `$team`, plus an explicit `$ralph` fallback note when persistent single-owner verification is intentionally selected, suggested reasoning levels by lane, explicit `omx team` / `$team` launch hints, a concrete **team verification** path, and a product-facing **Goal-Mode Follow-up Suggestions** section. Recommend `$ultragoal` by default for goal-mode follow-up, use `$autoresearch-goal` instead when the context is a research project, and use `$performance-goal` instead when the context is an optimization or performance project. Otherwise, output the final plan and stop.
7. *(--interactive only)* User chooses: Approve (`$ultragoal` durable goal execution, `$team`, explicit `$ralph` fallback, or a specialized goal-mode follow-up), Request changes, or Reject
8. *(--interactive only)* On approval: invoke `$ultragoal` for default durable sequential execution, `$team` for parallel team execution, the selected specialized goal-mode follow-up (`$autoresearch-goal` or `$performance-goal`), or `$ralph` only when the user explicitly selects that fallback with the approved plan and matching success/evaluator context -- never implement directly. Preserve the explicit available-agent-types roster, reasoning-by-lane guidance, role/staffing allocation guidance, launch hints, and verification-path guidance from the approved plan for Ultragoal/team paths and any explicit Ralph fallback.

> **Important:** Steps 3 and 4 MUST run sequentially as role-specific subagents. Do NOT issue both agent calls in the same parallel batch. Always await the subsequent `Architect` result before invoking the subsequent `Critic`; only a completed, role-specific `Critic` approval can satisfy the durable gate.

## Planning/Execution Boundary

`$ralplan` is a planning mode. While ralplan is active and no explicit execution handoff is active, implementation-focused write tools are out of scope. Ralplan may inspect the repository and may write only planning artifacts such as `.omx/context/`, `.omx/plans/`, `.omx/specs/`, and required `.omx/state/` records.

The canonical flow is:

```
$ralplan -> durable consensus artifact -> explicit execution lane -> $ultragoal | $team | $ralph
```

Before any execution lane begins, ralplan must emit terminal planning state (complete, paused, failed, or waiting for input) and the durable handoff record below. Do not continue from consensus planning into direct code edits in the same ralplan session.

## Durable Consensus Handoff Contract

Ralplan is not complete, skippable, or ready for execution merely because `.omx/plans/prd-*.md` and `.omx/plans/test-spec-*.md` exist. Those files are planning artifacts, not consensus evidence.

Before any Autopilot, Pipeline, Ultragoal, Team, Ralph, or implementation handoff, persist a durable handoff record that distinguishes:

- `planning_artifacts`: PRD/test-spec paths.
- `ralplan_architect_review`: the completed Architect review with an approving verdict.
- `ralplan_critic_review`: the completed Critic review with an approving verdict, recorded only after the Architect review.
- `ralplan_consensus_gate.complete:true` only when both reviews are present, approving, and in the required Architect→Critic order.

If Architect is missing/blocked, keep the workflow in Architect review or report that blocker. If Critic is missing/blocked/non-approving, keep the workflow in Critic/re-review or report the max-iteration outcome. Do not treat existing plan/test-spec files as permission to skip ralplan or start execution.

Follow the Plan skill's full documentation for consensus mode details.

## Goal-Mode Follow-up Suggestions

When ralplan outputs a final handoff or asks the user to choose a next lane, include product-facing goal-mode suggestions alongside the existing Ralph and team options:

- `$ultragoal` — **default goal-mode follow-up** for implementation or general goal-oriented follow-up plans that should become durable Codex/OMX goals with sequential completion tracking.
- `$autoresearch-goal` — research-project follow-up when the plan centers on a question, literature/reference gathering, evaluator-backed research, or a professor/critic-style research deliverable.
- `$performance-goal` — optimization/performance follow-up when the plan centers on speed, latency, throughput, memory, benchmark, or other measurable performance work.

Keep `$team` as a first-class execution option and keep `$ralph` available only as an explicit fallback where appropriate: use Ultragoal as the default durable goal-mode follow-up, Team for coordinated parallel implementation, and Ralph only for intentionally selected persistent single-owner completion/verification pressure. For parallelizable durable-goal delivery, recommend `$ultragoal` + `$team` together: Ultragoal remains the leader-owned `.omx/ultragoal` ledger/Codex-goal wrapper while Team runs parallel lanes and returns checkpoint-ready evidence. Do not present Ralph as the recommended follow-up when durable goal tracking is needed; present Ultragoal as the superseding default, with Team for parallel delivery and Ralph only as an explicit fallback when its narrow persistence loop is specifically desired.

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
6. If a prior `$autoresearch` or `$autoresearch-goal` run exists, treat its approved artifact as evidence for the plan. Do not include Autoresearch as a final architecture or runtime component unless the user explicitly requested ongoing research automation; otherwise synthesize the evidence into the `$ralplan` ADR, risks, and verification steps.

Do not hand off to execution modes until this intake is complete; if urgency forces progress, explicitly document the risk tradeoffs.

## Pre-Execution Gate

### Why the Gate Exists

Execution modes (ralph, autopilot, team, ultrawork) spin up heavy multi-agent orchestration. When launched on a vague request like "ralph improve the app", agents have no clear target — they waste cycles on scope discovery that should happen during planning, often delivering partial or misaligned work that requires rework.

The ralplan-first gate intercepts underspecified execution requests and redirects them through the ralplan consensus planning workflow. This ensures:
- **Explicit scope**: A PRD defines exactly what will be built
- **Test specification**: Acceptance criteria are testable before code is written
- **Consensus**: Planner, Architect, and Critic agree on the approach
- **No wasted execution**: Agents start with a clear, bounded task

### Good vs Bad Prompts

**Passes the gate** (specific enough for direct execution):
- `ralph fix the null check in src/hooks/bridge.ts:326`
- `autopilot implement issue #42`
- `team add validation to function processKeywordDetector`
- `ralph do:\n1. Add input validation\n2. Write tests\n3. Update README`
- `ultrawork add the user model in src/models/user.ts`

**Gated — redirected to ralplan** (needs scoping first):
- `ralph fix this`
- `autopilot build the app`
- `team improve performance`
- `ralph add authentication`
- `ultrawork make it better`

**Bypass the gate** (when you know what you want):
- `force: ralph refactor the auth module`
- `! autopilot optimize everything`

### When the Gate Does NOT Trigger

The gate auto-passes when it detects **any** concrete signal. You do not need all of them — one is enough:

| Signal Type | Example prompt | Why it passes |
|---|---|---|
| File path | `ralph fix src/hooks/bridge.ts` | References a specific file |
| Issue/PR number | `ralph implement #42` | Has a concrete work item |
| camelCase symbol | `ralph fix processKeywordDetector` | Names a specific function |
| PascalCase symbol | `ralph update UserModel` | Names a specific class |
| snake_case symbol | `team fix user_model` | Names a specific identifier |
| Test runner | `ralph npm test && fix failures` | Has an explicit test target |
| Numbered steps | `ralph do:\n1. Add X\n2. Test Y` | Structured deliverables |
| Acceptance criteria | `ralph add login - acceptance criteria: ...` | Explicit success definition |
| Error reference | `ralph fix TypeError in auth` | Specific error to address |
| Code block | `ralph add: \`\`\`ts ... \`\`\`` | Concrete code provided |
| Escape prefix | `force: ralph do it` or `! ralph do it` | Explicit user override |

### End-to-End Flow Example

1. User types: `ralph add user authentication`
2. Gate detects: execution keyword (`ralph`) + underspecified prompt (no files, functions, or test spec)
3. Gate redirects to **ralplan** with message explaining the redirect
4. Ralplan consensus runs:
   - **Planner** creates initial plan (which files, what auth method, what tests)
   - **Architect** reviews for soundness
   - **Critic** validates quality and testability
5. On consensus approval, user chooses execution path:
   - **ultragoal**: default durable follow-up for sequential goal execution with ledger checkpoints
   - **team**: coordinated parallel execution for stories that need multiple lanes, with evidence ready for Ultragoal checkpoints
   - **ralph**: explicit single-owner fallback only when the user intentionally wants a persistent verification/completion loop instead of the default durable goal ledger
6. Execution begins with a clear, bounded plan through the selected handoff path

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Gate fires on a well-specified prompt | Add a file reference, function name, or issue number to anchor the request |
| Want to bypass the gate | Prefix with `force:` or `!` (e.g., `force: ralph fix it`) |
| Gate does not fire on a vague prompt | The gate only catches prompts with <=15 effective words and no concrete anchors; add more detail or use `$ralplan` explicitly |
| Redirected to ralplan but want to skip planning | In the ralplan workflow, say "just do it" or "skip planning" to transition directly to execution |

## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.
