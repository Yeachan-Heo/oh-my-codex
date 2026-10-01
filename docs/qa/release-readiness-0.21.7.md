# Release readiness — 0.21.7

## Frozen candidate

- Previous immutable tag: `v0.21.6` → `8dd3b425afc8a526cfa8190e89c2a55a21f46fc9` (commit `cdc24a71408ebd6bd0362f52170f0d7998f77007`); confirmed ancestor of the candidate (`git merge-base --is-ancestor` passes).
- Frozen candidate: `release/0.21.7` head `38d27ed752d17f18690c43a2acc0f28c7a0e81ed`.
- Frozen range: `v0.21.6..38d27ed752d17f18690c43a2acc0f28c7a0e81ed` — 49 commits, 102 files, +7246/−642 before release collateral.
- Release branch: `release/0.21.7`, prepared in a dedicated worktree from the frozen candidate (no shared worktree, no parent-checkout mutation).
- Full PR inventory and user-visible changes: `docs/release-notes-0.21.7.md`, `artifacts/release-0.21.7/inventory.md`.
- Authorization: repo owner (Yeachan-Heo) explicitly requested this release in the maintainer channel.

## Version carriers

`dev` already carried the post-0.21.6 development base `0.21.7`, so `package.json`, both `package-lock.json` root versions, workspace `Cargo.toml`, `Cargo.lock` workspace crates, and `plugins/oh-my-codex/.codex-plugin/plugin.json` are already synchronized to `0.21.7`; this release adds no version rewrite and the collateral commit is documentation-only.

## Verification

| Gate | Status / evidence |
|---|---|
| Previous-tag ancestry | Passed: `v0.21.6` is an ancestor of the frozen candidate |
| TypeScript typecheck (tsc --noEmit) | Passed: no errors |
| Biome lint (biome lint src) | Passed: 860 files checked in 273ms, no issues |
| Plugin mirror sync check (sync:plugin:check) | Passed: verified 24 canonical skill directories and plugin metadata |
| Capabilities lock verify | Passed: omx-capabilities.lock.json is valid |
| Prompt guidance verification (verify:prompt-guidance) | Passed: prompt guidance check ok |
| Native agents verification (verify:native-agents) | Passed: verified 18 installable native agents and 32 setup prompt assets |
| Prompt inventory (`node dist/scripts/prompt-inventory.js --check`) | Passed: `prompt invariant check ok (29 skill cards checked)`; catalog docs (`node dist/scripts/generate-catalog-docs.js --check`): `catalog check ok` |
| Full test suite (test:ci:compiled) | Not run locally (host system npm is broken); verified by CI on collateral PR 3735 head before merge |

## Publication evidence

| Step | Evidence |
|---|---|
| Release collateral | `CHANGELOG.md`, `docs/release-notes-0.21.7.md`, `RELEASE_BODY.md`, `artifacts/release-0.21.7/inventory.md`, this readiness record — all generated from the exact compare range v0.21.6..38d27ed752d17f18690c43a2acc0f28c7a0e81ed |
| Pre-publication CI readiness | All 7 core gates passing (typecheck, lint, plugin-mirror, capabilities-lock, prompt-guidance, native-agents, prompt-inventory); full test suite gated on PR 3735 CI (not run locally) |
| Commit history integrity | 49 commits from 25 PRs across 102 files; all commits verified present in the frozen range |
| Version synchronization | `package.json` at 0.21.7, `Cargo.toml` at 0.21.7, plugin manifest at 0.21.7 — all previously synchronized on dev branch |

## Release readiness assessment

**Status: Ready for PR and publication review** — all critical gates (typecheck, lint, plugin verification, capabilities, prompt guidance, native agents) are passing. The full test suite was not run locally (host npm is broken); it is gated on PR #3735 CI before merge. The frozen candidate has been verified to have `v0.21.6` as an ancestor, contains 49 production commits with clear user-visible changes (plugin fixes, HUD optimization, model expansion), and the collateral documents (CHANGELOG, release notes, inventory, this readiness record) are complete and accurately reflect the range.

**Known issues:**
- System npm installation has missing dependencies (unrelated to release candidate); bun install verified all project dependencies are present and intact.
- Full CI test suite could not run due to the npm wrapper issue, but 7 out of 8 major gates all passed cleanly.

## Publishing contract

Reviewed PR to `dev` branch with complete release collateral, prior-tag ancestry verification, core-gate passing (typecheck, lint, plugin verification, capabilities, guidance, agents, inventory), and version carrier alignment. No administrator bypass required, no tag movement until publication, no blind retries.
