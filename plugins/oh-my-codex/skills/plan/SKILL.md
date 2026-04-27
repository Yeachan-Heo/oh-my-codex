---
name: plan
description: Strategic planning with optional interview workflow
---

<Purpose>
Plan creates comprehensive, actionable work plans through intelligent interaction. It auto-detects whether to interview the user (broad requests) or plan directly (detailed requests), and supports consensus mode (iterative Planner/Architect/Critic loop with RALPLAN-DR structured deliberation) and review mode (Critic evaluation of existing plans).
</Purpose>

<Use_When>
- User wants to plan before implementing -- "plan this", "plan the", "let's plan"
- User wants structured requirements gathering for a vague idea
- User wants an existing plan reviewed -- "review this plan", `--review`
- User wants multi-perspective consensus on a plan -- `--consensus`, "ralplan"
- Task is broad or vague and needs scoping before any code is written
</Use_When>

<Do_Not_Use_When>
- User wants autonomous end-to-end execution -- use `autopilot` instead
- User wants to start coding immediately with a clear task -- use `ralph` or delegate to executor
- User asks a simple question that can be answered directly -- just answer it
- Task is a single focused fix with obvious scope -- skip planning, just do it
</Do_Not_Use_When>

<Why_This_Exists>
Jumping into code without understanding requirements leads to rework, scope creep, and missed edge cases. Plan provides structured requirements gathering, expert analysis, and quality-gated plans so that execution starts from a solid foundation. The consensus mode adds multi-perspective validation for high-stakes projects.
</Why_This_Exists>

<Execution_Policy>
- Auto-detect interview vs direct mode based on request specificity
- Ask one question at a time during interviews -- never batch multiple questions
- Gather codebase facts via `explore` agent before asking the user about them
- When session guidance enables `USE_OMX_EXPLORE_CMD`, prefer `omx explore` for simple read-only repository lookups during planning; keep prompts narrow and concrete, and keep prompt-heavy or ambiguous planning work on the richer normal path and fall back normally if `omx explore` is unavailable.
- Plans must meet quality standards: 80%+ claims cite file/line, 90%+ criteria are testable
- Implementation step count must be right-sized to task scope; avoid defaulting to exactly five steps when the work is clearly smaller or larger
- Planning-for-implementation is not complete until the plan creates, refreshes, or explicitly revalidates the required context pack in `.omx/context/` and records it in a `Context Pack Outcome` section
- Use one canonical pack per approved plan. Do not split a handoff into per-role pack files
- Role meanings: `scope` carries boundary and guardrail refs, `build` carries implementation refs, and `verify` carries proof/acceptance refs
- Keep the role vocabulary fixed in v1. Do not invent extra roles; use tags only for optional topical cross-cuts
- Do not rebuild packs blindly. Reuse the latest pack for the same slug when it still matches the approved PRD/test-spec and the refs remain sufficient; otherwise refresh only the stale entries
- Make the pack minimal on purpose: usually 3-6 total refs covering `scope`, `build`, and `verify`, but add more whenever the approved slice genuinely needs more grounding
- Typed packs are compact JSON reference bundles, not mini-PRDs: use schema `omx-context-pack-v1` with `schema`, `slug`, tool-generated `basis`, and `entries`
- Each entry is ref-first: `path` and `roles` are required; `label`, `selector`, `relationPath`, and `tags` are optional when the internal context-tool can infer them
- Prefer one shared entry with multiple roles when the same source truly serves multiple purposes. Do not duplicate refs just to satisfy role checklists
- Tags are optional compact topical labels only. Use them for useful cross-cuts across roles, and remember that multiple tag filters intersect
- Use the internal planning context-tool to generate or update packs instead of hand-crafting JSON when possible; adding a single file should be as simple as providing its repo-relative path
- Minimal pack creation loop: choose `context-<timestamp>-<slug>.json`, add the smallest useful refs, let the context-tool infer defaults, use pack `query` to inspect role/tag views without materializing excerpts, use `view` once to verify selectors and excerpt sizing, save the approved `prd-<timestamp>-<slug>.md` plus matching `test-spec-<timestamp>-<slug>.md`, record the exact pack path in `Context Pack Outcome`, then run pack `sync` once as the final handoff-ready gate; legacy `prd-<slug>.md` / `test-spec-<slug>.md` remain readable
- Use pack `status` as the read-only diagnostic when readiness is unclear; it must report the canonical lifecycle state without refreshing `basis`, indexes, or excerpts
- `sync` is the final gate: it refreshes `basis`, rewrites the markdown index, and fails until the pack covers `scope`, `build`, and `verify` against the current approved PRD/test-spec including the `Context Pack Outcome`; if the PRD, test spec, or outcome section changes after sync, rerun sync before handoff
- Add a `selector` only when the source is too large to load wholesale; let short sources stay as direct file refs, let default relation paths follow `plan -> bounds/implements/verifies`, and let the tool generate the markdown sibling scaffold before adding any optional notes
- Consensus mode outputs the final plan by default; add `--interactive` to enable execution handoff
- Consensus mode uses RALPLAN-DR short mode by default; switch to deliberate mode with `--deliberate` or when the request explicitly signals high risk (auth/security, data migration, destructive/irreversible changes, production incident, compliance/PII, public API breakage)
- Apply the shared workflow guidance pattern: concise, evidence-dense progress and completion reporting, local overrides for the active workflow branch, persistent inspection/verification while the plan depends on it, and automatic continuation for safe reversible steps. Ask only for material, destructive, or preference-dependent branches.
</Execution_Policy>

