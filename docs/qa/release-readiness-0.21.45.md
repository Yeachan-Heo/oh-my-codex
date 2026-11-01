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

Release PR #3986 ([release: v0.21.45](https://github.com/Yeachan-Heo/oh-my-codex/pull/3986)) merged to `main` at `7ca48b79`. Its Release run #41332073403 ([run](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41332073403)) ended cancelled after two attempts when the `aarch64-apple-darwin` build hit the macOS 14 runner brownout tracked in [actions/runner-images#13518](https://github.com/actions/runner-images/issues/13518).

Runner fix PR #3987 ([main](https://github.com/Yeachan-Heo/oh-my-codex/pull/3987)) moved the arm64 release build from `macos-14` to `macos-15` and merged to `main`; PR #3988 ([dev](https://github.com/Yeachan-Heo/oh-my-codex/pull/3988)) applied the same runner fix to `dev`. The `v0.21.45` tag was moved from `7ca48b79` to `8f35f24c865cfed15234dd00570331ec2aab0870`; the former tag target was never published.

The tag move happened before main CI completed, an ordering deviation from the intended gate sequence. Main CI #41339407648 ([run](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41339407648)) on `8f35f24c865cfed15234dd00570331ec2aab0870` later concluded success. Release run #41339422194 ([run](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41339422194)) on the same commit concluded success, including the native asset publication and verification and the packed global-install smoke test.

## Publication evidence

GitHub Release `v0.21.45` is non-draft with `publishedAt` `2026-11-01T19:15:23Z`. The npm workflow was dispatched as run #41341474394 ([run](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41341474394)); its `Publish npm (trusted publishing)` job and registry propagation verification succeeded.

Post-publication readbacks:

- `gh release view v0.21.45 -R Yeachan-Heo/oh-my-codex --json isDraft,publishedAt` — `{"isDraft":false,"publishedAt":"2026-11-01T19:15:23Z"}`.
- `npm view oh-my-codex dist-tags.latest` — `0.21.45`.
- `npm view oh-my-codex@0.21.45 gitHead` — `8f35f24c865cfed15234dd00570331ec2aab0870`.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
