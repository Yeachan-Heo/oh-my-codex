# Worker 1 Risk Audit — autolayout tmux + team auto-merge/reporting

Date: 2026-03-18
Scope: audit remaining risks for the completed tmux autolayout feature and the observed team auto-merge/reporting issue.

## Findings

### 1) High risk: runtime emits integration event types that the public contract/API does not accept
Evidence:
- `src/team/runtime.ts` emits `worker_auto_commit`, `worker_merge_applied`, `worker_cross_rebase_applied`, `worker_cross_rebase_conflict`, and `worker_cross_rebase_skipped` via `appendIntegrationEvent(...)`.
- `src/team/contracts.ts` does **not** include those event types in `TEAM_EVENT_TYPES`.
- `omx team api read-events --input '{"team_name":"audit-remaining-risks-for-comp","type":"worker_merge_applied"}' --json` fails with `type must be one of: ...`.

Impact:
- Integration activity can be written to the NDJSON log but cannot be queried through the official API by its actual emitted type.
- This creates an observability gap and is a strong candidate root cause for the reported auto-merge/reporting inconsistency.

### 2) Medium risk: reporting vocabulary drift between contracts and runtime
Evidence:
- Contract exposes `worker_merge_report`, `worker_rebase_applied`, `worker_rebase_conflict`.
- Runtime currently uses `worker_merge_applied` and `worker_cross_rebase_*` instead.

Impact:
- Downstream tooling that keys off contract event names will miss successful merge/rebase integration activity.
- Wakeability/filtering behavior can diverge from what operators expect from the documented event set.

### 3) Medium risk: lint verification is noisy/broken in this branch due nested Biome root configs under `.omx/team/.../worktrees/*`
Evidence:
- `npm run lint -- ...` fails because Biome scans nested root configs in generated worker worktrees and reports `Found a nested root configuration`.

Impact:
- Required verification is harder to trust.
- CI/local verification can fail for repository-state reasons unrelated to the code under audit.

### 4) Medium risk: tmux autolayout changes are targeted and tested, but broader runtime health is currently red
Evidence:
- Focused tmux/layout tests pass, including `dist/team/__tests__/tmux-session.test.js` coverage for resize-hook registration and relaunch/reconcile behavior.
- Broader runtime suite still has many unrelated failures/ENOENT assertions when running the selected runtime bundle.

Impact:
- The new tmux autolayout feature itself looks reasonably covered.
- However, team runtime baseline instability increases regression/debugging risk around shutdown, mailbox, and task lifecycle flows.

## What looks good
- The autolayout implementation keeps topology stable by reconciling via `select-layout main-vertical`, `main-pane-width`, and HUD resize, without topology-changing commands in the hook builders.
- Hook builder tests explicitly assert absence of `split-window`, `kill-pane`, `kill-session`, and tiled-layout mutations.
- Notify-hook coverage for `leader_pane_missing_deferred` is present and passing.

## Recommended next actions
1. Normalize integration event names across `src/team/runtime.ts`, `src/team/contracts.ts`, and API validation/read paths.
2. Add/adjust a regression test that proves successful merge/rebase integration events are queryable via `omx team api read-events`.
3. Scope Biome linting away from generated nested worktree configs or prevent those configs from being treated as nested roots.
4. Re-run the targeted runtime suite after event-name normalization to confirm the reporting path is fixed without regressing tmux autolayout behavior.
