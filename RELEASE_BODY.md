# oh-my-codex 0.21.2

`0.21.2` is a patch release for `v0.21.1..04533ebfc887643586e37180ec3270473948115a` (11 commits, 29 changed files, PRs #3599/#3601/#3602).

## Highlights

- **macOS arm64 runtime hydration** — global install/reinstall and immediate/deferred updates hydrate the verified `omx-runtime` cache with bounded non-fatal network behavior (#3602).
- **GitGuardex HUD progress** — optional live review/autofix progress with nested-path config discovery, bounded metadata reads, and watch-cadence-safe animation (#3601).
- **Indonesian localization** — Bahasa Indonesia README plus synchronized navigation across localized documentation (#3599).

## Compatibility

Patch release. Guardex HUD integration is opt-in. Native hydration remains integrity-verified and non-fatal when unavailable.

## Contributors

Thanks to Bellman (@Yeachan-Heo), @NagyVikt, Dendroculus, and the gaebal-gajae (clawdbot) release and repair lanes.

## Frozen-range acknowledgements

Merge this release PR with a two-parent merge commit so frozen `dev@04533ebf` remains reachable. Immediately before merge, force-fetch and record the exact `origin/release/0.21.2` head; verify both it and frozen dev are ancestors of the tagged main commit.

**Full Changelog**: [`v0.21.1...v0.21.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.1...v0.21.2)
