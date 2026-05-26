# oh-my-codex 0.18.4

`0.18.4` is a patch release after `0.18.3` for the runtime-safety and operator-experience fixes that landed on `dev`. It focuses on Ultragoal recovery, the `omx explore` deprecation contract, Team/HUD ownership, plugin native-agent setup, project-local Codex trust sync, Autopilot question waiting, and ralplan reviewer handoff quality.

## Highlights

- **Ultragoal recovery is safer** — plain-label checklist sections no longer confuse Ultragoal parsing, and completed aggregate goals no longer trigger unrecoverable Stop recovery loops.
- **Explore is deprecated without breaking legacy callers** — guidance now points operators away from `omx explore` for new lookup work while preserving compatibility behavior.
- **Autopilot question flow waits correctly** — deep-interview question handling can wait for `omx question` answers instead of continuing prematurely.
- **Team and HUD ownership is cleaner** — worker UserPromptSubmit paths avoid owning leader HUD reconciliation, and duplicate HUD pane spawn convergence is fixed.
- **Plugin native-agent setup is more reliable** — doctor/setup paths surface missing reviewer roles, preserve plugin-only obsolete agents, and keep plugin native-agent role CI covered.
- **Project-local trust sync is safer** — Codex trust sync relaunches no longer corrupt local config.
- **Ralplan reviewer contracts are tighter** — reviewer subagent instructions are narrowed so review evidence remains grounded before execution handoff.

## Fixes / compatibility

- `omx explore` remains available for compatibility but is deprecated in runtime guidance.
- Ultragoal Stop recovery now handles already-completed aggregate goals without looping.
- HUD reconciliation remains leader-owned across worker prompt hooks.
- Plugin-mode native-agent role setup and obsolete-agent preservation are covered by the release train.

## Merged PR inventory

#2499, #2501, #2502, #2504, #2507, #2508, #2515, #2519, #2521, #2522, #2524, #2525.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.4.md`.

Local gates completed before tagging:

- `npm run build`
- `npm run lint`
- `npm run check:no-unused`
- `npm run verify:native-agents`
- `npm run sync:plugin`
- `npm run verify:plugin-bundle`
- `node dist/scripts/generate-catalog-docs.js --check`
- `git diff --check`
- `npm pack --dry-run`

The GitHub release workflow remains the authoritative cross-platform native asset and npm publication gate after tag push.

## Contributors

Thanks to the contributors who landed the `v0.18.3...v0.18.4` delta:

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) — #2501, #2502, #2504, #2507, #2508, #2515, #2519, #2521, #2522, #2524, #2525
- [@iqdoctor](https://github.com/iqdoctor) — #2499

**Full Changelog**: [`v0.18.3...v0.18.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.3...v0.18.4)
