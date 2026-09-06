# oh-my-codex 0.21.4

`0.21.4` is a patch release for the frozen range `v0.21.3..b08eceeecc7a7379f041ceca51260f073d8a95bb` (3 commits, 35 changed files, +364/−195; PRs #3615/#3618/#3622).

## Highlights

- **Astra is the default across OMX agent tiers** — leaders, specialists, standard and fast agents, low-complexity workers, Team children, exact planning/research roles, new-agent configuration, subscription defaults, and SparkShell summaries now default to `gpt-6-astra` (#3622).
- **Explicit choices remain authoritative** — existing model configuration, profiles, per-agent overrides, CLI/environment choices, provider-specific names, custom instructions, and reasoning-effort defaults are preserved (#3622).
- **The agent catalog matches the packaged product** — only active/internal roles are presented as directly invocable, merged/deprecated replacements are documented, and workflow guidance is aligned with `$deep-interview` → `$ralplan` → `$ultragoal`; `$team` remains conditional parallel execution (#3618).

## Compatibility

Patch release with no intentional breaking CLI or package-layout changes. Astra defaults apply only where no explicit model choice exists.

## Known gap

[#3623](https://github.com/Yeachan-Heo/oh-my-codex/issues/3623) remains open, separately owned, unmerged, and outside this release. OMX doctor/setup still use Codex CLI 0.153.4's removed `plugin_hooks` feature flag for plugin-hook inference and generated configuration, which can produce misleading diagnostics and obsolete config. Native `hooks/list` recognized the installed plugin hooks in the report, so a runtime hook outage has not been demonstrated.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) and [@ev78394](https://github.com/ev78394) for contributing to this release.

## Frozen-range acknowledgements

The product candidate is frozen at `dev@b08eceeecc7a7379f041ceca51260f073d8a95bb`. #3615 is release-train metadata rather than a product headline. Issue #3623 is explicitly excluded because it is unmerged and separately owned.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.4/inventory.md`.

**Full Changelog**: [`v0.21.3...v0.21.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.3...v0.21.4)
