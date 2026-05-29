# Goal Harness Completion Audit - 2026-05-29

This audit maps the active Codex goal-native OMX harness objective to current repository evidence. It is a verification aid, not a claim that the broad autonomy system is permanently solved.

## Requirement Evidence

- Single Codex goal ownership: `src/goal-harness/artifacts.ts`, `src/goal-harness/completion.ts`, and `skills/goal-harness/SKILL.md` require the leader to own `get_goal`, `create_goal`, and `update_goal`; shell commands only emit handoffs and artifacts.
- Prompt refinement and routing: `src/goal-harness/policy.ts` builds refined goal prompts and routes direct, goal-only, plan, Ralph-loop, and Team-assisted work. Covered by `src/goal-harness/__tests__/policy.test.ts`.
- Deep-interview intake and ralplan critique: `src/goal-harness/planning.ts` writes `intake.md` and `plan.md` under `.omx/goals/goal-harness/<slug>/`. Covered by `planning.test.ts`.
- Ralph-style persistent leader memory: `src/goal-harness/runtime.ts` stores phase, trajectories, leader steps, Team plans, perturbations, completion gates, Codex snapshots, and bounded annealing budgets in `runtime.json`. Covered by `runtime.test.ts` and `lifecycle.test.ts`.
- Annealing/backpressure schedule: early/middle/late/stuck challenges are defined in `policy.ts`; next-action transitions are in `runtime.ts`; stuck perturbation artifacts are in `perturbation.ts`.
- Optional Team worker lanes: `team-packet.ts` writes manifest, lane instructions, and result templates; `team-result.ts` imports worker evidence only after boundary confirmation. Covered by `team-packet.test.ts` and `team-result.test.ts`.
- Hooks/status/HUD surfaces: `$goal-harness` is registered in hook detection and canonical state; HUD renders `harness:<phase>`. Covered by hook, state, and HUD focused tests.
- Completion gate: `completion.ts` requires late phase, leader actor, objective audit, non-empty implementation evidence, passing external verification, clear adversarial review, and a basin-escape convergence challenge before local validation passes. It then requires a fresh complete `get_goal` snapshot before marking the local workflow complete.
- Lightweight aggregate status: `status.ts` summarizes stages without introducing heavy Ultragoal ledgers. Covered by `status.test.ts`.
- Product-level install surface: `package.json` exposes the sibling `omg` bin at `dist/cli/omg.js`; `src/cli/omg-main.ts` maps `omg <command>` to the goal harness engine and documents `npx -p oh-my-codex omg ...`. Covered by `goal-harness.test.ts`, `package-bin-contract.test.ts`, and packed install smoke.

## Latest Tightening

- `buildGoalHarnessNextAction` now includes `--slug <slug>` in the default late completion-gate recommendation.
- `evaluateGoalHarnessCompletionGate` now rejects blank implementation evidence, missing/non-finite alternative counts, and adversarial reviews with issues or blocked status.
- The CLI now requires an explicit `--phase` for `advance`, and worker candidate trajectories require a worker role plus score.
- Early trajectory selection now requires at least two candidates plus one independent alternative with distinct source, role, or novelty evidence before the runtime can move from exploration to exploitation.
- Late phase entry now requires implementation evidence, a selected trajectory, middle-phase exploitation, and at least one critic/tester pressure trajectory.
- `sync-goal` records active `get_goal` snapshots with status, token budget, and remaining-token evidence without treating them as completion snapshots.
- `next` and `summary` are artifact-aware and keep early execution on required deep-interview and ralplan artifacts before trajectory recording.
- Completion gate verification now rejects self-asserted external passes without a concrete command or artifact path, and the basin-escape challenge requires at least two alternatives before completion can pass.
- `omg` now provides an npx-installable sibling product surface for Goal Harness while preserving `omx goal-harness` as the broader OMX subcommand path.

## Verification Run

Current focused verification passed:

```sh
npm run build
node --test dist/cli/__tests__/goal-harness.test.js dist/goal-harness/__tests__/policy.test.js dist/goal-harness/__tests__/runtime.test.js dist/goal-harness/__tests__/completion.test.js dist/goal-harness/__tests__/artifacts.test.js dist/goal-harness/__tests__/planning.test.js dist/goal-harness/__tests__/status.test.js dist/goal-harness/__tests__/lifecycle.test.js dist/goal-harness/__tests__/team-packet.test.js dist/goal-harness/__tests__/team-result.test.js dist/goal-harness/__tests__/perturbation.test.js dist/hooks/__tests__/goal-harness-keyword.test.js dist/state/__tests__/goal-harness-workflow-transition.test.js dist/hud/__tests__/render.test.js dist/hud/__tests__/state.test.js dist/hud/__tests__/index.test.js dist/hud/__tests__/reconcile.test.js dist/cli/__tests__/package-bin-contract.test.js dist/scripts/__tests__/smoke-packed-install.test.js
npm run lint
npm run check:no-unused
npm run sync:plugin:check
node dist/scripts/generate-catalog-docs.js --check
npm pack --json --ignore-scripts
npm exec --yes --package ./oh-my-codex-0.18.6.tgz -- omg --help
npm run smoke:packed-install
```

Result: 205 focused tests passed; package smoke passed.

## Residual Risk

The full `npm test` suite has known unrelated or environment-sensitive failures in this worktree, including missing native `cargo`/`tmux` dependencies and pre-existing auth/team assertions. Treat focused green tests as evidence for the goal-harness slice, not as proof that the entire repository suite is clean.
