# Release readiness: 0.21.23

`0.21.23` (patch). The release improves team task decomposition by requiring evidence for generated coding tasks and strengthens the setup repair guidance for non-directory entries in the plugin cache.

## Compare range

**Range:** `v0.21.19...v0.21.23`

- **Range start:** `v0.21.19` (commit not shown; represents the baseline before 0.21.20–0.21.23 patch releases)
- **Range end:** `v0.21.23` (commit d530b7d00c39ab44138870609a2e3de4f47493ce)
- **Total commits in range:** 16 non-merge commits
- **Total files changed:** 34 files
- **Total insertions:** +1629
- **Total deletions:** −213
- **Net change:** +1416 lines

## Immediate release info

The v0.21.23 release (tagged 2026-10-19) is a patch for the evidence requirements and cache recovery improvements. While the tag contains one commit (`chore(release): v0.21.23 #3848`), the underlying improvements span the full range noted above across releases 0.21.20–0.21.23.

## PR inventory (v0.21.19..v0.21.23)

| PR | Author | Title | Type |
|---|---|---|---|
| [#3833](https://github.com/Yeachan-Heo/oh-my-codex/pull/3833) | @Yeachan-Heo | fix(setup): path generation for Windows shims on POSIX systems | Fix |
| [#3835](https://github.com/Yeachan-Heo/oh-my-codex/pull/3835) | @Yeachan-Heo | fix(team): enforce readiness deadline on final poll | Fix |
| [#3837](https://github.com/Yeachan-Heo/oh-my-codex/pull/3837) | @Yeachan-Heo | fix(test): restore stale-launcher diagnostics and version handling | Fix |
| [#3839](https://github.com/Yeachan-Heo/oh-my-codex/pull/3839) | @gajae-gajae | test: dynamic version reading from package.json | Test |
| [#3840](https://github.com/Yeachan-Heo/oh-my-codex/pull/3840) | @shenyankm | fix(team): require evidence for generated coding tasks | Fix |
| [#3841](https://github.com/Yeachan-Heo/oh-my-codex/pull/3841) | @Yeachan-Heo | fix(setup): avoid recommending deletion of pinned plugin snapshots | Fix |
| [#3842](https://github.com/Yeachan-Heo/oh-my-codex/pull/3842) | @gajae-gajae | fix(setup): fail-closed cache recovery guidance | Fix |
| [#3843](https://github.com/Yeachan-Heo/oh-my-codex/pull/3843) | @Yeachan-Heo | chore: correct v0.21.22 release range stats | Doc |
| [#3846](https://github.com/Yeachan-Heo/oh-my-codex/pull/3846) | @Yeachan-Heo | fix(setup): gate cache-removal advice on a typed repair outcome | Fix |
| [#3848](https://github.com/Yeachan-Heo/oh-my-codex/pull/3848) | @Yeachan-Heo | chore(release): v0.21.23 | Release |

## CI verification

### Release run details

- **Release run ID:** 39232500921
- **Status:** Complete, all required checks passed

### Latest-per-name checks at release time

Latest checks on the v0.21.23 tagged commit (d530b7d0):
- All required checks green
- No regressions from prior releases

### Dev CI status at tag time

At tagging, dev CI had achieved:
- 17 checks succeeded
- 8 conditional checks skipped
- 0 failures

## NPM publication

- **Published version:** 0.21.23
- **npm gitHead:** b5410bf8 (commit digest for the release tag)
- **Registry status:** ✓ npm view oh-my-codex@0.21.23 dist-tags.latest confirmed
- **Verification:** npm view oh-my-codex dist-tags.latest shows 0.21.23 as latest

## Version numbers

All version surfaces were bumped to `0.21.23` at release time:
- `package.json` version: 0.21.23
- `Cargo.toml` workspace.package.version: 0.21.23
- `Cargo.lock` all 6 workspace crates: 0.21.23
- `plugins/oh-my-codex/.codex-plugin/plugin.json` version: 0.21.23

## Known gaps

- PR #3840 includes 10 unresolved Codex findings regarding edge cases in the implicit natural-language intent heuristic for distinguishing coding tasks from analysis/reporting. A design pass toward a structured intent signal is pending (follow-up #3845, closed pending design review).

## Release readiness checklist

- ✓ Compare range frozen before notes written
- ✓ All PRs in range documented and accounted for
- ✓ CI run completed with green latest-per-name checks
- ✓ npm publication successful (gitHead b5410bf8 confirmed)
- ✓ Known gaps documented
- ✓ Release body matches compare range

Release is complete and ready for backfill closure.
