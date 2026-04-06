# Prompt Token-Reduction Test Cases

This document covers the files changed by the token-reduction pass and the follow-up regression fixes:
- [AGENTS.md](../AGENTS.md)
- [templates/AGENTS.md](../templates/AGENTS.md)
- [prompts/information-architect.md](../prompts/information-architect.md)
- [prompts/product-analyst.md](../prompts/product-analyst.md)
- [prompts/product-manager.md](../prompts/product-manager.md)
- [prompts/quality-strategist.md](../prompts/quality-strategist.md)
- [prompts/ux-researcher.md](../prompts/ux-researcher.md)
- [src/cli/__tests__/ask.test.ts](../src/cli/__tests__/ask.test.ts)
- [src/cli/__tests__/explore.test.ts](../src/cli/__tests__/explore.test.ts)
- [src/cli/__tests__/launch-fallback.test.ts](../src/cli/__tests__/launch-fallback.test.ts)
- [src/cli/__tests__/session-search.test.ts](../src/cli/__tests__/session-search.test.ts)
- [src/cli/__tests__/sparkshell-packaging.test.ts](../src/cli/__tests__/sparkshell-packaging.test.ts)
- [src/cli/__tests__/team.test.ts](../src/cli/__tests__/team.test.ts)
- [src/cli/explore.ts](../src/cli/explore.ts)
- [src/session-history/search.ts](../src/session-history/search.ts)
- [crates/omx-explore/src/main.rs](../crates/omx-explore/src/main.rs)

## Why this exists

The prompt surfaces were shortened to reduce token usage, but the first pass removed or reshaped wording that the contract tests still depended on. The follow-up fixes restored the required behavior in minimal form and hardened the tests so they no longer depend on brittle raw path strings or timing-sensitive assertions.

## Validation Order

Use this order when checking the change set:

1. Run the repository checks from the contributing guide: install, lint, build, and full test suite.
2. Run the prompt-guidance contract tests after build.
3. Run the file-specific regression tests for ask, explore, launch fallback, session search, sparkshell packaging, and team.
4. Inspect the updated prompt files for readability and for the required contract phrases.

## Required Checks

### Prompt-guidance contract tests

Run the focused contract suite after build:

```bash
npm run build
node --test \
  dist/hooks/__tests__/prompt-guidance-contract.test.js \
  dist/hooks/__tests__/prompt-guidance-wave-two.test.js \
  dist/hooks/__tests__/prompt-guidance-scenarios.test.js \
  dist/hooks/__tests__/prompt-guidance-catalog.test.js
```

Expected result:
- Exit code 0.
- No missing required guidance-pattern errors.

### Root and template AGENTS checks

These checks verify that the root operating contract and the template stay aligned after trimming:

```bash
node --test dist/hooks/__tests__/prompt-guidance-contract.test.js
diff -u AGENTS.md templates/AGENTS.md
```

Expected result:
- The root and template files only differ where the template intentionally carries reusable copy.
- No accidental removal of required sections such as keyword detection, execution protocol, verification, or model routing.

### Prompt catalog checks

These checks validate the shortened role prompts:

```bash
node --test dist/hooks/__tests__/prompt-guidance-catalog.test.js
```

Expected result:
- The changed prompts still contain the required contract phrases and remain structurally complete.

## File-Specific Test Cases

### TC-ASK-001: Ask artifact path remains correct on non-root working directories

File: [src/cli/__tests__/ask.test.ts](../src/cli/__tests__/ask.test.ts)

What changed:
- The test now resolves both the temporary working directory and the generated artifact path before checking the artifact location.
- The raw `startsWith` check on the original temp path was replaced with a real-path comparison.

Why it changed:
- Temporary paths can be represented differently by the filesystem on different platforms.
- The new check verifies the actual location of the artifact instead of depending on one string form of the temp directory.

What to run:

```bash
node --test dist/cli/__tests__/ask.test.js
```

Expected result:
- The test confirms that `omx ask` writes the artifact under the current working directory's `.omx/artifacts` tree.
- The test continues to verify the artifact content without exposing any environment-specific paths.

### TC-ASK-002: Ask command preserves output and exit code behavior

File: [src/cli/__tests__/ask.test.ts](../src/cli/__tests__/ask.test.ts)

What changed:
- The existing contract tests were kept in place for stdout, stderr, and exit-code preservation.

Why it matters:
- The token-reduction work should not change command passthrough behavior.
- The ask CLI still needs to preserve child process output exactly when the advisor script exits non-zero.

What to run:

```bash
node --test dist/cli/__tests__/ask.test.js
```

Expected result:
- Stdout and stderr are forwarded unchanged.
- The exit code matches the child process exit code.

### TC-EXP-001: Explore harness prefers the intended resolution path

File: [src/cli/explore.ts](../src/cli/explore.ts)

What changed:
- Repository checkouts now resolve the harness from source/repo state before falling back to cached native hydration.

Why it changed:
- The prior order could pick up stale cached binaries during local development.
- The new order keeps the behavior aligned with the checked-out repository being tested.

What to run:

```bash
node --test dist/cli/__tests__/explore.test.js
```

Expected result:
- The harness resolution tests continue to pass.
- The repository checkout path uses the intended local source behavior.

### TC-EXP-002: Explore tests use normalized temporary directories

File: [src/cli/__tests__/explore.test.ts](../src/cli/__tests__/explore.test.ts)

