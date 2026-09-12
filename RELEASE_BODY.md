# oh-my-codex 0.21.5

`0.21.5` is a release for the frozen range `v0.21.4..dev` (62 commits): active-team tmux HUD, current Codex lifecycle alignment, ordinary native execution under inherited permissions, credential-provenance and Team startup fixes, portable session recovery, TOML/POSIX PATH fixes, dependency updates, and a dogfood/concurrency repair chain.

## Highlights

- **Active Team progress in the tmux HUD:** show the active team identity and each worker's status/task, retain readable narrow layouts and leader space, use the selected runtime state root, and fence resize reconciliation by exact session ownership (#3644).
- **Current Codex lifecycle:** align plugin-hook diagnostics/setup/uninstall with current Codex capabilities; preserve user-owned reasoning effort; dogfood the real hook trust lifecycle against exact Codex CLI 0.153.4 (#3627, #3631, #3632, #3650).
- **Safe ordinary execution:** ordinary native implementation/reporting respects inherited permissions instead of obsolete workflow restrictions (#3637). Active guidance no longer hands users to retired workflows (#3647).

## Fixes and compatibility

- Preserve credential provenance in ephemeral project-scope runtime homes and export child-safe CODEX_HOME for Team workers without persisting auth into the project (#3633).
- Make Team startup checks side-effect free and report actionable failures (#3643).
- Recover session pointers portably without requiring the native runtime (#3638); resolve hydrated runtime binaries through createRequire (#3639).
- Respect TOML arrays-of-tables (#3645), and preserve POSIX PATH edge cases in command discovery (#3644).
- Fix a real concurrency bug in canonical mode-binding lease acquisition: a removable bootstrap-owner sentinel had an ABA race that could produce an unrecoverable ambiguous multi-owner lock state under concurrent contention. Replaced with a descriptor-bound native OS advisory mutex (`omx-runtime lease-mutex`) that serializes the full observe/claim/publish/release lifecycle of every lease acquisition (#3650, #3652).
- Repair macOS dogfood fixtures using real cross-platform process identities and platform-appropriate directory references; close retained fixture handles explicitly for Node 26 (#3650).
- Refresh dependency lock entries (#3640, #3641, #3642), add the MIT license, and measure maintenance growth without new runtime machinery (#3646).

The packed-install live lifecycle is pinned to Codex 0.153.4. Unsupported installed versions fail explicitly; absence remains separately reported. This is not a claim that every other Codex version is unsupported by OMX itself.

## Validation evidence

Full compare-range candidate CI green on `dev` (final candidate `52bc1197`, CI run [34561205896](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34561205896)). Local verification: real packed-install Codex 0.153.4 lifecycle, the complete 42-test canonical-lease suite (including repeated 20/32/64-process stress and the mutex-serialization regression), the full dependent state/modes/ralph/ralplan suite (26 files), the complete whole-product suite (439/439 test files, 0 failures), typecheck/lint/generated checks, and Rust formatting/clippy/workspace tests. The bootstrap-sentinel ABA race found via post-merge stress testing (#3652) was independently reviewed with a full-diff architecture pass (CLEAR/APPROVE, zero findings) and its own PR CI passed in full before merging to dev.

Full readiness evidence: `docs/qa/release-readiness-0.21.5.md`.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@NagyVikt](https://github.com/NagyVikt), [@hiSandog](https://github.com/hiSandog), [@AmatsuZero](https://github.com/AmatsuZero), and [@ev78394](https://github.com/ev78394), with dependency updates from Dependabot.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.5/inventory.md`.

**Full Changelog**: [`v0.21.4...v0.21.5`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.4...v0.21.5)
