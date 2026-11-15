# oh-my-codex 0.22.7

`0.22.7` ships updated agent guidance: prioritizing complete, maintainable repairs over minimal-diff patches.

## Changed

- **PRIORITIZE COMPLETE, MAINTAINABLE REPAIRS IN AGENT GUIDANCE (#4083):** Agent repair guidelines now emphasize choosing complete, correct solutions at natural ownership boundaries instead of minimizing diff size. This aligns agent behavior with maintainability practices: deletion over addition, boundary repair over new layers, and documented mitigations where appropriate. Updated guidance appears in system prompts (`prompts/team-executor.md`, `prompts/build-fixer.md`), agent templates (`templates/AGENTS.md`, `plugins/oh-my-codex/templates/AGENTS.md`), and skill documentation (`skills/ultrawork/references/agent-tiers.md`, `docs/shared/agent-tiers.md`). Fixes #4082.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.7` at the pinned source.

## Included scope

The pinned source is dev `a023e9ef1`. Product changes from `v0.22.6`: #4083. The other commits are internal (back-merge #4080) and the version bump (#4081).

**Full Changelog**: [`v0.22.6...v0.22.7`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.6...v0.22.7)

## Validation

Release-pipeline evidence is recorded in [release readiness](qa/release-readiness-0.22.7.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
