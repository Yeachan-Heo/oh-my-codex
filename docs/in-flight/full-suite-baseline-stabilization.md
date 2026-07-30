# Full-Suite Baseline Stabilization Lane

- Branch: `imyuntae/full-suite-baseline-stabilization`
- Worktree: `/Users/yuntae/orca/workspaces/oh-my-codex/full-suite-baseline-stabilization`
- Base: `origin/main@57f8e682af899b5d0e28d05b238c903c2fdeb913`
- Plan: [2026-07-30-full-suite-baseline-stabilization.md](../superpowers/plans/active/2026-07-30-full-suite-baseline-stabilization.md)
- Orca worktree id: `b6169913-0352-4117-9928-75864165958d::/Users/yuntae/orca/workspaces/oh-my-codex/full-suite-baseline-stabilization`

## Start evidence

- Nearest applicable `AGENTS.md`: `/Users/yuntae/AGENTS.md`; this lane has no repo-local `AGENTS.md`.
- `git fetch origin --prune` and explicit `origin/main` refresh completed.
- `HEAD`, `origin/main`, and merge-base: `57f8e682af899b5d0e28d05b238c903c2fdeb913`.
- `origin/main...HEAD`: `0 0`.
- Initial and post-marker tracked status: clean.
- Linked worktree: `.git` path differs from common dir; not the main checkout.
- Orca current worktree path/branch/baseRef match this lane and `refs/remotes/origin/main`.
- Worktree guard: `record`, `check`, and `resume` passed.
- Graph provenance sibling remained on `imyuntae/feature-graph-execution-provenance`; only read-only branch/status/handoff inspection was performed.

## Dependency hydration

- Node: `v20.19.4`; package engines: `>=20`; CI full-suite lane uses Node 20.
- npm: `11.4.2`.
- `npm ci`: PASS; 219 packages installed; prepare/build passed.
- npm audit reported 5 existing dependency vulnerabilities; no audit fix or dependency change was authorized or performed.

## Scope guard

- Reproduce and classify only the 13 user-named full-suite files.
- Fix only deterministic defects proven on clean `origin/main`, at the shared root cause, with TDD.
- Do not install tmux or global packages.
- Do not edit ignored local `AGENTS.md`, graph provenance code, global model/OMX state, or user custom settings.
- No push, PR, merge, deploy, release, OMX update, or EOD.

## Current status

- Task 1 targeted reproduction completed on clean `origin/main`.
- Task 2 classification completed: 4 PASS/not failing, 4 environment-only, 3 suite-interaction/flaky, 2 deterministic baseline defects.
- TDD RED evidence: existing `codex-native-hook` and `api-interop` assertions repeatedly fail on clean `origin/main`; GREEN pending.
- Task 3A plan correction: the initial one-line shared-helper reuse compiled but stayed RED on the first safe `env ... node dist/cli/omx.js` wrapper. It remains uncommitted while the exact-path wrapper proof is reviewed; no test was weakened.
- Known environment blocker: `tmux` is not installed; no installation is authorized.

## Task 1 reproduction evidence

The repo runner reported test concurrency 1 and per-file process isolation. The initial 13-file invocation was followed by one isolated invocation per file because the combined output did not preserve a complete matrix after the first failure.

```sh
node dist/scripts/run-test-files.js \
  dist/cli/__tests__/team.test.js \
  dist/notifications/__tests__/tmux.test.js \
  dist/team/__tests__/tmux-test-fixture.test.js \
  dist/hooks/__tests__/deep-interview-contract.test.js \
  dist/hooks/__tests__/team-runtime-gating-docs-contract.test.js \
  dist/team/__tests__/worker-runtime-identity.test.js \
  dist/utils/__tests__/agents-model-table.test.js \
  dist/hooks/__tests__/analyze-routing-contract.test.js \
  dist/scripts/__tests__/codex-native-hook.test.js \
  dist/scripts/__tests__/smoke-packed-install.test.js \
  dist/team/__tests__/api-interop.test.js \
  dist/cli/__tests__/setup-gh-star.test.js \
  dist/team/__tests__/runtime.test.js
```

