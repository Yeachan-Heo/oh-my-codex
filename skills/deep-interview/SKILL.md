---
name: deep-interview
description: Socratic deep interview with mathematical ambiguity gating before execution
argument-hint: "<idea or vague description>"
---

<Purpose>
Deep Interview implements an Ouroboros-inspired Socratic clarification loop before planning or implementation. It turns vague ideas into explicit specifications by asking targeted questions, scoring ambiguity across weighted dimensions, and gating execution until clarity reaches a configurable threshold.
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
Execution quality is usually bottlenecked by requirement clarity. A single expansion pass often misses hidden assumptions. This workflow applies Socratic pressure + quantitative ambiguity scoring so orchestration modes begin with an explicit, testable spec.

Inspired by Ouroboros (https://github.com/Q00/ouroboros) and adapted for OMX conventions.
</Why_This_Exists>

<Depth_Profiles>
- **Quick (`--quick`)**: fast pre-PRD pass; target threshold `<= 0.30`; max rounds 5
- **Standard (`--standard`, default)**: full requirement interview; target threshold `<= 0.20`; max rounds 12
- **Deep (`--deep`)**: high-rigor exploration; target threshold `<= 0.15`; max rounds 20

If no flag is provided, use **Standard**.
</Depth_Profiles>

<Execution_Policy>
- Ask ONE question per round (never batch)
- Target the weakest clarity dimension each round
- Gather codebase facts via `explore` before asking user about internals
- When session guidance enables `USE_OMX_EXPLORE_CMD`, prefer `omx explore` for simple read-only brownfield fact gathering; keep ambiguous or non-shell-only investigation on the richer normal path and fall back normally if `omx explore` is unavailable.
- Always run a preflight context intake before the first interview question
- In Codex CLI, prefer `request_user_input` when available; if unavailable, fall back to concise plain-text one-question turns
- Re-score ambiguity after each answer and show progress transparently
- Do not hand off to execution while ambiguity remains above threshold unless user explicitly opts to proceed with warning
- Persist mode state for resume safety (`state_write` / `state_read`)
</Execution_Policy>

<Steps>

## Phase 0: Preflight Context Intake

1. Parse `{{ARGUMENTS}}` and derive a short task slug.
2. Attempt to load the latest relevant context snapshot from `.omx/context/{slug}-*.md`.
3. If no snapshot exists, create a minimum context snapshot with:
   - Task statement
   - Desired outcome
   - Known facts/evidence
   - Constraints
   - Unknowns/open questions
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

Target the lowest-scoring dimension:
- Goal Clarity
- Constraint Clarity
- Success Criteria Clarity
- Context Clarity (brownfield only)

### 2b) Ask the question
Use structured user-input tooling available in the runtime (`AskUserQuestion` / equivalent) and present:

```
Round {n} | Target: {weakest_dimension} | Ambiguity: {score}%

{question}
```

### 2c) Score ambiguity
Score each dimension in `[0.0, 1.0]` with justification + gap.

Greenfield: `ambiguity = 1 - (goal × 0.40 + constraints × 0.30 + criteria × 0.30)`

Brownfield: `ambiguity = 1 - (goal × 0.35 + constraints × 0.25 + criteria × 0.25 + context × 0.15)`

### 2d) Report progress
Show weighted breakdown table and next focus dimension.

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
- Goal / Constraints / Non-goals
- Testable acceptance criteria
- Assumptions exposed + resolutions
- Technical context findings
- Full or condensed transcript

## Phase 5: Execution Bridge

Present execution options after artifact generation:

1. **`$ralplan` (Recommended)**
   - Run consensus refinement on the spec:
   - `$plan --consensus --direct <spec-path>`
2. **`$autopilot`**
   - Use spec as high-clarity execution input
3. **`$ralph`**
   - Sequential persistence loop using spec/criteria
4. **`$team`**
   - Parallel coordinated execution using shared spec
5. **Refine further**
   - Continue interview loop for lower ambiguity

**IMPORTANT:** Deep-interview is a requirements mode. On handoff, invoke the selected skill. **Do NOT implement directly** inside deep-interview.

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
- [ ] Weakest-dimension targeting used
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
