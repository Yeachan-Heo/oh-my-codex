# Release readiness — 0.20.3

## Release readiness record

This record is the readiness declaration for the frozen `0.20.3` candidate. It captures the compare-range inventory, local gate evidence collected on 2026-07-19, and external CI/tag/npm evidence recorded as the publish sequence completes.

## Release identity

- Release: `0.20.3` (patch; includes one additive, backward-compatible feature, #3143).
- Date: 2026-07-19.
- Previous tag: `v0.20.2`.
- Frozen dev base: `f967cfed64ec57614af136f75d7cb81509808f7e`.
- Exact compare range: `v0.20.2..f967cfed64ec57614af136f75d7cb81509808f7e`.
- Ancestry: `git merge-base --is-ancestor v0.20.2 dev` passes; `merge-base(v0.20.2, dev-HEAD)` equals the v0.20.2 commit `2e666461d4147fa4718691f7b4d9a1a282380f16`.
- Range size: 99 commits — 13 merged product PRs, four v0.20.2 post-publish evidence corrections carried forward, one release-development preparation commit, and the squashed-in constituents of PRs #3153, #3196, #3215, #3217, and #3218.
- Compatibility: no intentional breaking CLI or package-layout changes.

## Re-baseline note

An initial pass froze base `a03da9c0` (90 commits). Before publish, `origin/dev` advanced to `f967cfed` with 9 additional commits (PRs #3143, #3215, #3217, #3218). `a03da9c0` remained an ancestor of `f967cfed` (no divergence), so the range and all collateral were re-baselined to the current tip. The in-range ralplan-gate diagnostic-wording regression found in the first pass was fixed upstream in #3218, so no local test change is carried into the release.

## Frozen commit inventory

The full commit/PR inventory is in `docs/release-notes-0.20.3.md` and `artifacts/release-0.20.3/inventory.md`. The merged product PR set is #3135, #3143, #3153, #3186, #3187, #3191, #3192, #3196, #3201, #3211, #3215, #3217, and #3218. Issues #3121, #3127, #3181, #3194, #3195, #3199, #3203, and #3204 are associated issues, not additional PRs. Reproduce with:

```sh
git log --reverse --format='%H%x09%s' v0.20.2..f967cfed64ec57614af136f75d7cb81509808f7e
```

Any mismatch blocks release preparation.

## Required gates

| Gate | Evidence | Status |
|---|---|---|
| Collateral/range review | Confirmed the frozen 99-commit range, 13 merged PRs, classifications, highlights, contributors, and compare link across `CHANGELOG.md`, `docs/release-notes-0.20.3.md`, `RELEASE_BODY.md`, and this record against `git log v0.20.2..dev`. | Passed locally |
| Release-scope review | Candidate ships the current `dev` tip `f967cfed`. Release-prep pass adds only the four release-collateral files and the frozen-range inventory artifacts under `artifacts/release-0.20.3/`; no product-runtime source, dependency, lockfile, or workflow change is introduced by the release-prep pass. Version metadata is `0.20.3` in `package.json` and `Cargo.toml`. | Passed locally |
| Local static gates | Passed on `f967cfed`: `npm ci`, `npm run build`, `npm run lint` (753 files), `npm run verify:plugin-bundle` (29 canonical skill dirs), `npm run verify:native-agents` (22 native agents, 37 setup prompt assets). | Passed locally |
| Local Node tests | `npm run test:node` autopilot suite 25/25 (the first-pass ralplan-gate regression is fixed upstream in #3218). Remaining local failures are pre-existing environment/platform-gated suites already failing at the v0.20.2 baseline on this workstation (see Known gaps); they are green on Linux CI. | Passed with documented environment exceptions |
| Release-body generation | `node dist/scripts/generate-release-body.js --template RELEASE_BODY.md --current-tag v0.20.3 --previous-tag v0.20.2 --repo Yeachan-Heo/oh-my-codex` produced a body containing `## Contributors`, all thirteen PR numbers, the highlights, and the correct `**Full Changelog**: v0.20.2...v0.20.3` compare link. | Passed locally |
| CI | `dev` and `main` CI green for the exact shipped commit. | Pending (publish sequence) |
| Tag and release | Annotated `v0.20.3` peels to the shipped commit; release workflow completes all native builds, asset publication/verification, packed-install smoke, and npm publication. | Pending (publish sequence) |
| npm publication | `npm view oh-my-codex@0.20.3` returns `0.20.3`. | Pending (publish sequence) |
| Public registry install | Isolated public-registry install boots and reports `oh-my-codex v0.20.3`. | Pending (publish sequence) |

## Known gaps

- **Environment/platform-gated local test suites.** On this macOS workstation with the default `codex-cli 0.142.3`, the following suites fail identically at the v0.20.2 baseline and are therefore not v0.20.3 regressions; they are green on the Linux CI boundary:
  - `src/cli/__tests__/uninstall.test.ts` — macOS path/grammar-simulation cases (21 failures at the v0.20.2 baseline).
  - `src/scripts/__tests__/codex-native-hook.test.ts` and `src/scripts/__tests__/smoke-packed-install.test.ts` — live-CLI/version-boundary cases; `smoke-packed-install` fails with `Codex version resolution exceeded the 5000ms global deadline` because the workstation default is `0.142.3` (0.20.2 required an isolated `@openai/codex@0.142.5` for the same reason).
  - `src/team/__tests__/runtime.test.ts` and `src/team/__tests__/scaling.test.ts` — tmux-timing-sensitive suites that exceed local wall-clock budgets.
  The `dev`/`main` CI gate (Linux, pinned Codex boundary) is authoritative for these suites.
- **Contributors dedup at publish.** All commits in this range are the sole maintainer (Yeachan Heo, GitHub @Yeachan-Heo), committed under local identities `Yeachan-Heo`, `Bellman`, and `bellman`. The local (no-GitHub-API) `generate-release-body.js` shortlog renders "Thanks to Bellman and Yeachan-Heo …". Per `RELEASE_PROTOCOL.md` §3, the published body collapses this to the single maintainer in the prior release-train sentence format. No external contributors or dependabot commits are in this range.

## Compatibility

This patch release has no intentional breaking CLI or package-layout changes; the one feature (#3143) is additive and backward-compatible.

## Publish sequence (RELEASE_PROTOCOL.md §5)

1. Push the candidate collateral commit to `dev`; wait for `dev` CI green for the shipped commit.
2. Promote the candidate to `main` through the normal CI path; wait for `main` CI green.
3. Create and push the annotated `v0.20.3` tag; wait for the tag-triggered release workflow (native builds, asset publication/verification, packed-install smoke, npm publication).
4. Verify the non-draft GitHub release with native assets/manifest attached and `npm view oh-my-codex version` == `0.20.3`.
5. Fast-forward `dev` to the shipped `main` commit; wait for final `dev` CI green.
6. Bump `dev` metadata to the next development base version (`0.20.4`).

## Release notes and contributors

The product-facing summary is in `docs/release-notes-0.20.3.md`, the GitHub body is `RELEASE_BODY.md`, and the changelog entry is `CHANGELOG.md`. Commit evidence identifies the sole maintainer Bellman (@Yeachan-Heo). The compare link is [`v0.20.2...v0.20.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.2...v0.20.3).
