# oh-my-codex v0.22.1

## Summary

This patch release ships critical fixes for the omx question command when stdin is closed, adds readline close event handling for EOF detection, reapplies verified handoffs and safe drains after v0.22.0, accepts aliased Codex homes for external live pins, and addresses three Codex findings from the v0.22.0 release review.

## Fixed

- **ACCEPT ALIASED CODEX HOMES FOR EXTERNAL LIVE PINS (#3939):** Accept either spelling of the configured Codex home when validating live pin cache paths, enabling external Codex home links and symlinks to resolve correctly while maintaining no-follow traversal security. This fixes live pin resolution when Codex homes are aliased or redirected.
- **FIX EOF DETECTION FOR CLOSED STDIN IN OMX QUESTION --UI (#4048, #4046):** Replaced input stream listeners with readline close event for more reliable EOF detection when stdin is closed. Handle closed stdin in `omx question --ui` with proper error handling to prevent crashes when the command is invoked without stdin.
- **PRESERVE NON-FORCE DRAINS AND REQUIRE VERIFIED CODE HANDOFF (#4034):** Non-force team drains no longer interrupt in-flight worker Git operations, and worker code handoff to the leader requires verified evidence before integration. This change was held out of v0.22.0.
- **ADDRESS CODEX FINDINGS FROM v0.22.0 RELEASE REVIEW (#4047):** Fixes for issues identified in Codex review of release PR #4042. Herdr team shutdown now fails closed when workspace teardown fails, so team state and worktrees are preserved instead of removed while workers may still run. Scale-up honors a team's persisted Herdr launch mode, and startup readiness evidence is tracked per worker instead of leaking across concurrent startups.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.1` at the pinned source.

## Verification

- `npm ci` — passed; packages installed and lifecycle hooks completed.
- `npm run build` — passed.
- `npm test` — passed on the full test run.
- `npm run lint` — passed. No lint fixes required.
- `npm run check:no-unused` — passed. No unused imports or declarations.

## Contributors

[@ev78394](https://github.com/ev78394), [@shenyankm](https://github.com/shenyankm), [@Yeachan-Heo](https://github.com/Yeachan-Heo)

**Full Changelog**: [`v0.22.0...v0.22.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.0...v0.22.1)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
