# oh-my-codex 0.21.36

`0.21.36` is a patch release that routes native-hook CLI error diagnostics through the configured OMX logs directory.

## Highlights

- **NATIVE HOOK LOGGING (#3909):** CLI error diagnostics now use `omxLogsDir`, honoring `OMX_ROOT` (which takes precedence) or `OMX_STATE_ROOT` instead of always writing under the project working directory. With neither configured, the existing project `.omx/logs` behavior is unchanged. This fixes #3908.

## Fixes and compatibility

- No breaking API changes.
- `OMX_ROOT` takes precedence over `OMX_STATE_ROOT` for native-hook CLI error logs.

## Known issues

- #3898 (live-pin fix) remains blocked on an owner design decision; #3900 and #3907 are open drafts. On Codex 0.164.0, `.omx-live-pin` files in the plugin cache can invalidate hook approval. The workaround posted in #3898 disables the `oh-my-codex-local` plugin.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3909](https://github.com/Yeachan-Heo/oh-my-codex/pull/3909) | @Yeachan-Heo | fix(native-hook): route CLI error logs through omxLogsDir | Fixes #3908; uses configured OMX logs directory |
| [#3906](https://github.com/Yeachan-Heo/oh-my-codex/pull/3906) | @Yeachan-Heo | chore(back-merge): v0.21.35 to dev | Internal back-merge; no content changes |

## Validation

- Pinned dev candidate `4932ef923a15a5bf818f5b4fa2625d3259486275`: latest-per-name CI checks 17 success, 8 skipped, 0 failures (run [40160210335](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40160210335)).
- macOS Ralplan preflight security passed for Node 20 (job 121070025433) and Node 26.5.1 (job 121070025331).
- Release-branch build, typecheck/no-unused, lint, Rust workspace checks, plugin-bundle verification, and focused native-hook/path/version tests passed; see [release readiness](qa/release-readiness-0.21.36.md) for exact commands and scope.
- Release-branch local and PR gates: see [release readiness](qa/release-readiness-0.21.36.md).

## Contributors

Thanks to @Yeachan-Heo for the native-hook logging fix and release back-merge.

## Verify the upgrade

```bash
npm list oh-my-codex
# or: gh release view v0.21.36 --repo Yeachan-Heo/oh-my-codex
```

## Installation

```bash
npm install -g oh-my-codex@latest
# or install from the release page: https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.36
```

**Full Changelog**: [`v0.21.35...v0.21.36`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.35...v0.21.36)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
