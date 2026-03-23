---
name: build-fix
description: "Fix build and compilation errors (TypeScript, tsc, mypy, cargo check, etc.) with the smallest possible diff — no refactoring, no architectural changes, only what's needed to make the build pass. Use when a user says 'fix the build', 'build is broken', 'type errors', or the type checker reports failures. Verifies each fix does not introduce new errors."
---

# Build Fix Skill

Fix build and compilation errors quickly with minimal code changes. Get the build green without refactoring.

## When to Use

This skill activates when:
- User says "fix the build", "build is broken"
- TypeScript compilation fails
- the build command or type checker reports errors
- User requests "minimal fixes" for errors

## What It Does

## GPT-5.4 Guidance Alignment

- Default to concise, evidence-dense progress and completion reporting unless the user or risk level requires more detail.
- Treat newer user task updates as local overrides for the active workflow branch while preserving earlier non-conflicting constraints.
- If correctness depends on additional inspection, retrieval, execution, or verification, keep using the relevant tools until the build-fix workflow is grounded.
- Continue through clear, low-risk, reversible next steps automatically; ask only when the next step is materially branching, destructive, or preference-dependent.

Delegates to the `build-fixer` agent (STANDARD tier) to:

1. **Collect Errors**
   - Run the project's type check command (e.g., `tsc --noEmit`, `mypy`, `cargo check`, `go vet`)
   - Or run the project's build command to get build failures
   - Categorize errors by type and severity

2. **Fix Strategically**
   - Add type annotations where missing
   - Add null checks where needed
   - Fix import/export statements
   - Resolve module resolution issues
   - Fix linter errors blocking build

3. **Minimal Diff Strategy**
   - NO refactoring of unrelated code
   - NO architectural changes
   - NO performance optimizations
   - ONLY what's needed to make build pass

4. **Verify**
   - Run the project's type check command after each fix
   - Ensure no new errors introduced
   - Stop when build passes

## Command Guidance

- Prefer `omx sparkshell` for noisy build/typecheck runs, repository search/listing, and bounded read-only inspection when summary output is enough.
- Use raw shell when exact stdout/stderr, shell composition, dependency installation, or low-level debugging fidelity is required.
- If `omx sparkshell` returns incomplete, ambiguous, or `summary unavailable` output, retry with a more precise command or the raw shell immediately.

## Agent Delegation

```
delegate(
  role="build-fixer",
  tier="STANDARD",
  prompt="BUILD FIX TASK

Fix all build and TypeScript errors with minimal changes.

Requirements:
- Run tsc/build to collect errors
- Fix errors one at a time
- Verify each fix doesn't introduce new errors
- NO refactoring, NO architectural changes
- Stop when build passes

Output: Build error resolution report with:
- List of errors fixed
- Lines changed per fix
- Final build status"
)
```

## Stop Conditions

The build-fixer agent stops when:
- Type check command exits with code 0
- Build command completes successfully
- No new errors introduced

## Output Format

```
BUILD FIX REPORT
================

Errors Fixed: 12
Files Modified: 8
Lines Changed: 47

Fixes Applied:
1. src/utils/validation.ts:15 - Added return type annotation
2. src/components/Header.tsx:42 - Added null check for props.user
3. src/api/client.ts:89 - Fixed import path for axios
...

Final Build Status: ✓ PASSING
Verification: [type check command] (exit code 0)
```

## Best Practices

- **One fix at a time** - Easier to verify and debug
- **Minimal changes** - Don't refactor while fixing
- **Document why** - Comment non-obvious fixes
- **Test after** - Ensure tests still pass


## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.

## Use with Other Skills

Combine with other skills for comprehensive fixing:

**With Ultrawork:**
```
/ultrawork fix all build errors
```
Spawns multiple build-fixer agents in parallel for different files.

**With Ralph:**
```
/ralph fix the build
```
Keeps trying until build passes, even if it takes multiple iterations.

**With Team:**
```
/team "debug build failures and fix type errors"
```
Uses: explore → build-fixer → verifier workflow.
