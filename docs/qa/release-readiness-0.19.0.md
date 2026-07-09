# Release readiness — 0.19.0

## Compare range

- Previous released tag: `v0.18.17`
- Candidate ref: `dev` (HEAD)
- Ancestry: `v0.18.17` is an ancestor of the candidate.
- Full compare: `v0.18.17...v0.19.0`

## PR inventory

#3056, #3055, #3054, #3051, #3050, #3048, #3047, #3046, #3045, #3042, #3040, #3038, #3037, #3035, #3032, #3031, #3030, #3025, #3022, #3018

Plus this release's in-branch flaky-test fix (no separate PR yet): collision-proof `unique_temp_dir()` in `crates/omx-sparkshell/tests/execution.rs`.

## Local gates

- `npm run build` — pass.
- `node dist/scripts/check-version-sync.js` — pass (`package=0.19.0 workspace=0.19.0`).
- Version bump synced across `package.json`, `package-lock.json`, `Cargo.toml [workspace.package]`, `Cargo.lock`, and `plugins/oh-my-codex/.codex-plugin/plugin.json`; no stray `0.18.18` references remain in tracked toml/json/lock files.
- `npm run sync:plugin` + `node dist/scripts/sync-plugin-mirror.js --check` — verified 29 canonical skill directories and plugin metadata.
- Rust workspace: `cargo test` rerun 3x at full parallelism with 0 failures; `cargo test -p omx-sparkshell --test execution` rerun 5x with 0 failures. The pre-fix flake (`json_mode_reports_failed_worker_status`, execution.rs:723) was reproduced under full-workspace parallelism before the fix and does not recur after it.
- Node suite: `node dist/scripts/run-test-files.js dist` — 2 full runs, exit 0, 0 failures.
- `npm pack --dry-run` — recorded below.

## Flaky-fix root cause

`unique_temp_dir()` keyed temp-dir uniqueness on `SystemTime` nanos + process id. Rust runs a test binary's tests as parallel threads inside one shared-PID process, so under coarse-clock load two threads could resolve the same nanos value and collide on the same `OMX_TEAM_STATE_ROOT`, overwriting each other's `status.json` and `remove_dir_all`-ing each other's dirs mid-run. A per-process `AtomicU64` monotonic counter now guarantees a distinct path per call, mirroring the already-fixed `omx-api/tests/cli.rs::temp_state_file` pattern. Evidence: `artifacts/release-0.19.0/g001-flaky-fix-qa.json`.

## CI run IDs

- Branch CI / dev / main promotion / tag-triggered release workflow: appended after publication.

## Known gaps

- Publication steps (merge to `main`, tag push, tag-triggered release workflow, GitHub release, native asset attachment, `npm publish`) require maintainer/CI action and credentials and are intentionally not performed autonomously.
