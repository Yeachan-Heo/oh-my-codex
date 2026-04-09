# CI speedup evidence after the prompt-worker teardown fix

Date: 2026-04-09

## Goal

Verify the post-fix CI speedups against the current workflow shape, keep required-check semantics stable, and avoid path-filter fragility.

## Required-check / trigger safety

- `.github/workflows/ci.yml` still triggers on `push` and `pull_request` for `main`, `dev`, and `experimental/dev`.
- The workflow does **not** use `paths:` or `paths-ignore:` filters, so protected-branch checks cannot be skipped into a permanently pending state.
- `CI Status` still gates the same required jobs:
  - `Rust Format`
  - `Rust Clippy`
  - `Lint`
  - `Typecheck`
  - `Test`
  - `Coverage Gate (Team Critical)`
  - `Coverage Report (TypeScript Full)`
  - `Coverage Report (Rust)`
  - `Ralph Persistence Gate`
  - `Build (Full Source Build)`

## Measured evidence

### Local measurements in this worktree

- `npm run build` → `7.47s`
- compiled `team-state-runtime` lane  
  `node dist/scripts/run-test-files.js dist/team/__tests__ dist/state/__tests__ dist/ralph/__tests__ dist/ralplan/__tests__ dist/runtime/__tests__`  
  → `103.70s` (`exit 1`, existing suite failures preserved)
- compiled `hooks-notify-platform` lane  
  `node dist/scripts/run-test-files.js dist/hooks/__tests__ dist/hooks/code-simplifier/__tests__ dist/hooks/extensibility/__tests__ dist/notifications/__tests__ dist/mcp/__tests__ dist/hud/__tests__ dist/verification/__tests__ dist/openclaw/__tests__`  
  → `31.75s` (`exit 1`, existing suite failures preserved)
- compiled `cli-core-rest` lane + catalog check  
  `node dist/scripts/run-test-files.js ... && node dist/scripts/generate-catalog-docs.js --check`  
  → `9.08s` (`exit 0`)

### Existing split-lane baseline already recorded by task 2

- `team-state-runtime` with per-lane rebuild → `103.52s`
- `hooks-notify-platform` with per-lane rebuild → `29.64s`
- `cli-core-rest` with per-lane rebuild → `9.72s`

## Interpretation

### 1) Splitting the Node 20 suite materially reduces test-tail latency

The old single `Test (Node 20 / full)` bottleneck is replaced by three deterministic grouped lanes plus the existing Node 22 smoke lane. This preserves required-check simplicity while turning one long opaque job into smaller, attributable lanes.

### 2) Build-once artifact reuse is still worthwhile for gated follow-on jobs

`build-dist` is still reused by:

- `Coverage Gate (Team Critical)`
- `Coverage Report (TypeScript Full)`
- `Ralph Persistence Gate`
- `Build (Full Source Build)`

Those lanes already wait on other prerequisites (`typecheck`, Rust gates, or both), so the shared `dist/` build can overlap that prerequisite time instead of being paid again inside each downstream job.

### 3) Reusing `build-dist` inside the split test matrix is **not** a clear wall-clock win

The local split-lane timings show that removing the in-lane rebuild does not materially improve the slowest test lane. Because the test matrix itself is the first gated consumer, forcing it to wait on `build-dist` would serialize the build ahead of all three split lanes and risks increasing the critical path. The evidence supports:

- keep split test lanes self-building
- keep artifact reuse on the downstream gated jobs that already have other prerequisites

## Verification commands used

- `npm run build`
- `npx tsc --noEmit`
- `npm run check:no-unused`
- `npm run lint`
- `node --test dist/verification/__tests__/ci-rust-gates.test.js dist/verification/__tests__/ralph-persistence-gate.test.js dist/cli/__tests__/package-bin-contract.test.js`
- `npm run test:ralph-persistence:compiled`
- timed grouped-lane commands listed above

## Outcome

The current repo is using the safer CI speedup shape:

1. no path-filtered required checks
2. split the Node 20 full test suite into deterministic grouped lanes
3. reuse `build-dist` only on downstream jobs where it can overlap prerequisite work

No evidence here justifies demoting `coverage-ts-full` from the required path.