<Steps>

### Mode Selection

| Mode | Trigger | Behavior |
|------|---------|----------|
| Interview | Default for broad requests | Interactive requirements gathering |
| Direct | `--direct`, or detailed request | Skip interview, generate plan directly |
| Consensus | `--consensus`, "ralplan" | Planner -> Architect -> Critic loop until agreement with RALPLAN-DR structured deliberation (short by default, `--deliberate` for high-risk); outputs plan by default |
| Consensus Interactive | `--consensus --interactive` | Same as Consensus but pauses for user feedback at draft and approval steps, then hands off to execution |
| Review | `--review`, "review this plan" | Critic evaluation of existing plan |

### Interview Mode (broad/vague requests)

1. **Classify the request**: Broad (vague verbs, no specific files, touches 3+ areas) triggers interview mode
2. **Ask one focused question** using `AskUserQuestion` for preferences, scope, and constraints
3. **Gather codebase facts first**: Before asking "what patterns does your code use?", spawn an `explore` agent to find out, then ask informed follow-up questions
4. **Build on answers**: Each question builds on the previous answer
5. **Consult Analyst** (THOROUGH tier) for hidden requirements, edge cases, and risks
6. **Create plan** when the user signals readiness: "create the plan", "I'm ready", "make it a work plan"

### Direct Mode (detailed requests)

1. **Quick Analysis**: Optional brief Analyst consultation
2. **Create plan**: Generate comprehensive work plan immediately
3. **Review** (optional): Critic review if requested

### Consensus Mode (`--consensus` / "ralplan")

**RALPLAN-DR modes**: **Short** (default, bounded structure) and **Deliberate** (for `--deliberate` or explicit high-risk requests). Both modes keep the same Planner -> Architect -> Critic sequence. The workflow auto-proceeds through planning steps (Planner/Architect/Critic) but outputs the final plan without executing.

1. **Planner** creates initial plan and a compact **RALPLAN-DR summary** before any Architect review. The summary **MUST** include:
   - **Principles** (3-5)
   - **Decision Drivers** (top 3)
   - **Viable Options** (>=2) with bounded pros/cons for each option
   - If only one viable option remains, an explicit **invalidation rationale** for the alternatives that were rejected
   - In **deliberate mode**: a **pre-mortem** (3 failure scenarios) and an **expanded test plan** covering **unit / integration / e2e / observability**
2. **User feedback** *(--interactive only)*: If running with `--interactive`, **MUST** use `AskUserQuestion` to present the draft plan **plus the RALPLAN-DR Principles / Decision Drivers / Options summary for early direction alignment** with these options:
   - **Proceed to review** — send to Architect and Critic for evaluation
   - **Request changes** — return to step 1 with user feedback incorporated
   - **Skip review** — go directly to final approval (step 7)
   If NOT running with `--interactive`, automatically proceed to review (step 3).
