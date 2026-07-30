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
- Task 2 initial file-level classification completed: 4 PASS/not failing, 4 environment-only, 3 suite-interaction/flaky, 2 files with deterministic baseline defects.
- TDD RED evidence: existing `codex-native-hook` and `api-interop` assertions repeatedly failed on clean `origin/main`; both deterministic defects now have targeted GREEN evidence.
- Task 3A plan correction: the initial one-line shared-helper reuse compiled but stayed RED on the first safe `env ... node dist/cli/omx.js` wrapper. The new lookalike assertion then exposed two authorization leaks in the uncommitted revision: raw mutation trust ran before the exact-path proof, and a rejected recognized state write fell through to the generic no-write-intent allow. After those were closed, the later `env -C` input-file assertion showed the generic runtime classifier still ran before the exact wrapper proof. The security review also required trusted Node interpreter resolution so `env PATH=<attacker>` cannot borrow the exact script path. The final plan uses the repo's existing path-state/interpreter trust predicates before both generic checks and returns the helper decision directly; no existing test was weakened.
- Task 3A verified slice: commit `bef2a329` changes only `src/scripts/codex-native-hook.ts` and `src/scripts/__tests__/codex-native-hook.test.ts`. Fresh post-commit evidence: build exit 0; exact scrubbed hook run 1 pass, 637 skipped, 0 fail; deep-interview contract 27/27 pass; commit diff check exit 0. Independent static verification confirmed exact workspace CLI path, trusted Node resolution, terminal rejection on helper false, and unchanged default 3-argument callers.
- Task 3B verified slice: commit `b822cdc9` changes only `src/team/runtime.ts`. Existing RED repeated at `second.ok` with 128/129 pass; fresh post-commit evidence: build exit 0; API interop 129/129 pass; MCP communication 9/9 pass; commit diff check exit 0. Generic queue code and tests remain unchanged.
- Task 3C verified slice: commit `e27e4455` changes only the hook source and its existing test file. Clean-origin/main isolated RED proved ambient `ZDOTDIR` was incorrectly applied to bash. The original nested-redirect assertion remains unchanged; explicit controls now prove bash/BASH_ENV, zsh/ZDOTDIR, and sh/ENV boundaries. Fresh post-commit evidence: build exit 0; scrubbed focused run 2 pass, 636 skipped, 0 fail; commit diff check and guard pass.
- Final integrated source review: APPROVE; no graph provenance, dependency, ignored `AGENTS.md`, global configuration, or unrelated production path change found.
- Known environment blockers: `tmux` is absent; global model configuration selects Spark/Terra rather than fallback Luna; prompt triage is explicitly disabled; inherited model variables, PATH candidates, and missing `wget` affect four hook assertions. No host/global workaround is authorized.

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

## Final 13-file rerun

The final branch rerun used the same 13 files, serial execution, per-file process isolation, and a command-local `OMX_NODE_TEST_RUNNER_TIMEOUT_MS=600000`.

| Test file | Final result | Evidence |
| --- | --- | --- |
| `cli/__tests__/team` | environment-only FAIL | 75 pass, 1 skip; `tmux is not available` |
| `notifications/__tests__/tmux` | PASS | 24/24 |
| `team/__tests__/tmux-test-fixture` | environment-only FAIL | 5 pass, 9 skip; missing tmux |
| `hooks/__tests__/deep-interview-contract` | PASS | 27/27 |
| `hooks/__tests__/team-runtime-gating-docs-contract` | PASS | 1/1 |
| `team/__tests__/worker-runtime-identity` | environment-only FAIL | 2 pass, 2 fail; configured model differs from fallback expectation |
| `utils/__tests__/agents-model-table` | environment-only FAIL | 4 pass, 1 fail; configured Spark/Terra differs from fallback expectation |
| `hooks/__tests__/analyze-routing-contract` | PASS | 3/3 |
| `scripts/__tests__/codex-native-hook` | environment-only FAIL after deterministic repairs | 613 pass, 24 fail, 1 skip |
| `scripts/__tests__/smoke-packed-install` | PASS | 48/48 |
| `team/__tests__/api-interop` | PASS | 129/129 |
| `cli/__tests__/setup-gh-star` | PASS | 2/2 |
| `team/__tests__/runtime` | PASS | 196/196 |

Final matrix: 8 files PASS; 5 files fail only on preserved environment inputs.

The 24 remaining hook failures are fully classified:

- 20 triage advisory expectations: global `promptRouting.triage.enabled=false`. Clean `origin/main` with the preserved config passed 17/37 and failed 20/37; a command-local empty `CODEX_HOME` passed 37/37.
- 1 untrusted-omx PATH diagnostic: inherited global model variables are rejected before the intended PATH branch; focused origin/main run passes when those command-local variables are unset.
- 1 wget read-only case: `wget` is absent on this host, so executable resolution correctly fails closed.
- 2 `env cp` metadata cases: inherited PATH contains a user-owned, non-executable `~/.local/bin/env` before the trusted system binary, so wrapper resolution correctly fails closed.

No source or test change was made for these environment-only cases.

## Final verification ladder

- `npm run build`: PASS.
- Exact scrubbed deep-interview hook regression: 1 pass, 637 skipped, 0 fail.
- Scrubbed shell-startup regressions: 2 pass, 636 skipped, 0 fail.
- Deep-interview contract: 27/27 PASS.
- API interop and MCP communication: 129/129 and 9/9 PASS.
- `npm run lint`: PASS; 788 files checked.
- `npm run check:no-unused`: PASS.
- `npm run verify:native-agents`: PASS; 22 installable agents and 37 prompt assets.
- `npm run verify:plugin-bundle`: PASS; 29 canonical skill directories and plugin metadata.
- Worktree guard self-test and active-lane check: PASS.
- `git diff --check` and committed-range diff check: PASS.
- Exact 13-file matrix: nonzero only for the five environment rows above.
- `npm test`: build, native-agent verification, and plugin-bundle verification passed before the 405-file serial runner. The runner remained active beyond the intended 10-minute bound and grace period; only that owned process was terminated with exit 130. Full-suite completion is therefore not claimed.

## Local checkpoints

- `36c1af99` Preserve the baseline failure boundary before source repair
- `71fe47ff` Correct the deep-interview repair boundary after TDD disproved the first plan
- `f0ccde4d` Order the deep-interview wrapper proof before legacy mutation trust
- `bef2a329` Allow safe deep-interview state writes to reach backend validation
- `b822cdc9` Preserve idempotent leader mailbox sends across pending dispatch dedupe
- `e27e4455` Apply shell startup guards only to the shell that reads them

All checkpoints are local. No push, PR, merge, deploy, release, OMX update, EOD, global installation change, or user-setting change was performed.
