# Release readiness: 0.21.14

## Range

- Previous tag: `v0.21.13` (`798d623c16549c8e6d6b4eef1f28cb4abe5763ed`)
- Frozen candidate: `7fd6e95a839c0c0c14de67a7bc976c4d9134b923`
- Compare range: `v0.21.13..7fd6e95a839c0c0c14de67a7bc976c4d9134b923`, 3 commits, 9 files, +1,480/−71
- Product PR: #3793. The candidate also includes the #3803 main-to-dev back-merge; see `artifacts/release-0.21.14/inventory.md`.

## Version choice

`0.21.14` (patch), continuing the established 0.21.x patch train. PR #3793 adds an independent session timeline command and diagnostics without changing or removing existing commands or protocols.

## Version carriers

`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` (all six workspace crates), and `plugins/oh-my-codex/.codex-plugin/plugin.json` are set to `0.21.14`. The version-sync contract test covers package, workspace, Rust members, and plugin alignment. `cargo metadata --locked --format-version 1 --no-deps` succeeds; `npm run sync:plugin:check` verifies plugin metadata and all 24 canonical skill directories.

## Dev CI on the candidate

- Run: [38795551991](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/38795551991)
- Candidate SHA: `7fd6e95a839c0c0c14de67a7bc976c4d9134b923`
- Latest-per-name conclusion: 24 success, 1 skipped (`Publish npm (trusted publishing)`, conditional release job); no failures.

## Local gates (Linux x64)

| Gate | Result |
|---|---|
| `npm ci` | pass (172 packages installed) |
| `npm run build` | pass |
| `npm run check:no-unused` | pass |
| `npm run build:runtime` | pass |
| `cargo metadata --locked --format-version 1 --no-deps` | pass; all six workspace crates report `0.21.14` |
| `npm run sync:plugin:check` | pass (24 canonical skill directories and plugin metadata verified) |
| Version-sync, session timeline CLI, and session-history timeline tests | pass; 0 failures |

No host-environment failures were observed. The full Node test suite was not rerun; candidate CI test lanes passed.

## Known gaps

Main promotion, tag publication, npm publication, and GitHub Release readback are release steps, not candidate readiness gates.
