# Release Readiness: oh-my-codex v0.22.9

## Release Scope

- **Previous version**: v0.22.8 (commit c860bc0b9 on main)
- **Candidate branch**: origin/dev (commit 40dc73197)
- **Release version**: v0.22.9
- **Compare range**: v0.22.8..v0.22.9

## Compare Range Verification

```bash
git merge-base --is-ancestor v0.22.8 origin/dev
# ✓ v0.22.8 is ancestor of origin/dev
```

## Commit Inventory (v0.22.8..origin/dev)

```
40dc73197 (HEAD -> release/0.22.9, origin/dev, dev) docs(code-review): source-bound continuation and repair receipts (#4098)
c4d165131 docs: add release back-merge merge-commit requirement (#4094)
5d0de5095 Merge pull request #4093 from Yeachan-Heo/restore-ancestry-main-dev
93cfb795f chore: restore main ancestry in dev after v0.22.8 (merge commit)
70a7d1fac back-merge: main into dev after v0.22.8 release + bump to 0.22.9-dev (#4092)
```

## Merged PR Inventory

User-facing changes:
- **#4098**: docs(code-review): source-bound continuation and repair receipts by Yeachan-Heo

Internal process and back-merge:
- **#4094**: docs: add release back-merge merge-commit requirement by Yeachan-Heo
- **#4093**: Merge pull request to restore ancestry main-dev by Yeachan-Heo
- **#4092**: back-merge: main into dev after v0.22.8 release + bump to 0.22.9-dev by Yeachan-Heo

## Version File Updates

Updated the following files from 0.22.9-dev to 0.22.9:

- ✓ package.json
- ✓ package-lock.json
- ✓ Cargo.toml (workspace version)
- ✓ Cargo.lock
- ✓ plugins/oh-my-codex/.codex-plugin/plugin.json

## Release Collateral

- ✓ CHANGELOG.md (updated with v0.22.9 entry)
- ✓ docs/release-notes-0.22.9.md (created)
- ✓ docs/qa/release-readiness-0.22.9.md (this file)
- ○ RELEASE_BODY.md (to be generated and validated)

## Local Gates

Pending execution after release branch creation:

- [ ] TypeScript compilation check
- [ ] Local test suite
- [ ] Release body validation via `generate-release-body.js`

## Known Gaps

None. User-facing content is documented in #4098 (code-review skill improvements). Back-merges and version metadata are standard release procedure.

## CI Status

Dev CI on 40dc73197 passed at submission:
- 24 successes
- 1 skipped

Awaiting main branch CI green after PR merge.

## Release Readiness

This release is ready for publication pending:
1. ✓ Version files updated to 0.22.9
2. ✓ Release notes and changelog created
3. ○ PR to main opened and CI passed
4. ○ Tag created and tag workflow passed
5. ○ GitHub release body verified non-draft
6. ○ npm registry verification

Updated 2026-11-17 UTC.
