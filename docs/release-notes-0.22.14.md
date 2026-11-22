# Release Notes: oh-my-codex v0.22.14

## Candidate and Compare Range

- **Previous tag**: `v0.22.13`
- **Candidate**: `646e66f6d4dc2e5a36b961ae46f518f2141fe2f8`
- **Compare range**: `v0.22.13..646e66f6d`

## PR Inventory

### Merged PRs (2)

- **#4118**: fix(resume): suggest tmux reattach when the session owner is still alive
  - Commits: 5
  - Author: Yeachan-Heo
  - Merged: Fri Nov 22 2026
  - Part A of #4117: Exit-block improvements

- **#4120**: fix(resume): keep resume hint for completed foreground launches
  - Commits: 1
  - Author: Yeachan-Heo
  - Merged: Fri Nov 22 2026
  - Regression fix from #4118

## Commits in Release Range

```
e9ef3eabf fix(resume): keep resume hint for completed foreground launches (#4120)
04cfa6879 Merge pull request #4118 from Yeachan-Heo/fix-4117-resume-reattach
a781f1c7a test: update integration tests for omx doctor behavior
8182c7ade fix(resume): quote tmux binary path and fix non-runtime-owner classification
08b376f87 fix(resume): properly classify liveness and use resolved tmux binary
0e056fc0e fix(resume): suggest tmux reattach when the session owner is still alive
d9b961366 fix: safely resume verified OMX session owners (#3965)
646e66f6d Merge pull request #4121 from Yeachan-Heo/back-merge/dev-0.22.13
```

## User-Visible Changes

### Fixes

- **Exit-block session reattach suggestion (Part A of #4117)**: Exit-block now intelligently detects when a detached OMX session owner is still alive and suggests the appropriate reattach command (`tmux attach` or `psmux attach`). This eliminates the need for manual session recovery in many cases. Part B of #4117 (alternative attach paths) remains open.

- **Preserved resume hints on completed launches**: Fixed a regression where the omx resume hint was being dropped after foreground launches completed. Resume hints are now correctly maintained throughout the entire launch lifecycle, ensuring users always have access to resume commands when needed.

## Validation

- Dev CI run 44979121056 on candidate 646e66f6d passed all checks
- macOS Ralplan preflight jobs passed
- Release-coupled versions verified synchronized across package.json, Cargo.toml, Cargo.lock, and plugin.json

## Compatibility

No breaking changes. All public APIs remain stable.
