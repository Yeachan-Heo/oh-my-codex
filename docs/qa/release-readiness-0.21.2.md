# Release readiness — 0.21.2

## Identity

- Release: `0.21.2` patch.
- Previous tag: `v0.21.1` (`8513abf70609061770a97100ef8964c8ebb40700`).
- Frozen dev: `04533ebfc887643586e37180ec3270473948115a`.
- Range: 11 commits, 29 files, +1,245/−10, PRs #3599/#3601/#3602.
- Owner authorization: direct `ㄱㄱ` in the OmX v0.21.2 readiness thread.
- Backlog at freeze: open PR 0, open issue 0.

## Version carriers

- package.json / package-lock.json → 0.21.2
- Cargo.toml workspace package → 0.21.2
- plugins/oh-my-codex/.codex-plugin/plugin.json → 0.21.2

## Gates

| Gate | Status |
|---|---|
| Frozen dev CI `33406782191` | Passed |
| Version sync / build / static / generated | Pending release validation |
| Full tests and package/native smoke | Pending release validation |
| Exact-head PR to main, CI, adversarial review | Pending |
| Main CI, tag `v0.21.2`, GitHub Release/native assets | Pending |
| Exact tag/SHA-bound OIDC npm trusted publish | Pending |
| npm `oh-my-codex@0.21.2` and latest | Pending |

## Publish contract

Merge the release PR using a two-parent merge commit. Immediately before merge, force-fetch `+refs/heads/release/0.21.2:refs/remotes/origin/release/0.21.2` and record the exact release head. Before tagging, verify that recorded release head and frozen dev `04533ebf` are ancestors of the merged main commit. Use the tag-triggered Release workflow for GitHub assets and the CI workflow's exact `release_tag`/`release_sha` OIDC trusted-publish job for npm. No token/manual publisher.
