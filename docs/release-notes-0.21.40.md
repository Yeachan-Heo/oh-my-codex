# oh-my-codex 0.21.40

`0.21.40` is a patch release that fixes OMX session-pointer ownership when a long-lived managed Codex app-server is running and improves tmux shim-log test reliability.

## Highlights

- **MANAGED CODEX SESSION POINTER OWNERSHIP (#3949; fixes #3946):** A verified `codex app-server --managed-daemon` process is no longer republished as the OMX session owner or allowed to block `omx resume` and fresh launches. `omx session pointer recover` and doctor provide a working recovery action. Live interactive OMX owners remain protected; unknown or mismatched process identity fails closed. Reported by @nascyimento.

## Fixes and compatibility

- No breaking API changes.
- Preserve completed, trailerless non-tail tmux shim-log records when command writes interleave; discard only an unfinished final segment (#3941). This is test-harness coverage, not a runtime behavior change.
- The release-train commits synchronize the package, npm lockfile, Cargo workspace/lockfile, and plugin metadata at `0.21.40` (#3943).

## Known issues and exclusions

- #3898 remains held for the owner design decision. Related PRs #3939, #3900, and #3907 remain excluded, as does held PR #3915.
- No other user-facing changes in the compare range are excluded.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3941](https://github.com/Yeachan-Heo/oh-my-codex/pull/3941) | @Yeachan-Heo | test: keep interleaved tmux shim records | Preserve complete interleaved non-tail shim records and verify unfinished-tail safety |
| [#3943](https://github.com/Yeachan-Heo/oh-my-codex/pull/3943) | @Yeachan-Heo | chore(dev): bump base version to 0.21.40 | Synchronize development package and plugin/Cargo version surfaces |
| [#3944](https://github.com/Yeachan-Heo/oh-my-codex/pull/3944) | @Yeachan-Heo | docs: record v0.21.39 publication evidence | Carry prior-release publication evidence onto dev |
| [#3945](https://github.com/Yeachan-Heo/oh-my-codex/pull/3945) | @Yeachan-Heo | back-merge: main to dev for v0.21.39 | Internal merge aligning dev with the prior shipped main |
| [#3949](https://github.com/Yeachan-Heo/oh-my-codex/pull/3949) | @Yeachan-Heo | fix(session): don't let a managed Codex daemon own the OMX session pointer | Recover from a verified managed-daemon owner without stopping it; protect live interactive owners and fail closed on uncertain identity |

## Validation

- Pinned dev candidate `87ace943784fa5873e5f8b39edc6686d8bbadde8` passed CI run [40824315726](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726): latest-per-name checks were 18 success, 7 skipped, and 0 failures.
- Both macOS Ralplan preflights passed: Node 20 (job [123283770572](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726/job/123283770572)) and Node 26.5.1 (job [123283770409](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726/job/123283770409)); CI Status passed (job [123288130258](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726/job/123288130258)).
- Release-branch local gates and release review/publication evidence are recorded in [release readiness](qa/release-readiness-0.21.40.md).

## Contributors

Thanks to @nascyimento for reporting the managed-daemon session-pointer issue, and @Yeachan-Heo for the fix, regression coverage, and release-train maintenance.

**Full Changelog**: [`v0.21.39...v0.21.40`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.39...v0.21.40)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
