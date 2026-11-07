# Release Readiness: v0.21.48

**Release Date:** 2026-11-07<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev source:** `3dc87dfaa8b6142922ea67294587895ee367d2f7`<br>
**Range:** [`v0.21.47...v0.21.48`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.47...v0.21.48)

## Summary

This patch release drops role-based reasoning-effort defaults from seven role prompts, ensuring Vision stays extraction-only unless reassessment is justified. Release-coupled metadata was pre-synchronized to `0.21.48` on dev by #4017, so the release branch does not bump these values again.

## Included scope

The release includes the pinned source and the v0.21.48 release commit. No additional content ships beyond what was finalized on main.

## Version synchronization

The pinned source already reads `0.21.48` across every release-coupled version surface; the release branch does not bump these values again.

| Surface | Verified value |
|---|---|
| `package.json` | `0.21.48` |
| `package-lock.json` root and root package entry | `0.21.48` |
| `Cargo.toml` workspace package | `0.21.48` |
| `Cargo.lock` six OMX workspace crates | `0.21.48` |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | `0.21.48` |

## Local gates

- `npm ci` — passed; 172 packages installed and lifecycle hooks completed.
- `npm run build` — passed.
- `npm test` — passed on the subsequent full run: runtime build, all 475 Node test files, generated catalog check, and prompt-inventory check completed.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files. Biome emitted the existing `linter.rules.recommended` deprecation notice; no lint fixes were applied.
- Focused native-config regression tests — passed: 36 passed, 0 failed.
- Focused `codex-hooks.test.js` regression suite — passed: 74 passed, 1 skipped, 0 failed.
- Version synchronization checks — passed as listed above.

## Release PR and main gates

- Release commit e74b1e212bcb0f7d7e881d8ba0c3addc8ba97b45 pushed to main at 2026-11-07 21:13:26Z via PR #4025.
- Main push CI run [42416497142](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42416497142) (Release workflow) completed successfully at 2026-11-07 21:57:52Z.

## Publication evidence

- Annotated tag: `v0.21.48` at `a153daee4e57a8cdb068e7cfde5c23206509d57b` (merge of release/omx-0.21.48-main into main).
- GitHub Release: published non-draft at 2026-11-07 21:47:40Z with 57 assets (native builds for macOS arm64/x64, Linux x64, and portable bundles).
- npm publish (job ID workflow_dispatch run 42419468636): Completed successfully at 2026-11-07 22:26:16Z. Published `oh-my-codex@0.21.48` with identical source and provenance.
- npm `dist-tags.latest`: `0.21.48`.
- npm `oh-my-codex@0.21.48` `gitHead`: `3dc87dfaa8b6142922ea67294587895ee367d2f7` (matches the pinned dev source).
- GitHub Release body generated from template and includes `## Contributors` section and full `## Compatibility` and `## Verification` sections.

## Back-merge and version bump

Pending.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
