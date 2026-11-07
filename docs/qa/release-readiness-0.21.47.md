# Release Readiness: v0.21.47

**Release Date:** 2026-11-07<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev source:** `509a299d586b48f145c2c7a7baac8ce08d01a015`<br>
**Range:** [`v0.21.46...v0.21.47`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.46...v0.21.47)

## Summary

This patch release keeps generated native-agent instructions within the assigned scope and clarifies Git Master's task authority for history and remote writes. The release process experienced a Sigstore transient failure during the first npm publish attempt, which was resolved on a subsequent rerun.

## Included scope

The release includes the pinned source and the v0.21.47 release commit. No additional content ships beyond what was finalized on main.

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
- `npm test` — passed on the subsequent full run: runtime build, all 475 Node test files, generated catalog check, and prompt-inventory check completed.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files. Biome emitted the existing `linter.rules.recommended` deprecation notice; no lint fixes were applied.
- Focused native-config regression tests — passed: 36 passed, 0 failed.
- Focused `codex-hooks.test.js` regression suite — passed: 74 passed, 1 skipped, 0 failed.
- Version synchronization checks — passed as listed above.

## Release PR and main gates

- Release commit 931f8589c177574d7068d2701d25eded9d2d310c pushed to main at 2026-11-07 14:25:54Z.
- Main push CI run [42380613095](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42380613095) completed successfully.

## Publication evidence

- Annotated tag: `v0.21.47` at `931f8589c177574d7068d2701d25eded9d2d310c`.
- GitHub Release: published non-draft at 2026-11-07 14:25:54Z with 57 assets (native builds for macOS arm64/x64, Linux x64, and portable bundles).
- **First npm publish attempt (job ID 128427245548):** Failed in the Sigstore entry creation step with `TLOG_CREATE_ENTRY_ERROR` (Sigstore server HTTP 500 error). No npm package was published from this attempt.
- **Rerun npm publish (job ID 128442102217):** Completed successfully at 2026-11-07 15:21:58Z. The rerun published `oh-my-codex@0.21.47` with identical source and provenance.
- npm `dist-tags.latest`: `0.21.47`.
- npm `oh-my-codex@0.21.47` `gitHead`: `931f8589c177574d7068d2701d25eded9d2d310c` (matches the release tag commit).
- GitHub Release body generated from template and includes `## Contributors` section and full `## Compatibility` and `## Verification` sections.

## Back-merge and version bump

Pending.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
