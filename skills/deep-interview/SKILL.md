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
- **Autoresearch (`--autoresearch`)**: same interview rigor as Standard, but specialized for `$autoresearch` mission readiness and `.omx/specs/` artifact handoff

If no flag is provided, use **Standard**.

<Mode_Flags>
- **`--autoresearch`**: switch the interview into autoresearch-intake mode for `$autoresearch` handoff. In this mode, the interview should converge on a validator-ready research mission, write canonical artifacts under `.omx/specs/`, and preserve the explicit `refine further` vs `launch` boundary for downstream skill intake.
</Mode_Flags>
</Depth_Profiles>

<Execution_Policy>
- Ask ONE question per round (never batch)
- Ask about intent and boundaries before implementation detail
- Target the weakest clarity dimension each round after applying the stage-priority rules below
- Treat every answer as a claim to pressure-test before moving on: the next question should usually demand evidence or examples, expose a hidden assumption, force a tradeoff or boundary, or reframe root cause vs symptom
- Do not rotate to a new clarity dimension just for coverage when the current answer is still vague; stay on the same thread until one layer deeper, one assumption clearer, or one boundary tighter
- Before crystallizing, complete at least one explicit pressure pass that revisits an earlier answer with a deeper, assumption-focused, or tradeoff-focused follow-up
- Gather codebase facts via `explore` before asking user about internals
- When session guidance enables `USE_OMX_EXPLORE_CMD`, prefer `omx explore` for simple read-only brownfield fact gathering; keep prompts narrow and concrete, and keep ambiguous or non-shell-only investigation on the richer normal path and fall back normally if `omx explore` is unavailable.
- Always run a preflight context intake before the first interview question
- If initial context is oversized or would exceed the prompt budget, do not paste or forward the raw payload into interview prompts; request and record a prompt-safe initial-context summary first
- The oversized initial-context summary gate is blocking: wait for the concise summary before ambiguity scoring, crystallizing artifacts, or any downstream execution handoff
- The summary must preserve goals, constraints, success criteria, non-goals, decision boundaries, and references to any full source documents so downstream consumers receive a prompt-safe but faithful context
- Keep total prompt payloads within a safe budget by summarizing or trimming retained history; preserve newest/highest-signal answers and never let raw oversized context crowd out the current question
- Reduce user effort: ask only the highest-leverage unresolved question, and never ask the user for codebase facts that can be discovered directly
- For brownfield work, prefer evidence-backed confirmation questions such as "I found X in Y. Should this change follow that pattern?"
- In Codex CLI, deep-interview uses `omx question` as the required OMX-owned structured questioning path for every interview round
- If you launch `omx question` in a background terminal, immediately wait for that background terminal to finish and read its JSON answer before scoring ambiguity, asking another round, or handing off
- If `omx question` is unavailable in the current runtime, treat that as a blocker/error for deep-interview rather than falling back to `request_user_input` or plain-text questioning
- Re-score ambiguity after each answer and show progress transparently
- Do not hand off to execution while ambiguity remains above threshold unless user explicitly opts to proceed with warning
- Do not crystallize or hand off while `Non-goals` or `Decision Boundaries` remain unresolved, even if the weighted ambiguity threshold is met
- Treat early exit as a safety valve, not the default success path
- Persist mode state for resume safety (`state_write` / `state_read`)
</Execution_Policy>

<Steps>

## Phase 0: Preflight Context Intake

1. Parse `{{ARGUMENTS}}` and derive a short task slug.
2. Attempt to load the latest relevant context snapshot from `.omx/context/{slug}-*.md`.
3. Check whether the provided initial context or loaded snapshot is too large for safe prompt use. If it is oversized, the first interview round must ask for a concise prompt-safe summary instead of scoring ambiguity or continuing to downstream handoff.
4. If no snapshot exists, create a minimum context snapshot with:
   - Task statement
   - Desired outcome
   - Stated solution (what the user asked for)
   - Probable intent hypothesis (why they likely want it)
   - Known facts/evidence
   - Constraints
   - Unknowns/open questions
   - Decision-boundary unknowns
   - Likely codebase touchpoints
   - Prompt-safe initial-context summary status (`not_needed`, `needed`, or `recorded`)
5. Save snapshot to `.omx/context/{slug}-{timestamp}.md` (UTC `YYYYMMDDTHHMMSSZ`) and reference it in mode state.

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

Repeat until ambiguity `<= threshold`, the pressure pass is complete, the readiness gates are explicit, the user exits with warning, or max rounds are reached.

