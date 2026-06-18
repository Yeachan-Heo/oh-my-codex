# oh-my-codex 0.18.13

> Draft status: release-prep PR body source before tagging. Keep publication proof updates in `docs/qa/release-readiness-0.18.13.md` after PR CI, tag workflow, GitHub release creation, and npm publication.

`0.18.13` is a patch release after `0.18.12` focused on project-scoped resume/search discovery, safer setup and hook behavior, ralplan/autopilot consensus freshness, CI runner reliability, sidecar/team state alignment, geobench documentation/schema fixes, and release-readiness cleanup after the `0.18.12` promotion topology. It preserves the existing CLI/package contract while tightening release, session, hook, and workflow edge cases discovered after `0.18.12`.

## Highlights

- **Project resume/search discovery is more complete** — project-scoped runtime Codex homes are included in `omx resume` and `omx session search`, with `--project` and `--codex-home` escape hatches documented for narrower or explicit lookup.
- **Setup and hook handling is safer** — generated native-agent TOMLs preserve user customization, setup overwrite behavior is covered, hook JSON state compatibility is hardened, and project Codex transcripts are preserved during cleanup.
- **Ralplan and Autopilot gates are fresher** — consensus freshness checks, tracker-backed native reviews, and Autopilot ralplan handoff validation are hardened.
- **CI and release infrastructure is sturdier** — workflows move to GitHub-hosted runners where appropriate, dev-merge issue-close follow-up comments are best-effort, and release topology for `0.18.12` is explicitly accounted for before preparing `0.18.13`.
- **Geobench visibility is documented** — the curated geobench profile, visibility spec, romanization schema, and enriched profile schema are captured for repeatable benchmark configuration.

## Fixes / compatibility

- Existing CLI, plugin, native-agent, HUD, state, hook, package layout, and runtime contracts remain compatible with `0.18.12`.
- The release keeps npm/package layout compatibility and updates root/plugin/Cargo metadata to `0.18.13`.
- Open GitHub issues were empty at release-scope review time; open PRs #2840, #2839, #2838, and draft #2828 did not change the patch-release decision.

## Merged PR / commit inventory

#2816, #2817, #2820, #2821, #2824, #2826, #2829, #2831, #2832, #2833, #2836, #2843, #2845, #2846, plus direct geobench visibility/profile/schema commits.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.13.md`.

Local release-prep gates include version sync for `v0.18.13`, build, native-agent verification, plugin mirror/bundle checks, catalog docs check, focused changed-surface tests, dogfooding of built CLI/package surfaces, `npm pack --dry-run`, and `git diff --check`. Branch CI, tag-triggered release workflow, GitHub release proof, and npm publication proof remain post-PR/tag publication gates.

The GitHub release workflow remains the authoritative cross-platform native asset gate after tag push, including the uploaded `native-release-manifest.json`.

## Contributors

Thanks to the contributors who landed the `v0.18.12...v0.18.13` delta:

- [@Yeachan-Heo](https://github.com/Yeachan-Heo)
- [@app/dependabot](https://github.com/apps/dependabot)
- [@iqdoctor](https://github.com/iqdoctor)

**Full Changelog**: [`v0.18.12...v0.18.13`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.12...v0.18.13)
