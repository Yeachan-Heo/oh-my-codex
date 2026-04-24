# GPT-5.4 Prompt Guidance Contract

Status: contributor-facing contract for OMX prompt and orchestration surfaces.

## Purpose

This document explains the **behavioral prompt contract** introduced by the GPT-5.4 guidance rollout in [#608](https://github.com/Yeachan-Heo/oh-my-codex/issues/608) and expanded in [#611](https://github.com/Yeachan-Heo/oh-my-codex/pull/611) and [#612](https://github.com/Yeachan-Heo/oh-my-codex/pull/612).

Use it when you edit any of these surfaces:

- `AGENTS.md` when a repo chooses to track a project-root copy
- `templates/AGENTS.md`
- canonical XML-tagged role prompt surfaces in `prompts/*.md`
- generated top-level `developer_instructions` text in `src/config/generator.ts`

## Scope and current source of truth

Issue [#615](https://github.com/Yeachan-Heo/oh-my-codex/issues/615) uses examples like `src/prompts/role-planner.ts`, but the current prompt sources in this repository live in **`prompts/*.md`**, then get installed to `~/.codex/prompts/`.

The GPT-5.4 contract is currently distributed across:

- orchestration surfaces: `templates/AGENTS.md` and any tracked project-root `AGENTS.md`
- canonical XML-tagged subagent role prompt surfaces: `prompts/*.md`
- generated top-level Codex config guidance: `src/config/generator.ts`
- regression tests: `src/hooks/__tests__/prompt-guidance-*.test.ts`

In this repository, `prompts/*.md` remain the canonical source files even when their installed runtime form is injected into TOML or other launcher-specific wrappers. Treat the XML-tagged prompt body itself as the canonical role surface.

This document is the contributor-oriented index for those surfaces.

## Exact-model mini adaptation seam

OMX also has a narrow **instruction-composition seam** for subagents/workers whose **final resolved model** is exactly `gpt-5.4-mini`.
That seam is part of prompt delivery, but it is intentionally narrower than the general GPT-5.4 behavioral contract described below.

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

This contract is about **how OMX prompts should behave**.
It is not the same thing as OMX's routing metadata.

- **Behavioral contract:** quality-first intent-deepening defaults, automatic follow-through, localized task updates, persistent tool use, and evidence-backed completion.
- **Adjacent but separate routing layer:** role/tier/posture metadata such as `frontier-orchestrator`, `deep-worker`, and `fast-lane` in `src/agents/native-config.ts` and `docs/shared/agent-tiers.md`.

If you are changing prompt prose, use this document first.
If you are changing routing metadata or native config overlays, use the routing docs/tests first.

## The 4 core GPT-5.4 patterns OMX should now enforce

### 1. Quality-first, intent-deepening output by default

Contributors should preserve the default posture of quality-first outputs that dig deeper into intent, think one more step before asking, and still include the evidence needed to act safely.

Representative locations:

| Surface | Evidence |
|---|---|
| `templates/AGENTS.md` | `templates/AGENTS.md:29` |
| `prompts/executor.md` | `prompts/executor.md:47`, `prompts/executor.md:121` |
| `prompts/planner.md` | `prompts/planner.md:35`, `prompts/planner.md:79` |
| `prompts/verifier.md` | `prompts/verifier.md:29` |
| contract tests | `src/hooks/__tests__/prompt-guidance-contract.test.ts:15-19`, `src/hooks/__tests__/prompt-guidance-wave-two.test.ts:27-30`, `src/hooks/__tests__/prompt-guidance-catalog.test.ts:35-39` |

Example prompt text:

> - Default to quality-first, intent-deepening responses; think one more step before replying or asking for clarification, and use as much detail as needed for a strong result without empty verbosity.
>
> - More effort does not mean reflexive web/tool escalation; use tools when they materially improve the result.

### 2. Automatic follow-through on clear, low-risk, reversible next steps

Contributors should preserve the bias toward continuing useful work automatically instead of asking avoidable confirmation questions.

Representative locations:

| Surface | Evidence |
|---|---|
| `templates/AGENTS.md` | `templates/AGENTS.md:30` |
| `prompts/executor.md` | `prompts/executor.md:48`, `prompts/executor.md:139-143` |
| `prompts/planner.md` | `prompts/planner.md:36`, `prompts/planner.md:118-122` |
| release notes | `docs/release-notes-0.8.6.md:42-47` |
| contract tests | `src/hooks/__tests__/prompt-guidance-contract.test.ts:30-32`, `src/hooks/__tests__/prompt-guidance-scenarios.test.ts:13-33` |

Example prompt text:

> - Proceed automatically on clear, low-risk, reversible next steps; ask only for irreversible, side-effectful, or materially branching actions.
> - Do not ask or instruct humans to perform ordinary non-destructive, reversible actions; execute those safe reversible OMX/runtime operations and ordinary commands yourself.
> - Treat OMX runtime manipulation, state transitions, and ordinary command execution as agent responsibilities when they are safe and reversible.
>
> **Good:** The user says `continue` after you already identified the next safe implementation step. Continue the current branch of work instead of asking for reconfirmation.

### 3. Localized task-update overrides that preserve earlier non-conflicting instructions

Contributors should treat user updates as **scoped overrides**, not full prompt resets.

Representative locations:

| Surface | Evidence |
|---|---|
| `templates/AGENTS.md` | `templates/AGENTS.md:31`, `templates/AGENTS.md:300` |
| `src/config/generator.ts` | `src/config/generator.ts:77` |
| `prompts/executor.md` | `prompts/executor.md:49-50`, `prompts/executor.md:60`, `prompts/executor.md:141-147` |
| `prompts/planner.md` | `prompts/planner.md:37`, `prompts/planner.md:118-126` |
| `prompts/verifier.md` | `prompts/verifier.md:38`, `prompts/verifier.md:91-99` |
| contract tests | `src/hooks/__tests__/prompt-guidance-contract.test.ts:34-36`, `src/hooks/__tests__/prompt-guidance-wave-two.test.ts:27-30`, `src/hooks/__tests__/prompt-guidance-catalog.test.ts:35-39` |

Example prompt text:

> - Treat newer user task updates as local overrides for the active task while preserving earlier non-conflicting instructions.
>
> 4. If a newer user message updates only the current step or output shape, apply that override locally without discarding earlier non-conflicting instructions.

### 4. Persistent tool use, dependency-aware sequencing, and evidence-backed completion

Contributors should preserve the rule that prompts keep using tools when correctness depends on retrieval, diagnostics, tests, or verification. OMX should not stop at a plausible answer if proof is still missing.

Representative locations:

| Surface | Evidence |
|---|---|
| `templates/AGENTS.md` | `templates/AGENTS.md:32`, `templates/AGENTS.md:288`, `templates/AGENTS.md:297-301`, `templates/AGENTS.md:307-308` |
| `src/config/generator.ts` | `src/config/generator.ts:77` |
| `prompts/executor.md` | `prompts/executor.md:32-38`, `prompts/executor.md:45`, `prompts/executor.md:50`, `prompts/executor.md:101-109` |
| `prompts/planner.md` | `prompts/planner.md:47-53` |
| `prompts/verifier.md` | `prompts/verifier.md:26-30`, `prompts/verifier.md:34-38`, `prompts/verifier.md:91-99` |
| broader prompt catalog tests | `src/hooks/__tests__/prompt-guidance-wave-two.test.ts:33-43` |

Example prompt text:

> - Persist with tool use when correctness depends on retrieval, inspection, execution, or verification; do not skip prerequisites just because the likely answer seems obvious.
>
> Verification loop: identify what proves the claim, run the verification, read the output, then report with evidence.

## Active workflow terminal handoff contract

Prompt surfaces that control active workflows should describe terminal user-facing replies as explicit handoffs, not as casual optional follow-ups.

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

## Reinforcement pattern: scenario examples

OMX also uses **scenario-style examples** to make the contract concrete for "continue", "make a PR", and "merge if CI green" flows.
These examples reinforce the four core patterns above, but they are not a separate routing or reasoning system.

Representative locations:

- `prompts/executor.md:137-147`
- `prompts/planner.md:116-126`
- `prompts/verifier.md:89-99`
- `src/hooks/__tests__/prompt-guidance-scenarios.test.ts:13-33`
- `src/hooks/__tests__/prompt-guidance-wave-two.test.ts:45-61`

## Relationship to the guidance schema

`docs/guidance-schema.md` defines the **section layout contract** for AGENTS and worker surfaces.
This document defines the **behavioral wording contract** that should appear within those sections after the GPT-5.4 rollout.

Use both documents together:

- `docs/guidance-schema.md` for structure
- `docs/prompt-guidance-contract.md` for behavior

## Relationship to posture-aware routing

Posture-aware routing is real, but it is not the same contract as the GPT-5.4 behavior rollout.
Keep these separate when editing docs and prompts:

| Topic | Primary sources |
|---|---|
| GPT-5.4 prompt behavior contract | `templates/AGENTS.md`, any tracked `AGENTS.md`, canonical XML-tagged role prompt surfaces in `prompts/*.md`, `src/config/generator.ts`, `src/hooks/__tests__/prompt-guidance-*.test.ts` |
| exact-model mini composition seam | `src/agents/native-config.ts`, `src/team/runtime.ts`, `src/team/scaling.ts`, `src/team/worker-bootstrap.ts`, targeted native/runtime/scaling/bootstrap tests |
| role/tier/posture routing | `README.md:133-179`, `docs/shared/agent-tiers.md:7-56`, `src/agents/native-config.ts:12-40` |

If a change only affects posture overlays or native agent metadata, document it in the routing docs rather than expanding this contract unnecessarily.

## Canonical role prompts vs specialized behavior prompts

The main role catalog is the installable specialized-agent set used by native agent generation and internal role prompt composition.

- Files like `prompts/executor.md`, `prompts/planner.md`, and `prompts/architect.md` are canonical XML-tagged role prompt surfaces.
- `prompts/sisyphus-lite.md` should be treated as a specialized worker-behavior prompt, not as a first-class main catalog role.
- Worker/runtime overlays may compose that behavior under worker protocol constraints without promoting it to the primary public role catalog.

## Contributor checklist for prompt changes

Before opening a PR that changes prompt text, confirm all of the following:

1. **Preserve the four core behaviors.** Your change should keep or strengthen quality-first intent-deepening output, low-risk follow-through, scoped overrides, and grounded tool use/verification.
2. **Keep role-specific wording role-specific.** The phrasing can differ by role, but the behavior should stay semantically aligned.
3. **Update scenario examples when behavior changes.** If you change how prompts handle `continue`, `make a PR`, or `merge if CI green`, update the prompt examples and the related tests.
4. **Keep the mini-only seam exact and centralized.** If you touch mini adaptation, gate it on the final resolved model with exact `gpt-5.4-mini` equality, keep the shared inner helper as the source of truth, and keep `worker-bootstrap.ts` wrapper-only.
5. **Do not confuse routing metadata with prompt behavior.** Posture/tier updates belong in routing docs/tests unless they also change prompt prose.
6. **Update regression coverage when the contract changes.** Start with `src/hooks/__tests__/prompt-guidance-contract.test.ts`, `prompt-guidance-wave-two.test.ts`, `prompt-guidance-scenarios.test.ts`, and `prompt-guidance-catalog.test.ts`; add native/runtime/scaling/bootstrap coverage when the mini-only seam changes.

## Validation workflow for contributors

For prompt-guidance edits, run at least:

```bash
npm run build   # TypeScript build
node --test \
  dist/hooks/__tests__/prompt-guidance-contract.test.js \
  dist/hooks/__tests__/prompt-guidance-wave-two.test.js \
  dist/hooks/__tests__/prompt-guidance-scenarios.test.js \
  dist/hooks/__tests__/prompt-guidance-catalog.test.js \
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

- Implementation issue: [#608](https://github.com/Yeachan-Heo/oh-my-codex/issues/608)
- Documentation issue: [#615](https://github.com/Yeachan-Heo/oh-my-codex/issues/615)
- Rollout summary: `docs/release-notes-0.8.6.md:24-47`
- Guidance schema: `docs/guidance-schema.md`
