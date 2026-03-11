# PR Draft: Rebase `feat/omx-sparkshell` onto `experimental/dev`

## Target branch
`experimental/dev`

## Summary
This PR rebases the `omx sparkshell` feature line onto `experimental/dev` and preserves the follow-on team-status inspection work built on top of it.

It adds the native Rust-backed `omx sparkshell <command> [args...]` flow, plus a long sequence of `omx team status` improvements that surface pane-aware inspection metadata and ready-to-run sparkshell commands for leader triage.

## What’s included
### `omx sparkshell`
- adds CLI dispatch/help for `omx sparkshell`
- adds `src/cli/sparkshell.ts` for native binary discovery and launch
- adds the Rust crate under `native/omx-sparkshell/`
- adds packaging/build helpers:
  - `scripts/build-sparkshell.mjs`
  - `scripts/test-sparkshell.mjs`
- stages the packaged native binary under `bin/native/linux-x64/omx-sparkshell`
- adds focused CLI + packaging tests

### `omx team status` inspection improvements
- leader/hud/worker pane ids in text and JSON output
- direct sparkshell inspection commands per pane
- prioritized inspection queue and `inspect_next`
- dead/non-reporting worker targeting
- richer recommended inspection metadata, including:
  - worker CLI, role, liveness, index, turn/activity context
  - task id, subject, description, status, lifecycle, approvals, claims, dependencies
  - worktree/runtime paths and team/worker state artifact paths
  - structured `recommended_inspect_items` JSON payloads

## Rebase / integration fixes included
- merged `experimental/dev` CLI/explore surfaces with sparkshell command routing
- excluded `native/omx-sparkshell` from the root Cargo workspace so manifest-path cargo commands work again
- refreshed/added missing compat doctor fixtures after the rebase
- hardened MCP team-job cleanup to resolve the jobs directory from the current home directory dynamically
- updated tests for newly surfaced claim-lock inspection metadata

## Local verification
- `npm run lint`
- `npm run check:no-unused`
- `npm run build`
- `cargo test --manifest-path native/omx-sparkshell/Cargo.toml`
- `node scripts/build-sparkshell.mjs`
- `node scripts/test-sparkshell.mjs`
- `node bin/omx.js sparkshell cargo --version`
- `node bin/omx.js sparkshell npm --version`
- `node bin/omx.js sparkshell git log --oneline -3`
- `npm test`

## Notes
- `npm test` removes the staged packaged sparkshell binary as part of packaging cleanup; I restored the tracked binary afterward.
- Native Rust build artifacts under `native/omx-sparkshell/target/` were removed after verification.
