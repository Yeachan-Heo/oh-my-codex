# Deep-interview Phase 1 transcript-style validation

Date: **2026-03-25**
Scope: manual transcript-style validation for the Phase 1 deep-interview questioning-strengthening pass.

This lane complements the deterministic contract tests. The deep-interview skill is an instruction surface rather than a compiled runtime, so this document validates the updated question-flow contract against representative prompts and checks that the interview now applies more pressure without dropping OMX invariants.

## Validation focus

The walkthrough below checks the four required axes:

1. question count pressure
2. depth pressure
3. assumption probing
4. follow-up pressure

It also rechecks preserved invariants:
- ambiguity gating remains present in the skill contract
- readiness gates still require explicit `Non-goals` and `Decision Boundaries`
- context snapshot / transcript / spec artifacts still exist
- execution handoff contracts still exist
- brownfield confirmation still cites discovered evidence

## Scenario 1 — greenfield CLI

**Prompt**
> I want to build a task management CLI.

**Expected Phase 1 flow after this change**

1. **Round 1**
   - Assistant: asks why the user wants the CLI and what failure in the current workflow triggered the request.
2. **Round 2**
   - User: explains they keep forgetting ad-hoc tasks across repos.
   - Assistant: follows the same seam and asks which assumption makes a CLI better than a calendar/reminder flow.
3. **Round 3**
   - User: says they need repo-local context and quick capture.
   - Assistant: asks what should stay explicitly out of scope for the first version.
4. **Round 4**
   - User: says no sync, no multi-user, no GUI.
   - Assistant: asks which tradeoff is unacceptable if fast capture conflicts with strict task structure.

**Pass criteria**
- Question count pressure: **PASS** — no crystallization before round 4.
- Depth pressure: **PASS** — round 2 pushes on the underlying assumption, not just features.
- Assumption probing: **PASS** — the CLI-vs-reminder assumption is challenged immediately.
- Follow-up pressure: **PASS** — the second question stays on the fresh seam instead of summarizing early.

## Scenario 2 — brownfield auth change

**Prompt**
> I need to change auth in this brownfield app.

**Expected Phase 1 flow after this change**

1. **Preflight**
   - Assistant gathers codebase evidence first.
2. **Round 1**
   - Assistant: asks an evidence-backed confirmation question such as “I found token-refresh handling in `src/auth/session.ts`. Should this change follow that pattern or replace it?”
3. **Round 2**
   - User: says replace it because refresh loops hide the real failure.
   - Assistant: asks what evidence shows the loop is the root cause rather than a symptom.
4. **Round 3**
   - User: says refresh retries hide upstream 401 churn.
   - Assistant: asks what decision boundary OMX may take without confirmation if the fix requires touching both middleware and session storage.
5. **Round 4**
   - User: answers the ownership boundary.
   - Assistant: asks which auth behaviors must remain explicitly out of scope.

**Pass criteria**
- Question count pressure: **PASS** — the interview keeps pressing after the initial brownfield confirmation.
- Depth pressure: **PASS** — round 2 forces root-cause evidence rather than accepting the replacement claim.
- Assumption probing: **PASS** — unsupported brownfield claims are challenged directly.
- Follow-up pressure: **PASS** — each answer generates a narrower next question before moving on.
- Brownfield invariant: **PASS** — questioning stays evidence-backed instead of abstract.

## Scenario 3 — ambiguous workflow request

**Prompt**
> Improve onboarding for first-time contributors.

**Expected Phase 1 flow after this change**

1. **Round 1**
   - Assistant: asks what concrete contributor failure or abandonment signal motivated the request.
2. **Round 2**
   - User: says new contributors get lost during setup.
   - Assistant: asks what assumption makes setup the real blocker instead of docs discoverability or review latency.
3. **Round 3**
   - User: says most drop-offs happen before the first successful local run.
   - Assistant: uses Simplifier mode and asks what the smallest first-time-contributor success outcome is.
4. **Round 4**
   - User: says “get the app running and submit one trivial PR.”
   - Assistant: asks which decision boundary OMX may choose alone versus what must be escalated for approval.

**Pass criteria**
- Question count pressure: **PASS** — the flow survives at least four rounds before any handoff.
- Depth pressure: **PASS** — the blocker claim is challenged before solution shaping.
- Assumption probing: **PASS** — the assistant tests whether setup is truly the dominant failure mode.
- Follow-up pressure: **PASS** — each answer is tightened into the next boundary-setting question.

## Preserved-invariant recheck

| Invariant | Evidence | Result |
|---|---|---|
| Ambiguity scoring | `skills/deep-interview/SKILL.md` retains the greenfield/brownfield weighting formulas | PASS |
| Readiness gates | `Non-goals` and `Decision Boundaries` remain mandatory | PASS |
| Snapshot / transcript / spec artifacts | `.omx/context/`, `.omx/interviews/`, `.omx/specs/` outputs remain required | PASS |
| Handoff contracts | `$ralplan`, `$autopilot`, `$ralph`, `$team`, `Refine further` remain present | PASS |
| Brownfield evidence-backed confirmation | Execution policy + pressure ladder still require cited evidence before confirmation | PASS |

## Outcome

Manual contract-walk validation indicates Phase 1 now applies stronger pressure on all four axes while preserving OMX’s ambiguity gating, artifact generation, and handoff discipline. If later live usage still shows two or more weak axes, the PRD’s Phase 2 interviewer/crystallizer split should be reopened.
