---
name: ralplan
description: Alias for $plan --consensus
---

# Ralplan (Consensus Planning Alias)

Ralplan is a shorthand alias for `$plan --consensus`. It triggers iterative planning with Planner, Architect, and Critic agents until consensus is reached, with **RALPLAN-DR structured deliberation** (short mode by default, deliberate mode for high-risk work).

## Usage

```
$ralplan "task description"
```

## Flags

- `--interactive`: Enables user prompts at key decision points (draft review in step 2 and final approval in step 6). Without this flag the workflow runs fully automated — Planner → Architect → Critic loop — and outputs the final plan without asking for confirmation.
- `--deliberate`: Forces deliberate mode for high-risk work. Adds pre-mortem (3 scenarios) and expanded test planning (unit/integration/e2e/observability). Without this flag, deliberate mode can still auto-enable when the request explicitly signals high risk (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage).

## Usage with interactive mode

```
$ralplan --interactive "task description"
```

## Behavior

## GPT-5.4 Guidance Alignment

Use the shared workflow guidance pattern: concise, evidence-dense progress and completion reporting, local overrides for the active workflow branch, persistent inspection/verification while consensus planning depends on it, right-sized implementation/PRD shape, and automatic continuation for safe reversible steps. Ask only for material, destructive, or preference-dependent branches.

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
2. **User feedback** *(--interactive only)*: If `--interactive` is set, use `AskUserQuestion` to present the draft plan **plus the Principles / Drivers / Options summary** before review (Proceed to review / Request changes / Skip review). Otherwise, automatically proceed to review.
3. **Architect** reviews for architectural soundness and must provide the strongest steelman antithesis, at least one real tradeoff tension, and (when possible) synthesis — **await completion before step 4**. In deliberate mode, Architect should explicitly flag principle violations.
4. **Critic** evaluates against quality criteria — run only after step 3 completes. Critic must enforce principle-option consistency, fair alternatives, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. In deliberate mode, Critic must reject missing/weak pre-mortem or expanded test plan.
5. **Re-review loop** (max 5 iterations): Any non-`APPROVE` Critic verdict (`ITERATE` or `REJECT`) MUST run the same full closed loop:
   a. Collect Architect + Critic feedback
   b. Revise the plan with Planner
   c. Return to Architect review
   d. Return to Critic evaluation
   e. Repeat this loop until Critic returns `APPROVE` or 5 iterations are reached
   f. If 5 iterations are reached without `APPROVE`, present the best version to the user
6. On Critic approval *(--interactive only)*: If `--interactive` is set, use `AskUserQuestion` to present the plan with approval options (Approve and execute via ralph / Approve and implement via team / Request changes / Reject). Final plan must include ADR (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups), an explicit available-agent-types roster, concrete follow-up staffing guidance for both `ralph` and `team`, suggested reasoning levels by lane, explicit `omx team` / `$team` launch hints, and a concrete **team verification** path. Otherwise, output the final plan and stop.
7. *(--interactive only)* User chooses: Approve (ralph or team), Request changes, or Reject
8. *(--interactive only)* On approval: invoke `$ralph` for sequential execution or `$team` for parallel team execution with the explicit available-agent-types roster, reasoning-by-lane guidance, role/staffing allocation guidance, launch hints, and verification-path guidance from the approved plan -- never implement directly

> **Important:** Steps 3 and 4 MUST run sequentially. Do NOT issue both agent calls in the same parallel batch. Always await the Architect result before invoking Critic.

Follow the Plan skill's full documentation for consensus mode details.

## Pre-context Intake

Before consensus planning or execution handoff, ground the plan in canonical artifacts:

