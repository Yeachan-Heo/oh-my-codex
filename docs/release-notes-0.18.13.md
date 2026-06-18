# oh-my-codex 0.18.13

> Release note status: pre-tag release-prep draft. Local validation evidence is tracked in `docs/qa/release-readiness-0.18.13.md`; final PR CI, dev/main promotion, tag workflow, GitHub release proof, and npm proof remain publication-stage evidence to append after those gates run.

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
- The largest user-visible change is additive discovery behavior for existing resume/session-search surfaces; no removed active command, package bin/engine break, or incompatible public schema change was found during release-scope review.

## Merged PR / commit inventory

Primary merged PR and commit evidence in the current dev candidate includes:

- #2846 — Improve project resume/search discovery.
- #2845 — Move CI workflows to GitHub-hosted runners.
- #2843 — Fix hooks JSON state compatibility.
- #2836 — Preserve project Codex transcripts on cleanup.
- #2833 — Bump `@biomejs/biome` from `2.4.16` to `2.5.0`.
- #2832 — Bump `@types/node` from `25.9.2` to `25.9.3`.
- #2831 — Suppress child-agent lifecycle notifications before canonical session reconcile.
- #2829 — Make deep-interview/RALPLAN Bash write detector target-aware.
- #2826 — Make dev-merge issue-close PR follow-up comments best-effort.
- #2824 — Align sidecar team state root with Team runtime.
- #2820 — Preserve customized native agent TOMLs.
- #2821 — Accept tracker-backed ralplan native reviews.
- #2817 — Fix Autopilot ralplan consensus freshness.
- #2816 — Harden ralplan consensus freshness gates.
- Direct geobench commits — add geobench visibility spec and curated profile; fix geobench enriched profile and romanization schemas.

## Issues

Open GitHub issues were empty at release-scope review time. Four open PRs were present and scoped as fixes/docs/warnings/safety follow-ups rather than release-version blockers: #2840, #2839, #2838, and draft #2828.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.13.md`.

Release-prep gates include version sync for `v0.18.13`, build, native-agent verification, plugin mirror/bundle checks, catalog docs check, focused release-scope review, dogfooding of the built CLI/package surfaces, `npm pack --dry-run`, and `git diff --check`. Branch CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm publication proof remain publication-stage gates.

**Full Changelog**: [`v0.18.12...v0.18.13`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.12...v0.18.13)
