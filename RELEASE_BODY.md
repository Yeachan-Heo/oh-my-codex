# oh-my-codex v0.22.9

## Summary

This minor release ships updated code-review skill with source-bound continuation and repair receipts. Review receipts now capture and preserve source identity (commit hash, uncommitted changes, file hashes), track scope, requirements, gates, and validation results independently for each review lane, and enforce invalidation rules preventing unverifiable approval of changed source or invalidated evidence.

## Added

- **CODE-REVIEW SKILL: SOURCE-BOUND CONTINUATION AND REPAIR RECEIPTS (#4098):** The code-review skill now captures source identity in review receipts, distinguishes review operation contexts (fresh review, missing-lane resumption, missing-validation collection, repair re-review, complete evidence termination), and prevents receipt reuse when source, requirements, gates, or validation change. Receipt-based invalidation rules ensure continuation always operates on verified scope and that repair re-review never substitutes lane results. First review runs both lanes in parallel on clean contexts; continuation never drops lanes. Standalone review stays read-only. Fixes #4095.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.9`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.9.md)).
- PR #4098 CI passed on merged head.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.8...v0.22.9`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.8...v0.22.9)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
