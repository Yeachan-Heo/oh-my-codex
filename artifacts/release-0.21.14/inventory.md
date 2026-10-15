# Release 0.21.14 Inventory

Frozen range: `v0.21.13..7fd6e95a839c0c0c14de67a7bc976c4d9134b923` (3 commits; 1 product PR and the #3803 back-merge)

## Commits

```
f5120320a977600ff8535f1580e18eae2a061da2 feat(session): add execution timelines and tool diagnostics (#3793)
f2fac30a14106e281c106f3181408545b14ca0ef Merge remote-tracking branch 'origin/dev' into chore/backmerge-v0.21.13
7fd6e95a839c0c0c14de67a7bc976c4d9134b923 Merge pull request #3803 from Yeachan-Heo/chore/backmerge-v0.21.13
```

## Merged PRs

| Number | Author | Title |
|--------|--------|-------|
| [#3793](https://github.com/Yeachan-Heo/oh-my-codex/pull/3793) | @hiSandog | feat(session): add execution timelines and tool diagnostics |
| [#3803](https://github.com/Yeachan-Heo/oh-my-codex/pull/3803) | @Yeachan-Heo | chore: back-merge v0.21.13 release to dev (integration only) |

PR #3803 is included for base convergence; release highlights focus on product PR #3793.

## Included change

- Add `omx session timeline <session-id>` to inspect tool executions, turn boundaries, context compactions, observed durations, exit codes, failures, and incomplete calls from active or archived transcripts (#3793).

## Contributors

- @hiSandog (author of #3793)
- @Yeachan-Heo (author of #3803 back-merge)
