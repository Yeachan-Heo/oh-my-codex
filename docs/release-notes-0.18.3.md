# oh-my-codex 0.18.3

`0.18.3` is a patch release after `0.18.2` for the post-release reliability and operator-experience train on `dev`. It focuses on HUD/tmux lifecycle cleanup, Team diff readability, auth slot hot-swap support, visible explore prompt syntax guidance, deep-interview runtime configuration and handoff authority, plugin-owned hook preservation, and the new Scholastic ontology reviewer agent.

## Highlights

- **HUD panes are less stale and less duplicated** — HUD launch/reconcile now coalesces same-leader panes, preserves session ownership, reaps dead-leader panes, and reuses the existing HUD during UserPromptSubmit revive.
- **Team diff output is easier to review** — wrapped multi-line diff hunks preserve the diff gutter so long patches remain readable in tmux panes.
- **Deep-interview is more configurable and safer to hand off** — runtime config overrides are supported, and `plan_then_execute` downstream authority is enforced as a binding gate.
- **Auth slots can be hot-swapped more safely** — the release includes the auth slot hot-swap wrapper work from the final `dev` delta.
- **Explore runtime guidance keeps prompt syntax visible** — prompt syntax remains visible in runtime guidance so operators do not lose invocation shape while using `omx explore`.
- **Plugin-owned hooks are respected** — Codex setup paths preserve plugin-owned hooks instead of overwriting user/plugin surfaces.
- **Scholastic ontology review is available** — a first-class Scholastic reviewer agent is added to the agent catalog and native config surface.
- **Skill/agent bloat audit is documented** — the release carries an inventory and connectivity roadmap for future consolidation work.

## Fixes / compatibility

- HUD ownership and tmux reconciliation fixes reduce cross-worktree accumulation and stale session-id/env drift.
- Team hunk rendering keeps gutters on wrapped multi-line diffs.
- Setup and native hook paths preserve plugin ownership boundaries while still warning on invalid/missing coverage.
- Deep-interview and ralplan guidance now encode stricter downstream execution authority and runtime override behavior.
- Auth slot wrapper and explore prompt-guidance fixes from the rebased `dev` head are included in this cut.

## Merged PR inventory

#2474, #2476, #2477, #2478, #2481, #2482, #2483, #2484, #2485, #2486, #2487, #2488, #2489, #2491, #2492, #2493, #2494, #2495.

## Validation

UltraQA release-prep evidence is recorded in `docs/qa/release-readiness-0.18.3.md`.

Local gates completed before metadata finalization:

- `npm run lint`
- `npm run check:no-unused`
- `npm run test`
- Project-native targeted changed-area tests, rerun twice through `dist/scripts/run-test-files.js`
- Adversarial release harness for malformed state, prompt-injection, repeated interruption/cancel wording, hung child process, misleading success output, and no-tag side-effect guard
- `npm pack --dry-run`

Accepted residual risk:

- `cargo test` exposed one failing `omx-explore` process-group timeout cleanup assertion (`run_command_with_timeout_kills_process_group_children`). The release owner explicitly directed this to be ignored for this cut; it is recorded in the readiness doc and should be fixed after `0.18.3`.

## Contributors

Thanks to everyone who narrowed the post-`0.18.2` HUD, Team, deep-interview, hook, and agent-catalog follow-ups.

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.2...v0.18.3
