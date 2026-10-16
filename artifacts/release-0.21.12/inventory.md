# Release 0.21.12 Inventory

Frozen range: `v0.21.11..6937884f4d09a485d5b4f16498517bcd05384e06` (6 commits; 6 merged PRs)

## Commits

```
9a1e2640 fix(hud): bound the watcher repair child so a hung reconcile cannot block repairs (#3786)
2d9839d6 test(hud): put the real-tmux test socket under tmpdir (#3788)
da547fca test(hud): make the adaptive-budget resize watch test hermetic (#3789)
bf7b2073 perf(hud): cache the git branch label until HEAD, refs or git config change (#3791)
3313add0 feat(team): Require completion evidence for implementation tasks (#3797)
6937884f build(deps): bump @modelcontextprotocol/sdk from 1.32.0 to 1.32.1 (#3794)
```

## Merged PRs

| Number | Author | Title |
|--------|--------|-------|
| [#3786](https://github.com/Yeachan-Heo/oh-my-codex/pull/3786) | @spicysharkco | fix(hud): bound the watcher repair child so a hung reconcile cannot block repairs |
| [#3788](https://github.com/Yeachan-Heo/oh-my-codex/pull/3788) | @spicysharkco | test(hud): put the real-tmux test socket under tmpdir |
| [#3789](https://github.com/Yeachan-Heo/oh-my-codex/pull/3789) | @spicysharkco | test(hud): make the adaptive-budget resize watch test hermetic |
| [#3791](https://github.com/Yeachan-Heo/oh-my-codex/pull/3791) | @spicysharkco | perf(hud): cache the git branch label until HEAD, refs or git config change |
| [#3794](https://github.com/Yeachan-Heo/oh-my-codex/pull/3794) | @dependabot | build(deps): bump @modelcontextprotocol/sdk from 1.32.0 to 1.32.1 |
| [#3797](https://github.com/Yeachan-Heo/oh-my-codex/pull/3797) | @shenyankm | feat(team): Require completion evidence for implementation tasks |

## Issues addressed

- Require current-claim completion evidence for tasks marked `requires_code_change: true` (#3797).
- Bound HUD watcher repair children and cache git branch labels with relevant invalidation (#3786, #3791).
- Make HUD watcher tests hermetic (#3788, #3789).
- Update `@modelcontextprotocol/sdk` to 1.32.1 (#3794).

## Contributors

- @spicysharkco (author of #3786, #3788, #3789, #3791)
- @shenyankm (author of #3797)
- @dependabot (author of #3794)
