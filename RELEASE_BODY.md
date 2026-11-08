# oh-my-codex v0.22.3

## Summary

This patch release ships Plan and Ralplan skill guidance that matches the tools the host actually exposes.

## Fixed

- **ALIGN PLAN AND RALPLAN WITH AVAILABLE HOST TOOLS (#3998):** The Plan and Ralplan skills no longer reference unavailable `ask_codex` syntax or a nonexistent `$plan` consensus mode. Plan asks questions through `omx question` in attached tmux (with the return pane preserved) and through native structured input elsewhere, uses only the host's exposed reviewer subagents, and reports a missing independent review instead of claiming approval. A "skip planning" request now continues through direct execution while keeping active workflow gates, instead of always handing off to `$ultragoal`. Ralplan owns the consensus sequence and its quality gates.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.3`.

## Verification

- Full CI passed on dev `f7569d2b8` (the source of this release), [CI run 42516047121](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42516047121).
- PR #3998 CI passed on its merged head.

## Contributors

[@lisrel-claw](https://github.com/lisrel-claw) and [@Yeachan-Heo](https://github.com/Yeachan-Heo)

**Full Changelog**: [`v0.22.2...v0.22.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.2...v0.22.3)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
