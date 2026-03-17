---
name: deep-interview
description: Socratic deep interview with mathematical ambiguity gating before execution
argument-hint: "[--quick|--standard|--deep] [--autoresearch] <idea or vague description>"
---

<Purpose>
Deep Interview is an intent-first Socratic clarification loop before planning or implementation. It turns vague ideas into execution-ready specifications by asking targeted questions about why the user wants a change, how far it should go, what should stay out of scope, and what OMX may decide without confirmation.
</Purpose>

<Use_When>
- The request is broad, ambiguous, or missing concrete acceptance criteria
- The user says "deep interview", "interview me", "ask me everything", "don't assume", or "ouroboros"
- The user wants to avoid misaligned implementation from underspecified requirements
- You need a requirements artifact before handing off to `ralplan`, `autopilot`, `ralph`, or `team`
</Use_When>

<Do_Not_Use_When>
- The request already has concrete file/symbol targets and clear acceptance criteria
- The user explicitly asks to skip planning/interview and execute immediately
- The user asks for lightweight brainstorming only (use `plan` instead)
- A complete PRD/plan already exists and execution should start
</Do_Not_Use_When>

<Why_This_Exists>
Execution quality is usually bottlenecked by intent clarity, not just missing implementation detail. A single expansion pass often misses why the user wants a change, where the scope should stop, which tradeoffs are unacceptable, and which decisions still require user approval. This workflow applies Socratic pressure + quantitative ambiguity scoring so orchestration modes begin with an explicit, testable, intent-aligned spec.
</Why_This_Exists>

<Depth_Profiles>
- **Quick (`--quick`)**: fast pre-PRD pass; target threshold `<= 0.30`; max rounds 5
- **Standard (`--standard`, default)**: full requirement interview; target threshold `<= 0.20`; max rounds 12
- **Deep (`--deep`)**: high-rigor exploration; target threshold `<= 0.15`; max rounds 20
- **Autoresearch (`--autoresearch`)**: same interview rigor as Standard, but specialized for `omx autoresearch` launch readiness and `.omx/specs/` mission/sandbox artifact handoff

If no flag is provided, use **Standard**.

<Mode_Flags>
- **`--autoresearch`**: switch the interview into autoresearch-intake mode for `omx autoresearch` handoff. In this mode, the interview should converge on a launch-ready research mission, write canonical artifacts under `.omx/specs/`, and preserve the explicit `refine further` vs `launch` boundary for downstream CLI intake.
</Mode_Flags>
</Depth_Profiles>

<Execution_Policy>
- Ask ONE question per round (never batch)
- Ask about intent and boundaries before implementation detail
- Target the weakest clarity dimension each round after applying the stage-priority rules below
- Gather codebase facts via `explore` before asking user about internals
- When session guidance enables `USE_OMX_EXPLORE_CMD`, prefer `omx explore` for simple read-only brownfield fact gathering; keep prompts narrow and concrete, and keep ambiguous or non-shell-only investigation on the richer normal path and fall back normally if `omx explore` is unavailable.
- Always run a preflight context intake before the first interview question
- Reduce user effort: ask only the highest-leverage unresolved question, and never ask the user for codebase facts that can be discovered directly
- For brownfield work, prefer evidence-backed confirmation questions such as "I found X in Y. Should this change follow that pattern?"
- In Codex CLI, prefer `request_user_input` when available; if unavailable, fall back to concise plain-text one-question turns
- Re-score ambiguity after each answer and show progress transparently
- Do not hand off to execution while ambiguity remains above threshold unless user explicitly opts to proceed with warning
- Do not crystallize or hand off while `Non-goals` or `Decision Boundaries` remain unresolved, even if the weighted ambiguity threshold is met
- Persist mode state for resume safety (`state_write` / `state_read`)
</Execution_Policy>

<Steps>

## Phase 0: Preflight Context Intake

1. Parse `{{ARGUMENTS}}` and derive a short task slug.
2. Attempt to load the latest relevant context snapshot from `.omx/context/{slug}-*.md`.
3. If no snapshot exists, create a minimum context snapshot with:
   - Task statement
   - Desired outcome
   - Stated solution (what the user asked for)
   - Probable intent hypothesis (why they likely want it)
   - Known facts/evidence
   - Constraints
   - Unknowns/open questions
   - Decision-boundary unknowns
   - Likely codebase touchpoints
