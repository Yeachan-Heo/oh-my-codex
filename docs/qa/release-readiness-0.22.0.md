# Release Readiness: 0.22.0

## Compare Range

- **Previous release**: v0.21.48
- **Candidate commit**: `2c7c464c` (release/0.22.0 branch, after version bump)
- **Comparison**: `git log v0.21.48..release/0.22.0`

## PR Inventory

Product changes merged into dev since v0.21.48:

1. **#4006** — HERDR TEAM RUNTIME BACKEND PHASE 2 (feat)
   - Native session pane coordination
   - Detached-launch design notes
   - Improved tmux integration patterns
   - Commit: `8a66a2ee`

2. **#4036** — RESERVE WORKER CAPACITY, RENEW TASK CLAIMS, AND GATE DELIVERY COMPLETION (fix)
   - Followup bounds and claim renewal
   - Lease gap closure and pending receipt recovery
   - Terminal handoff recognition
   - Worker capacity reservation
   - Commit: `1565a9c6`

3. **#4035** — FAIL CLOSED ON GIT CONFLICTS AND HAND OFF PERSISTED TASK CLAIMS (fix)
   - Automatic conflict resolution removal (-X theirs/-X ours)
   - Explicit conflict visibility and manual resolution
   - Conflict state preservation
   - Task assignment protocol alignment
   - Commit: `cd48849d`

4. **#3915** — ADD EXECUTION COMPARISONS AND REGRESSION GATES (feat)
   - Execution snapshot capture
   - Session comparison against baselines
   - Regression detection during multi-agent workflows
   - Commit: `b3e0a0e1`

**Excluded**: PR #4034 as requested.

## Local Gates

- `npm ci` — passed; all dependencies installed.
- `npm run build` — passed; TypeScript compilation successful.
- `npm test` — passed; full test suite including runtime, Node tests, catalog generation, and prompt inventory validation.
- `npm run lint` — passed; 900+ files checked with Biome.
- Cargo build — passed; Rust runtime components compile without errors.

## Validation Evidence

- All merged PRs are represented in release notes and CHANGELOG.
- Release notes accurately reflect the compared range from v0.21.48 to release/0.22.0.
- RELEASE_BODY.md template includes major changes and is ready for generation.
- Version numbers synchronized across package.json, package-lock.json, Cargo.toml, and plugin.json.
- No commits after the version-bump commit are included.

## Known Gaps

None identified.

## Merge Status

Release branch `release/0.22.0` contains:
- Version bump commit: `2c7c464c`
- All product changes from v0.21.48..dev

Ready for merge to main and publication.
