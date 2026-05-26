# Release readiness: oh-my-codex 0.18.4

## Range

- Previous tag: `v0.18.3` (`f512a177`).
- Candidate branch during prep: `dev` at `8ddeb799` plus the `origin/main` release-body attribution fixes merged back into `dev` before the `0.18.4` metadata bump.
- Release tag to create after local gates: `v0.18.4`.
- Compare: `v0.18.3..HEAD` before tag, then `v0.18.3..v0.18.4` after tagging.

## Release scope

`0.18.4` packages the post-`0.18.3` patch train:

- Ultragoal checklist parsing and Stop recovery-loop hardening.
- Formal `omx explore` deprecation guidance while preserving compatibility behavior.
- Team/HUD ownership fixes for worker UserPromptSubmit and duplicate HUD pane convergence.
- Autopilot deep-interview question waiting through `omx question`.
- Plugin native-agent role setup, doctor readiness, and obsolete-agent preservation fixes.
- Project-local Codex trust sync relaunch safety.
- Ralplan reviewer subagent contract tightening.

## Merged PR inventory

- #2499 — ignore plain-label Ultragoal checklist sections.
- #2501 — reconcile completed subagents before ralplan waits.
- #2502 — keep worker UserPromptSubmit from owning HUD reconcile.
- #2504 — deprecate `omx explore` in runtime guidance.
- #2507 — prevent unrecoverable Ultragoal Stop recovery loops.
- #2508 — allow Autopilot deep-interview to wait on `omx question`.
- #2515 — surface plugin native reviewer role readiness in doctor.
- #2519 — fix plugin native-agent role setup CI.
- #2521 — preserve plugin-only obsolete native agents.
- #2522 — fix project-local Codex trust sync relaunch regression.
- #2524 — tighten ralplan reviewer subagent contract.
- #2525 — fix duplicate HUD pane spawn convergence.

## Local validation evidence

Completed final gates for this cut:

- [x] Release workflow version-sync probe — PASS (`package=0.18.4`, `workspace=0.18.4`, `tag=v0.18.4`). Log: `.omx/logs/release-0.18.4-workflow-version-sync.log`.
- [x] `npm run build` — PASS. Log: `.omx/logs/release-0.18.4-build.log`.
- [x] `npm run lint` — PASS (`Checked 681 files`, no fixes applied). Log: `.omx/logs/release-0.18.4-lint.log`.
- [x] `npm run check:no-unused` — PASS. Log: `.omx/logs/release-0.18.4-no-unused.log`.
- [x] `npm run verify:native-agents` — PASS (`22` installable native agents, `37` setup prompt assets). Log: `.omx/logs/release-0.18.4-verify-native-agents.log`.
- [x] `npm run sync:plugin` — PASS (`29` canonical skill directories and plugin metadata synced). Log: `.omx/logs/release-0.18.4-sync-plugin.log`.
- [x] `npm run verify:plugin-bundle` — PASS (`29` canonical skill directories and plugin metadata verified). Log: `.omx/logs/release-0.18.4-verify-plugin-bundle.log`.
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS (`catalog check ok`). Log: `.omx/logs/release-0.18.4-catalog-docs-check.log`.
- [x] `git diff --check` — PASS. Log: `.omx/logs/release-0.18.4-diff-check.log`.
- [x] `npm pack --dry-run` — PASS (`oh-my-codex-0.18.4.tgz`, package size `3.6 MB`, unpacked size `22.1 MB`, `2974` files). Log: `.omx/logs/release-0.18.4-npm-pack-dry-run.log`.

## No-publish / no-tag evidence before final tag

- `git tag --list 'v0.18.4'` showed no local `v0.18.4` tag before tagging.
- `git tag --points-at HEAD` showed no tag at the release-prep worktree HEAD before the release commit.
- No `npm publish` command was run by local prep; publication is delegated to the release workflow after `v0.18.4` tag push.

## External release actions

1. Commit release prep using the Lore commit protocol.
2. Push `dev` with the release prep and merged `main` attribution fixes.
3. Merge `dev` to `main`.
4. Create/push tag `v0.18.4` from merged `main`.
5. Verify GitHub release workflow assets and npm publication.
6. Fill CI/publish evidence in this document after publication if needed.

## Current readiness verdict

Local release prep is ready for commit, merge to `main`, and tag cut. Do not claim `0.18.4` is published until the tag workflow and npm/GitHub release evidence are verified.
