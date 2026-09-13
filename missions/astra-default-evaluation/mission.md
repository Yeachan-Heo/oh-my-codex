# Mission

Measure where OMX's Astra defaults (merged in #3622) improve completed OMX work, and where a
supported override reaches comparable quality with less usage or latency. This is an evaluation,
not a claim that the defaults are defective. Retaining the current defaults is a valid outcome.

## Layout

- `fixtures/*.json` — model-agnostic task fixtures with predeclared quality checks. They contain no
  model configuration and stay reusable across future OMX default changes.
- `configs/*.json` — pinned, inspectable experiment declarations: OMX revision, comparison model and
  reasoning effort per role, service tier, and cache conditions. These fields are not runtime
  observations; unknown values stay explicit. Exactly one configuration is the comparison baseline.

## Covered surfaces

Optional supplied-record reporting and stage/accounting semantics are documented
in [Deterministic stage-transition reports](stage-transitions.md). The default
no-model evaluator remains unchanged.

| surface | fixture | response-text check |
| --- | --- | --- |
| `explore` | `explore-locate-stop-nudge` | names the implementing source, no unrequested follow-up work |
| `executor` | `executor-bounded-change` | mentions the required test command, no scope-inflation phrases |
| `code-reviewer` | `code-reviewer-known-defect` | finds the planted defect, no false positive on the clean control hunk |
| Team low-complexity worker | `team-worker-delegated-task` | handoff text names a docs path and mentions a check, no continuation after completion |
| Sparkshell | `sparkshell-failing-tests`, `sparkshell-exit-status` | exact extraction; both carry a deterministic no-model baseline |

These checks score returned text. They do not verify that an executor edited a fixture repository,
that a required command ran, or that a Team worker used the declared surface. The two Sparkshell
baselines are the narrower exception: local extractors compute answers from fixed command-output
strings without invoking a model or executing those commands.

## Experiment requirements

- Task requirements, tools, and per-role reasoning effort stay fixed across the initial model
  comparison. Later effort tuning is a separate pass against the same predeclared requirements.
- Actual runs record requested settings separately from launch-resolved and runtime-observed settings;
  a declared configuration never substitutes for runtime evidence.
- Usage that cannot be attributed is recorded as `unknown`, never as zero, and blocks a complete
  cost claim for that configuration.
- Operator intervention, review, and repair time is reported separately from model usage, so work
  transferred to the operator cannot appear as savings.
- Workload-weighted results are emitted only when every evaluated fixture has a documented
  frequency; otherwise only per-task results are reported.
- Failed and difficult cases are reported separately from the aggregate.

## Implemented validation

- Suite loading validates fixture/configuration shape, requires one comparison baseline, and keeps
  model configuration out of task fixtures.
- `node dist/scripts/eval/eval-astra-defaults.js` validates the suite and checks that every declared
  deterministic no-model extractor reproduces its fixture's expected response text. It does not run
  the non-deterministic tasks or their required commands.
- Report mode validates supplied-record shape and renders declared outcomes, response-text grades,
  required-check status, settings observations, usage, latency, and operator effort as separate
  fields. It does not verify that supplied observations are true.

## Experiment success

An owner-approved run over the pinned configurations must execute the tasks and required commands,
capture available launch and runtime evidence, and produce the report sections above without
fabricated usage, latency, or operator-effort values. The current harness accepts and reports those
records; it does not collect them.
