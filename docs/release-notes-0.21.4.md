# oh-my-codex 0.21.4

Patch release for the frozen range `v0.21.3..b08eceeecc7a7379f041ceca51260f073d8a95bb` (3 commits, 35 changed files, +364/−195; PRs #3615/#3618/#3622).

## Highlights

- **Astra is the default across OMX agent tiers** — leaders, specialists, standard and fast agents, low-complexity workers, Team children, exact planning/research roles, new-agent configuration, subscription defaults, and SparkShell summaries now default to `gpt-6-astra` (#3622).
- **Existing choices remain authoritative** — explicit model configuration, profiles, per-agent overrides, CLI/environment selections, provider-specific model names, and established reasoning-effort defaults are preserved. Plugin setup seeds a missing root model without replacing an existing model or custom instructions (#3622).

## Documentation

- **Agent catalog matches the packaged product** — the generated catalog now presents only active/internal roles as directly invocable, documents merged and deprecated role replacements, and aligns the primary workflow wording with `$deep-interview` → `$ralplan` → `$ultragoal`; `$team` remains conditional parallel execution (#3618).

## Compatibility and known gap

- This is a patch release with no intentional breaking CLI or package-layout changes. The new Astra defaults apply only where the user has not already made an explicit model choice.
- [#3623](https://github.com/Yeachan-Heo/oh-my-codex/issues/3623) remains open and is not included in this release. On Codex CLI 0.153.4, OMX doctor/setup still key plugin-hook detection and generated configuration to the removed `plugin_hooks` feature flag, which can produce misleading diagnostics and obsolete configuration. Native `hooks/list` recognized the installed plugin hooks in the report, so a runtime hook outage has not been demonstrated.

## Merged PR inventory

- [#3622](https://github.com/Yeachan-Heo/oh-my-codex/pull/3622) — feat(models): default all OMX agents to Astra, preserving effort and overrides — by [@ev78394](https://github.com/ev78394).
- [#3618](https://github.com/Yeachan-Heo/oh-my-codex/pull/3618) — docs: align agent catalog with packaged catalog and current workflow — by [@Yeachan-Heo](https://github.com/Yeachan-Heo).
- [#3615](https://github.com/Yeachan-Heo/oh-my-codex/pull/3615) — chore: bump dev base version to 0.21.4 — by [@Yeachan-Heo](https://github.com/Yeachan-Heo); release-train metadata rather than a product headline.

## Validation evidence

The exact candidate range, local gates, CI run IDs, known gaps, promotion evidence, native asset evidence, npm publication evidence, and post-release alignment are tracked in `docs/qa/release-readiness-0.21.4.md`. The reproducible commit/PR inventory is recorded in `artifacts/release-0.21.4/inventory.md`.

**Full Changelog**: [`v0.21.3...v0.21.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.3...v0.21.4)
