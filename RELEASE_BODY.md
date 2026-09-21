# oh-my-codex 0.21.6

`0.21.6` is a maintenance and reliability release for the frozen range `v0.21.5..dev` (52 commits, 101 files, +4294/−707): tmux HUD lifecycle correctness, AGENTS scope fixes, auth/credential record hardening, Team dispatch and Windows startup robustness, a reusable default-model cost/quality evaluation suite, and dependency updates.

## Highlights

- **Reusable default-model cost/quality evaluations:** a declarative suite for OMX's default model lineup with deterministic stage-transition records, supplied-record reporting, and explicitly documented declaration/validation limits (#3663, #3665, #3666, #3667), answering the evaluation request in issue #3655 without asserting unmeasured numbers.
- **Self-terminating, leak-free tmux HUD:** stale Team leader panes are skipped during reconciliation, orphan watchers and noisy reconcile failures are gone, and the HUD closes when its tmux leader pane exits. Leader absence is decided from a validated server-wide pane snapshot, so a window move is never mistaken for an exit and a failed tmux query is never treated as evidence (#3660, #3683, #3685).
- **AGENTS scope correctness:** durable AGENTS content is no longer duplicated into session instructions, and global AGENTS survive project-scoped launches (#3678, #3684).

## Fixes and compatibility

- Hardened auth storage, TOML boundaries, PATH resolution, and stderr redaction (#3662); oversized stderr suppression no longer swallows the next record (#3676).
- Windows `EPERM` fsync during Team startup is survivable (#3661); non-directory entries no longer break Team dispatch draining (#3680).
- Notifications strip complete ANSI CSI sequences instead of leaving partial escapes (#3668).
- Ordinary requests stay out of optional workflow machinery (#3648); confirmed unused internal exports were removed rather than aliased (#3649); remaining 0.21 capability-parity documentation gaps are closed (#3634).
- Dependency updates: `zod` 4.6.2, `@biomejs/biome` 2.5.13, `@types/node` 26.5.1 (#3673, #3674, #3675).

## Validation evidence

Exact frozen candidate `750fdd08ef6b902c8ac9bb4f48d440ead87f6d12` is fully green on `dev` CI (17 successful checks, 8 platform-skipped, 0 failures). Every external contribution in this range (#3660, #3668, #3683, #3684, #3685) was independently reproduced on a clean `origin/dev` base before merge, with post-merge `dev` CI re-verified after each merge.

Full readiness evidence: `docs/qa/release-readiness-0.21.6.md`.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@ev78394](https://github.com/ev78394), [@NagyVikt](https://github.com/NagyVikt), [@hiSandog](https://github.com/hiSandog), [@wangxingzhen](https://github.com/wangxingzhen), and [@Xrondev](https://github.com/Xrondev), with dependency updates from Dependabot.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.6/inventory.md`.

**Full Changelog**: [`v0.21.5...v0.21.6`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.5...v0.21.6)