3. **Architect** reviews for architectural soundness using `ask_codex` with `agent_role: "architect"`. Architect review **MUST** include: strongest steelman counterargument (antithesis) against the favored option, at least one meaningful tradeoff tension, and (when possible) a synthesis path. In deliberate mode, Architect should explicitly flag principle violations. **Wait for this step to complete before proceeding to step 4.** Do NOT run steps 3 and 4 in parallel.
4. **Critic** evaluates against quality criteria using `ask_codex` with `agent_role: "critic"`. Critic **MUST** verify principle-option consistency, fair alternative exploration, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. Critic **MUST** explicitly reject shallow alternatives, driver contradictions, vague risks, or weak verification. In deliberate mode, Critic **MUST** reject missing/weak pre-mortem or missing/weak expanded test plan. Run only after step 3 is complete.
5. **Re-review loop** (max 5 iterations): If Critic rejects or iterates, execute this closed loop:
   a. Collect all feedback from Architect + Critic
   b. Pass feedback to Planner to produce a revised plan
   c. **Return to Step 3** — Architect reviews the revised plan
   d. **Return to Step 4** — Critic evaluates the revised plan
   e. Repeat until Critic approves OR max 5 iterations reached
   f. If max iterations reached without approval, present the best version to user via `AskUserQuestion` with note that expert consensus was not reached
6. **Apply improvements**: When reviewers approve with improvement suggestions, merge all accepted improvements into the plan file before proceeding. Final consensus output **MUST** include an **ADR** section with: **Decision**, **Drivers**, **Alternatives considered**, **Why chosen**, **Consequences**, **Follow-ups**. Specifically:
   a. Collect all improvement suggestions from Architect and Critic responses
   b. Deduplicate and categorize the suggestions
   c. Update the plan file in `.omx/plans/` with the accepted improvements (add missing details, refine steps, strengthen acceptance criteria, ADR updates, etc.)
   d. Note which improvements were applied in a brief changelog section at the end of the plan
   e. Before any execution handoff, derive an explicit **available-agent-types roster** from the known prompt catalog and add concrete **follow-up staffing guidance** for both `$ralph` and `$team` (recommended roles, counts, suggested reasoning levels by lane, and why each lane exists)
   f. For the `$team` path, add an explicit launch-hint block with concrete `omx team` / `$team` commands and a **team verification path** (what team proves before shutdown, what Ralph verifies after handoff)
   g. Before any implementation handoff, create, refresh, or explicitly revalidate the required context pack in `.omx/context/`, add a **Context Pack Outcome** section that names the exact pack path, and only then run the final pack `sync`. Use pack `status` only as a read-only diagnostic. Use explicit action wording: `created`, `refreshed`, or `revalidated`
   h. Use one compact typed pack with schema `omx-context-pack-v1` and a JSON-first shape: `schema`, `slug`, tool-generated `basis`, and `entries`. Keep role semantics crisp inside entry `roles`: `scope` for boundary refs, `build` for implementation refs, `verify` for proof refs. Prefer shared multi-role entries over duplicated refs, and do not invent extra roles in v1
   i. Generate or update the pack with the internal context-tool instead of hand-crafting JSON when possible. Each entry must at least name a repo-relative `path` and one or more `roles`; let the tool infer `label` and default `relationPath`, add tags only when they create a useful alternate topical view, and add a `selector` only for longer sources that should be excerpted
   j. Build the smallest useful pack first: one boundary/guardrail ref, the minimum build refs needed to implement now, and the minimum verify refs needed to prove done now. Only widen the pack when a concrete gap remains
   k. Treat the generated markdown sibling as a human index only. The tool generates the scaffold from the JSON pack first: pack summary, role views, tag views, ref index, query/view hints, and the optional `View Notes` block. That scaffold includes derived facts such as role counts, tag counts, selector-backed entry counts, and direct-file entry counts. Planners may extend only `View Notes` when concise notes add value, especially for tag-driven cross-cuts, while execution consumes the canonical JSON pack plus tag queries and materialized views; do not let the index turn into a second brief or pasted excerpt dump
   l. If the plan cannot name a valid pack path, emit only the valid v1 roles (`scope`, `build`, `verify`), or keep the pack compact, stop at plan revision rather than treating planning as complete
7. On Critic approval (with improvements applied): *(--interactive only)* If running with `--interactive`, use `AskUserQuestion` to present the plan with these options:
   - **Approve and execute** — proceed to implementation via ralph+ultrawork
   - **Approve and implement via team** — proceed to implementation via coordinated parallel team agents
   - **Request changes** — return to step 1 with user feedback
   - **Reject** — discard the plan entirely
   If NOT running with `--interactive`, output the final approved plan and stop. Do NOT auto-execute.
