# Open PR readiness matrix for `dev` — 2026-04-09 UTC

Current `dev` head reviewed: `8656d21149a0772369f697df002f7bf85002db8d`.

## `dev` CI note

Push run `24141814673` on `dev` finished red because long jobs were cancelled, not because the fast validation jobs failed.

- Passed on `dev`: Rust Format, Rust Clippy, Lint, Typecheck (Node 20/22), Test (Node 22 / smoke), Coverage Report (Rust), Coverage Gate (Team Critical), Ralph Persistence Gate.
- Cancelled on `dev`: `Test (Node 20 / full)`, `Coverage Report (TypeScript Full)`.
- Failed gate: `CI Status`.
- Workflow reason: `.github/workflows/ci.yml:260-289` requires every `needs.*.result` to equal `success`; cancelled/skipped results force the gate red.

## Readiness matrix

| PR | Summary | Current checks | Merge blockers | Recommendation |
| --- | --- | --- | --- | --- |
| #1403 | Shared-session shutdown hardening + regression coverage | Fast checks mostly green, but both Typecheck jobs failed in run `24173665271`; full Node 20 suite still running | **Hard blocker:** `npm run check:no-unused` fails locally on PR head `e802eff1` with `src/team/runtime.ts(20,3): error TS6133: 'isNativeWindows' is declared but its value is never read.` | **Do not merge yet.** Fix unused import, rerun PR CI, then reassess. |
| #1402 | tmux HUD self-healing / prompt-submit reconcile | Lint, typecheck, smoke, rust coverage, team coverage gate passed; full Node 20 and TS full coverage still pending | Pending long jobs; touches `src/cli`, `src/hud`, and native-hook operational events, so I would not merge before `dev` CI is green | **Good candidate once long jobs finish green and `dev` is green.** Recommended ahead of docs-only work. |
| #1400 | Unknown `$token` duplicate continuation + stale Ralph state fix | Lint, typecheck, smoke, rust coverage, team coverage gate passed; full Node 20 and TS full coverage still pending | Pending long jobs; overlaps `src/scripts/codex-native-hook.ts` and its tests with #1380 | **Merge after #1380 is in `dev`, then rebase/retest.** Otherwise likely conflict/re-review churn. |
| #1382 | Stale team worktree cleanup at startup | PR is open, but its head commit `e5f9ffe7...` is already an ancestor of current `dev` head | No merge work left; CI Status failure is stale noise from cancelled long jobs on an already-landed change | **Close as stale/already merged.** No merge needed. |
| #1380 | Stale deep-interview stop-hook gating fix | Fast checks passed; CI Status failed only because long jobs were cancelled in old run `24142611197` | Long jobs were cancelled; overlaps same native-hook files as #1400 | **Best first merge among the hook fixes once `dev` CI is green.** Land before #1400. |
| #1357 | AGENTS/template token reduction | Fast checks passed; CI Status failed only because long jobs were cancelled in old run `24145469951` | Long jobs cancelled; PR body/checklist says only two files changed, but diff also changes `CLAUDE.md` | **Hold for manual review after runtime fixes.** Lower urgency than #1380/#1400/#1402. |

## Recommended merge order

1. Close **#1382** as already merged into `dev`.
2. After `dev` CI is rerun/green, merge **#1380**.
3. Rebase/retest and merge **#1400**.
4. Merge **#1402** once its pending jobs finish green.
5. Re-review **#1357** (body/diff mismatch, prompt-contract risk) before merging.
6. Fix **#1403** unused import + rerun CI before considering merge.

## Evidence collected

- `gh run view 24141814673 --json ...` for current `dev` CI failure shape.
- `gh pr checks 1402`, `1400`, `1382`, `1380`, `1357`, `1403` for current PR statuses.
- `gh pr diff --name-only` for overlap checks.
- `git rev-list --left-right --count dev...pr-<n>` and `git merge-base dev pr-1382` for ancestry / already-merged detection.
- Local PR verification for #1403 in `/tmp/worker3-pr1403`:
  - `npm ci`
  - `npm run build`
  - `npm run check:no-unused` → unused import failure in `src/team/runtime.ts`.
