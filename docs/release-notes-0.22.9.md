# Release Notes: oh-my-codex v0.22.9

## Highlights

### Code-Review Skill: Source-Bound Continuation and Repair Receipts

The code-review skill now captures and preserves source identity (commit hash, uncommitted changes, file hashes) in review receipts. Receipt structure now tracks scope identity, requirements, configured gates, review lane results, validation inputs/results, and unresolved findings independently. The skill enforces receipt-based invalidation rules: changed source, requirements, gates, or validation invalidate prior evidence and prevent unverifiable approval.

This change ensures that code review continuation always operates on verified scope and that repair re-review never substitutes lane results, maintaining invariants that first review runs both lanes in parallel on clean contexts and that standalone review stays read-only.

- **#4098**: Code-review skill source-bound continuation and repair receipts

## Merged PRs

- **#4098**: docs(code-review): source-bound continuation and repair receipts by Yeachan-Heo
- **#4094**: docs: add release back-merge merge-commit requirement (internal process doc)
- **#4093**: Merge pull request to restore ancestry main-dev (internal process fix)
- **#4092**: back-merge: main into dev after v0.22.8 release + bump to 0.22.9-dev (internal)

## Contributors

- Yeachan-Heo

## Full Changelog

Compare full changes: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.8...v0.22.9

**v0.22.9** was released on {{ release_date }} (UTC).
