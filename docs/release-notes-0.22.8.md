# Release Notes: oh-my-codex v0.22.8

## Highlights

### Team Lock Recovery and Stop Hook Stability

Fixed a critical issue where the native Stop hook could loop indefinitely when encountering a stale team membership lock, exhausting the Codex API quota. The Stop hook now properly detects `team_lock_recovery_required` errors and terminates cleanly with `continue:false` instead of retrying.

- **#4087**: Stop hook now halts on `team_lock_recovery_required` instead of looping
- **#4090**: Stale team locks properly signal terminal stop status to prevent continuation attempts

## Fixes

- Team lock recovery handling: Stop hook now correctly detects and handles `team_lock_recovery_required` errors by terminating the task with `continue:false` (#4087)
- Stop output terminal status: Stale team membership locks now correctly output as terminal stops, preventing loop conditions (#4090)

## Merged PRs

- **#4090**: fix(#4086): make stale team lock Stop output terminal (continue:false)
- **#4087**: fix(hooks): stop continuation on team_lock_recovery_required instead of looping
- **#4085**: back-merge: main into dev after v0.22.7

## Contributors

- Yeachan-Heo

## Full Changelog

Compare full changes: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.7...v0.22.8

**v0.22.8** was released on {{ release_date }} (UTC).
