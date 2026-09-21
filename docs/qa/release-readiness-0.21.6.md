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

## Publication evidence

| Step | Evidence |
|---|---|
| Release collateral PR | #3687 merged to `dev` as `e39a25cd`; PR CI fully green (0 failures) |
| Protected-main promotion | PR #3689 (`dev`→`main`) all checks green, merged as `cdc24a71`. `main` requires a second reviewer; merged under the repo owner's explicit release authorization via admin merge. This is the single documented deviation from the default reviewed-PR path and it is the owner's own authorized action on their own repository |
| Main CI | `cdc24a71` → 24 checks, 0 failures, 0 pending |
| Annotated tag | `v0.21.6` → `8dd3b425` dereferencing to `cdc24a71`; `v0.21.5` confirmed ancestor |
| Tag Release workflow | Run [35585264512](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/35585264512): conclusion `success`. All 8 native targets built, assets published, smoke-verified, packed global install smoke passed |
| GitHub release | `v0.21.6` non-draft, non-prerelease, 57 assets attached. Body regenerated via `dist/scripts/generate-release-body.js` with the curated contributor sentence retained instead of the distorted shortlog author list |
| Trusted OIDC npm publish | `ci.yml` `workflow_dispatch` with `release_tag=v0.21.6 release_sha=cdc24a71408ebd6bd0362f52170f0d7998f77007`, run [35587479707](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/35587479707). `npm publish` succeeded with signed provenance (sigstore log index 2905494473); the job's own 5-minute registry-propagation poll expired at 10:18:14Z and the run is marked `failure` for that wait only. No manual npm token was used and no republish was attempted |
| Registry verification | Registry metadata confirms `0.21.6` published at 10:19:18Z with `dist-tags.latest = 0.21.6`; attestations expose `https://slsa.dev/provenance/v1` and the npm publish attestation |
| Final `dev` alignment | `dev` fast-forwarded to the shipped commit `cdc24a71`, then bumped to the next development base `0.21.7` across `package.json`, both `package-lock.json` roots, `Cargo.toml`, the 6 workspace `Cargo.lock` entries, and the plugin manifest (`check-version-sync` → `package=0.21.7 workspace=0.21.7`) |

## Known gaps

- The publish run's terminal conclusion is `failure` solely because npm registry propagation exceeded the workflow's fixed 5-minute poll window. The artifact itself is published, provenance-signed, and `latest`. No tag was moved and no retry publish was issued.

## Publishing contract

Reviewed PR to `main`, exact candidate CI, annotated tag, native asset/manifest verification, and the existing `ci.yml` `workflow_dispatch` with exact `release_tag` / `release_sha` for trusted OIDC publishing. No administrator bypass beyond explicit owner authorization, no manual npm token, no tag movement, no blind retries.
