# Release notes — 0.14.3

## Summary

`0.14.3` is a patch release after `0.14.2` for the current `dev` hardening train: question/deep-interview return-pane reliability, project-local explore launch context, setup TOML repair safety, tmux HUD window targeting, ultrawork protocol alignment, BusyBox cleanup compatibility, stale Stop/autopilot state handling, canonical runtime supervisor events, Docker-host tmux question rendering, and native Windows psmux worker pane bootstrap hardening.

## Highlights

- `omx question` now better preserves the invoking leader pane across tool-launched prompts, prompt reseeding, detached/visible renderer paths, and renderer metadata races.
- Deep-interview now reconciles answered question records before re-prompting and adds summary gates for oversized clarification flows.
- Project-scoped setup is respected during explore launches by resolving project-local `CODEX_HOME` from persisted setup scope.
- Setup refresh handles multiline root TOML assignments without orphaning fragments.
- HUD reconciliation targets the emitting tmux window, avoiding cross-window resize drift.
- Cleanup supports BusyBox `ps` by falling back from the `command` field to `args` only for that compatibility failure.
- Runtime/team surfaces add canonical supervisor events and native Windows psmux pane bootstrap hardening.

## Compatibility

- No user migration is required.
- `omx question` remains intentionally fail-closed when no visible/returnable tmux pane exists.
- Project-local `.codex` users should get more consistent launch behavior after update/setup refresh.

## Verification

- `npm test` ✅ — 3910 tests passed, 0 failed; catalog check ok.
- `npm run check:no-unused` ✅
- `cargo test --workspace` ✅
- `npm run lint` ✅
- `npm run build` ✅
- Targeted changed-path Node suites for question/deep-interview/hooks/team/config/cleanup/HUD ✅

Release verification evidence is recorded in `docs/qa/release-readiness-0.14.3.md`.
