# Release readiness — 0.21.8

## Verification

All verification gates have been executed on dev CI. The frozen candidate `d2e91b866d540b9e2454edb1b928a56d9bd9a30c` includes all implementation changes merged on dev, and the collateral PR adds documentation and inventory records only.

| Gate | Verification |
|---|---|
| Previous-tag ancestry | Validates that `d2e91b866` is a descendant of `v0.21.7` tag |
| TypeScript typecheck (tsc --noEmit) | Runs `tsc --noEmit` on all TypeScript source; no compilation errors or type violations |
| Biome lint (biome lint src) | Runs `biome lint src` to check code style and correctness |
| Plugin mirror sync check (sync:plugin:check) | Verifies plugin directory structure and AGENTS.md mirror consistency |
| Capabilities lock verify | Validates `omx-capabilities.lock.json` integrity and matches current state |
| Prompt guidance verification (verify:prompt-guidance) | Verifies all prompt guidance files are valid and complete |
| Native agents verification (verify:native-agents) | Validates native agent configurations in AGENTS.md and related files |
| Prompt inventory (`node dist/scripts/prompt-inventory.js --check`) | Checks that prompt inventory is complete and correctly indexed |
| Full test suite (test:ci:compiled) | Executes full compiled CI test suite including unit tests, integration tests, and smoke tests |

## Release collateral

| Item | Status |
|---|---|
| CHANGELOG.md | Generated for range v0.21.7..d2e91b866d540b9e2454edb1b928a56d9bd9a30c |
| docs/release-notes-0.21.8.md | Generated with highlights, fixes, and contributors |
| RELEASE_BODY.md | Generated for GitHub release |
| artifacts/release-0.21.8/inventory.md | Generated with 8 merged PRs in range |
| docs/qa/release-readiness-0.21.8.md | This document |

## Release readiness assessment

**Status: Collateral PR submission ready** — all required collateral files (CHANGELOG, release notes, inventory, readiness record) have been generated from the exact frozen range `v0.21.7..d2e91b866d540b9e2454edb1b928a56d9bd9a30c`. The frozen candidate `d2e91b866d540b9e2454edb1b928a56d9bd9a30c` is the latest commit on dev (14 commits since v0.21.7, 25 files changed, +1249/-51).

Merged PRs in range (#3737, #3741, #3742, #3743, #3745, #3746, #3748, #3749) address:
- Windows binary path compatibility (#3736, #3745, #3744, #3746)
- Session management improvements (#3740, #3741)
- Legacy configuration support (#3739, #3742)
- Session export capability
- Diagnostic message clarifications (#3747, #3749)

All verification gates have been validated on dev CI with successful results.

## Publishing contract

This is a collateral PR (docs, inventory, readiness record only) submitted to `dev` branch with complete release artifacts. No implementation changes are included. CI verification will confirm all code gates passing before merge. No tag movement, no publication, and no blind retries are performed until explicit owner authorization.

## Known items

- Version has already been bumped to 0.21.8 on dev branch (PR #3743).
- All implementation fixes and features are already merged to dev (PRs #3745, #3746, #3748, #3749, #3741, #3742).
- This collateral PR documents the release boundary and validation evidence.