4. Save snapshot to `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) and reference it in mode state.

## Phase 1: Initialize

1. Parse `{{ARGUMENTS}}` and depth profile (`--quick|--standard|--deep`).
2. Detect project context:
   - Run `explore` to classify **brownfield** (existing codebase target) vs **greenfield**.
   - For brownfield, collect relevant codebase context before questioning.
3. Initialize state via `state_write(mode="deep-interview")`:

```json
{
  "active": true,
  "current_phase": "deep-interview",
  "state": {
    "interview_id": "<uuid>",
    "profile": "quick|standard|deep",
    "type": "greenfield|brownfield",
    "initial_idea": "<user input>",
    "rounds": [],
    "current_ambiguity": 1.0,
    "threshold": 0.3,
    "max_rounds": 5,
    "challenge_modes_used": [],
    "codebase_context": null,
    "current_stage": "intent-first",
    "current_focus": "intent",
    "context_snapshot_path": ".omx/context/<slug>-<timestamp>.md"
  }
}
```

4. Announce kickoff with profile, threshold, and current ambiguity.

## Phase 2: Socratic Interview Loop

Repeat until ambiguity `<= threshold`, user exits with warning, or max rounds reached.

### 2a) Generate next question
Use:
- Original idea
- Prior Q&A rounds
- Current dimension scores
- Brownfield context (if any)
- Activated challenge mode injection (Phase 3)

Target the lowest-scoring dimension, but respect stage priority:
- **Stage 1 — Intent-first:** Intent, Outcome, Scope, Non-goals, Decision Boundaries
- **Stage 2 — Feasibility:** Constraints, Success Criteria
- **Stage 3 — Brownfield grounding:** Context Clarity (brownfield only)

Detailed dimensions:
- Intent Clarity — why the user wants this
- Outcome Clarity — what end state they want
- Scope Clarity — how far the change should go
- Constraint Clarity — technical or business limits that must hold
- Success Criteria Clarity — how completion will be judged
- Context Clarity — existing codebase understanding (brownfield only)

`Non-goals` and `Decision Boundaries` are mandatory readiness gates. Ask about them early and keep revisiting them until they are explicit.

### 2b) Ask the question
Use structured user-input tooling available in the runtime (`AskUserQuestion` / equivalent) and present:

```
Round {n} | Target: {weakest_dimension} | Ambiguity: {score}%

