# Release Readiness: oh-my-codex v0.22.8

## Release Scope

- **Previous version**: v0.22.7 (commit 08d569cd6 on main)
- **Candidate branch**: origin/dev (commit cbb0d870a)
- **Release version**: v0.22.8
- **Compare range**: v0.22.7..v0.22.8

## Compare Range Verification

```bash
git merge-base --is-ancestor v0.22.7 origin/dev
# ✓ v0.22.7 is ancestor of origin/dev
```

## Commit Inventory (v0.22.7..origin/dev)

```
cbb0d870a (HEAD -> release/0.22.8, origin/dev, dev) fix(#4086): make stale team lock Stop output terminal (continue:false) (#4090)
98f37a9f6 fix(hooks): stop continuation on team_lock_recovery_required instead of looping (#4087)
b76d82587 Merge pull request #4085 from Yeachan-Heo/back-merge/main-to-dev-0.22.7
4404f3ca5 fix: update Cargo.toml version to 0.22.8-dev
ed8b0cf17 fix: update plugin manifest version to 0.22.8-dev
c195fed1a chore(dev): bump version to 0.22.8 after v0.22.7 release
4ed9f65b8 back-merge: main into dev after v0.22.7
a023e9ef1 docs(agents): prioritize complete, maintainable repairs over small diffs (#4083)
04787be7a chore(dev): bump version to 0.22.7 (#4081)
f1d4fd531 back-merge: main into dev after v0.22.6 (#4080)
```

## Merged PR Inventory

User-facing changes:
- **#4090**: fix(#4086): make stale team lock Stop output terminal (continue:false) by Yeachan-Heo
- **#4087**: fix(hooks): stop continuation on team_lock_recovery_required instead of looping by Yeachan-Heo

Back-merge and version metadata:
- **#4085**: back-merge: main into dev after v0.22.7 by Yeachan-Heo

Previous versions (already in v0.22.7):
- **#4083**: docs(agents): prioritize complete, maintainable repairs over small diffs by Yeachan-Heo
- **#4081**: chore(dev): bump version to 0.22.7 by Yeachan-Heo
- **#4080**: back-merge: main into dev after v0.22.6 by Yeachan-Heo

## Version File Updates

Updated the following files from 0.22.8-dev to 0.22.8:

- ✓ package.json
- ✓ package-lock.json
- ✓ Cargo.toml (workspace version)
- ✓ Cargo.lock
- ✓ plugins/oh-my-codex/.codex-plugin/plugin.json

## Release Collateral

- ✓ CHANGELOG.md (updated with v0.22.8 entry)
- ✓ docs/release-notes-0.22.8.md (created)
- ✓ docs/qa/release-readiness-0.22.8.md (this file)
- ○ RELEASE_BODY.md (to be generated and validated)

## Local Gates

Pending execution after release branch creation:

- [ ] TypeScript compilation check
- [ ] Local test suite
- [ ] Release body validation via `generate-release-body.js`

## Known Gaps

None. All user-facing changes are documented in #4087 and #4090. Back-merges and version metadata are standard release procedure.

## CI Status

Dev CI on cbb0d870a passed at submission:
- 24 successes
- 1 skipped

Awaiting main branch CI green after PR merge.

## Release Readiness

This release is ready for publication pending:
1. ✓ Version files updated to 0.22.8
2. ✓ Release notes and changelog created
3. ○ PR to main opened and CI passed
4. ○ Tag created and tag workflow passed
5. ○ GitHub release body verified non-draft
6. ○ npm registry verification

Updated 2026-11-16 UTC.
