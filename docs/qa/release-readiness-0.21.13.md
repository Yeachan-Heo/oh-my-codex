# Release readiness: 0.21.13

## Range

- Previous tag: `v0.21.12` (`13fd86b347c381d658fc977b90d6b4b3116d062b`)
- Frozen candidate: `51fa7eed6877b91706629174a2deeff83d1ce08f`
- Compare range: `v0.21.12..51fa7eed6877b91706629174a2deeff83d1ce08f`, 6 commits, 10 files, +576/−52
- Product PRs: #3787, #3795, #3796. The candidate also includes the #3801 main-to-dev back-merge; see `artifacts/release-0.21.13/inventory.md`.

## Version choice

`0.21.13` (patch), continuing the established 0.21.x patch train. This release bounds hook-spawned HUD reconciliation processes and updates dependencies. It does not change CLI commands, protocol, or package layout.

## Version carriers

`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` (all six workspace crates), and `plugins/oh-my-codex/.codex-plugin/plugin.json` are set to `0.21.13`. The version-sync contract test covers package, workspace, Rust member, and plugin alignment. `cargo metadata --locked --format-version 1 --no-deps` succeeds; `npm run sync:plugin:check` verifies plugin metadata and all 24 canonical skill directories.

## Dev CI on the candidate

- Run: [38770254118](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/38770254118)
- Candidate SHA: `51fa7eed6877b91706629174a2deeff83d1ce08f`
- Latest-per-name conclusion: 24 success, 1 skipped (`Publish npm (trusted publishing)`, conditional release job); no failures.

## Local gates (Linux x64)

| Gate | Result |
|---|---|
| `npm ci` | pass (172 packages installed) |
| `npm run build` | pass |
| `npm run check:no-unused` | pass |
| `npm run build:runtime` | pass |
| `cargo metadata --locked --format-version 1 --no-deps` | pass |
| `npm run sync:plugin:check` | pass (24 canonical skill directories and plugin metadata verified) |
| Version-sync and focused HUD Node tests (`version-sync-contract`, `index`, `tmux`, `spawn-reconcile-with-timeout`) | pass (70 passed, 0 failed) |
| Rust tests (`omx-api`, `omx-mux`, `omx-runtime-core`, `omx-runtime`) | pass (148 passed across 10 suites) |

No host-environment failures were observed. The full Node test suite was not rerun; candidate CI test lanes passed.

## Known gaps

Main promotion, tag publication, npm publication, and GitHub Release readback are release steps, not candidate readiness gates.
