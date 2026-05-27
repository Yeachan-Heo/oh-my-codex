# Release readiness: oh-my-codex 0.18.6

## Range

- Previous tag: `v0.18.5`.
- Candidate branch during prep: `dev` at `3088efc5` before the `0.18.6` release-prep metadata commit.
- Release tag to create after local gates: `v0.18.6`.
- Compare: `v0.18.5..HEAD` before tag, then `v0.18.5..v0.18.6` after tagging.
- Compare shape before release prep: `1` non-merge commit, `2` merge commits, `8` changed files.

## Release scope

`0.18.6` packages the post-`0.18.5` Ultragoal/HUD rendering follow-up:

- Adaptive HUD line budget: compact default for ordinary sessions and at most three lines for active Ultragoal state.
- tmux HUD pane reconcile/resize behavior derived from the same Ultragoal-aware render policy.
- Distinct current-Ultragoal magenta accent and reduced lower-priority next-goal text in compact output.
- ANSI-safe constrained-width truncation and watch-mode row-budget protection.
- Regression coverage for adaptive sizing, active-goal accent behavior, live tmux resize, and terminal row budget.

## Merged PR inventory

- #2555 — keep Ultragoal HUD compact and state-aware.

## Issue inventory

- `gh issue list --state closed --limit 50 --search "closed:>2026-05-27" --json number,title,closedAt,url,author` returned `[]` during release prep.
- No separately closed issue required an additional release-note entry beyond the merged PR inventory.

## Local validation evidence

Release-prep correction included in this cut: `src/scripts/check-version-sync.ts` now checks the current `crates/omx-runtime` and `crates/omx-sparkshell` paths, matching the release workflow.

Final gates for this cut:

- [x] Release workflow version-sync probe — PASS (`package=0.18.6`, `workspace=0.18.6`, `tag=v0.18.6`). Log: `.omx/logs/release-0.18.6-workflow-version-sync.log`.
- [x] `npm run build` — PASS. Log: `.omx/logs/release-0.18.6-build.log`.
- [x] HUD regression slice: `node --test dist/hud/__tests__/render.test.js dist/hud/__tests__/index.test.js dist/hud/__tests__/reconcile.test.js dist/hud/__tests__/hud-tmux-injection.test.js` — PASS (`128` pass / `0` fail). Log: `.omx/logs/release-0.18.6-hud-regression.log`.
- [x] `npm run lint` — PASS. Log: `.omx/logs/release-0.18.6-lint.log`.
- [x] `npm run check:no-unused` — PASS. Log: `.omx/logs/release-0.18.6-no-unused.log`.
- [x] `npm run verify:native-agents` — PASS. Log: `.omx/logs/release-0.18.6-verify-native-agents.log`.
- [x] `npm run sync:plugin` — PASS. Log: `.omx/logs/release-0.18.6-sync-plugin.log`.
- [x] `npm run verify:plugin-bundle` — PASS. Log: `.omx/logs/release-0.18.6-verify-plugin-bundle.log`.
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS. Log: `.omx/logs/release-0.18.6-catalog-docs-check.log`.
- [x] `git diff --check` — PASS (`PASS: git diff --check produced no whitespace errors.`). Log: `.omx/logs/release-0.18.6-diff-check.log`.
- [x] `npm pack --dry-run` — PASS (`oh-my-codex-0.18.6.tgz`, package size `3.6 MB`, unpacked size `22.2 MB`, `2974` files). Log: `.omx/logs/release-0.18.6-npm-pack-dry-run.log`.

## CI validation evidence

- `dev` candidate CI for pre-release-prep commit `3088efc57f8c548870b4904546d7a269d7a06624` completed successfully.
- Workflow: `CI`.
- Run ID: `26487388325`.
- URL: https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/26487388325
- Created: `2026-05-27T02:38:14Z`; updated: `2026-05-27T02:44:36Z`.
- Conclusion: `success`.
- Post-release-prep `dev` CI — pending after release-prep push.
- `main` CI — pending after merge to `main`.
- Tag-triggered release workflow — pending after `v0.18.6` tag push.

## No-publish / no-tag evidence before final tag

- `git tag --list 'v0.18.6'` showed no local `v0.18.6` tag before tagging.
- `git tag --points-at HEAD` showed no tag at the release-prep worktree HEAD before the release commit.
- No local `npm publish` command is intended; publication is delegated to the release workflow after `v0.18.6` tag push.

## External release actions

1. Commit release prep using the Lore commit protocol.
2. Push `dev` with the release prep.
3. Merge `dev` to `main`.
4. Create/push tag `v0.18.6` from merged `main`.
5. Verify GitHub release workflow assets and npm publication.
6. Fill CI/publish evidence in this document after publication if needed.

## Current readiness verdict

Local release prep is ready for commit, merge to `main`, and tag cut. Do not claim `0.18.6` is published until the tag workflow and npm/GitHub release evidence are verified.
