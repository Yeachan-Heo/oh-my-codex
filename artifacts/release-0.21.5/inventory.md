# Release inventory — 0.21.5

Frozen range: `v0.21.4..main` (63 commits, 118 files changed, +4037/-787).

## Merged PRs

- [#3627](https://github.com/Yeachan-Heo/oh-my-codex/pull/3627): current Codex hook capability diagnostics.
- [#3631](https://github.com/Yeachan-Heo/oh-my-codex/pull/3631): preserve user-owned reasoning effort.
- [#3632](https://github.com/Yeachan-Heo/oh-my-codex/pull/3632): remaining plugin-hook lifecycle corrections.
- [#3633](https://github.com/Yeachan-Heo/oh-my-codex/pull/3633): project runtime-home credential provenance and worker boundaries.
- [#3637](https://github.com/Yeachan-Heo/oh-my-codex/pull/3637): ordinary native execution/reporting under inherited permissions.
- [#3638](https://github.com/Yeachan-Heo/oh-my-codex/pull/3638): portable session pointer recovery.
- [#3639](https://github.com/Yeachan-Heo/oh-my-codex/pull/3639): native runtime cache resolution.
- [#3640](https://github.com/Yeachan-Heo/oh-my-codex/pull/3640), [#3641](https://github.com/Yeachan-Heo/oh-my-codex/pull/3641), [#3642](https://github.com/Yeachan-Heo/oh-my-codex/pull/3642): dependency lock updates.
- [#3643](https://github.com/Yeachan-Heo/oh-my-codex/pull/3643): safe Team startup checks.
- [#3644](https://github.com/Yeachan-Heo/oh-my-codex/pull/3644): active-team identity and per-worker progress in the tmux HUD, including POSIX PATH edge-case fixes and resize-hook session-owner fencing.
- [#3645](https://github.com/Yeachan-Heo/oh-my-codex/pull/3645): TOML array-of-tables boundaries.
- [#3646](https://github.com/Yeachan-Heo/oh-my-codex/pull/3646): maintenance inventory.
- [#3647](https://github.com/Yeachan-Heo/oh-my-codex/pull/3647): retire stale workflow handoffs.
- [#3650](https://github.com/Yeachan-Heo/oh-my-codex/pull/3650): current Codex/macOS dogfood, receipt and fixture corrections.
- [#3651](https://github.com/Yeachan-Heo/oh-my-codex/pull/3651): 0.21.5 release preparation and reconciliation with published main.
- [#3652](https://github.com/Yeachan-Heo/oh-my-codex/pull/3652): native OS mutex serialization for canonical mode-binding leases, fixing a real bootstrap-sentinel ABA race found via post-merge concurrency stress testing.
- [#3657](https://github.com/Yeachan-Heo/oh-my-codex/pull/3657): 0.21.5 PR-inventory attribution correction.
- [#3658](https://github.com/Yeachan-Heo/oh-my-codex/pull/3658): 0.21.5 readiness-doc finalization with confirmed dev CI evidence.
- [#3659](https://github.com/Yeachan-Heo/oh-my-codex/pull/3659): merge dev into main for release 0.21.5.

## Validation evidence

See `docs/qa/release-readiness-0.21.5.md` for the full verification record: dev CI, local whole-product suite, Rust gates, canonical-lease suite, and the real packed-install Codex 0.153.4 smoke test.
