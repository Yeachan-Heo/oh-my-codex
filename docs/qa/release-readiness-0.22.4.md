# Release Readiness: 0.22.4

## Compare Range

- **Previous release**: v0.22.3
- **Candidate commit**: `c81c0aa4` (release/0.22.4 branch HEAD)
- **Comparison**: `git log v0.22.3..release/0.22.4`

## PR Inventory

1. **#4061** — PRINT RESUME BLOCK ON EXIT FOR WORKFLOW CONTINUATION (feat, @Yeachan-Heo)
   - Commit: `3f055fef7`
2. **#4062** — HONOR DIRECTORY OVERRIDES IN RESUME COMMANDS (fix, @Yeachan-Heo)
   - Commit: `22d9a94dd`
3. **#4063** — RESTORE APOSTROPHE ESCAPING IN SHELLQUOTE (fix, @Yeachan-Heo)
   - Commit: `c81c0aa4`
4. **#4058** — back-merge main into dev after 0.22.3 (infra)
5. **#4059** — bump dev to 0.22.4 (infra)

## Gates

- Full CI on dev `c81c0aa4`: passed, [CI run 42603444740](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42603444740).
- PR #4061 CI: passed on merged head.
- PR #4062 CI: passed on merged head.
- PR #4063 CI: passed on merged head.
- Release PR CI: must be green before merge.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
