# oh-my-codex 0.21.20

`0.21.20` is a patch release for team worker readiness deadline enforcement during the final poll (2 commits, 8 files, +110/−18; PR #3835).

## Highlights

- **Readiness deadline enforcement (#3835):** enforce the configured `OMX_TEAM_READY_TIMEOUT_MS` timeout on the final team worker readiness poll, preventing team workers from reporting ready after the deadline. Incompatibility markers remain fail-closed.

## Compatibility

- Team workers now strictly respect the readiness deadline on all polls, including the final poll.
- Readiness behavior is more deterministic and compatible with configured timeout expectations.

## Validation

- Pinned candidate `3a7ae367a5d8c75ffd6df591f83e08f5c79a849a` passed latest-per-name dev CI: 17 checks succeeded and 8 conditional checks were skipped, with no failures.
- Release branch CI passed with all required checks green.
- All code review findings resolved.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3835](https://github.com/Yeachan-Heo/oh-my-codex/pull/3835) | @Yeachan-Heo | fix(team): enforce the readiness deadline after the final poll |

## Contributors

Thanks to @Yeachan-Heo for the fix.

**Full Changelog**: [`v0.21.19...v0.21.20`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.19...v0.21.20)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
