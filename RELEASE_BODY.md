# oh-my-codex 0.18.11

`0.18.11` is a patch release after `0.18.10` that completes the `omx explore` command-surface deprecation, adds Spark/model lane routing diagnostics to `omx doctor`, and hardens launch-time tmux HUD behavior. It preserves existing package layout and CLI compatibility while removing stale explore guidance and narrowing HUD/diagnostic edge cases.

## Highlights

- **`omx explore` command surface is hard-deprecated** — the explore command surface is fully retired, and remaining `omx explore` mentions are removed from global AGENTS guidance so generated agent docs stop pointing at the deprecated lane.
- **`omx doctor` gains Spark/model lane routing diagnostics** — doctor now surfaces Spark/model lane routing state so misrouted model lanes are visible during diagnosis.
- **Launch-time HUD is safer in cramped tmux windows** — the launch-time HUD split is skipped inside cramped existing tmux windows, preventing unusable pane splits during startup.
- **Catalog gains the wiki skill manifest entry** — the wiki skill manifest entry is registered in the catalog so the skill is discoverable through the standard manifest surface.

## Fixes / compatibility

- Existing CLI, plugin, generated-agent, HUD, and diagnostic contracts remain compatible; this release retires the already-deprecated `omx explore` surface and narrows HUD/diagnostic edge cases without intentional breaking changes.
- The release retains npm/package layout compatibility with `0.18.10`.
- Two direct-to-dev `docs(model)` commits (`0d7a3899`, `6567fd3b`) are included in the compare range and net to no docs change after the misattributed model-switching guidance was reverted.

## Merged PR inventory

#2746, #2747, #2750, #2755, #2758.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.11.md`.

Local gates before tagging include version sync, build, CLI smoke (`omx --help`, `omx doctor`), `npm pack` + packed-install smoke, release body generation and review, `git diff --check`, branch CI, tag-triggered release workflow, GitHub release proof, and npm publication proof.

The GitHub release workflow remains the authoritative cross-platform native asset gate after tag push, including the uploaded `native-release-manifest.json`.

## Contributors

Thanks to the contributors who landed the `v0.18.10...v0.18.11` delta:

- [@Yeachan-Heo](https://github.com/Yeachan-Heo)
- [@simongonzalezdc](https://github.com/simongonzalezdc)

**Full Changelog**: [`v0.18.10...v0.18.11`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.10...v0.18.11)
