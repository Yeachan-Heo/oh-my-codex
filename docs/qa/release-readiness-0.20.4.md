# Release readiness — 0.20.4

## Release readiness record

This record is the readiness declaration for the frozen `0.20.4` candidate. It captures the compare-range inventory, local gate evidence collected on 2026-07-28, and external CI/tag/npm evidence recorded as the publish sequence completes.

## Release identity

- Release: `0.20.4` (patch; includes one additive, backward-compatible feature, #3241/#3242).
- Date: 2026-07-28.
- Previous tag: `v0.20.3`.
- Frozen dev base: `73cb50c125c11aca0654b8841e690f011eb5f43f`.
- Exact compare range: `v0.20.3..73cb50c125c11aca0654b8841e690f011eb5f43f`.
- Ancestry: `git merge-base --is-ancestor v0.20.3 dev` passes; `merge-base(v0.20.3, dev-HEAD)` equals the v0.20.3 commit `2e666461d4147fa4718691f7b4d9a1a282380f16`.
- Range size: 130 commits — 62 merged product PRs (one additive feature plus reliability, workflow-safety, native-hook trust, and path-canonicalization fixes), plus squash-merged constituents and dependency bumps.
- Compatibility: no intentional breaking CLI or package-layout changes.

## Frozen commit inventory

The full commit/PR inventory is in `docs/release-notes-0.20.4.md` and `artifacts/release-0.20.4/inventory.md`. The merged product PR set is #3145, #3160, #3214, #3216, #3219, #3228, #3229, #3230, #3231, #3232, #3233, #3235, #3237, #3238, #3240, #3241, #3242, #3244, #3248, #3249, #3250, #3251, #3252, #3254, #3255, #3258, #3259, #3260, #3262, #3264, #3265, #3267, #3271, #3272, #3273, #3276, #3277, #3280, #3284, #3285, #3289, #3290, #3292, #3293, #3294, #3295, #3296, #3297, #3298, #3299, #3300, #3304, #3305, #3308, #3311, #3312, #3313, #3314, #3317, #3318, #3324, #3326, #3328, #3330, #3331, #3332, #3333, #3335, #3337, #3339, #3340, #3343, #3346, #3347, #3348, #3349, #3350, #3351, #3352, and #3353. Reproduce with:

```sh
git log --reverse --format='%H%x09%s' v0.20.3..73cb50c125c11aca0654b8841e690f011eb5f43f
```

Any mismatch blocks release preparation.

## Required gates

| Gate | Evidence | Status |
|---|---|---|
| Collateral/range review | Confirmed the frozen 130-commit range, 62 merged PRs, classifications, highlights, contributors, and compare link across `CHANGELOG.md`, `docs/release-notes-0.20.4.md`, `RELEASE_BODY.md`, and this record against `git log v0.20.3..dev`. | Passed locally |
| Release-scope review | Candidate ships the current `dev` tip `73cb50c12`. Release-prep pass adds only release-collateral files and version-carrier bumps; no product-runtime source, dependency, lockfile, or workflow change is introduced by the release-prep pass. Version metadata is `0.20.4` in `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, and `plugins/oh-my-codex/.codex-plugin/plugin.json`. | Passed locally |
| Local static gates | `npm ci`, `npm run build`, `npm run lint`, `npm run verify:plugin-bundle`, `npm run verify:native-agents`. | Pending (local gate run) |
| Local Node tests | `npm run test:node` for the touched surface. | Pending (local gate run) |
| Release-body generation | `node dist/scripts/generate-release-body.js --template RELEASE_BODY.md --current-tag v0.20.4 --previous-tag v0.20.3 --repo Yeachan-Heo/oh-my-codex` | Pending (local gate run) |
| CI | `dev` and `main` CI green for the exact shipped commit. | Pending (publish sequence) |
| Tag and release | Annotated `v0.20.4` peels to the shipped commit; release workflow completes all native builds, asset publication/verification, packed-install smoke, and npm publication. | Pending (publish sequence) |
| npm publication | `npm view oh-my-codex@0.20.4` returns `0.20.4`. | Pending (publish sequence) |
| Public registry install | Isolated public-registry install boots and reports `oh-my-codex v0.20.4`. | Pending (publish sequence) |

## Known gaps

- **Environment/platform-gated local test suites.** The Linux CI boundary is authoritative for platform-gated suites. Any local failures matching the v0.20.3 baseline on this workstation are documented during the local gate run (Phase B) and are not v0.20.4 regressions if they reproduce identically at the v0.20.3 baseline.
- **Contributors.** The range includes external contributors: @achieve0410 (#3260, #3308), @bohe76 (#3260), @chief-impact7 (#3273), @don9x2E (#3233), @huajuan404 (#3347), @ictechgy (#3265), @lux-02 (#3276), @masterFoad (#3238), @WangErgouaaaa (#3235, #3244), plus @app/dependabot for dependency updates. The maintainer (Yeachan Heo, @Yeachan-Heo) authored the majority of commits.

## Compatibility

This patch release has no intentional breaking CLI or package-layout changes; the one feature (#3241/#3242) is additive and backward-compatible.

## Publish sequence (RELEASE_PROTOCOL.md §5)

1. Push the candidate collateral commit to `dev`; wait for `dev` CI green for the shipped commit.
2. Promote the candidate to `main` through the normal CI path; wait for `main` CI green.
3. Create and push the annotated `v0.20.4` tag; wait for the tag-triggered release workflow (native builds, asset publication/verification, packed-install smoke, npm publication).
4. Verify the non-draft GitHub release with native assets/manifest attached and `npm view oh-my-codex version` == `0.20.4`.
5. Fast-forward `dev` to the shipped `main` commit; wait for final `dev` CI green.
6. Bump `dev` metadata to the next development base version (`0.20.5`).

## Release notes and contributors

The product-facing summary is in `docs/release-notes-0.20.4.md`, the GitHub body is `RELEASE_BODY.md`, and the changelog entry is `CHANGELOG.md`. The compare link is [`v0.20.3...v0.20.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.3...v0.20.4).
