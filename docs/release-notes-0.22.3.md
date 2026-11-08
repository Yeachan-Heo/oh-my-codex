# oh-my-codex 0.22.3

`0.22.3` ships Plan and Ralplan skill guidance that matches the tools the host actually exposes.

## Fixed

- **ALIGN PLAN AND RALPLAN WITH AVAILABLE HOST TOOLS (#3998):** The Plan and Ralplan skills no longer reference unavailable `ask_codex` syntax or a nonexistent `$plan` consensus mode. Plan asks questions through `omx question` in attached tmux (with the return pane preserved) and through native structured input elsewhere, uses only the host's exposed reviewer subagents, and reports a missing independent review instead of claiming approval. A "skip planning" request now continues through direct execution while keeping active workflow gates, instead of always handing off to `$ultragoal`. Ralplan owns the consensus sequence and its quality gates.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.3` at the pinned source.

## Included scope

The pinned source is dev `f7569d2b8`. Product change from `v0.22.2`: #3998. The other commits are the post-0.22.2 back-merge (#4055) and version bump (#4056).

**Full Changelog**: [`v0.22.2...v0.22.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.2...v0.22.3)

## Validation

Release-pipeline evidence is recorded in [release readiness](qa/release-readiness-0.22.3.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