| Test file | Isolated result | Direct evidence |
| --- | --- | --- |
| `cli/__tests__/team` | FAIL | 76 tests; 75 pass, 1 skipped; runner failure: `tmux is not available` |
| `notifications/__tests__/tmux` | PASS | 24/24 pass |
| `team/__tests__/tmux-test-fixture` | FAIL | 14 tests; 5 pass, 9 skipped; runner failure surfaces `tmux is not available` |
| `hooks/__tests__/deep-interview-contract` | PASS | 27/27 pass |
| `hooks/__tests__/team-runtime-gating-docs-contract` | PASS | 1/1 pass |
| `team/__tests__/worker-runtime-identity` | FAIL | 4 tests; 2 pass, 2 fail; expected `--model gpt-5.6-luna`, actual explorer model `gpt-5.3-codex-spark` |
| `utils/__tests__/agents-model-table` | FAIL | 5 tests; 4 pass, 1 fail; expected Luna/frontier defaults, actual Spark/Terra defaults |
| `hooks/__tests__/analyze-routing-contract` | PASS | 3/3 pass |
| `scripts/__tests__/codex-native-hook` | BOUNDED FAIL/HANG | No final TAP footer after 5 minutes; visible 253 `ok`, 1 `not ok` through subtest 254. Subtest 244 expected a canonical deep-interview state write command to defer to backend validation, but the hook returned a block decision. Only the owned test process group was terminated. |
| `scripts/__tests__/smoke-packed-install` | FAIL | 48 tests; 47 pass, 1 fail; pinned Codex version probe timed out after 2000 ms |
| `team/__tests__/api-interop` | FAIL | 129 tests; 128 pass, 1 fail; expected persisted leader mailbox result `strict: true`, actual `false` |
| `cli/__tests__/setup-gh-star` | FAIL | 2 tests; 1 pass, 1 fail; expected `gh repo star Yeachan-Heo/oh-my-codex` hint was absent |
| `team/__tests__/runtime` | PASS on bounded repeat | Initial run timed out waiting for `worker-argv.json`; `OMX_NODE_TEST_RUNNER_TIMEOUT_MS=300000 node dist/scripts/run-test-files.js dist/team/__tests__/runtime.test.js` then passed 196/196 in 243530 ms. This is a flaky/timing candidate; current evidence does not establish a deterministic defect. |

Post-run evidence:

- `npm run build`: PASS.
- `origin/main...HEAD`: `0 0`.
- Tracked source diff: clean; only this plan and handoff are untracked.
- `command -v tmux`: no path.
- `AGENTS.md`: ignored by shared `.git/info/exclude`; no ignored file was edited.
- No subagent changed, staged, or committed files.

## Task 2 classification

| Test file | Classification | Evidence |
| --- | --- | --- |
| `cli/__tests__/team` | environment-only | `tmux` absent; shared fixture throws `tmux is not available` |
| `notifications/__tests__/tmux` | PASS/not failing | 24/24 baseline pass |
| `team/__tests__/tmux-test-fixture` | environment-only | real-tmux helper requires the missing binary |
| `hooks/__tests__/deep-interview-contract` | PASS/not failing | 27/27 baseline pass |
| `hooks/__tests__/team-runtime-gating-docs-contract` | PASS/not failing | 1/1 baseline pass |
| `team/__tests__/worker-runtime-identity` | environment-only | repeat read configured Spark from `/Users/yuntae/.codex/.omx-config.json`; test expects fallback Luna |
| `utils/__tests__/agents-model-table` | environment-only | repeat read configured Spark/Terra after runner env scrub; test expects fallback Luna/frontier |
| `hooks/__tests__/analyze-routing-contract` | PASS/not failing | 3/3 baseline pass |
| `scripts/__tests__/codex-native-hook` | deterministic baseline defect | exact scrubbed subtest failed twice with the same safe state-write `decision: block`; Task 1 observed the same assertion |
| `scripts/__tests__/smoke-packed-install` | suite-interaction/flaky | isolated repeat passed 48/48 after initial 2000 ms version-probe timeout |
| `team/__tests__/api-interop` | deterministic baseline defect | duplicate persisted leader message repeatedly returns `ok: false`; existing RED at `src/team/__tests__/api-interop.test.ts:421` |
| `cli/__tests__/setup-gh-star` | suite-interaction/flaky | isolated repeat passed 2/2 after initial missing-hint assertion |
| `team/__tests__/runtime` | suite-interaction/flaky | initial `worker-argv.json` timeout followed by bounded 196/196 pass; no deterministic defect established |

Deterministic shared roots:

- Deep-interview hook: `isAllowedDeepInterviewBashWrite` validates the state payload, but the shared transport helper's final raw Main-root mutation proof rejects otherwise-safe `env`/`command`/`exec` Node CLI wrappers. The revised plan keeps that default proof for Ralplan/Conductor and permits only the exact workspace `dist/cli/omx.js` wrapper in deep-interview.
- Leader mailbox API: `queueDirectMailboxMessage` correctly reports `duplicate_pending_dispatch_request`, but `sendLeaderMailboxMessage` passes the false outcome to `sendWorkerMessage`, which throws before API interop can return the already-persisted row.

No source fix is authorized for the environment-only or suite-interaction/flaky rows.
