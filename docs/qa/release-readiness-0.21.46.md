# Release Readiness: v0.21.46

**Release Date:** 2026-11-02<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev source:** `41f8cd5c3cbcce8803f3d14c72e32bace88011dd`<br>
**Range:** [`v0.21.45...v0.21.46`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.45...v0.21.46)

## Summary

This patch release updates generated native-agent posture/exact-model guidance to preserve assignment scope (#3989) and bounds Git Master's history and write authority (#3997).

## Included scope

The source-only diff from `v0.21.45` to the pinned source changes `src/agents/native-config.ts`, its regression tests in `src/agents/__tests__/native-config.test.ts`, and `prompts/git-master.md`. No commits after the pinned source are included. No other user-facing changes ship.

## Version synchronization

The pinned source already reads `0.21.46` across every release-coupled version surface; the release branch does not bump these values again.

| Surface | Verified value |
|---|---|
| `package.json` | `0.21.46` |
| `package-lock.json` root and root package entry | `0.21.46` |
| `Cargo.toml` workspace package | `0.21.46` |
| `Cargo.lock` six OMX workspace crates | `0.21.46` |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | `0.21.46` |
| `node dist/scripts/check-version-sync.js --tag v0.21.46` | Passed — package, workspace, and tag all `0.21.46` |
| `cargo metadata --locked --format-version 1 --no-deps` | Passed — all six OMX workspace crates report `0.21.46` |

## Local gates

- `npm ci` — passed; 172 packages installed and lifecycle hooks completed.
- `npm run build` — passed.
- `npm test` — passed on the subsequent full run: runtime build, all 475 Node test files, generated catalog check, and prompt-inventory check completed. An earlier attempt exceeded the command timeout without a final suite summary.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files. Biome emitted the existing `linter.rules.recommended` deprecation notice; no lint fixes were applied.
- Focused native agent overlay tests — passed: 36 passed, 0 failed.
- Focused `codex-hooks.test.js` regression suite — passed: 74 passed, 1 skipped, 0 failed.
- Version synchronization checks — passed as listed above.

## Release PR and main gates

Pending.

## Publication evidence

Pending.

## Back-merge and version bump

Pending.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