### 2a) Generate next question
If the initial context is oversized and no prompt-safe summary has been recorded yet, the next question must be only a summary request. Do not score ambiguity, do not run readiness gates, and do not hand off to `$ralplan`, `$autopilot`, `$ralph`, or `$team` until that summary answer is captured.

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

Follow-up pressure ladder after each answer:
1. Ask for a concrete example, counterexample, or evidence signal behind the latest claim
2. Probe the hidden assumption, dependency, or belief that makes the claim true
3. Force a boundary or tradeoff: what would you explicitly not do, defer, or reject?
4. If the answer still describes symptoms, reframe toward essence / root cause before moving on

Prefer staying on the same thread for multiple rounds when it has the highest leverage. Breadth without pressure is not progress.

Detailed dimensions:
- Intent Clarity — why the user wants this
- Outcome Clarity — what end state they want
- Scope Clarity — how far the change should go
- Constraint Clarity — technical or business limits that must hold
- Success Criteria Clarity — how completion will be judged
- Context Clarity — existing codebase understanding (brownfield only)

`Non-goals` and `Decision Boundaries` are mandatory readiness gates. Ask about them early and keep revisiting them until they are explicit.

### 2b) Ask the question
Use OMX-owned structured questioning via `omx question` for every interview round (this is the required `AskUserQuestion` equivalent for deep-interview) and present:

```
Round {n} | Target: {weakest_dimension} | Ambiguity: {score}%

{question}
```

`omx question` payload guidance for interview rounds:
- Use canonical `type` values instead of authoring raw `multi_select` flags by hand. `type: "single-answerable"` is the default for one-path decisions; `type: "multi-answerable"` is the canonical shape for bounded multi-select rounds. The runtime will keep `multi_select` aligned with `type`.
- Use `single-answerable` when exactly one answer should drive the next branch, the options are mutually exclusive, or selecting more than one answer would blur the decision boundary. Typical cases: handoff lane selection, choosing the primary failure mode, or confirming which of several competing interpretations is correct.
- Use `multi-answerable` when multiple options may all be true at once and you need to capture a bounded set of coexisting constraints, non-goals, risks, or acceptance checks in one round. Typical cases: selecting all out-of-scope items, all success metrics that must hold, or all deployment constraints that apply together.
- If one selected option would immediately require a follow-up question to disambiguate the others, prefer a `single-answerable` round now and ask the follow-up next. Do not hide a branching interview tree inside one overloaded multi-select prompt.
- Keep interview options bounded and concrete. If the valid answers are already known, set `allow_other: false`; only leave `allow_other: true` when the interview genuinely needs one user-supplied option that cannot be enumerated in advance.
- Read answers structurally. For `single-answerable`, expect one decisive selection in `answer.value` plus `answer.selected_values`. For `multi-answerable`, treat `answer.selected_values` as the source of truth for all chosen constraints/non-goals and preserve the full set in the transcript/spec.

Canonical bounded single-choice payload:

```json
{
  "question": "Which execution lane should own this once the interview is complete?",
  "type": "single-answerable",
  "options": [
    {
      "label": "Plan first",
      "value": "ralplan",
      "description": "Need architecture and test-shape review before execution"
    },
    {
      "label": "Execute directly",
      "value": "autopilot",
      "description": "Requirements are already explicit enough for planning plus execution"
    },
    {
      "label": "Refine further",
      "value": "refine",
      "description": "Clarification is still needed before any handoff"
    }
  ],
  "allow_other": false,
  "other_label": "Other",
  "source": "deep-interview"
}
```

Canonical bounded multi-select payload:

```json
{
  "question": "Which non-goals must stay out of scope for the first pass?",
  "type": "multi-answerable",
  "options": [
    {
      "label": "No UI redesign",
      "value": "no-ui-redesign",
      "description": "Keep layout and styling unchanged"
    },
    {
      "label": "No new dependencies",
      "value": "no-new-dependencies",
      "description": "Work within the existing toolchain"
    },
    {
      "label": "No API contract changes",
      "value": "no-api-contract-changes",
      "description": "Preserve external request and response shapes"
    }
  ],
  "allow_other": false,
  "other_label": "Other",
  "source": "deep-interview"
}
```

Canonical answer-shape reminders:

```json
{
  "answer": {
    "kind": "option",
    "value": "ralplan",
    "selected_labels": ["Plan first"],
    "selected_values": ["ralplan"]
  }
}
```

