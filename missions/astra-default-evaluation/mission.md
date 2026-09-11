# Mission

Measure where OMX's Astra defaults (merged in #3622) improve completed OMX work, and where a
supported override reaches comparable quality with less usage or latency. This is an evaluation,
not a claim that the defaults are defective. Retaining the current defaults is a valid outcome.

## Layout

- `fixtures/*.json` — model-agnostic task fixtures with predeclared quality checks. They contain no
  model configuration and stay reusable across future OMX default changes.
- `configs/*.json` — pinned, inspectable configurations: OMX revision, effective model and reasoning
  effort per role, service tier, and observable cache conditions. Exactly one is the baseline.

## Covered surfaces

| surface | fixture | quality check |
| --- | --- | --- |
| `explore` | `explore-locate-stop-nudge` | names the implementing source, no unrequested follow-up work |
| `executor` | `executor-bounded-change` | required checks run, scope not inflated |
| `code-reviewer` | `code-reviewer-known-defect` | finds the planted defect, no false positive on the clean control hunk |
| Team low-complexity worker | `team-worker-delegated-task` | handoff names changed file and check outcome, no continuation after completion |
| Sparkshell | `sparkshell-failing-tests`, `sparkshell-exit-status` | exact extraction; both carry a deterministic no-model baseline |

## Rules the harness enforces

- Task requirements, tools, and per-role reasoning effort stay fixed across the initial model
  comparison. Later effort tuning is a separate pass against the same predeclared requirements.
- Usage that cannot be attributed is recorded as `unknown`, never as zero, and blocks a complete
  cost claim for that configuration.
- Operator intervention, review, and repair time is reported separately from model usage, so work
  transferred to the operator cannot appear as savings.
- Workload-weighted results are emitted only when every evaluated fixture has a documented
  frequency; otherwise only per-task results are reported.
- Failed and difficult cases are reported separately from the aggregate.

## Success

1. `node dist/scripts/eval/eval-astra-defaults.js` passes: the suite validates and every
   deterministic no-model baseline reproduces its fixture's expected answer.
2. A run over the pinned configurations produces the report sections above with no fabricated
   usage, latency, or operator-effort values.
