# oh-my-codex 0.21.47

`0.21.47` keeps psmux worker panes alive on native Windows by embedding the split receipt safely in tmux's output format rather than appending it as a shell comment.

## Fixed

- **PSMUX WINDOWS WORKER LAUNCH (#4008, fixes #4007):** On native Windows with psmux, `omx team` workers exited at launch because OMX appended a `# omx_source_...` receipt to the worker command. psmux does not treat `#` as a comment starter, so the receipt reached `powershell.exe` as extra arguments. The receipt is now embedded in the tmux format specifier (`-F '#{pane_id}:'`) for all platforms, providing verification without a shell comment.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.47` on dev by #4003, so the release branch does not bump those values again. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.47` at the pinned source.

## Included scope

The pinned source is `335a33656a82eedc0f19e14c04042712c40db214`. The source-only diff from `v0.21.46` to that commit is limited to `src/team/tmux-session.ts` and its regression tests; no commits after the pinned source are included. The only user-facing change in this release is #4008.

**Full Changelog**: [`v0.21.46...v0.21.47`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.46...v0.21.47)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.21.47.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
