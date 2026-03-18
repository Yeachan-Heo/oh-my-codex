---
name: ai-slop-cleaner
description: Run an anti-slop cleanup/refactor/deslop workflow
---

# AI Slop Cleaner Skill

Reduce AI-generated slop with a regression-tests-first, smell-by-smell cleanup workflow that preserves behavior and raises signal quality.

## When to Use

Use this skill when:
- A code path works but feels bloated, noisy, repetitive, or over-abstracted
- A user asks to “cleanup”, “refactor”, or “deslop” AI-generated output
- Follow-up implementation left duplicate code, dead code, weak boundaries, missing tests, or unnecessary wrapper layers
- You need a disciplined cleanup workflow without broad rewrites

## GPT-5.4 Guidance Alignment

- Keep outputs concise and evidence-dense unless risk or the user requests more detail.
- Treat newer user instructions as local workflow updates without discarding earlier non-conflicting constraints.
- Keep using inspection, tests, diagnostics, and verification until the cleanup is grounded.
- Proceed automatically through clear, reversible cleanup steps; ask only when a choice materially changes scope or behavior.

## Scoped File Lists and Ralph Workflow

- This skill can accept a **file list scope** instead of a whole feature area.
- When the caller provides a changed-files list (for example, Ralph session-owned edits), keep the cleanup strictly bounded to those files.
- In the **Ralph workflow**, the mandatory deslop pass should run this skill on Ralph's changed files only, in standard mode unless the caller explicitly requests otherwise.

## Procedure

1. **Lock behavior with regression tests first**
   - Identify the behavior that must not change
   - Add or run targeted regression tests before editing cleanup candidates
   - If behavior is currently untested, create the narrowest test coverage needed first

2. **Create a cleanup plan before code**
   - List the specific smells to remove
   - Bound the pass to the requested files/scope
   - If a file list scope is provided, keep the pass restricted to that changed-files list
   - Order fixes from safest/highest-signal to riskiest
   - Do not start coding until the cleanup plan is explicit

3. **Categorize issues before editing**
   - **Duplication** — repeated logic, copy-paste branches, redundant helpers
   - **Dead code** — unused code, unreachable branches, stale flags, debug leftovers
   - **Needless abstraction** — pass-through wrappers, speculative indirection, single-use helper layers
   - **Boundary violations** — hidden coupling, leaky responsibilities, wrong-layer imports or side effects
   - **Missing tests** — behavior not locked, weak regression coverage, gaps around edge cases

4. **Execute passes one smell at a time**
   - **Pass 1: Dead code deletion**
   - **Pass 2: Duplicate removal**
   - **Pass 3: Naming/error handling cleanup**
   - **Pass 4: Test reinforcement**
   - Re-run targeted verification after each pass
   - Avoid bundling unrelated refactors into the same edit set

5. **Run quality gates**
   - Regression tests stay green
   - Lint passes
   - Typecheck passes
   - Relevant unit/integration tests pass
   - Static/security scan passes when available
   - Diff stays minimal and scoped
   - No new abstractions or dependencies unless explicitly required

6. **Finish with an evidence-dense report**
   - Changed files
   - Simplifications made
   - Tests/diagnostics/build checks run
   - Remaining risks
   - Residual follow-ups or consciously deferred cleanup

## Output Format

```text
AI SLOP CLEANUP REPORT
======================

Scope: [files or feature area]
Behavior Lock: [targeted regression tests added/run]
Cleanup Plan: [bounded smells and order]

Passes Completed:
1. Pass 1: Dead code deletion - [concise fix]
2. Pass 2: Duplicate removal - [concise fix]
3. Pass 3: Naming/error handling cleanup - [concise fix]
4. Pass 4: Test reinforcement - [concise fix]

Quality Gates:
- Regression tests: PASS/FAIL
- Lint: PASS/FAIL
- Typecheck: PASS/FAIL
- Tests: PASS/FAIL
- Static/security scan: PASS/FAIL or N/A

Changed Files:
- [path] - [simplification]

Remaining Risks:
- [none or short deferred item]
```

## Scenario Examples

**Good:** The user says `continue` after tests already lock behavior and the next smell pass is clear. Continue with the next bounded cleanup pass.

**Good:** The user narrows the scope to a specific file after planning. Keep the regression-tests-first workflow, but apply the new scope locally.

**Bad:** Start rewriting architecture before protecting behavior with tests.

**Bad:** Collapse multiple smell categories into one large refactor with no intermediate verification.
