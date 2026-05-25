# Release readiness: oh-my-codex 0.18.3

## Range

- Previous tag: `v0.18.2` (`29e87a24a0ed354283604bfc1ba995d1245813c4`).
- Candidate branch during prep: `dev` at `7f0a3fa1` after rebasing release metadata over the latest `origin/dev` delta.
- Release tag to create after approval: `v0.18.3`.
- Compare: `v0.18.2..HEAD` before tag, then `v0.18.2..v0.18.3` after tagging.

## Release scope

`0.18.3` packages the post-`0.18.2` patch train:

- HUD lifecycle/reconcile fixes: coalesced launch panes, preserved session id/owner env, dead-leader HUD reaping, and UserPromptSubmit revive reuse.
- Team diff gutter preservation for wrapped multi-line hunks.
- Deep-interview runtime config overrides and stricter `plan_then_execute` downstream-authority enforcement.
- Auth slot hot-swap wrapper support.
- Explore runtime guidance keeps prompt syntax visible.
- Plugin-owned Codex hook preservation during setup/update paths.
- Scholastic ontology reviewer agent catalog/native-config support.
- Skills/agents bloat-audit and connectivity-roadmap documentation.

## Merged PR inventory

- #2474 — skills/agents bloat-audit + connectivity roadmap.
- #2476 / #2478 — enforce deep-interview `plan_then_execute` downstream authority.
- #2477 — respect plugin-owned hooks without overwriting user surfaces.
- #2481 — coalesce launch HUD panes by leader.
- #2482 — support `deepInterview` runtime config overrides.
- #2483 — add Scholastic ontology reviewer.
- #2484 / #2493 — add auth slot hot-swap wrapper.
- #2485 / #2486 — preserve HUD session id and owner env.
- #2487 / #2491 — preserve Team diff gutter on wrapped multi-line hunks.
- #2488 / #2492 — reuse existing HUD during UserPromptSubmit revive.
- #2489 — reap dead-leader HUD panes on launch.
- #2494 / #2495 — keep prompt syntax visible in explore runtime guidance.

## UltraQA / local validation evidence

UltraQA planning artifacts:

- Context: `.omx/context/release-0-18-3-after-ultraqa-20260525T040404Z.md`
- PRD: `.omx/plans/prd-0.18.3-release.md`
- Test spec: `.omx/plans/test-spec-0.18.3-release.md`
- Consensus: `.omx/plans/release-0.18.3-ralplan-consensus.md`
- Scenario matrix: `.omx/qa/ultraqa-release-0.18.3.md`

Completed gates:

- [x] `npm run lint` — PASS (`Checked 665 files`, no fixes applied). Log: `.omx/logs/ultraqa-0.18.3-lint.log`.
- [x] `npm run check:no-unused` — PASS. Log: `.omx/logs/ultraqa-0.18.3-no-unused.log`.
- [x] `npm run test` — PASS. Evidence: `5335` passed, `0` failed, `1` skipped; catalog check ok. Log: `.omx/logs/ultraqa-0.18.3-npm-test.log`.
- [x] Adversarial release harness — PASS for malformed state, prompt-injection text, repeated interruption/cancel wording, bounded hung child process, misleading success output, and no-`v0.18.3` tag side-effect guard. Log: `.omx/logs/ultraqa-0.18.3-adversarial-harness.log`.
- [x] Targeted changed-area tests, project-native harness, rerun twice — PASS (`1149` tests, `0` failed on each run). Log: `.omx/logs/ultraqa-0.18.3-targeted-rerun-project-native.log`.
- [x] `npm pack --dry-run` before metadata bump — PASS for the pre-bump package surface. Log: `.omx/logs/ultraqa-0.18.3-npm-pack-dry-run.log`.
- [x] Final metadata-sensitive `npm pack --dry-run` after the `0.18.3` bump — PASS. Produced `oh-my-codex-0.18.3.tgz` dry-run listing, package size `3.6 MB`, unpacked size `21.8 MB`, `2910` files. Log: `.omx/logs/release-0.18.3-final-npm-pack-dry-run.log`.
- [x] Final post-bump `npm run build`, `npm run lint`, `npm run check:no-unused`, `npm run verify:native-agents`, `npm run sync:plugin`, `npm run verify:plugin-bundle`, `node dist/scripts/generate-catalog-docs.js --check`, and `git diff --check` — PASS. Logs under `.omx/logs/release-0.18.3-final-*`.

Harness correction note:

- A first direct `node --test ...` targeted rerun failed because it bypassed the project-native `dist/scripts/run-test-files.js` environment sanitation (`OMX_TEST_RELAX_TMUX_TIMEOUT`, runtime env scrubbing). The corrected project-native targeted rerun passed twice.

## Accepted residual risk

- `cargo test` failed in `crates/omx-explore/src/main.rs` test `run_command_with_timeout_kills_process_group_children`: expected the child TERM trap file to contain `term`, but it was empty within the assertion window. Command log: `.omx/logs/ultraqa-0.18.3-cargo-test.log`.
- Release-owner direction on 2026-05-25: “no just ignore that part.” This readiness record therefore treats the Rust process-group cleanup test failure as waived for `0.18.3`, not fixed.
- Follow-up recommendation: fix or quarantine the `omx-explore` process-group timeout cleanup assertion before the next release that changes explore/process-tree behavior.

## No-publish / no-tag evidence

- `git tag --points-at HEAD` showed no `v0.18.3` during UltraQA.
- `git tag --list 'v0.18.3'` showed no local `v0.18.3` tag during UltraQA.
- No `npm publish` command was run by this local prep. Grep matches in logs are release-workflow test text only, not an executed publish command.

## Remaining external release actions

1. Commit release prep using the Lore commit protocol.
2. Push/merge to the release branch as appropriate.
3. Create/push tag `v0.18.3` only after maintainer approval.
4. Verify GitHub release workflow assets and npm publication.
5. Fill CI/publish evidence in this document after publication.

## Current readiness verdict

Local release prep is ready to proceed with the explicitly waived Rust residual risk. Do not claim `0.18.3` is published until the tag workflow and npm/GitHub release evidence are recorded.
