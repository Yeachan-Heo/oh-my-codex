# oh-my-codex 0.21.2 release notes

Release date: 2026-09-01

`0.21.2` is a patch release covering `v0.21.1..04533ebfc887643586e37180ec3270473948115a`: 11 commits, 29 changed files (+1,245/−10), and three merged PRs (#3599, #3601, #3602).

## Highlights

- **macOS arm64 native runtime hydration** — global installs and same-version reinstalls hydrate `omx-runtime` into the verified native cache. Immediate and deferred `omx update` paths also hydrate after their script-suppressed install, with bounded non-fatal network behavior (#3602).
- **GitGuardex finish progress in HUD** — optional project-local HUD integration shows live review/autofix finish progress, resolves configuration from nested worktree paths, bounds metadata reads before stat calls, and uses a spinner cadence that advances under the one-second HUD watch interval (#3601).
- **Indonesian README** — adds a Bahasa Indonesia translation and synchronizes language navigation across every localized README (#3599).

## Compatibility

Patch release. GitGuardex integration is disabled by default and requires explicit project HUD configuration. Runtime hydration preserves fail-closed checksum/cache verification and does not make package installation fatal when assets or network access are unavailable.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.2/inventory.md`.

## Contributors

Thanks to Bellman (@Yeachan-Heo), @NagyVikt, Dendroculus, and the gaebal-gajae (clawdbot) release and repair lanes.

**Full Changelog**: [`v0.21.1...v0.21.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.1...v0.21.2)
