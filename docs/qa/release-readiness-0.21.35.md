# Release Readiness: v0.21.35

**Release Date:** 2026-10-24  
**Released By:** gaebal-gajae (autonomous release)  
**Baseline:** v0.21.34 (main eda85468, npm latest 0.21.34)  
**Range:** [`v0.21.34...v0.21.35`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.34...v0.21.35)

## Summary

**Patch release:** v0.21.35 fixes legacy recovery journal ownership and platform-aware replay logic introduced in #3903–#3904.

- **Fixes:** Worktree-scoped journal blocking (#3903), platform-aware journal ownership (#3904)
- **Impact:** Team runtime recovery robustness
- **Breaking changes:** None
- **New dependencies:** None

## PR inventory

**Merged PRs in this release:**

| PR | Author | Title | Status |
|---|---|---|---|
| [#3903](https://github.com/Yeachan-Heo/oh-my-codex/pull/3903) | @shenyankm | fix(team): scope legacy recovery journals to the owning worktree | MERGED ✓ |
| [#3904](https://github.com/Yeachan-Heo/oh-my-codex/pull/3904) | @Claude Code | fix(team): platform-aware legacy journal ownership and modules-only replay | MERGED ✓ |
| [#3902](https://github.com/Yeachan-Heo/oh-my-codex/pull/3902) | back-merge | Merge pull request #3902 from Yeachan-Heo/back-merge/v0.21.34 | MERGED ✓ |

**Not included:** #3900 (#3898 live-pin fix) is an open draft, blocked on a design decision. Kept in Known issues.

## Local gates

Pinned SHA `c6a41e75a04a77c7507b5987246abad80029ac9a` (release/omx-0.21.35 HEAD):

Verified at 02:17Z on 2026-10-24

### Build and typecheck
- ✓ `bun run build` passes
- ✓ `bun run typecheck` passes
- ✓ No eslint violations

### Tests
- ✓ Team runtime tests pass
- ✓ Legacy recovery tests pass
- ✓ All test suites pass

## CI gates

- ✓ Candidate is the pinned commit (c6a41e75 release/omx-0.21.35 HEAD)
- ✓ All version surfaces bumped to 0.21.35
- ✓ macOS Ralplan preflight security (Node 20) PASSED
- ✓ macOS Ralplan preflight security (Node 26.5.1) PASSED
- ✓ Coverage Gate (Team Critical) PASSED
- ✓ Latest-per-name CI checks: 17 success, 8 skipped, 0 failures

## Known gaps and issues

- #3898 (live-pin fix): In progress via #3900. Codex 0.164.0 hook validation invalidated by `.omx-live-pin` files in the plugin cache. Workaround: manually clear `.omx-live-pin` if running Codex 0.164.0. This does not block the v0.21.35 release.

## Merge approval

**Codex review:** jq gate must print `[]` (no open findings). Latest Codex review targets the exact HEAD commit. All findings addressed.

**Ready for merge:** Yes. No blockers. PR passes all gates.

## Release notes

- Full Changelog link: [`v0.21.34...v0.21.35`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.34...v0.21.35)
- RELEASE_BODY.md: Updated to describe 0.21.35
- docs/release-notes-0.21.35.md: Created with full release notes

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
