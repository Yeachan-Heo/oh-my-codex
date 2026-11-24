# oh-my-codex v0.22.19

## Summary

This patch release makes the `OMX_DEFAULT_*_MODEL` env tier variables the single source of truth for agent models (#4146, fixes #4133/#4149) and prints the exit resume block for resume launches (#4144, fixes #4060).

## Changed

- **ENV TIER VARS AS SINGLE SOURCE OF TRUTH (#4146):** Fixes #4133, #4149. The per-agent `exactModel` pins are removed. `OMX_DEFAULT_FRONTIER_MODEL`, `OMX_DEFAULT_STANDARD_MODEL` and `OMX_DEFAULT_SPARK_MODEL` drive all agents. Defaults: frontier `gpt-6.2-astra` (planner/architect/critic), standard `gpt-6.2-sol`, spark `gpt-6-luna` (explore/style-reviewer/vision). The model table lists the leader row first and orders rows by tier.

## Fixed

- **PRINT EXIT RESUME BLOCK FOR RESUME LAUNCHES (#4144):** Fixes #4060. Resume launches now print the exit resume block.

## Migration

This is a behavior change (#4146):

- The `exactModel` pins are removed.
- `OMX_DEFAULT_FRONTIER_MODEL`, `OMX_DEFAULT_STANDARD_MODEL` and `OMX_DEFAULT_SPARK_MODEL` drive all agents.
- The defaults are frontier `gpt-6.2-astra` (planner/architect/critic), standard `gpt-6.2-sol`, spark `gpt-6-luna` (explore/style-reviewer/vision).
- The `config.toml` root `model` no longer affects agent tiers.
- Re-run `omx setup --force` to regenerate the agent TOML.

## Compatibility

Behavior change for agent model selection, see Migration. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.19`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

**Full Changelog**: [`v0.22.18...v0.22.19`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.18...v0.22.19)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
