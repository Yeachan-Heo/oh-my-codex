# Release Readiness: v0.21.48

**Release Date:** 2026-11-07<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned source (tag v0.21.48):** `a153daee49a0931788c3f3ac5e53f5f1a393aeb2`<br>
**Range:** [`v0.21.47...v0.21.48`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.47...v0.21.48)

## Summary

This patch release stores live Codex pins outside the plugin fingerprint root to fix invalidation on plugin refresh (#4010, fixes #3898), and drops role-based reasoning-effort defaults from seven role prompts (#4021), ensuring Vision stays extraction-only unless reassessment is justified. Release-coupled metadata was pre-synchronized to `0.21.48` on dev by #4017, so the release branch does not bump these values again.

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

## Release CI gates

Release workflow [42416497142](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42416497142) ran on a153daee and completed successfully. The workflow includes:
- TypeScript compilation
- Native builds for macOS arm64/x64, Linux x64, and portable bundles
- All release-asset postinstall hydration gates

Version synchronization checks passed as listed above.

## Release PR and main gates

- Release commit e74b1e212bcb0f7d7e881d8ba0c3addc8ba97b45 pushed to main at 2026-11-07 21:13:26Z via PR #4025.
- Main push CI run [42416476573](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42416476573) (CI workflow) completed successfully at 2026-11-07 21:34:07Z.

## Publication evidence

- Annotated tag: `v0.21.48` at `a153daee4e57a8cdb068e7cfde5c23206509d57b` (merge of release/omx-0.21.48-main into main).
- GitHub Release: published non-draft at 2026-11-07 21:47:40Z with 57 assets (native builds for macOS arm64/x64, Linux x64, and portable bundles).
- npm publish (job ID workflow_dispatch run 42419468636): Completed successfully at 2026-11-07 22:26:16Z. Published `oh-my-codex@0.21.48` with identical source and provenance.
- npm `dist-tags.latest`: `0.21.48`.
- npm `oh-my-codex@0.21.48` `gitHead`: `a153daee49a0931788c3f3ac5e53f5f1a393aeb2` (matches the pinned source tag).
- GitHub Release body generated from template and includes `## Contributors` section and full `## Compatibility` and `## Verification` sections.

## Back-merge and version bump

- Version bump: PR #4029 'chore(dev): bump version to 0.21.49' merged to dev as f890ea7829c5873795e82aff3f8892431ad158fb.
- Back-merge: PR #4028 'back-merge/main-to-dev-0.21.48' merged to dev.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
