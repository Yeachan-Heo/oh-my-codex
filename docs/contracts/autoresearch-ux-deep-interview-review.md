# `omx autoresearch` deep-interview UX review notes

Date: 2026-03-17  
Reviewer lane: worker-3

## Scope reviewed

Compared the current implementation and operator-facing docs against:

- `.omx/plans/prd-autoresearch-ux-deep-interview.md`
- `.omx/plans/test-spec-autoresearch-ux-deep-interview.md`

Reviewed files:

- `src/cli/autoresearch.ts`
- `src/cli/autoresearch-guided.ts`
- `src/cli/__tests__/autoresearch-guided.test.ts`
- `src/cli/__tests__/autoresearch.test.ts`
- `skills/deep-interview/SKILL.md`
- `README.md`
- `docs/contracts/autoresearch-command-contract.md`
- in-progress contract-test delta from worker-2: `src/hooks/__tests__/deep-interview-contract.test.ts`

## Current status

**Status:** the PRD/test-spec behavior is not implemented on the reviewed branch yet.

Current code still reflects the older guided-init flow:

- `omx autoresearch` with no args enters `guidedAutoresearchSetup()` and immediately asks for a raw evaluator command.
- bare `init` still routes into that same guided path instead of an explicit novice compatibility bridge.
- there is no autoresearch-specific intake module, no canonical `.omx/specs/deep-interview-autoresearch-{slug}.md` artifact, and no confirm/refine launch gate.
- launch still happens immediately after guided setup returns.
- README/help/contract docs still describe the thin-supervisor runtime, but not the new novice deep-interview intake surface from this PRD.

## Evidence observed

### Code-path findings
- `src/cli/autoresearch.ts`
  - `parseAutoresearchArgs()` only recognizes no-arg guided mode, `init`, `--resume`, and `<mission-dir>`.
  - top-level `--topic/--evaluator/--keep-policy/--slug` seeded novice flags are not routed.
  - guided/init flows still call `spawnAutoresearchTmux()` immediately after mission creation.
- `src/cli/autoresearch-guided.ts`
  - `guidedAutoresearchSetup()` still prompts directly for `Evaluator command`.
  - no placeholder/readiness rejection exists beyond `parseSandboxContract()`.
  - no draft artifact is written under `.omx/specs/`.
- `skills/deep-interview/SKILL.md`
  - the generic execution bridge exists, but the autoresearch specialization section required by the PRD is absent on this branch.

### Test/doc alignment findings
- `src/cli/__tests__/autoresearch-guided.test.ts`
  - covers mission/scaffold creation and flag parsing for the older init/guided flow only.
- `src/cli/__tests__/autoresearch.test.ts`
  - still asserts the older `omx autoresearch init [--topic ...]` help surface and non-interactive `mission-dir is required` failure.
- worker-2 has an in-progress test addition that correctly starts locking the expected deep-interview specialization text in `src/hooks/__tests__/deep-interview-contract.test.ts`.

## PRD checklist assessment

### 1. Vague-goal novice intake without raw evaluator knowledge
**Fail on current branch.**
The first guided prompt still asks for a concrete evaluator shell command.

### 2. Autoresearch-specific deep-interview/refinement bridge
**Fail on current branch.**
No autoresearch-specific refinement loop or seeded novice bridge exists.

### 3. Canonical draft artifact at `.omx/specs/deep-interview-autoresearch-{slug}.md`
**Fail on current branch.**
No `.omx/specs/` draft artifact is generated.

### 4. Explicit `refine further` vs `launch` confirmation boundary
**Fail on current branch.**
Guided setup returns launch-ready mission data and tmux launch happens immediately.

### 5. Placeholder evaluator rejection before launch
**Fail on current branch.**
There is no blocked-pattern gate for placeholder evaluator commands.

### 6. Top-level seeded novice flags (`--topic`, `--evaluator`, `--keep-policy`, `--slug`)
**Fail on current branch.**
Those flags are not accepted at top level; only `init` parses them today.

### 7. Expert flows preserved (`<mission-dir>`, `init --flags`, `--resume`)
**Pass on current branch.**
Existing expert/runtime flows remain intact.

### 8. Bare `omx autoresearch init` documented as novice alias
**Fail on current branch.**
Bare `init` is routed into guided mode, but help/docs do not explain the compatibility semantics required by the PRD.

### 9. Non-interactive no-arg failure preserved
**Pass on current branch.**
The TTY guard still rejects no-arg non-interactive invocation.

### 10. Regression coverage for interview/draft/confirm path
**Fail on current branch.**
Those tests are not present yet.

## Documentation follow-ups once implementation lands

1. Update `README.md` with the new novice entry surfaces:
   - `omx autoresearch` as a deep-interview-style refinement flow
   - top-level seeded novice flags
   - explicit confirm-before-launch behavior
2. Update `docs/contracts/autoresearch-command-contract.md` to add:
   - canonical draft artifact path
   - launch-readiness placeholder rejection rules
   - confirm/refine bridge semantics
3. Extend `skills/deep-interview/SKILL.md` with the PRD-required `Autoresearch specialization` section and required artifact headings.
4. Keep help text explicit about the split between novice refinement mode and expert `init --flags` / `<mission-dir>` / `--resume` flows.

## Reviewer conclusion

This review lane can confirm the current branch preserves existing autoresearch runtime behavior, but it does **not** yet satisfy the deep-interview UX enhancement PRD. The most useful near-term review output is therefore this baseline gap assessment plus the documentation checklist above; once worker-1 lands the implementation, this file should be refreshed with a final pass/fail review and verification evidence.
