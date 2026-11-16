# Release Back-Merge Merge Commit Requirement

## Overview

After every release to `main`, a back-merge PR must be created from `main` → `dev` to:
1. Restore the ancestry relationship (main is always an ancestor of dev)
2. Bring release documentation and version updates on main back into dev's history
3. Keep the two branches synchronized

## Merge Method: Always Use Merge Commit

**The back-merge PR MUST be merged using a two-parent merge commit, NEVER squash merge or rebase.**

### Why This Matters

- **Ancestry Integrity**: A squash merge breaks the invariant that `origin/main` should always be an ancestor of `origin/dev`. This creates diverged branches that will cause spurious conflicts in the next release cycle.
- **Contributor Attribution**: A merge commit preserves the full contributor history and commit context from the release. A squash merge loses this information.
- **Release Topology**: Release tags point to main commits that must be reachable from dev. If back-merge squashes the release commit into dev's history, the tag becomes unreachable from dev's commit parents.

### Impact of Squash-Merge (Anti-Pattern)

When a back-merge is squash-merged:
- `git merge-base --is-ancestor origin/main origin/dev` fails
- The next release PR will have spurious conflicts with release documentation and version files
- The release commit history becomes fragmented and harder to audit

## Procedure

When creating a back-merge PR (typically titled `back-merge: main into dev after vX.Y.Z`):

1. Create the PR against `dev` with base `dev` and head from a branch created from `origin/main`
2. Run all CI checks and verify they pass
3. **Before merging**, explicitly use the merge commit method:
   ```bash
   gh api -X PUT repos/OWNER/REPO/pulls/NUMBER/merge \
     -f merge_method=merge \
     -f sha=EXACT_HEAD_SHA
   ```
4. Verify the ancestry relationship after merge:
   ```bash
   git fetch origin
   git merge-base --is-ancestor origin/main origin/dev
   # Should exit 0 (success)
   ```

## GitHub UI Alternative

If using the GitHub UI:
1. Go to the PR
2. Click the merge dropdown
3. Select **"Create a merge commit"** (not "Squash and merge")
4. Complete the merge

## Repository Settings Check

Verify that the repository's branch protection rules for `dev` do NOT:
- Require squash-merge only (`required_linear_history`)
- Restrict merge commit method

If these settings are incorrectly configured, they must be updated to allow merge commits.

## Related Documents

- `docs/release-readiness-0.21.1.md` — Original specification of this requirement
- `docs/release-readiness-0.21.2.md` — Confirmed in subsequent release
- `.github/workflows/release.yml` — Release workflow that expects main to be an ancestor of dev

## Incident Record

PR #4092 (back-merge after v0.22.8) was incorrectly squash-merged, breaking the ancestry relationship. This was fixed by PR #4093, which restored the merge commit approach. This document prevents recurrence.
