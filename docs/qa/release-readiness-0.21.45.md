# Release Readiness: v0.21.45

**Release Date:** 2026-11-01<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev source:** `0057f272db97454afa8ccf3320ed590175016b0a`<br>
**Range:** [`v0.21.44...v0.21.45`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.44...v0.21.45)

## Summary

This patch release fixes a false `unsafe_managed_removal` trust-migration report for unchanged foreign Codex hook groups with an explicitly empty matcher. `foreignHookTrustHash` now includes a matcher whenever its value is a string, preserving `""` in the hash identity. The separately reported SessionEnd outlier is not addressed.

## Included scope

The source-only diff from `v0.21.44` to the pinned source changes `src/config/codex-hooks.ts` and its regression test, for 36 insertions and 1 deletion. The production change is #3985 (fixes #3984); the regression test confirms the empty matcher remains in the expected hash and trust-coordinate migration. No commits after the pinned source are included.

## Version synchronization

The pinned source already reads `0.21.45` across every release-coupled version surface; the release branch does not bump these values again.

| Surface | Verified value |
|---|---|
| `package.json` | `0.21.45` |
| `package-lock.json` root and root package entry | `0.21.45` |
| `Cargo.toml` workspace package | `0.21.45` |
| `Cargo.lock` six OMX workspace crates | `0.21.45` |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | `0.21.45` |
| `node dist/scripts/check-version-sync.js --tag v0.21.45` | Passed |
| `cargo metadata --locked --format-version 1 --no-deps` | All six OMX workspace packages report `0.21.45` |

## Local gates

- `npm ci` — passed; locked install and lifecycle hooks completed.
- `npm run build` — passed.
- `npm test` — passed; runtime build, 475 Node test files, generated catalog check, and prompt-inventory check completed.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files. Biome emitted the existing `linter.rules.recommended` deprecation notice; no lint fixes were applied.
- Focused `codex-hooks.test.js` regression suite — passed: 74 passed, 1 skipped, 0 failed.
- Version synchronization checks — passed as listed above.

## Release PR and main gates

Release PR, latest-per-name CI checks, review-thread resolution, merge commit, and main push CI evidence will be recorded after those gates complete.

## Publication evidence

Tag, GitHub Release workflow, npm trusted-publishing dispatch, and registry readbacks will be recorded after publication. Required readbacks are `gh release view v0.21.45` (`isDraft=false`), npm `dist-tags.latest` (`0.21.45`), and `npm view oh-my-codex@0.21.45 gitHead` matching the tagged commit.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
