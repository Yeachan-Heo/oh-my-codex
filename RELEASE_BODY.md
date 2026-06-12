# oh-my-codex 0.18.12


> Draft status: release-prep PR body source before tagging. Keep publication proof updates in `docs/qa/release-readiness-0.18.12.md` after PR CI, tag workflow, GitHub release creation, and npm publication.

`0.18.12` is a patch release after `0.18.11` focused on release-workflow reconciliation, safer runtime automation gates, plugin guidance preservation, Windows hook/state robustness, and HUD/session cleanup. It preserves the existing CLI/package contract while tightening release and operator edge cases discovered after `0.18.11`.

## Highlights

- **Release workflow history is reconciled for 0.18.12** — the release prep branch carries the main manual npm publishing workflow and npm auth configuration history forward while keeping the local prep boundary intact: no tag, no main merge, and no local npm publish.
- **Automation and planning gates are stricter** — Autopilot final gates, best-practice-research read-only enforcement, ralplan consensus guards, deep-interview artifact writes, and Windows-safe `omx state` input handling reduce unsafe or confusing execution paths.
- **Plugin guidance handling is safer** — persistent AGENTS guidance, setup plugin agent merge repair, developer-instruction prompt policy, setup mode inference, JSON fallback, and cleanup preservation are all hardened.
- **HUD/session behavior is more reliable** — stale HUD cleanup, dev version labels, owner matching, terminal skill-active visibility, cancel run-dir visibility, and detached history pruning are tightened.
- **Windows hook paths are safer** — hook shims preserve `Path`, emit `omx.cmd`, use absolute PowerShell hook paths, and include UTF-8 BOM handling for non-ASCII install paths.

## Fixes / compatibility

- Existing CLI, plugin, native-agent, HUD, state, hook, and package layout contracts remain compatible with `0.18.11`.
- The release keeps npm/package layout compatibility and updates root/plugin/Cargo metadata to `0.18.12`.
- Open GitHub PR and issue inventory was empty at release prep time.

## Merged PR inventory

#2760, #2762, #2765, #2766, #2768, #2771, #2773, #2774, #2776, #2798, #2800, #2801, #2802, #2805, #2806, #2810, #2812.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.12.md`.

Local release-prep gates include build, version sync for `v0.18.12`, lint, no-unused, native-agent verification, plugin mirror/bundle checks, catalog docs check, focused hook/state tests, `npm pack --dry-run`, and `git diff --check`. Branch CI, tag-triggered release workflow, GitHub release proof, and npm publication proof remain post-PR/tag publication gates.

The GitHub release workflow remains the authoritative cross-platform native asset gate after tag push, including the uploaded `native-release-manifest.json`.

## Contributors

Thanks to the contributors who landed the `v0.18.11...v0.18.12` delta:

- [@Yeachan-Heo](https://github.com/Yeachan-Heo)
- [@app/dependabot](https://github.com/apps/dependabot)
- [@iqdoctor](https://github.com/iqdoctor)
- [@lifrary](https://github.com/lifrary)

**Full Changelog**: [`v0.18.11...v0.18.12`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.11...v0.18.12)
