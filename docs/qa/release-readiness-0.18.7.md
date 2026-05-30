# Release readiness: oh-my-codex 0.18.7

## Range

- Previous tag: `v0.18.6`.
- Candidate branch during prep: `release/0.18.7` from `dev`.
- Release tag to create after merge: `v0.18.7`.
- Compare: `v0.18.6..HEAD` before tag, then `v0.18.6..v0.18.7` after tagging.
- Release-prep branch target: `dev`.

## Release scope

`0.18.7` packages the post-`0.18.6` runtime reliability train:

- Duplicate HUD pane prevention and HUD ownership preservation across attached tmux, standalone restore, and native tmux session replacement paths.
- Duplicate question renderer pane prevention and answered-renderer cleanup.
- Worker Stop-hook duplicate suppression with preserved recovery evidence.
- Autopilot gate evidence, command-style routing, and deep-interview/question state hardening.
- Ralplan planning-only boundary hardening.
- Hermes MCP tmux bridge pane routing and detached tmux history growth fixes.
- Lightweight Team coordination protocol state/docs/tests.
- Effective gitignore regression protection.

## Merged PR inventory

- #2571 — route command-style Autopilot invocations.
- #2573 — prevent duplicate question renderer panes.
- #2574 — prevent duplicate worker Stop nudges.
- #2583 — keep HUD watch bound to its live tmux cwd.
- #2593 — keep attached tmux HUD rendering singleton.
- #2594 — clean Autopilot gate evidence handling on current dev.
- #2595 — update README Discord invite.
- #2605 — protect ralplan as a planning-only boundary.
- #2608 — fix duplicate standalone HUD pane restore.
- #2609 — preserve HUD ownership across native session replacement.
- #2611 — protect effective gitignore handling from regression.

## Issue inventory

- No separately closed GitHub issues were found for the `v0.18.6..HEAD` release range during local release prep.
- The release scope is represented by the merged PR inventory above.

## Local validation evidence

Final gates for this cut:

- [x] Release workflow version-sync probe — PASS (`package=0.18.7`, `workspace=0.18.7`, `tag=v0.18.7`): `node dist/scripts/check-version-sync.js --tag v0.18.7`.
- [x] `npm run build` — PASS.
- [x] Focused duplicate HUD/tmux regression suite — PASS (`633` pass / `0` fail): `node --test dist/hud/__tests__/tmux.test.js dist/hud/__tests__/reconcile.test.js dist/hud/__tests__/index.test.js dist/cli/__tests__/index.test.js dist/team/__tests__/tmux-session.test.js dist/team/__tests__/runtime.test.js`.
- [x] Changed-surface compiled regression suite — PASS (`1173` pass / `0` fail): question, hooks, Autopilot, ralplan, Team, state, MCP, native-hook, agents, pipeline, and mode-contract tests.
- [x] `npm run lint` — PASS.
- [x] `npm run check:no-unused` — PASS.
- [x] `npm run verify:native-agents` — PASS.
- [x] `npm run sync:plugin` — PASS; plugin manifest metadata synced to `0.18.7`.
- [x] `npm run verify:plugin-bundle` — PASS.
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS.
- [x] `git diff --check` — PASS.
- [x] `npm pack --dry-run` — PASS (`oh-my-codex-0.18.7.tgz`).

## Duplicate HUD release-blocker evidence

The duplicate HUD blocker is covered by both implementation and tests:

- `src/hud/tmux.ts` owner matching scopes HUD panes by `OMX_SESSION_ID` and `OMX_TMUX_HUD_LEADER_PANE`.
- `src/hud/reconcile.ts` reuses/resizes a matching HUD pane and kills same-owner duplicates during prompt-submit reconciliation.
- `src/hud/index.ts` reuses an existing HUD pane for `omx hud --tmux` instead of splitting duplicates.
- `src/cli/index.ts` and `src/team/tmux-session.ts` preserve leader/HUD exclusion and ownership during launch, restore, and teardown flows.
- Tests cover same-leader duplicate HUD pane cleanup, same-session reuse without `TMUX_PANE`, cross-leader isolation, native Windows HUD restore reuse, attached tmux singleton behavior, and resize-hook preservation.

## CI / PR evidence

- PR targeting `dev`: pending.
- LGTM review: pending.
- Merge to `dev`: pending.
- Post-merge CI: pending.

## No-publish / no-tag evidence before final tag

- Do not create or push `v0.18.7` until this PR is merged and release gates are green.
- No local `npm publish` command is intended; publication remains delegated to the release workflow after tag push.

## Current readiness verdict

Local release prep is ready for PR review and merge to `dev`. Do not create or push `v0.18.7` and do not claim publication until the PR is merged, post-merge CI is green, and the tag-triggered release workflow/npm publication are verified.
