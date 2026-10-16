# Release 0.21.13 Inventory

Frozen range: `v0.21.12..51fa7eed6877b91706629174a2deeff83d1ce08f` (6 commits; 3 product PRs and the #3801 back-merge)

## Commits

```
f4fdb8fba63649bd9d804d0c741444873808ea68 build(deps): bump serde_json from 1.0.151 to 1.0.154 (#3795)
753f2238764b3d680bf0ef6e5c4143cd943bf0dc build(deps-dev): bump @types/node from 26.6.4 to 26.6.5 (#3796)
07f42f4dc7da937ba878f9efc362df91cf267079 Merge remote-tracking branch 'origin/dev' into chore/backmerge-v0.21.12
50a553b79377e989eecbc216689f219275c3c389 fix(hud): bound hook-spawned reconcile processes with timeout (Fixes #3785) (#3787)
7339315478e067185f89a9559ac8b9b67d5c042b Merge remote-tracking branch 'origin/dev' into work/6f6d782d6261636b6d657267652d302e32312e31322d7232
51fa7eed6877b91706629174a2deeff83d1ce08f Merge pull request #3801 from Yeachan-Heo/chore/backmerge-v0.21.12
```

## Merged PRs

| Number | Author | Title |
|--------|--------|-------|
| [#3787](https://github.com/Yeachan-Heo/oh-my-codex/pull/3787) | @Yeachan-Heo | fix(hud): bound hook-spawned reconcile processes with timeout (Fixes #3785) |
| [#3795](https://github.com/Yeachan-Heo/oh-my-codex/pull/3795) | @dependabot | build(deps): bump serde_json from 1.0.151 to 1.0.154 |
| [#3796](https://github.com/Yeachan-Heo/oh-my-codex/pull/3796) | @dependabot | build(deps-dev): bump @types/node from 26.6.4 to 26.6.5 |
| [#3801](https://github.com/Yeachan-Heo/oh-my-codex/pull/3801) | @Yeachan-Heo | chore: back-merge v0.21.12 release to dev (integration only) |

PR #3801 is included for base convergence; release highlights focus on the three product PRs.

## Issues addressed

- Bound hook-spawned HUD reconciliation processes with a timeout (#3787, fixes #3785).
- Update `serde_json` to 1.0.154 (#3795).
- Update `@types/node` to 26.6.5 (#3796).

## Contributors

- @Yeachan-Heo (author of #3787 and #3801)
- @dependabot (author of #3795 and #3796)
