# Release readiness: 0.21.34

`0.21.34` (patch). SHUTDOWN RESILIENCE release. Worker worktrees could be deleted during shutdown even when checkpointing or merging failed, or when ignored files were present. This fix preserves worktrees in failure cases, allowing recovery state to be kept for retries.

## Compare range

**Range:** `v0.21.33...v0.21.34`

- **Previous:** `v0.21.33` (commit 8215c6b8)
- **Candidate:** `bc7efc1c1c504b84a28cd4b24c1f3d6af08e6217` (release branch HEAD)

## Commits

**1 commit, 7 files, +1413/−57:**

- bc7efc1c fix(team): preserve worker worktrees when shutdown cannot save work (#3896)

## PR inventory

| PR | Author | Title | Status |
|---|---|---|---|
| [#3896](https://github.com/Yeachan-Heo/oh-my-codex/pull/3896) | @shenyankm | fix(team): preserve worker worktrees when shutdown cannot save work | MERGED ✓ |

## Local gates

Pinned SHA `bc7efc1c1c504b84a28cd4b24c1f3d6af08e6217` (release/omx-0.21.34 HEAD):

Verified at 20:17Z on 2026-10-24

### Build and typecheck
- ✓ `bun run build` passes
- ✓ `bun run typecheck` passes
- ✓ No eslint violations

### Tests
- ✓ Shutdown preservation tests pass (3 test suites in `src/team/__tests__/shutdown-preservation.test.ts`)
- ✓ Worker worktree tests pass (updated to verify preservation logic)
- ✓ Team runtime tests pass (includes new preservation scenarios)

## CI gates

- ✓ Candidate is the pinned commit (bc7efc1c release/omx-0.21.34 HEAD)
- ✓ All version surfaces bumped to 0.21.34
- ✓ Local build and typecheck pass
- ✓ Local lint checks pass (889 files)
- ✓ Shutdown preservation tests pass (3 test suites)
- ✓ Team runtime integration tests pass
- ✓ macOS Ralplan preflight security (Node 20) PASSED
- ✓ macOS Ralplan preflight security (Node 26.5.1) PASSED
- ✓ Coverage Gate (Team Critical) PASSED
- ✓ Latest-per-name CI checks: 17 success, 8 skipped, 0 failures

## Known gaps and issues

- #3898 (live-pin fix): In progress via #3900. Codex 0.164.0 hook validation invalidated by `.omx-live-pin` files in the plugin cache. Workaround: manually clear `.omx-live-pin` if running Codex 0.164.0. This does not block the v0.21.34 release.

## Merge approval

**Codex review:** jq gate must print `[]` (no open findings). Latest Codex review targets the exact HEAD commit. All findings addressed.

**Ready for merge:** Yes. No blockers. PR passes all gates.

## Release notes

- Full Changelog link: [`v0.21.33...v0.21.34`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.33...v0.21.34)
- RELEASE_BODY.md: Updated to describe 0.21.34
- docs/release-notes-0.21.34.md: Created with full release notes

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
