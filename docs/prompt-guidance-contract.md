# GPT-5.4 Prompt Guidance Contract

Status: contributor-facing contract for OMX prompt and orchestration surfaces.

## Purpose

This document explains the **behavioral prompt contract** introduced by the GPT-5.4 guidance rollout in [#608](https://github.com/Yeachan-Heo/oh-my-codex/issues/608) and expanded in [#611](https://github.com/Yeachan-Heo/oh-my-codex/pull/611) and [#612](https://github.com/Yeachan-Heo/oh-my-codex/pull/612).

Use it when you edit any of these surfaces:

- `AGENTS.md`
- `templates/AGENTS.md`
- `prompts/*.md`
- generated top-level `developer_instructions` text in `src/config/generator.ts`

## Scope and current source of truth

Issue [#615](https://github.com/Yeachan-Heo/oh-my-codex/issues/615) uses examples like `src/prompts/role-planner.ts`, but the current prompt sources in this repository live in **`prompts/*.md`**, then get installed to `~/.codex/prompts/`.

The GPT-5.4 contract is currently distributed across:

- orchestration surfaces: `AGENTS.md`, `templates/AGENTS.md`
- role prompts: `prompts/*.md`
- generated top-level Codex config guidance: `src/config/generator.ts`
- regression tests: `src/hooks/__tests__/prompt-guidance-*.test.ts`

This document is the contributor-oriented index for those surfaces.

## What this contract is — and is not

This contract is about **how OMX prompts should behave**.
It is not the same thing as OMX's routing metadata.

- **Behavioral contract:** compact output defaults, automatic follow-through, localized task updates, persistent tool use, and evidence-backed completion.
- **Adjacent but separate routing layer:** role/tier/posture metadata such as `frontier-orchestrator`, `deep-worker`, and `fast-lane` in `src/agents/native-config.ts` and `docs/shared/agent-tiers.md`.

If you are changing prompt prose, use this document first.
If you are changing routing metadata or native config overlays, use the routing docs/tests first.

## The 4 core GPT-5.4 patterns OMX currently enforces

### 1. Compact, information-dense output by default

Contributors should preserve the default posture of concise outputs that still include the evidence needed to act safely.

Representative locations:

| Surface | Evidence |
|---|---|
| `AGENTS.md` | `AGENTS.md:29` |
| `templates/AGENTS.md` | `templates/AGENTS.md:29` |
| `prompts/executor.md` | `prompts/executor.md:47`, `prompts/executor.md:121` |
| `prompts/planner.md` | `prompts/planner.md:35`, `prompts/planner.md:79` |
| `prompts/verifier.md` | `prompts/verifier.md:29` |
| contract tests | `src/hooks/__tests__/prompt-guidance-contract.test.ts:15-19`, `src/hooks/__tests__/prompt-guidance-wave-two.test.ts:27-30`, `src/hooks/__tests__/prompt-guidance-catalog.test.ts:35-39` |

Example prompt text:

> - Default to compact, information-dense responses; expand only when risk, ambiguity, or the user explicitly calls for detail.
>
> - Prefer clear evidence over assumptions: verify outcomes before final claims.

### 2. Automatic follow-through on clear, low-risk, reversible next steps

Contributors should preserve the bias toward continuing useful work automatically instead of asking avoidable confirmation questions.

Representative locations:

| Surface | Evidence |
|---|---|
| `AGENTS.md` | `AGENTS.md:30` |
| `templates/AGENTS.md` | `templates/AGENTS.md:30` |
| `prompts/executor.md` | `prompts/executor.md:48`, `prompts/executor.md:139-143` |
| `prompts/planner.md` | `prompts/planner.md:36`, `prompts/planner.md:118-122` |
| release notes | `docs/release-notes-0.8.6.md:42-47` |
| contract tests | `src/hooks/__tests__/prompt-guidance-contract.test.ts:30-32`, `src/hooks/__tests__/prompt-guidance-scenarios.test.ts:13-33` |

Example prompt text:

> - Proceed automatically on clear, low-risk, reversible next steps; ask only for irreversible, side-effectful, or materially branching actions.
>
> **Good:** The user says `continue` after you already identified the next safe implementation step. Continue the current branch of work instead of asking for reconfirmation.

### 3. Localized task-update overrides that preserve earlier non-conflicting instructions

Contributors should treat user updates as **scoped overrides**, not full prompt resets.

Representative locations:

| Surface | Evidence |
|---|---|
| `AGENTS.md` | `AGENTS.md:31`, `AGENTS.md:300` |
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
| `AGENTS.md` | `AGENTS.md:32`, `AGENTS.md:288`, `AGENTS.md:297-301`, `AGENTS.md:307-308` |
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
| GPT-5.4 prompt behavior contract | `AGENTS.md`, `templates/AGENTS.md`, `prompts/*.md`, `src/config/generator.ts`, `src/hooks/__tests__/prompt-guidance-*.test.ts` |
| role/tier/posture routing | `README.md:133-179`, `docs/shared/agent-tiers.md:7-56`, `src/agents/native-config.ts:12-40` |

If a change only affects posture overlays or native agent metadata, document it in the routing docs rather than expanding this contract unnecessarily.

## Contributor checklist for prompt changes

Before opening a PR that changes prompt text, confirm all of the following:

1. **Preserve the four core behaviors.** Your change should keep or strengthen compact output, low-risk follow-through, scoped overrides, and grounded tool use/verification.
2. **Keep role-specific wording role-specific.** The phrasing can differ by role, but the behavior should stay semantically aligned.
3. **Update scenario examples when behavior changes.** If you change how prompts handle `continue`, `make a PR`, or `merge if CI green`, update the prompt examples and the related tests.
4. **Do not confuse routing metadata with prompt behavior.** Posture/tier updates belong in routing docs/tests unless they also change prompt prose.
5. **Update regression coverage when the contract changes.** Start with `src/hooks/__tests__/prompt-guidance-contract.test.ts`, `prompt-guidance-wave-two.test.ts`, `prompt-guidance-scenarios.test.ts`, and `prompt-guidance-catalog.test.ts`.

## Validation workflow for contributors

For prompt-guidance edits, run at least:

```bash
npm run build
node --test \
  dist/hooks/__tests__/prompt-guidance-contract.test.js \
  dist/hooks/__tests__/prompt-guidance-wave-two.test.js \
  dist/hooks/__tests__/prompt-guidance-scenarios.test.js \
  dist/hooks/__tests__/prompt-guidance-catalog.test.js
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
