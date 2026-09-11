# Release readiness — 0.21.5

## Frozen candidate

- Previous immutable tag: `v0.21.4` → `304fb3b4825c4132c273732b14d2d5e86b54f8e3`.
- Product repair head: `7aa2b9a93188c7c4310fbc7cfd55a57f4577fe7f`, merged through PR #3650 as `00d31f78591a7f8c9f808a7bdb72948ec86af114`. A post-merge stress-test pass found a real bootstrap-sentinel ABA race in the canonical mode-binding lease; the fix (native OS mutex serialization) is PR #3652, merged as `e0004b693292e92209f5c41c5b292d934873fee1`.
- Reconciled release base: `3c761cda33959226e66642c325beb12355481ba6`; merges published main history into dev without conflicts. Previous-tag ancestry passes.
- Frozen range: 46 commits, 102 files, +3,268/−686 before release collateral/version changes.
- Full PR inventory and user-visible changes: `docs/release-notes-0.21.5.md`.
- Final dev candidate commit: `3d2743b33db3f4ed4385fe826a24ac60aef8a19c` (merged PR #3651 release preparation + PR #3657 PR-inventory correction).
- User authorization: this session requested dogfood and a new release only if LGTM, then explicitly requested fixing all blockers under Ultragoal.
- Parent checkout contains an unrelated user README edit; it was not committed or overwritten. Release preparation uses a clean checkout.

## Version carriers

`package.json`, both package-lock root versions, workspace `Cargo.toml`, and plugin manifest are synchronized to 0.21.5. Historical workspace Cargo.lock package-version drift is not silently treated as new product behavior; generated lock changes must be reviewed if included.

## Verification

| Gate | Status / evidence |
|---|---|
| Repair exact-head CI | Passed: [34444169245](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34444169245), SHA `7aa2b9a9…` |
| Repair source review | Final authenticated-bootstrap architecture approved; cleaner and adversarial QA passed |
| Real packed-install lifecycle | Passed on macOS with default temporary directory and actual Codex 0.153.4; hooks/list, trust persistence, foreign hooks, setup/uninstall exercised |
| Focused smoke regression | 59/59 passed; exact-version and required-field negatives preserved |
| Darwin lease verification | 42/42 passed, including malformed/partial/symlink/foreign bootstrap refusal, deterministic ENOENT contender, repeated 20/32/64 stress |
| Other focused verification | Native-hook full suite, corrected platform fixtures, real tmux hostile receipt, lint, no-unused, generated/native-agent checks passed |
| Rust gates | Formatting, clippy with warnings denied, workspace tests passed |
| Bootstrap-sentinel ABA race (found post-merge) | Fixed via PR #3652 (native `omx-runtime lease-mutex` OS advisory lock serializing the full lease lifecycle); independent full-diff architecture review returned CLEAR/APPROVE with zero findings; PR #3652 exact CI passed in full |
| Clean whole-product local suite | **Passed**: all 439 test files, 0 failures, clean exit 0, at reconciled commit `859555b1` (`TMPDIR=/private/tmp npm run test:node`). Also passed: `verify:native-agents` (18 agents/32 prompt assets), `verify:plugin-bundle` (24 skill dirs), `verify:capabilities-lock`, `verify:prompt-guidance`, generated-catalog-docs check, prompt-inventory check |
| Reconciled versioned candidate local gates | Build, lint, no-unused, cargo fmt/clippy/workspace tests, 42/42 lease suite, and full packed-install smoke (real Codex 0.153.4 lifecycle) all passed in the reconciled release worktree |
| Release collateral PR / exact dev CI | PR #3651 merged (`b2e7afa2`); PR #3657 inventory correction merged (`3d2743b3`). Dev CI for final candidate `3d2743b3`: [34560825883](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34560825883), conclusion `success` |
| Protected-main PR review and exact main CI | Pending; one approving review required, no admin bypass |
| Annotated v0.21.5 tag / native Release workflow | Pending |
| Exact tag/SHA trusted OIDC npm publish | Pending |
| Registry/provenance/isolated install verification | Pending |
| Final dev alignment / next development base | Pending |

## Prior publication recovery

The previous GitHub v0.21.4 release had passed its native workflow but never received the separate CI trusted-publish dispatch. The existing exact-SHA OIDC workflow was dispatched once as [34436067953](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/34436067953), completed successfully, and npm now exposes 0.21.4 with SLSA provenance. An isolated consumer install, version command, and global native-runtime hydration passed. No tag was moved and no manual npm token was used.

## Negative evidence retained

The first local whole-product run failed 14 of 439 files. Follow-up isolated reproduction separated macOS fixture assumptions from real bootstrap contention and tmux receipt-format defects; those were repaired rather than skipped. One bounded version-probe timeout and one launcher timing/count failure occurred under concurrent load and passed unchanged isolated retries; the clean full rerun remains the authoritative local aggregate result. An intermediate native-hook rerun overlapped a build and was invalidated by deleted dist modules; a later rebuild-free native-hook run passed after closing test-owned retained handles. None of these intermediate failures is presented as a passing run.

## Publishing contract

Use reviewed PRs, exact candidate CI, protected main approval, annotated tag, successful native assets/manifest verification, and the existing main `ci.yml` workflow_dispatch with exact `release_tag` / `release_sha`. Verify public npm and a clean install before completing. Do not use administrator bypass, manual token publishing, blind retries, or tag movement.
