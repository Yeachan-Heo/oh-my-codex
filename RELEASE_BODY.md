# oh-my-codex v0.10.3

**21 PRs in the release window**

`0.10.3` is a feature-rich release following `0.10.2`. The release window began with the `0.10.2` tag at `2026-03-16 09:14 UTC`; the 21 PRs landed across two days, with the final merge (`#919`) at `2026-03-18 02:24 UTC`, for a shipped turnaround of about **41 hours** before this release-prep commit.

## Highlights

### Native subagent integration (phase 1)

- Codex CLI native subagent spawning and coordination is now available as a first-pass integration
- Skill references can bridge to native subagents with full lifecycle tracking
- AGENTS.md setup now auto-generates a model capability table for quick reference

### Autoresearch hardening and UX

- Novice users can now be routed through deep-interview intake before launching autonomous research
- Worktree paths moved to project-local `.omx/worktrees/` for isolation
- Contracts and runtime deslopped for clarity
- ESM `__dirname` error and macOS test compatibility fixed

- Marathon execution mode with watchdog failure notifications, structured PRD orchestrator, and state recovery

### New: `omx cleanup`

- Detects and removes orphaned MCP server processes
- Cleans stale `/tmp` artifacts

### Security

- High-severity transitive vulnerabilities patched with dependabot config added

## What's Changed

### Features
- feat: add Lore commit protocol to AGENTS.md template and executor prompt ([#916](https://github.com/Yeachan-Heo/oh-my-codex/pull/916))
- feat(setup): generate AGENTS model capability table ([#894](https://github.com/Yeachan-Heo/oh-my-codex/pull/894))
- feat: add skill_ref bridges and subagent tracking ([#892](https://github.com/Yeachan-Heo/oh-my-codex/pull/892))
- feat: add native codex agent integration phase 1 ([#886](https://github.com/Yeachan-Heo/oh-my-codex/pull/886))
- feat: add AGENTS autonomy directive ([#883](https://github.com/Yeachan-Heo/oh-my-codex/pull/883))
- feat(autoresearch): add novice deep-interview intake bridge ([#906](https://github.com/Yeachan-Heo/oh-my-codex/pull/906))
- feat(cli): add omx cleanup for orphaned MCP servers ([#901](https://github.com/Yeachan-Heo/oh-my-codex/pull/901))

### Fixes
- fix: bootstrap packed-install smoke deps in worktrees ([#919](https://github.com/Yeachan-Heo/oh-my-codex/pull/919), closes [#917](https://github.com/Yeachan-Heo/oh-my-codex/issues/917))
- fix: use deep-interview launch for autoresearch intake ([#915](https://github.com/Yeachan-Heo/oh-my-codex/pull/915), closes [#911](https://github.com/Yeachan-Heo/oh-my-codex/issues/911))
- fix(native): prefer musl Linux assets before glibc ([#914](https://github.com/Yeachan-Heo/oh-my-codex/pull/914))
- fix(autoresearch): use project-local worktree paths ([#913](https://github.com/Yeachan-Heo/oh-my-codex/pull/913))
- fix: ship musl-first Linux native assets ([#907](https://github.com/Yeachan-Heo/oh-my-codex/pull/907))
- fix: resolve __dirname ESM error in autoresearch guided flow ([#903](https://github.com/Yeachan-Heo/oh-my-codex/pull/903))
- fix: clean up stale obsolete native agents ([#899](https://github.com/Yeachan-Heo/oh-my-codex/pull/899))
- fix: stop generating skill agents ([#897](https://github.com/Yeachan-Heo/oh-my-codex/pull/897))
- fix(autoresearch): replace execFileSync('cat') with readFileSync and fix macOS test compatibility ([#891](https://github.com/Yeachan-Heo/oh-my-codex/pull/891) — @lifrary)
- fix(deps): patch high-severity transitive vulnerabilities and add dependabot config ([#889](https://github.com/Yeachan-Heo/oh-my-codex/pull/889), closes [#888](https://github.com/Yeachan-Heo/oh-my-codex/issues/888))
- Add stale /tmp cleanup to omx cleanup ([#912](https://github.com/Yeachan-Heo/oh-my-codex/pull/912), closes [#908](https://github.com/Yeachan-Heo/oh-my-codex/issues/908))

### Refactor
- refactor(autoresearch): deslop contracts and runtime ([#918](https://github.com/Yeachan-Heo/oh-my-codex/pull/918))

### Docs
- docs: add autoresearch showcase hub with completed demos ([#884](https://github.com/Yeachan-Heo/oh-my-codex/pull/884))

## Referenced issues

[#888](https://github.com/Yeachan-Heo/oh-my-codex/issues/888), [#900](https://github.com/Yeachan-Heo/oh-my-codex/issues/900), [#908](https://github.com/Yeachan-Heo/oh-my-codex/issues/908), [#911](https://github.com/Yeachan-Heo/oh-my-codex/issues/911), [#917](https://github.com/Yeachan-Heo/oh-my-codex/issues/917)

## Contributors

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) (Bellman)
- [@lifrary](https://github.com/lifrary) (SEUNGWOO LEE)

## Local release verification checklist

Run before tagging / publishing:

- `node scripts/check-version-sync.mjs --tag v0.10.3`
- `npm run build`
- `npm run check:no-unused`
- `npm test`

**Full Changelog**: [`v0.10.2...v0.10.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.10.2...v0.10.3)