What changed:
- The test now resolves temporary directories to their real filesystem paths before asserting against them.
- The archive-name fixture logic was also made platform-aware instead of assuming a single packaged artifact name.

Why it changed:
- Raw temporary-directory strings can differ from the filesystem's canonical form.
- The test needed to validate behavior without depending on one platform's naming convention.

What to run:

```bash
node --test dist/cli/__tests__/explore.test.js
```

Expected result:
- Harness hydration and end-to-end explore tests pass on the current platform without path-prefix brittleness.

### TC-LAUNCH-001: Launch fallback ignores inherited tmux session markers

File: [src/cli/__tests__/launch-fallback.test.ts](../src/cli/__tests__/launch-fallback.test.ts)

What changed:
- The test now explicitly clears inherited tmux session marker variables in its child process environment.

Why it changed:
- Running tests from within tmux can accidentally force the CLI down the inside-tmux path, which is not what this fallback test is validating.
- The test should validate direct-launch fallback behavior when tmux is unavailable, without false noise from parent-shell state.

What to run:

```bash
node --test dist/cli/__tests__/launch-fallback.test.js
```

Expected result:
- The test passes without ENOENT tmux noise in stderr.
- The launch still verifies codex direct invocation and argument passthrough behavior.

### TC-SPARK-001: Sparkshell packaging scaffold tolerates missing cargo toolchains

File: [src/cli/__tests__/sparkshell-packaging.test.ts](../src/cli/__tests__/sparkshell-packaging.test.ts)

What changed:
- The test keeps all package metadata and script assertions.
- If the sparkshell build helper fails specifically because `cargo` is not installed, the staged-binary assertion path is skipped instead of failing the entire test.

Why it changed:
- The scaffold contract under test is package/script wiring, not host toolchain availability.
- Environments that do not have Rust installed should not fail this packaging-contract check for reasons unrelated to the npm package layout.

What to run:

```bash
node --test dist/cli/__tests__/sparkshell-packaging.test.js
```

Expected result:
- On hosts with cargo installed: staged binary checks run and pass.
- On hosts without cargo: metadata checks still run, and the test exits cleanly without a false packaging failure.

### TC-SEARCH-001: Session search handles canonical current-project filtering

File: [src/session-history/search.ts](../src/session-history/search.ts)

What changed:
- The `current` project filter now normalizes filesystem paths before matching.
- Filter comparisons tolerate canonical path aliases instead of requiring one exact raw string.

Why it changed:
- Session search previously failed when the current working directory appeared in a different canonical form.
- The new matching logic preserves the intended filter semantics while avoiding false negatives.

What to run:

```bash
node --test dist/cli/__tests__/session-search.test.js
```

Expected result:
- Session search still returns structured JSON results for matching transcripts.
- The `current` project filter works regardless of the filesystem alias used by the runtime.

### TC-TEAM-001: Team smoke test waits for the actual failed state

File: [src/cli/__tests__/team.test.ts](../src/cli/__tests__/team.test.ts)

What changed:
- The dead-worker smoke test no longer relies on a single fixed delay.
- It now polls until the failed phase is observable or the retry budget is exhausted.

Why it changed:
- A fixed sleep made the test timing-sensitive on slower runs.
- Polling checks the behavior that matters: whether the team state reaches the failed phase.

What to run:

```bash
node --test dist/cli/__tests__/team.test.js
```

Expected result:
- The smoke test passes consistently without depending on a specific sleep interval.

### TC-TEAM-002: Team state and routing remain intact after compression

Files:
- [AGENTS.md](../AGENTS.md)
- [templates/AGENTS.md](../templates/AGENTS.md)
- [src/hooks/__tests__/prompt-team-routing.test.ts](../src/hooks/__tests__/prompt-team-routing.test.ts)

What changed:
- The team-routing phrase in the root and template AGENTS files was restored in the exact form expected by the guardrail test.

Why it changed:
- The guardrail test checks for exact wording.
- The shorter wording still needs to preserve the implementation-role boundary that prevents worker misuse outside team mode.

What to run:

```bash
node --test dist/hooks/__tests__/prompt-team-routing.test.js
```

Expected result:
- The routing guardrail passes and the root/template wording remains aligned.

## Prompt Readability Checks

Targets:
- [prompts/information-architect.md](../prompts/information-architect.md)
- [prompts/product-analyst.md](../prompts/product-analyst.md)
- [prompts/product-manager.md](../prompts/product-manager.md)
- [prompts/quality-strategist.md](../prompts/quality-strategist.md)
- [prompts/ux-researcher.md](../prompts/ux-researcher.md)

Verify each file still contains:
- Role boundaries.
- Delegation or escalation rules.
- Tool guidance.
- Output contract.
- Anti-patterns and final checklist.

Also verify:
- The compressed text still includes the exact contract phrases required by the catalog tests.
- The files remain readable without long narrative introductions or filler prose.

## Pass/Fail Gate

Pass when all of the following are true:
- The repository checks pass.
- The prompt-guidance contract tests pass.
- The ask, explore, launch-fallback, session-search, sparkshell-packaging, team, and routing tests pass.
- The prompt files remain concise but still satisfy their contract requirements.
- The documentation describes what changed and why without exposing environment-specific details.

Fail when any condition breaks, then fix the specific regression and rerun the relevant checks.