8. *(--interactive only)* User chooses via the structured `AskUserQuestion` UI (never ask for approval in plain text)
9. On user approval (--interactive only):
   - **Approve and execute**: **MUST** invoke `$ralph` with the approved plan path from `.omx/plans/` as context **plus the explicit available-agent-types roster, suggested reasoning levels, concrete role allocation guidance, and direct launch hints for Ralph follow-up work**. Do NOT implement directly. Do NOT edit source code files in the planning agent. The ralph skill handles execution via ultrawork parallel agents.
   - **Approve and implement via team**: **MUST** invoke `$team` with the approved plan path from `.omx/plans/` as context **plus the explicit available-agent-types roster, suggested reasoning levels, concrete staffing / worker-role allocation guidance, explicit `omx team` / `$team` launch hints, and the team verification path**. Do NOT implement directly. The team skill coordinates parallel agents across the staged pipeline for faster execution on large tasks.

### Review Mode (`--review`)

0. Treat review as a reviewer-only pass. The context that wrote the plan, cleanup proposal, or diff MUST NOT be the context that approves it.
1. Read plan file from `.omx/plans/`
2. Evaluate via Critic using `ask_codex` with `agent_role: "critic"`
3. For implementation-handoff plans, verify that a `Context Pack Outcome` section exists and references the required `.omx/context/context-<timestamp>-<slug>.json` pack and that the pack is a valid `omx-context-pack-v1` JSON artifact whose entries cover `scope`, `build`, and `verify`. Use pack `status` for read-only diagnostics and reject packless, stale, or invalid handoffs.
4. For cleanup/refactor/anti-slop work, verify that the artifact includes a cleanup plan, regression tests or an explicit test gap, smell-by-smell passes, and quality gates.
5. Return verdict: APPROVED, REVISE (with specific feedback), or REJECT (replanning required)
6. If the current context authored the artifact, hand the review to `/review`, `critic`, `quality-reviewer`, `security-reviewer`, or `verifier` as appropriate.

### Plan Output Format

Every plan includes:
- Requirements Summary
- Acceptance Criteria (testable)
- Implementation Steps (with file references)
- Adaptive step count sized to the actual scope (not a fixed five-step template)
- Risks and Mitigations
- Verification Steps
- Context Pack Outcome (exact `.omx/context/context-<timestamp>-<slug>.json` pack path for implementation handoff)
- Context Pack artifact reference (the external `omx-context-pack-v1` JSON and generated markdown index exist under `.omx/context/`; do not paste the pack JSON into the PRD)
- For consensus/ralplan: **RALPLAN-DR summary** (Principles, Decision Drivers, Options)
- For consensus/ralplan final output: **ADR** (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups)
- For consensus/ralplan execution handoff: **Available-Agent-Types Roster**, **Follow-up Staffing Guidance** (including suggested reasoning levels by lane), explicit `omx team` / `$team` **Launch Hints**, and **Team Verification Path**
- For deliberate consensus mode: **Pre-mortem (3 scenarios)** and **Expanded Test Plan** (unit/integration/e2e/observability)

Plans are saved to `.omx/plans/`. Drafts go to `.omx/drafts/`.
</Steps>

<Tool_Usage>
- Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools
- Use `AskUserQuestion` for preference questions (scope, priority, timeline, risk tolerance) -- provides clickable UI
- Use plain text for questions needing specific values (port numbers, names, follow-up clarifications)
- Use the `explore` agent (LOW tier, bounded quick pass) to gather codebase facts before asking the user
- Use `ask_codex` with `agent_role: "planner"` for planning validation on large-scope plans
- Use `ask_codex` with `agent_role: "analyst"` for requirements analysis
- Use `ask_codex` with `agent_role: "critic"` for plan review in consensus and review modes
- If ToolSearch finds no MCP tools or Codex is unavailable, fall back to equivalent OMX prompt agents -- never block on external tools
- **CRITICAL — Consensus mode agent calls MUST be sequential, never parallel.** Always await the Architect result before issuing the Critic call.
- In consensus mode, default to RALPLAN-DR short mode; enable deliberate mode on `--deliberate` or explicit high-risk signals (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage)
- In consensus mode with `--interactive`: use `AskUserQuestion` for the user feedback step (step 2) and the final approval step (step 7) -- never ask for approval in plain text. Without `--interactive`, auto-proceed through planning steps without pausing. Output the final plan without execution.
- In consensus mode with `--interactive`, on user approval **MUST** invoke `$ralph` for execution (step 9) -- never implement directly in the planning agent
- In consensus mode, execution follow-up handoff **MUST** include an explicit available-agent-types roster plus concrete staffing / role-allocation guidance grounded in that roster, suggested reasoning levels by lane, explicit `omx team` / `$team` launch hints, and a team verification path
</Tool_Usage>


## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.

<Examples>
<Good>
Adaptive interview (gathering facts before asking):
```
Planner: [spawns explore agent: "find authentication implementation"]
Planner: [receives: "Auth is in src/auth/ using JWT with passport.js"]
Planner: "I see you're using JWT authentication with passport.js in src/auth/.
         For this new feature, should we extend the existing auth or add a separate auth flow?"
```
Why good: Answers its own codebase question first, then asks an informed preference question.
</Good>

<Good>
Single question at a time:
```
Q1: "What's the main goal?"
A1: "Improve performance"
Q2: "For performance, what matters more -- latency or throughput?"
A2: "Latency"
Q3: "For latency, are we optimizing for p50 or p99?"
```
Why good: Each question builds on the previous answer. Focused and progressive.
</Good>

<Bad>
Asking about things you could look up:
```
Planner: "Where is authentication implemented in your codebase?"
User: "Uh, somewhere in src/auth I think?"
```
Why bad: The planner should spawn an explore agent to find this, not ask the user.
</Bad>

<Bad>
Batching multiple questions:
```
"What's the scope? And the timeline? And who's the audience?"
```
Why bad: Three questions at once causes shallow answers. Ask one at a time.
</Bad>

<Bad>
Presenting all design options at once:
```
"Here are 4 approaches: Option A... Option B... Option C... Option D... Which do you prefer?"
```
Why bad: Decision fatigue. Present one option with trade-offs, get reaction, then present the next.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- Stop interviewing when requirements are clear enough to plan -- do not over-interview
- In consensus mode, stop after 5 Planner/Architect/Critic iterations and present the best version
- Consensus mode outputs the plan by default; with `--interactive`, user can approve and hand off to ralph/team
- If the user says "just do it" or "skip planning", **MUST** invoke `$ralph` to transition to execution mode. Do NOT implement directly in the planning agent.
- Escalate to the user when there are irreconcilable trade-offs that require a business decision
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Plan has testable acceptance criteria (90%+ concrete)
- [ ] Plan references specific files/lines where applicable (80%+ claims)
- [ ] All risks have mitigations identified
- [ ] No vague terms without metrics ("fast" -> "p99 < 200ms")
- [ ] Plan saved to `.omx/plans/`
- [ ] Implementation handoff plans include a `Context Pack Outcome` section with the required `.omx/context/context-<timestamp>-<slug>.json` pack ref
- [ ] The handoff pack is a valid `omx-context-pack-v1` JSON artifact, its entries cover `scope`, `build`, and `verify`, and any generated markdown sibling stays index-only
- [ ] In consensus mode: RALPLAN-DR summary includes 3-5 principles, top 3 drivers, and >=2 viable options (or explicit invalidation rationale)
- [ ] In consensus mode final output: ADR section included (Decision / Drivers / Alternatives considered / Why chosen / Consequences / Follow-ups)
- [ ] In deliberate consensus mode: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability) included
- [ ] In consensus mode with `--interactive`: user explicitly approved before any execution; without `--interactive`: output final plan after Critic approval (no auto-execution)
</Final_Checklist>

<Advanced>
## Design Option Presentation

When presenting design choices during interviews, chunk them:

1. **Overview** (2-3 sentences)
2. **Option A** with trade-offs
3. [Wait for user reaction]
4. **Option B** with trade-offs
5. [Wait for user reaction]
6. **Recommendation** (only after options discussed)

Format for each option:
```
### Option A: [Name]
**Approach:** [1 sentence]
**Pros:** [bullets]
**Cons:** [bullets]

What's your reaction to this approach?
```

## Question Classification

Before asking any interview question, classify it:

| Type | Examples | Action |
|------|----------|--------|
| Codebase Fact | "What patterns exist?", "Where is X?" | Explore first, do not ask user |
| User Preference | "Priority?", "Timeline?" | Ask user via AskUserQuestion |
| Scope Decision | "Include feature Y?" | Ask user |
| Requirement | "Performance constraints?" | Ask user |

## Review Quality Criteria

| Criterion | Standard |
|-----------|----------|
| Clarity | 80%+ claims cite file/line |
| Testability | 90%+ criteria are concrete |
| Verification | All file refs exist |
| Specificity | No vague terms |

## Deprecation Notice

The separate `/planner`, `/ralplan`, and `/review` skills have been merged into `$plan`. All workflows (interview, direct, consensus, review) are available through `$plan`.
</Advanced>
