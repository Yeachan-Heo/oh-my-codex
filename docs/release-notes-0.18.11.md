# oh-my-codex 0.18.11

`0.18.11` is a patch release after `0.18.10` focused on completing the `omx explore` command-surface deprecation, sharpening the `omx doctor` Spark/model lane diagnostics, and hardening launch-time tmux HUD behavior. It keeps the existing CLI/package contract while removing stale explore guidance and tightening HUD/diagnostic edge cases.

## Highlights

- **`omx explore` command surface is hard-deprecated** — the explore command surface is fully retired, and remaining `omx explore` mentions are removed from global AGENTS guidance so generated agent docs stop pointing at the deprecated lane.
- **`omx doctor` gains Spark/model lane routing diagnostics** — doctor now surfaces Spark/model lane routing state so misrouted model lanes are visible during diagnosis.
- **Launch-time HUD is safer in cramped tmux windows** — the launch-time HUD split is skipped inside cramped existing tmux windows, preventing unusable pane splits during startup.
- **Catalog gains the wiki skill manifest entry** — the wiki skill manifest entry is registered in the catalog so the skill is discoverable through the standard manifest surface.

## Fixes / compatibility

- Existing CLI, plugin, generated-agent, HUD, and diagnostic contracts remain compatible; this release retires the already-deprecated `omx explore` surface and narrows HUD/diagnostic edge cases without intentional breaking changes.
- The release retains npm/package layout compatibility with `0.18.10`.

## Merged PR inventory

#2746, #2747, #2750, #2755, #2758.

- [#2746](https://github.com/Yeachan-Heo/oh-my-codex/pull/2746) — feat(explore): hard-deprecate omx explore command surface (#2744, #2745).
- [#2747](https://github.com/Yeachan-Heo/oh-my-codex/pull/2747) — chore(catalog): add wiki skill manifest entry.
- [#2750](https://github.com/Yeachan-Heo/oh-my-codex/pull/2750) — fix(agents): remove remaining omx explore mentions from global AGENTS guidance (#2749).
- [#2755](https://github.com/Yeachan-Heo/oh-my-codex/pull/2755) — fix(hud): skip launch-time HUD split in cramped existing tmux windows (#2754).
- [#2758](https://github.com/Yeachan-Heo/oh-my-codex/pull/2758) — fix(doctor): add Spark/model lane routing diagnostic (#2757).

## Internal/no-PR commits in compare range

- `0d7a3899` — docs(model): clarify Codex model-migration switching (#2748).
- `6567fd3b` — docs(model): revert misattributed model-switching guidance (nets to no docs change after the revert).

## Issues

No open GitHub issues remain for the release range at release prep time. Closed issue coverage is represented by the merged PR inventory above.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.11.md`.

Release gates include version sync, build, CLI smoke (`omx --help`, `omx doctor`), `npm pack` + packed-install smoke, release body generation and review, branch CI, tag-triggered release workflow, GitHub release proof, and npm publication proof.

**Full Changelog**: [`v0.18.10...v0.18.11`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.10...v0.18.11)
