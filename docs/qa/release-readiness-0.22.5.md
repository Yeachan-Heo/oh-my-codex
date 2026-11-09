# Release Readiness: 0.22.5

## Compare Range

- **Previous release**: v0.22.4
- **Candidate commit**: `684c46b67` (dev HEAD at release time)
- **Comparison**: `git log v0.22.4..684c46b67`

## PR Inventory

1. **#4067** — FAIL CLOSED ON TASK READS AND STALE REPLY TARGETS (fix, @shenyankm)
   - Commit: `a91db393a`
2. **#4068** — PRESERVE MEMORY WRITES, SECRETS, AND API AVAILABILITY (fix, @shenyankm)
   - Commit: `2196916f1`
3. **#4066** — bump dev to 0.22.5 (infra)
   - Commit: `684c46b67`

## Gates

- Latest-per-name CI on dev `a91db393a` (pre-bump #4067): passed.
- Latest-per-name CI on dev `2196916f1` (pre-bump #4068): passed.
- PR #4067 CI: passed on merged head.
- PR #4068 CI: passed on merged head.
- Release PR CI: required before merge.

## Known gaps

- **CI infrastructure issue on version-only commits**: The dev CI for the version bump commit (684c46b67) is encountering a GitHub Actions workflow configuration issue where `build-dist` is skipped despite `full_suite=true`, causing dependent jobs to be skipped. This is a workflow infrastructure issue, not a code problem. All product code changes (PRs #4067, #4068) passed CI on their original commits. The version-bump-only commit is syntactically and semantically valid.

## Validation rationale

- Product changes (PRs #4067, #4068) from `v0.22.4` have been validated through full CI on their respective commits.
- The version bump commit (684c46b67) changes only `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, and plugin manifest — purely metadata with no code logic changes.
- Mergeable status and full CI pass on the combined state (dev HEAD after all three PRs) will be verified before promoting to main.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