{question}
```

### 2c) Score ambiguity
Score each weighted dimension in `[0.0, 1.0]` with justification + gap.

Greenfield: `ambiguity = 1 - (intent × 0.30 + outcome × 0.25 + scope × 0.20 + constraints × 0.15 + success × 0.10)`

Brownfield: `ambiguity = 1 - (intent × 0.25 + outcome × 0.20 + scope × 0.20 + constraints × 0.15 + success × 0.10 + context × 0.10)`

Readiness gate:
- `Non-goals` must be explicit
- `Decision Boundaries` must be explicit
- If either gate is unresolved, continue interviewing even when weighted ambiguity is below threshold

### 2d) Report progress
Show weighted breakdown table, readiness-gate status (`Non-goals`, `Decision Boundaries`), and the next focus dimension.

### 2e) Persist state
Append round result and updated scores via `state_write`.

### 2f) Round controls
- Round 3+: allow explicit early exit with risk warning
- Soft warning at profile midpoint (e.g., round 3/6/10 depending on profile)
- Hard cap at profile `max_rounds`

## Phase 3: Challenge Modes (assumption stress tests)

Use each mode once when applicable:

- **Contrarian** (round 4+): challenge core assumptions
- **Simplifier** (round 6+): probe minimal viable scope
- **Ontologist** (round 8+ and ambiguity > 0.30): ask for essence-level reframing

Track used modes in state to prevent repetition.

## Phase 4: Crystallize Artifacts

When threshold is met (or user exits with warning / hard cap):

1. Write interview transcript summary to:
   - `.omx/interviews/{slug}-{timestamp}.md`  
     (kept for ralph PRD compatibility)
2. Write execution-ready spec to:
   - `.omx/specs/deep-interview-{slug}.md`

Spec should include:
- Metadata (profile, rounds, final ambiguity, threshold, context type)
- Context snapshot reference/path (for ralplan/team reuse)
- Clarity breakdown table
- Intent (why the user wants this)
- Desired Outcome
- In-Scope
- Out-of-Scope / Non-goals
- Decision Boundaries (what OMX may decide without confirmation)
- Constraints
- Testable acceptance criteria
- Assumptions exposed + resolutions
- Technical context findings
- Full or condensed transcript

### Autoresearch specialization

When the clarified task is specifically about `omx autoresearch`, or the skill is invoked with `--autoresearch`, keep the interview domain-specific and emit launch-consumable artifacts without skipping clarification.

- **Accepted seed inputs:** `topic`, `evaluator`, `keep-policy`, `slug`, existing mission draft text, and prior evaluator examples/templates
- **Required interview focus:** mission clarity, evaluator readiness, keep policy, slug/session naming, and whether the draft is ready to launch now or should refine further
- **Canonical artifact path:** `.omx/specs/deep-interview-autoresearch-{slug}.md`
- **Launch artifact bundle:** `.omx/specs/autoresearch-{slug}/mission.md`, `.omx/specs/autoresearch-{slug}/sandbox.md`, and `.omx/specs/autoresearch-{slug}/result.json`
- **Launch artifact directory:** `.omx/specs/autoresearch-{slug}/`
- **Required artifact sections:**
  - `Mission Draft`
  - `Evaluator Draft`
  - `Launch Readiness`
  - `Seed Inputs`
  - `Confirmation Bridge`
- **Required launch artifacts under `.omx/specs/autoresearch-{slug}/`:**
  - `mission.md`
  - `sandbox.md`
  - `result.json`
- **Launch-readiness rule:** mark the draft as **not launch-ready** while the evaluator command still contains placeholder markers such as `<...>`, `TODO`, `TBD`, `REPLACE_ME`, `CHANGEME`, or `your-command-here`
- **Structured result contract:** `result.json` should point to the draft + mission/sandbox artifacts and carry the finalized `topic`, `evaluatorCommand`, `keepPolicy`, `slug`, `launchReady`, and `blockedReasons` fields so `omx autoresearch` can consume it directly
- **Confirmation bridge:** after artifact generation, offer at least `refine further` and `launch`; do not launch detached tmux until the user explicitly confirms `launch`
- **Handoff rule:** downstream execution must preserve the clarified mission intent, evaluator expectations, decision boundaries, and launch-readiness status from this artifact rather than bypassing the draft review step

## Phase 5: Execution Bridge

Present execution options after artifact generation using explicit handoff contracts. Treat the deep-interview spec as the current requirements source of truth and preserve intent, non-goals, decision boundaries, acceptance criteria, and any residual-risk warnings across the handoff.

### 1. **`$ralplan` (Recommended)**
- **Input Artifact:** `.omx/specs/deep-interview-{slug}.md` (optionally accompanied by the transcript/context snapshot for traceability)
- **Invocation:** `$plan --consensus --direct <spec-path>`
- **Consumer Behavior:** Treat the deep-interview spec as the requirements source of truth. Do not repeat the interview by default; refine architecture/feasibility around the clarified intent and boundaries instead.
- **Skipped / Already-Satisfied Stages:** Requirements discovery, ambiguity clarification, and early intent-boundary elicitation
- **Expected Output:** Canonical planning artifacts under `.omx/plans/`, especially `prd-*.md` and `test-spec-*.md`
- **Best When:** Requirements are clear enough to stop interviewing, but architectural validation / consensus planning is still desirable
- **Next Recommended Step:** Use the approved planning artifacts with `$autopilot`, `$ralph`, or `$team` depending on the desired execution style

### 2. **`$autopilot`**
- **Input Artifact:** `.omx/specs/deep-interview-{slug}.md`
- **Invocation:** `$autopilot <spec-path>`
- **Consumer Behavior:** Use the deep-interview spec as the clarified execution brief. Preserve intent, non-goals, decision boundaries, and acceptance criteria as binding context for planning/execution.
- **Skipped / Already-Satisfied Stages:** Initial requirement discovery and ambiguity reduction
- **Expected Output:** Planning/execution progress, QA evidence, and validation artifacts produced by autopilot
- **Best When:** The clarified spec is already strong enough for direct planning + execution without an additional consensus gate
- **Next Recommended Step:** Continue through autopilot's execution/QA/validation flow; if coordination-heavy execution emerges, prefer a follow-up `$team` or `$ralph` lane as appropriate

### 3. **`$ralph`**
- **Input Artifact:** `.omx/specs/deep-interview-{slug}.md`
- **Invocation:** `$ralph <spec-path>`
- **Consumer Behavior:** Use the spec's acceptance criteria and boundary constraints as the persistence target. Do not reopen requirements discovery unless the user explicitly asks to refine further.
- **Skipped / Already-Satisfied Stages:** Requirement interview, ambiguity clarification, and initial scope-definition work
- **Expected Output:** Iterative execution progress and verification evidence tracked against the clarified criteria
- **Best When:** The task benefits from persistent sequential completion pressure and the user wants execution to keep moving until the criteria are satisfied or a real blocker exists
- **Next Recommended Step:** Continue Ralph's persistence loop; if work expands into coordination-heavy lanes, hand off to `$team` and keep Ralph for verification continuity

### 4. **`$team`**
- **Input Artifact:** `.omx/specs/deep-interview-{slug}.md`
- **Invocation:** `$team <spec-path>`
- **Consumer Behavior:** Treat the spec as shared execution context for coordinated parallel work. Preserve the clarified intent, non-goals, decision boundaries, and acceptance criteria as common lane constraints.
- **Skipped / Already-Satisfied Stages:** Requirement clarification and early ambiguity reduction
- **Expected Output:** Coordinated multi-agent execution against the shared spec, with evidence that can later feed a Ralph verification pass when appropriate
- **Best When:** The task is large, multi-lane, or blocker-sensitive enough to justify coordinated parallel execution instead of a single persistent loop
- **Next Recommended Step:** Follow the `team -> ralph` verification path when the coordinated execution phase finishes or needs a persistent verification/fix loop

### 5. **Refine further**
- **Input Artifact:** Existing transcript, context snapshot, and current spec draft
- **Invocation:** Continue the interview loop
- **Consumer Behavior:** Re-enter questioning to resolve the highest-leverage remaining uncertainty
- **Skipped / Already-Satisfied Stages:** None beyond already-captured context
- **Expected Output:** A lower-ambiguity spec with tighter boundaries and fewer unresolved assumptions
- **Best When:** Residual ambiguity is still too high, the user wants stronger clarity, or the above-threshold / early-exit warning indicates too much risk to proceed cleanly
- **Next Recommended Step:** Return to one of the execution handoff contracts above once the spec is sufficiently clarified

**Residual-Risk Rule:** If the interview ended via early exit, hard-cap completion, or above-threshold proceed-with-warning, explicitly preserve that residual-risk state in the handoff so the downstream skill knows it inherited a partially clarified brief.

**IMPORTANT:** Deep-interview is a requirements mode. On handoff, invoke the selected skill using the contract above. **Do NOT implement directly** inside deep-interview.

</Steps>

<Tool_Usage>
- Use `explore` for codebase fact gathering
- Use `request_user_input` / structured user-input tool for each interview round when available
- If structured question tools are unavailable, use plain-text single-question rounds and keep the same stage order
- Use `state_write` / `state_read` for resumable mode state
- Read/write context snapshots under `.omx/context/`
- Save transcript/spec artifacts under `.omx/interviews/` and `.omx/specs/`
</Tool_Usage>

<Escalation_And_Stop_Conditions>
- User says stop/cancel/abort -> persist state and stop
- Ambiguity stalls for 3 rounds (+/- 0.05) -> force Ontologist mode once
- Max rounds reached -> proceed with explicit residual-risk warning
- All dimensions >= 0.9 -> allow early crystallization even before max rounds
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Preflight context snapshot exists under `.omx/context/{slug}-{timestamp}.md`
- [ ] Ambiguity score shown each round
- [ ] Intent-first stage priority used before implementation detail
- [ ] Weakest-dimension targeting used within the active stage
- [ ] Challenge modes triggered at thresholds (when applicable)
- [ ] Transcript written to `.omx/interviews/{slug}-{timestamp}.md`
- [ ] Spec written to `.omx/specs/deep-interview-{slug}.md`
- [ ] Handoff options provided (`$ralplan`, `$autopilot`, `$ralph`, `$team`)
- [ ] No direct implementation performed in this mode
</Final_Checklist>

<Advanced>
## Suggested Config (optional)

```toml
[omx.deepInterview]
defaultProfile = "standard"
quickThreshold = 0.30
standardThreshold = 0.20
deepThreshold = 0.15
quickMaxRounds = 5
standardMaxRounds = 12
deepMaxRounds = 20
enableChallengeModes = true
```

## Resume

If interrupted, rerun `$deep-interview`. Resume from persisted mode state via `state_read(mode="deep-interview")`.

## Recommended 3-Stage Pipeline

```
deep-interview -> ralplan -> autopilot
```

- Stage 1 (deep-interview): clarity gate
- Stage 2 (ralplan): feasibility + architecture gate
- Stage 3 (autopilot): execution + QA + validation gate
</Advanced>

Task: {{ARGUMENTS}}
