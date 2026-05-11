# GPT-5.5 Prompt Guidance Contract

Status: contributor-facing contract for OMX prompt and orchestration surfaces.

## Purpose

This document explains the active **behavioral prompt contract** for OMX after Issue [#2007](https://github.com/Yeachan-Heo/oh-my-codex/issues/2007): align prompt and instruction surfaces with OpenAI's official [GPT-5.5 prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance) while preserving OMX product contracts.

Use it when you edit any of these surfaces:

- `AGENTS.md` when a repo chooses to track a project-root copy
- `templates/AGENTS.md`
- canonical XML-tagged role prompt surfaces in `prompts/*.md`
- workflow skill instructions in `skills/*/SKILL.md`
- hook/generator prompt guidance and regression tests under `src/hooks/` and `src/config/`

## Scope and current source of truth

The current prompt sources in this repository live in **`prompts/*.md`** and **`skills/*/SKILL.md`**, then get installed to `~/.codex/prompts/`, `~/.codex/skills/`, and native agent wrappers. Treat the source markdown body as canonical; launcher-specific TOML or runtime wrappers should preserve the same behavior.

The GPT-5.5 contract is distributed across:

- orchestration surfaces: `templates/AGENTS.md` and any tracked project-root `AGENTS.md`
- shared fragments: `docs/prompt-guidance-fragments/*`
- canonical XML-tagged subagent role prompts: `prompts/*.md`
- workflow skills: `skills/*/SKILL.md`
- generated top-level Codex config guidance: `src/config/generator.ts`
- regression tests: `src/hooks/__tests__/prompt-guidance-*.test.ts`

## Workflow skill guidance dedupe

Workflow skills may use a compact reference to the shared workflow guidance pattern instead of repeating every GPT-5.5 bullet. That pattern must preserve: outcome-first framing, concise visible updates for multi-step work, scoped task-update overrides, evidence-backed validation, and explicit stop/escalation rules. Workflow-specific invariants such as state transitions, gates, cleanup, cancellation, and verification commands remain explicit in the owning skill.

### UltraQA adversarial e2e invariant

`$ultraqa` is an adversarial dynamic e2e workflow, not a shallow static QA checklist. Its skill guidance must require a generated scenario matrix, malicious/hostile user behavior modeling, useful temporary tests or harnesses, hostile edge cases such as malformed input, repeated interruptions, prompt injection, cancel/resume, stale state, dirty worktrees, hung commands, flaky tests, and misleading success output, plus a structured report with commands, failures, fixes, cleanup/rollback, residual risks, and evidence. Safety bounds must remain explicit: no destructive commands, no secret exfiltration, no unbounded runtime, and no untracked generated debris. Regression coverage in `src/hooks/prompt-guidance-contract.ts` and `src/hooks/__tests__/skill-guidance-contract.test.ts` should fail if UltraQA regresses to build/lint/typecheck/test-only guidance.

## Exact-model mini adaptation seam

OMX also has a narrow **instruction-composition seam** for subagents/workers whose **final resolved model** is exactly `gpt-5.4-mini`.
That seam is part of prompt delivery, but it is intentionally narrower than the general GPT-5.5 behavioral contract described below.

Contributor rules for that seam:

- Key mini-specific instruction adaptation off the **final resolved model string**, not off role name, lane, or default tier membership.
- Use **exact string equality** for `gpt-5.4-mini`; do not widen behavior to `gpt-5.5`, `gpt-5.4-mini-tuned`, or other variants.
- Keep one shared **inner role-instruction composition helper** as the source of truth for model-gated prompt adaptation.
- Keep `src/team/worker-bootstrap.ts` limited to **outer AGENTS/runtime wrapping**. It should wrap already-composed instructions, not own model-specific adaptation logic.
- Keep `src/team/role-router.ts` as a raw role-prompt loader unless a minimal plumbing change is unavoidable.

Primary implementation surfaces for this seam:

| Responsibility | Primary sources |
|---|---|
| shared inner prompt composition | `src/agents/native-config.ts`, `src/agents/__tests__/native-config.test.ts` |
| team runtime/scaling plumbing | `src/team/runtime.ts`, `src/team/scaling.ts`, associated runtime/scaling tests |
| outer wrapper boundary | `src/team/worker-bootstrap.ts`, `src/team/__tests__/worker-bootstrap.test.ts` |

## What this contract is — and is not

This contract is about **how OMX prompts should behave**. It is not the same thing as OMX's routing metadata.

- **Behavioral contract:** outcome-first defaults, concise collaboration style, low-risk follow-through, localized task updates, evidence-backed validation, and explicit stop rules.
- **Adjacent but separate routing layer:** role/tier/posture metadata such as `frontier-orchestrator`, `deep-worker`, and `fast-lane` in `src/agents/native-config.ts` and `docs/shared/agent-tiers.md`.

If you are changing prompt prose, use this document first. If you are changing routing metadata or native config overlays, use the routing docs/tests first.

## The 5 core GPT-5.5 patterns OMX should enforce

### 1. Outcome-first, success-criteria-led prompts

Contributors should describe the target result, success criteria, constraints, available evidence, expected output, and stop condition before adding process detail. Avoid process-heavy stacks unless the process is itself a product contract.

Representative locations:

| Surface | Evidence |
|---|---|
| shared fragments | `docs/prompt-guidance-fragments/core-operating-principles.md` |
| root orchestration | `templates/AGENTS.md` |
| core roles | `prompts/executor.md`, `prompts/planner.md`, `prompts/verifier.md` |
| contract tests | `src/hooks/prompt-guidance-contract.ts` and `src/hooks/__tests__/prompt-guidance-*.test.ts` |

Example prompt text:

> Default to outcome-first, quality-focused responses: identify the user's target result, success criteria, constraints, available evidence, expected output, and stop condition before adding process detail.

### 2. Concise personality/collaboration style with preambles for longer work

Keep tone and collaboration steering short. For multi-step or tool-heavy tasks, start with a brief visible preamble that acknowledges the request and names the first step; keep later updates brief and evidence-based.

Representative locations:

| Surface | Evidence |
|---|---|
| root orchestration | `templates/AGENTS.md` |
| executor/planner/verifier fragments | `docs/prompt-guidance-fragments/*-constraints.md` |
| core prompts | `prompts/executor.md`, `prompts/planner.md`, `prompts/verifier.md` |

### 3. Automatic follow-through on clear, low-risk, reversible next steps

Contributors should preserve the bias toward continuing useful work automatically instead of asking avoidable confirmation questions.

Example prompt text:

> Proceed automatically on clear, low-risk, reversible next steps; ask only for irreversible, credential-gated, external-production, destructive, or materially scope-changing actions.

Also preserve agent-owned safe runtime work:

> Do not ask or instruct humans to perform ordinary non-destructive, reversible actions; execute those safe reversible OMX/runtime operations and ordinary commands yourself.

### 4. Localized task-update overrides that preserve earlier non-conflicting instructions

Contributors should treat user updates as **scoped overrides**, not full prompt resets.

Example prompt text:

> Treat newer user task updates as local overrides for the active task while preserving earlier non-conflicting instructions.

Scenario examples for `continue`, `make a PR`, and `merge if CI green` reinforce this behavior in `prompts/executor.md`, `prompts/planner.md`, `prompts/verifier.md`, and related tests.

### 5. Evidence budgets, validation, and explicit stop rules

GPT-5.5 guidance favors enough retrieval/validation to answer correctly, then stopping. OMX prompts should continue tool use while correctness depends on repository inspection, official docs, diagnostics, tests, citations, or verification, but avoid extra loops that only improve phrasing or gather nonessential evidence.

For coding work, prompts should ask for concrete validation:

- targeted tests for changed behavior
- typecheck/lint/build checks when applicable
- a minimal smoke test when full validation is too expensive
- an explicit reason and next-best check when validation cannot run

Implementation plans should stay traceable: requirements, named files/resources/APIs, state transitions or data flow where relevant, validation commands, failure behavior, privacy/security considerations, and material open questions.

## Absolute-language rule

Use `MUST`, `NEVER`, `ALWAYS`, `only`, and similar absolute wording for true invariants: safety/security boundaries, side-effect constraints, required output fields, workflow state transitions, team/ralph gates, and product contracts. For judgment calls such as whether to search again, ask for clarification, or keep iterating, prefer decision rules and stop conditions.

## Active workflow terminal handoff contract

Prompt surfaces that control active workflows should describe terminal user-facing replies as explicit handoffs, not casual optional follow-ups.

Contributor rules:

1. Terminal active-workflow replies should name an explicit outcome such as `finished`, `blocked`, `failed`, `userinterlude`, or `askuserQuestion`.
2. Terminal replies should include the evidence or blocking reason that justifies that outcome.
3. Terminal replies should identify the handoff clearly: completed artifact, blocking dependency, failure recovery owner, or the single required question.
4. Terminal replies should not end in permission-seeking softeners such as `If you want, I can ...`, `If you'd like, I can ...`, or `Would you like me to continue?`.

This rule is specific to active workflow handoffs. Normal explanatory conversation outside an active workflow may still be conversational, but workflow-owned terminal replies must make the lifecycle state explicit.

## Orchestration sharpness rules for root AGENTS surfaces

When editing `templates/AGENTS.md`, any tracked root `AGENTS.md`, or other root orchestration guidance, keep the orchestration contract mode-driven and terse:

1. **Mode selection comes first.** Distinguish between `$deep-interview`, `$ralplan`, `$team`, and direct solo execution instead of blending them into one generic flow.
2. **Leader and worker responsibilities stay separate.** Leaders choose the mode, own verification, and integrate work; workers execute assigned slices and report blockers upward.
3. **Stop/escalate rules are explicit.** The prompt should say when to stop, when to escalate to the user, and when workers must escalate back to the leader.
4. **Output contract stays tight.** Default progress/final updates should be compact: current mode, action/result, and evidence or blocker/next step. Avoid repeating full-plan rationale unless the risk or decision changed.

## Relationship to the guidance schema

`docs/guidance-schema.md` defines the **section layout contract** for AGENTS and worker surfaces. This document defines the **behavioral wording contract** that should appear within those sections after the GPT-5.5 rollout.

Use both documents together:

- `docs/guidance-schema.md` for structure
- `docs/prompt-guidance-contract.md` for behavior

## Relationship to posture-aware routing

Posture-aware routing is real, but it is not the same contract as the GPT-5.5 behavior rollout. Keep these separate when editing docs and prompts:

| Topic | Primary sources |
|---|---|
| GPT-5.5 prompt behavior contract | `templates/AGENTS.md`, any tracked `AGENTS.md`, canonical XML-tagged role prompt surfaces in `prompts/*.md`, workflow skills in `skills/*/SKILL.md`, `src/config/generator.ts`, `src/hooks/__tests__/prompt-guidance-*.test.ts` |
| exact-model mini composition seam | `src/agents/native-config.ts`, `src/team/runtime.ts`, `src/team/scaling.ts`, `src/team/worker-bootstrap.ts`, targeted native/runtime/scaling/bootstrap tests |
| role/tier/posture routing | `README.md:133-179`, `docs/shared/agent-tiers.md`, `src/agents/native-config.ts` |

If a change only affects posture overlays or native agent metadata, document it in the routing docs rather than expanding this contract unnecessarily.

## Canonical role prompts vs specialized behavior prompts

The main role catalog is the installable specialized-agent set used by native agent generation and internal role prompt composition.

- Files like `prompts/executor.md`, `prompts/planner.md`, and `prompts/architect.md` are canonical XML-tagged role prompt surfaces.
- `prompts/sisyphus-lite.md` should be treated as a specialized worker-behavior prompt, not as a first-class main catalog role.
- Worker/runtime overlays may compose that behavior under worker protocol constraints without promoting it to the primary public role catalog.

## Contributor checklist for prompt changes

Before opening a PR that changes prompt text, confirm all of the following:

1. **Preserve the five core behaviors.** Your change should keep or strengthen outcome-first framing, concise collaboration/preambles, low-risk follow-through, scoped overrides, and evidence-backed validation/stop rules.
2. **Keep role-specific wording role-specific.** The phrasing can differ by role, but the behavior should stay semantically aligned.
3. **Update scenario examples when behavior changes.** If you change how prompts handle `continue`, `make a PR`, or `merge if CI green`, update the prompt examples and related tests.
4. **Keep the mini-only seam exact and centralized.** If you touch mini adaptation, gate it on the final resolved model with exact `gpt-5.4-mini` equality, keep the shared inner helper as the source of truth, and keep `worker-bootstrap.ts` wrapper-only.
5. **Do not confuse routing metadata with prompt behavior.** Posture/tier updates belong in routing docs/tests unless they also change prompt prose.
6. **Update regression coverage when the contract changes.** Start with `src/hooks/__tests__/prompt-guidance-contract.test.ts`, `prompt-guidance-wave-two.test.ts`, `prompt-guidance-scenarios.test.ts`, `prompt-guidance-catalog.test.ts`, `skill-guidance-contract.test.ts`, and `prompt-guidance-fragments.test.ts`; add native/runtime/scaling/bootstrap coverage when the mini-only seam changes.

## Validation workflow for contributors

For prompt-guidance edits, run at least:

```bash
npm run build
node --test \
  dist/hooks/__tests__/prompt-guidance-contract.test.js \
  dist/hooks/__tests__/prompt-guidance-wave-two.test.js \
  dist/hooks/__tests__/prompt-guidance-scenarios.test.js \
  dist/hooks/__tests__/prompt-guidance-catalog.test.js \
  dist/hooks/__tests__/skill-guidance-contract.test.js \
  dist/hooks/__tests__/prompt-guidance-fragments.test.js \
  dist/hooks/__tests__/explicit-terminal-stop-docs-contract.test.js
```

If you touch the exact-model `gpt-5.4-mini` composition seam, also run:

```bash
node --test \
  dist/agents/__tests__/native-config.test.js \
  dist/team/__tests__/runtime.test.js \
  dist/team/__tests__/scaling.test.js \
  dist/team/__tests__/worker-bootstrap.test.js
```

For broader prompt or skill changes, prefer the full suite:

```bash
npm test
```

## References

- Implementation issue: [#2007](https://github.com/Yeachan-Heo/oh-my-codex/issues/2007)
- Official source: [OpenAI GPT-5.5 prompt guidance](https://developers.openai.com/api/docs/guides/prompt-guidance)
- Prior rollout history: [#608](https://github.com/Yeachan-Heo/oh-my-codex/issues/608), [#611](https://github.com/Yeachan-Heo/oh-my-codex/pull/611), [#612](https://github.com/Yeachan-Heo/oh-my-codex/pull/612)
- Guidance schema: `docs/guidance-schema.md`