1. Derive a task slug from the request.
2. Gather the smallest necessary brownfield facts before planning. When session guidance enables `USE_OMX_EXPLORE_CMD`, prefer `omx explore` for simple read-only repository lookups with narrow, concrete prompts; otherwise use the richer normal explore path.
3. If ambiguity remains high after fact-gathering, run `$deep-interview --quick <task>` before continuing.
4. If the plan depends on official docs, version-aware framework guidance, best practices, or external dependency behavior, auto-delegate `researcher` before finalizing the planning handoff so execution does not start from repo-local recall alone.
5. For planning-for-implementation, the final approved plan MUST create, refresh, or explicitly revalidate one typed context pack at `.omx/context/context-<timestamp>-<slug>.json` and record it in a `Context Pack Outcome` section.
6. Keep the role meanings crisp and fixed in v1: `scope` for boundary/guardrail refs, `build` for implementation refs, and `verify` for proof refs. Do not invent extra roles; use tags only for optional topical cross-cuts.
7. Reuse before rebuild: if the latest pack for the same slug still matches the approved PRD/test-spec and the refs remain sufficient, revalidate it instead of regenerating it. Refresh only the stale entries.
8. Keep typed packs compact and machine-checkable: schema `omx-context-pack-v1`, JSON-first, with `schema`, `slug`, tool-generated `basis`, and `entries`. Each entry is ref-first: `path` and `roles` required; `label`, `selector`, `relationPath`, and `tags` optional when the internal context-tool can infer them.
9. Build the smallest useful pack first: usually 3-6 total refs covering `scope`, `build`, and `verify`, but widen the pack whenever the approved slice genuinely needs more grounding. Prefer shared multi-role entries over duplicated refs.
10. Use the internal planning context-tool to generate or update packs instead of hand-crafting JSON when possible. Add a `selector` only when the source should be excerpted instead of loaded whole; short sources stay direct file refs. Let default relation paths follow `plan -> bounds/implements/verifies` unless a custom path is more informative.
11. Minimal pack creation loop: choose `context-<timestamp>-<slug>.json`, add the smallest useful refs, use pack `query` to inspect role/tag views without materializing excerpts, use `view` once to verify selectors and excerpt sizing, save the approved `prd-*` plus matching `test-spec-*`, record the exact pack path in `Context Pack Outcome`, then run pack `sync` once as the final handoff-ready gate.
12. Use pack `status` as the read-only diagnostic when readiness is unclear; it must report the canonical lifecycle state without refreshing `basis`, indexes, or excerpts.
13. Use tags only when they create a useful alternate view such as `auth`, `migration`, or `api-contract`. Tags are optional cross-cuts across roles, and multiple tag filters intersect. Do not mirror a role or label into tags.
14. `sync` is the final gate: it refreshes `basis`, rewrites the markdown index, and fails until the pack covers `scope`, `build`, and `verify` against the current approved PRD/test-spec including the `Context Pack Outcome`. If the PRD, test spec, or outcome section changes after sync, rerun sync before handoff.
15. The generated markdown sibling is human-facing index output only. The tool generates it from the JSON pack as a scaffold with the pack summary, role views, tag views, ref index, query/view hints, and one optional `View Notes` block. It includes derived facts such as role counts, tag counts, selector-backed entry counts, and direct-file entry counts so executors can scan the pack before querying it. Planners may extend only `View Notes` when concise notes add value, especially for tag-driven cross-cuts. It is not a second contract and must not turn into a second brief or carry embedded excerpts.

Do not hand off to execution modes until this intake is complete; if urgency forces progress, explicitly document the risk tradeoffs.

## Pre-Execution Gate

### Why the Gate Exists

Execution modes (ralph, autopilot, team, ultrawork) spin up heavy multi-agent orchestration. When launched on a vague request like "ralph improve the app", agents have no clear target — they waste cycles on scope discovery that should happen during planning, often delivering partial or misaligned work that requires rework.

The ralplan-first gate intercepts underspecified execution requests and redirects them through the ralplan consensus planning workflow. This ensures:
- **Explicit scope**: A PRD defines exactly what will be built
- **Test specification**: Acceptance criteria are testable before code is written
- **Execution context**: the approved plan points execution at the exact `.omx/context/context-<timestamp>-<slug>.json` pack to load first
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
   - **ralph**: sequential execution with verification
   - **team**: parallel coordinated agents
6. Execution begins with a clear, bounded plan

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