```json
{
  "answer": {
    "kind": "multi",
    "value": ["no-new-dependencies", "no-api-contract-changes"],
    "selected_labels": ["No new dependencies", "No API contract changes"],
    "selected_values": ["no-new-dependencies", "no-api-contract-changes"]
  }
}
```

### 2c) Score ambiguity
Score each weighted dimension in `[0.0, 1.0]` with justification + gap.

Greenfield: `ambiguity = 1 - (intent × 0.30 + outcome × 0.25 + scope × 0.20 + constraints × 0.15 + success × 0.10)`

Brownfield: `ambiguity = 1 - (intent × 0.25 + outcome × 0.20 + scope × 0.20 + constraints × 0.15 + success × 0.10 + context × 0.10)`

Readiness gate:
- `Non-goals` must be explicit
- `Decision Boundaries` must be explicit
- A pressure pass must be complete: at least one earlier answer has been revisited with an evidence, assumption, or tradeoff follow-up
- If either gate is unresolved, or the pressure pass is incomplete, continue interviewing even when weighted ambiguity is below threshold

### 2d) Report progress
Show weighted breakdown table, readiness-gate status (`Non-goals`, `Decision Boundaries`), and the next focus dimension.

### 2e) Persist state
Append round result and updated scores via `state_write`.

### 2f) Round controls
- Do not offer early exit before the first explicit assumption probe and one persistent follow-up have happened
- Round 4+: allow explicit early exit with risk warning
- Soft warning at profile midpoint (e.g., round 3/6/10 depending on profile)
- Hard cap at profile `max_rounds`

## Phase 3: Challenge Modes (assumption stress tests)

Use each mode once when applicable. These are normal escalation tools, not rare rescue moves:

- **Contrarian** (round 2+ or immediately when an answer rests on an untested assumption): challenge core assumptions
- **Simplifier** (round 4+ or when scope expands faster than outcome clarity): probe minimal viable scope
- **Ontologist** (round 5+ and ambiguity > 0.25, or when the user keeps describing symptoms): ask for essence-level reframing

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
- Prompt-safe initial-context summary when oversized context was provided, plus references to any full source documents
- Clarity breakdown table
- Intent (why the user wants this)
- Desired Outcome
- In-Scope
- Out-of-Scope / Non-goals
- Decision Boundaries (what OMX may decide without confirmation)
- Constraints
- Testable acceptance criteria
- Assumptions exposed + resolutions
- Pressure-pass findings (which answer was revisited, and what changed)
- Brownfield evidence vs inference notes for any repository-grounded confirmation questions
- Technical context findings
- Full or condensed transcript

### Autoresearch specialization

When the clarified task is specifically about `$autoresearch`, or the skill is invoked with `--autoresearch`, keep the interview domain-specific and emit skill-consumable artifacts without skipping clarification.

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
- **Structured result contract:** `result.json` should point to the draft + mission/sandbox artifacts and carry the finalized `topic`, `evaluatorCommand`, `keepPolicy`, `slug`, `launchReady`, and `blockedReasons` fields so `$autoresearch` can consume it directly
- **Confirmation bridge:** after artifact generation, offer at least `refine further` and `launch`; do not run direct CLI launch or detached/split tmux launch, and only hand off to `$autoresearch` after explicit confirmation
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
- **Next Recommended Step:** Follow the team verification path when the coordinated execution phase finishes; escalate to a separate Ralph loop only when a later persistent verification/fix owner is still needed

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
- Use `omx question` as the OMX-native structured user-input tool for each interview round
- If `omx question` is unavailable in the current runtime, stop and surface that deep-interview requires the OMX question tool rather than falling back to another questioning path
- Use `state_write` / `state_read` for resumable mode state
- Read/write context snapshots under `.omx/context/`
- Record whether the oversized-context summary gate is not needed, pending, or satisfied before any scoring or handoff step
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
- [ ] Oversized initial context, if present, has a prompt-safe summary recorded before ambiguity scoring or downstream handoff
- [ ] Ambiguity score shown each round
- [ ] Intent-first stage priority used before implementation detail
- [ ] Weakest-dimension targeting used within the active stage
- [ ] At least one explicit assumption probe happened before crystallization
- [ ] At least one persistent follow-up / pressure pass deepened a prior answer
- [ ] Challenge modes triggered at thresholds (when applicable)
- [ ] Transcript written to `.omx/interviews/{slug}-{timestamp}.md`
- [ ] Spec written to `.omx/specs/deep-interview-{slug}.md`
- [ ] Brownfield questions use evidence-backed confirmation when applicable
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
