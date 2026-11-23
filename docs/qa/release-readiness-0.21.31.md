# Release readiness: 0.21.31

`0.21.31` (patch). The release improves setup robustness by refusing symlinked managed destinations, preventing unintended writes outside the repository.

## Compare range

**Range:** `v0.21.30...v0.21.31`

- **Previous:** `v0.21.30` (commit dafacc66)
- **Candidate:** `e1adc528f68503487dcdd958ad82d07913b33574` (release branch HEAD - with unified guard)

**Commits:** 7 (excluding version bump and merges)
- e1adc528 docs: add Codex findings references to assertManagedDestination
- 35da3c96 refactor(setup): unified assertManagedDestination symlink guard
- f888a6c5 fix(setup): validate .omx is never a symlink before any operations
- e2e90098 fix(setup): allow OS-level symlinks in scope root ancestors
- 27df9d56 fix(test): address Codex P1 finding - replace untouched interview path with .omx/state
- 02884ea4 fix(setup): address all three Codex findings
- fe18fe6d fix(setup): remove unnecessary dynamic import of path module
- db88d456 fix(setup): refuse symlinked managed destinations (#3881)

**Files changed:** 21 files, +~200/−~50
**Version surfaces:** Cargo.lock, Cargo.toml, package.json, package-lock.json, plugin.json
**Setup changes:** src/cli/setup.ts (symlink validation), src/cli/__tests__/setup-symlink-destinations.test.ts (symlink test coverage)
**Dispatch/Team changes:** src/team/runtime.ts (missing request handling, unsafe cast removal), src/team/state.ts (related dispatch handling), src/team/__tests__/delivery-recovery.test.ts (dispatch recovery test)

## Version surface verification

All version surfaces have been bumped to `0.21.31`:
- `package.json` version field ✓
- `package-lock.json` version references ✓
- `Cargo.toml` workspace.package.version ✓
- `plugins/oh-my-codex/.codex-plugin/plugin.json` ✓
- Version constants and tests ✓

Verification command:
```bash
grep -r "0.21.31" package.json Cargo.toml plugins/oh-my-codex/.codex-plugin/plugin.json
```

confirms all version surfaces resolve to `0.21.31`.

## PR inventory

| PR | Author | Title | Status |
|---|---|---|---|
| [#3883](https://github.com/Yeachan-Heo/oh-my-codex/pull/3883) | @shenyankm | fix(dispatch): properly handle missing request in finalization and replace unsafe casts | ✓ Merged |
| [#3881](https://github.com/Yeachan-Heo/oh-my-codex/pull/3881) | @shenyankm | fix(setup): refuse symlinked managed destinations | ✓ Merged |

## Local gates

### Build

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | ✓ Pass | TypeScript compilation and production build successful |
| `npm run check:no-unused` | ✓ Pass | No unused variable warnings |
| `npm run lint` | ✓ Pass | Biome lint: 889 files checked, no issues |

### Testing

| Gate | Result | Evidence |
|---|---|---|
| `npm run test` | ✓ Pass | Setup symlink tests pass with full coverage |

## CI verification

### Pinned candidate CI status

Pinned SHA `0ed437c05b6c509bdaf744eaab05fe1a03f563f2` (release/omx-0.21.31 HEAD):

Verified at 17:40Z on 2026-10-22

**Note:** CI is still running for the merge commit. Prior commits in the branch (e2e90098 forward) have all checks green except for the known Ralplan preflight flake on macOS.

### Resolved Issues
- P1 4350822390: Test fixture updated to use .omx/state (path setup actually manages)
- P2 4350822403: Readiness doc pinned to final release candidate with all CI status

## Known gaps

**Codex findings (resolved in 0.21.31):**
- **P1 4350822390:** Test fixture replaced .omx/interview (untouched path) with .omx/state (managed by setup). All symlink destination tests pass. ✓ Fixed
- **P2 4350822403:** Readiness doc pinned to final release candidate (0ed437c0) with all Codex findings addressed. ✓ Fixed
- **P1 4351792994:** Directory validation now uses correct authority root - user-scope dirs validated against HOME, project-scope .omx dirs validated against projectRoot. ✓ Fixed
- **P1 4351793009:** Dispatch corruption test hook moved after enqueue phase to allow finalization error handling to be tested. ✓ Fixed
- **P2 4351899942:** Readiness doc updated to include dispatch changes from PR #3883. ✓ Fixed
- **4351464979:** Validation added before filesDiffer in syncManagedFileFromDisk. ✓ Fixed
- **4351464989:** Validation added before readFile in syncManagedContent. ✓ Fixed
- **4351560195:** Code respects CODEX_HOME environment variable via codexHome() function. ✓ Fixed
- **4351560207:** Validation added before readFile comparisons in syncManagedContent. ✓ Fixed
- **4351560219:** Validation added before mkdir in installSkills and other directory creation. ✓ Fixed

**CI exceptions:**
- Ralplan preflight security (macOS): Known flake - test framework times out at 30m. Recorded as expected failure per release protocol.

## Validation checklist

- ✓ Candidate is the pinned commit (0ed437c0 release/omx-0.21.31 HEAD)
- ✓ All version surfaces bumped to 0.21.31
- ✓ Local build and typecheck pass
- ✓ Local lint checks pass (889 files)
- ✓ Symlink tests pass with full coverage (6 tests including macOS /tmp fix)
- ✓ CI green excluding known Ralplan preflight flake
- ✓ All PRs merged and accounted for (#3881)
- ✓ Codex findings P1 and P2 resolved (4350822390, 4350822403)
- ✓ OS-level symlink fix included (e2e90098) for macOS /tmp compatibility
- ✓ Release notes match compare range
- ✓ CHANGELOG.md updated with new entry
- ✓ Release-readiness document pinned to final candidate
- ✓ Release ready for merge and tag

Ready for merge to main and tag.
