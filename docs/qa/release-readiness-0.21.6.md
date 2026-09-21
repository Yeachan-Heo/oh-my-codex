# Release readiness — 0.21.6

## Frozen candidate

- Previous immutable tag: `v0.21.5` → `cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7`; confirmed ancestor of the candidate (`git merge-base --is-ancestor` passes).
- Frozen candidate: `dev` head `750fdd08ef6b902c8ac9bb4f48d440ead87f6d12`.
- Frozen range: `v0.21.5..dev` — 52 commits, 101 files, +4294/−707 before release collateral.
- Release branch: `release/0.21.6`, prepared in a dedicated worktree from the frozen candidate (no shared worktree, no parent-checkout mutation).
- Full PR inventory and user-visible changes: `docs/release-notes-0.21.6.md`, `artifacts/release-0.21.6/inventory.md`.
- Authorization: repo owner (Yeachan-Heo) explicitly requested this release in the maintainer channel.

## Version carriers

`dev` already carried the post-0.21.5 development base `0.21.6`, so `package.json`, both `package-lock.json` root versions, workspace `Cargo.toml`, `Cargo.lock` workspace crates, and `plugins/oh-my-codex/.codex-plugin/plugin.json` are already synchronized to `0.21.6`; this release adds no version rewrite and the collateral commit is documentation-only.

## Verification

| Gate | Status / evidence |
|---|---|
| Previous-tag ancestry | Passed: `v0.21.5` is an ancestor of the frozen candidate |
| Exact-candidate `dev` CI | Passed: `750fdd08ef` → 17 successful checks, 8 platform-skipped, 0 failures / 0 pending |
| External-contribution evidence | #3660, #3668, #3683, #3684, #3685 each independently reproduced on a clean `origin/dev` base before merge; post-merge `dev` CI re-verified after each merge (#3684 and #3685 post-merge runs: 17 pass / 0 fail) |
| Backlog terminality at freeze | Open PRs 0; open issues 1 (#3655, owner-gated feature request answered in part by the #3663 evaluation suite) |
| Release collateral | `CHANGELOG.md`, `docs/release-notes-0.21.6.md`, `RELEASE_BODY.md`, `artifacts/release-0.21.6/inventory.md`, this readiness record — all generated from the exact compare range, not from memory |

## Publish sequence

1. Merge the verified candidate to `main` via PR.
2. Wait for `main` CI green.
3. Push the annotated `v0.21.6` tag at the shipped `main` commit.
4. Wait for the tag-triggered Release workflow, then verify GitHub release assets and npm registry state.
5. Fast-forward `dev` to the shipped commit and bump `dev` to the next development base `0.21.7`.

## Publishing contract

Reviewed PR to `main`, exact candidate CI, annotated tag, native asset/manifest verification, and the existing `ci.yml` `workflow_dispatch` with exact `release_tag` / `release_sha` for trusted OIDC publishing. No administrator bypass beyond explicit owner authorization, no manual npm token, no tag movement, no blind retries.
