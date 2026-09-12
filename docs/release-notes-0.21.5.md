# oh-my-codex 0.21.5

## Highlights

- **Active Team progress in the tmux HUD:** show the active team identity and each worker's status/task, retain readable narrow layouts and leader space, use the selected runtime state root, and fence resize reconciliation by exact session ownership (#3644).
- **Current Codex lifecycle:** align plugin-hook diagnostics/setup/uninstall with current Codex capabilities; preserve user-owned reasoning effort; dogfood the real hook trust lifecycle against exact Codex CLI 0.153.4.
- **Safe ordinary execution:** ordinary native implementation/reporting respects inherited permissions instead of obsolete workflow restrictions (#3637). Active guidance no longer hands users to retired workflows (#3647).

## Fixes and compatibility

- Preserve credential provenance in ephemeral project-scope runtime homes and export child-safe CODEX_HOME for Team workers without persisting auth into the project (#3633).
- Make Team startup checks side-effect free and report actionable failures (#3643).
- Recover session pointers portably without requiring the native runtime (#3638); resolve hydrated runtime binaries through createRequire (#3639).
- Respect TOML arrays-of-tables (#3645), and preserve POSIX PATH whitespace and absent-PATH semantics.
- Fix a real concurrency bug in canonical mode-binding lease acquisition: a removable bootstrap-owner sentinel had an ABA race that could produce an unrecoverable ambiguous multi-owner lock state under concurrent contention. Replaced with a descriptor-bound native OS advisory mutex (`omx-runtime lease-mutex`) that serializes the full observe/claim/publish/release lifecycle of every lease acquisition. Verified via 42/42 focused lease tests (including repeated 20/32/64-process stress) and the full dependent state/modes/ralph/ralplan suite (#3650, #3652).
- Repair macOS dogfood fixtures using real cross-platform process identities and platform-appropriate directory references; close retained fixture handles explicitly for Node 26. Exact argv/stdin, ownership, trust, and no-follow checks remain enforced (#3650).
- Refresh dependency lock entries (#3640, #3641, #3642), add the MIT license, and measure maintenance growth without new runtime machinery (#3646).

The packed-install live lifecycle is pinned to Codex 0.153.4. Unsupported installed versions fail explicitly; absence remains separately reported. This is not a claim that every other Codex version is unsupported by OMX itself.

## Merged PR inventory

- [#3644](https://github.com/Yeachan-Heo/oh-my-codex/pull/3644): active-team identity and per-worker progress in the tmux HUD, including POSIX PATH edge-case fixes and resize-hook session-owner fencing.
- [#3627](https://github.com/Yeachan-Heo/oh-my-codex/pull/3627): current Codex hook capability diagnostics.
- [#3631](https://github.com/Yeachan-Heo/oh-my-codex/pull/3631): preserve user-owned reasoning effort.
- [#3632](https://github.com/Yeachan-Heo/oh-my-codex/pull/3632): remaining plugin-hook lifecycle corrections.
- [#3633](https://github.com/Yeachan-Heo/oh-my-codex/pull/3633): project runtime-home credential provenance and worker boundaries.
- [#3637](https://github.com/Yeachan-Heo/oh-my-codex/pull/3637): ordinary native execution/reporting under inherited permissions.
- [#3638](https://github.com/Yeachan-Heo/oh-my-codex/pull/3638): portable session pointer recovery.
- [#3639](https://github.com/Yeachan-Heo/oh-my-codex/pull/3639): native runtime cache resolution.
- [#3640](https://github.com/Yeachan-Heo/oh-my-codex/pull/3640), [#3641](https://github.com/Yeachan-Heo/oh-my-codex/pull/3641), [#3642](https://github.com/Yeachan-Heo/oh-my-codex/pull/3642): dependency lock updates.
- [#3643](https://github.com/Yeachan-Heo/oh-my-codex/pull/3643): safe Team startup checks.
- [#3645](https://github.com/Yeachan-Heo/oh-my-codex/pull/3645): TOML array-of-tables boundaries.
- [#3646](https://github.com/Yeachan-Heo/oh-my-codex/pull/3646): maintenance inventory.
- [#3647](https://github.com/Yeachan-Heo/oh-my-codex/pull/3647): retire stale workflow handoffs.
- [#3650](https://github.com/Yeachan-Heo/oh-my-codex/pull/3650): current Codex/macOS dogfood, receipt and fixture corrections.
- [#3651](https://github.com/Yeachan-Heo/oh-my-codex/pull/3651): 0.21.5 release preparation and reconciliation with published main.
- [#3652](https://github.com/Yeachan-Heo/oh-my-codex/pull/3652): native OS mutex serialization for canonical mode-binding leases, fixing a real bootstrap-sentinel ABA race found via post-merge concurrency stress testing.

Main-only 0.21.4 documentation/history was merged back before freezing this candidate; it is preserved rather than described as a new feature.

## Validation evidence

Repair head `7aa2b9a93188c7c4310fbc7cfd55a57f4577fe7f` passed [exact CI 34444169245](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34444169245). A subsequent post-merge stress-test pass uncovered a real bootstrap-sentinel ABA race in the canonical mode-binding lease; the fix (native OS mutex serialization, PR #3652) passed its own full CI run and an independent full-diff architecture review with zero findings. Local focused verification passed the real packed-install Codex 0.153.4 lifecycle, 59 smoke regressions, the complete 42-test lease suite (including repeated 20/32/64-process stress and the new mutex-serialization regression), the full dependent state/modes/ralph/ralplan suite (26 files), native-hook tests, fixture suites, typecheck/lint/generated checks, and Rust formatting/clippy/workspace tests.

Final release-collateral/main CI, native release assets, trusted npm publishing, and final installation evidence are tracked in `docs/qa/release-readiness-0.21.5.md`; they are not claimed complete in this candidate document.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@NagyVikt](https://github.com/NagyVikt), [@hiSandog](https://github.com/hiSandog), [@AmatsuZero](https://github.com/AmatsuZero), and [@ev78394](https://github.com/ev78394), with dependency updates from Dependabot.

**Full Changelog**: [`v0.21.4...v0.21.5`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.4...v0.21.5)
