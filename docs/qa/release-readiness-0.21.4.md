# Release readiness — 0.21.4

## Identity

- Release: `0.21.4` patch.
- Previous tag: `v0.21.3` (`2da36489cfa07ef1df802f01865e7d959d36f236`).
- Frozen candidate: `dev@b08eceeecc7a7379f041ceca51260f073d8a95bb`.
- Range: 3 commits, 35 files, +364/−195; PRs #3615/#3618/#3622.
- Owner authorization: end-to-end 0.21.4 release/main/tag/npm authority from Discord channel `1480171106324189335`, message `1545950894741393528`, with Astra switch expressly approved in message `1545955243811016766`.
- Release tracker: [#3624](https://github.com/Yeachan-Heo/oh-my-codex/issues/3624).
- Work-start evidence: [issue comment 5555864864](https://github.com/Yeachan-Heo/oh-my-codex/issues/3624#issuecomment-5555864864).

## Version carriers

- `package.json` → 0.21.4.
- `package-lock.json` root + self entry → 0.21.4.
- `Cargo.toml` `[workspace.package]` → 0.21.4.
- `plugins/oh-my-codex/.codex-plugin/plugin.json` → 0.21.4.

## Included work

- #3622 — Astra defaults across OMX agent tiers and SparkShell summaries while preserving explicit model/provider/profile/effort choices.
- #3618 — agent catalog and workflow documentation aligned with the packaged active/internal role catalog and current workflow guidance.
- #3615 — synchronized development base-version carriers advanced to 0.21.4 after the 0.21.3 release.

## Known gaps

- [#3623](https://github.com/Yeachan-Heo/oh-my-codex/issues/3623) remains open, separately owned, unmerged, and outside the frozen candidate. It confirms a doctor/setup diagnostic and configuration compatibility bug around Codex CLI 0.153.4's removed `plugin_hooks` flag. The report's native `hooks/list` evidence recognized the installed plugin hooks, so runtime hook failure is not established. This release does not claim #3623 fixed.
- `Cargo.lock` still records OMX workspace crate package versions as `0.20.5`, unchanged from the v0.21.3 shipped state. Release version sync is enforced from `Cargo.toml` workspace metadata and member manifests' `version.workspace = true`; the release does not silently rewrite the lockfile outside existing repository practice.

## Gates and evidence

| Gate | Status | Evidence |
|---|---|---|
| Previous tag is ancestor of frozen candidate | Passed | `git merge-base --is-ancestor v0.21.3 b08eceee...` |
| Full compare-range inventory and author attribution | Passed | `artifacts/release-0.21.4/inventory.md`; authors Bellman / `@Yeachan-Heo` and `@ev78394` |
| Frozen candidate `dev` CI | Passed | Exact `b08eceeecc7a7379f041ceca51260f073d8a95bb` run [34001800204](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34001800204): 24 successful jobs, 1 expected skipped publish job, 0 pending, 0 failed |
| Isolated focused release gates | Passed | Isolated `HOME`/XDG/Codex/OMX/npm directories: build, no-unused TypeScript check, native-agent verification, generated-artifact verification, release-body generator tests (6/6), and generated-body content/compare validation |
| Isolated full local `npm test` | Incomplete, no failure observed | The unchanged whole-product suite exceeded the 30-minute command deadline while running its 437 test files serially. Retained output reached late Team runtime/scaling suites with passing assertions and no reported failure before interruption. Exact candidate hosted CI is green; the full local suite was not repeated blindly. |
| Isolated packed-install smoke | Passed | `dist/scripts/smoke-packed-install.js` passed with isolated HOME/XDG/Codex/OMX/npm directories and a PATH that intentionally omitted the host's unsupported Codex 0.148 alpha binary. The first attempt correctly failed the script's exact Codex 0.142.5 boundary check; the rerun exercised the deterministic no-installed-Codex lifecycle rather than suppressing a product failure. |
| Release collateral PR to `dev`, exact-head CI, distinct adversarial review | Passed | PR [#3626](https://github.com/Yeachan-Heo/oh-my-codex/pull/3626), head `cdc5eb017ae69dcbfc2d7144158ced9deaadedcb`, diff SHA-256 `c8c86deda2dcc9bd00ce42d6cd9ecfc22aa793058c513490b412971c0d026fc1`, exact-head CI run [34004368972](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34004368972), distinct `MERGE_READY` review, merged as `0d5568565d1786d7215afc9c050fa73c42bb2741` |
| Exact merged-candidate `dev` CI | Passed | Run [34005314979](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34005314979) at `0d5568565d1786d7215afc9c050fa73c42bb2741`: 24 successful jobs, 1 expected skipped publish job, 0 pending, 0 failed |
| Protected-main promotion PR, exact-head CI, distinct adversarial review | Pending | Required before merge |
| Exact shipped-main CI | Pending | Required before tagging |
| Annotated `v0.21.4` at shipped main | Pending | Tag must peel to shipped main |
| Tag-triggered Release workflow and native assets/manifest | Pending | `.github/workflows/release.yml` |
| Exact tag/SHA OIDC npm trusted publish | Pending | `.github/workflows/ci.yml` `publish-npm-trusted` job; no token/manual publisher |
| Registry version and isolated clean install | Pending | `npm view oh-my-codex version` and clean isolated install |
| Final `dev` alignment and 0.21.5 base-version bump | Pending | Required after publication, with final CI |
| Signed issue closure | Pending | Only after all release stop conditions pass |

## Publish contract

1. Merge reviewed release collateral to `dev` without expanding the frozen product candidate beyond `b08eceeecc7a7379f041ceca51260f073d8a95bb`.
2. Promote the verified release candidate to protected `main` through a reviewed PR and wait for exact shipped-main CI.
3. Create and push annotated `v0.21.4` only at the shipped main commit.
4. Wait for the tag-triggered Release workflow to publish and verify all supported native archives plus `native-release-manifest.json`.
5. Dispatch the existing CI trusted-publishing path with `release_tag=v0.21.4` and `release_sha=<exact shipped main>` once; do not use manual npm credentials or repeat a failed publication attempt without new evidence.
6. Verify the GitHub Release is final, npm reports 0.21.4, and an isolated clean install works.
7. Fast-forward `dev` to shipped main, wait for CI, bump synchronized development metadata to 0.21.5, and wait for final `dev` CI.
