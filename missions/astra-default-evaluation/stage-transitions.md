# Deterministic stage-transition reports

This extends the existing evaluation path for #3655 and the
[maintainer invitation](https://github.com/Yeachan-Heo/oh-my-codex/issues/3664#issuecomment-5648392099).
It imports supplied observations; it never launches configurations, calls models,
collects telemetry, or changes routing. Live comparisons still require owner spend
approval. No model ranking, quality result, price, or savings claim follows from
these examples.

## Reproduce

From the checkout root, after `npm ci --ignore-scripts`:

```sh
npm run build
node dist/scripts/eval/eval-astra-defaults.js
node dist/scripts/eval/eval-astra-defaults.js \
  --report missions/astra-default-evaluation/examples/stage-transition/records.json \
  --configs missions/astra-default-evaluation/examples/stage-transition/configs
node dist/scripts/run-test-files.js dist/evals/astra-defaults/__tests__
```

The default command retains its `{pass, score, fixtures, configs,
deterministicBaselines}` JSON contract. Report mode renders Markdown and returns
success when inputs validate and rendering succeeds, even when supplied tasks
declare failures. It is not an execution-success gate. Invalid input returns the
existing `{pass:false, score:0}` error contract and a diagnostic on stderr.

`--configs` selects an alternate config directory while reusing the same fixtures;
it is only available with `--report`. The report adds any deterministic baselines
declared by the suite, including the existing Sparkshell controls. Supplied-record
reports also accept suites without baselines; the default evaluator still requires
at least one. The supplied JSON envelope requires `evidence` (`synthetic`
or `observed`) and `records`. This label describes the supplied records, not those
locally computed no-model controls. `observed` is a submitter's assertion, not
independent verification by the loader. Supplied checks must match fixture names
and kinds; this validates their shape, not their truth.

The checked-in [example report](examples/stage-transition/report.md) is reproduced
byte for byte by the test. It compares proposed native-agent planner/executor
stage descriptors using the existing executor fixture. There is no planner
fixture, planner quality grade, or exercised native-agent path here. Both proposed
strategies use native agents; “continue-pair” keeps the pair across stages and
does not assert same-session continuity. The split example deliberately supplies
conflicting requested/launch/runtime pairs and incomplete usage. Its figures and
check outcomes are synthetic; no fixture implementation or required command ran.

## Identity and settings

- `EvalConfig.stages` declares ordered, uniquely named stages: `id`, `role`,
  `surface` (`main`, `native-agent`, `team-worker`, `sparkshell`), `requested`
  model/effort and separate `overrideSource` strings for model and effort.
  These are experiment descriptors, not a capability registry or launch API.
- Each staged `RunRecord` has a `workflowId` and exactly the declared stage IDs.
  Missing evidence uses a stage entry with `usage: null`, `latencyMs: null` and
  absent setting observations. Stage rows cannot declare task outcomes.
- `launchResolved` and `runtimeObserved` each carry nullable `model` and
  `reasoningEffort` plus a concise `source`. Absent objects or null fields mean
  unknown. A launch receipt, explicit pin, or parent fallback never fills runtime
  evidence. An override that changes launch settings should be identified in the
  launch source; separate requested provenance remains intact.
- Existing `roles` pins and configs still load. They are declared comparison
  values, not launch-resolved or runtime observations. For staged workflows,
  `stages.requested` describes the proposed stage pair; `roles` remains the
  configuration for unstaged fixture surfaces. The primary baseline and example
  role pins use a deliberate uniform-medium comparison, not a reproduction of
  shipped role efforts. No model or effort is silently substituted or ranked.

The loader rejects duplicate fixture/config records (including different workflow
IDs) and reused workflow IDs within a config. Repeated trials remain unsupported;
this prevents stage or repetition rows from producing weighted rates above 100%.
Workload frequencies still require documentation. Declared pass rates retain the
existing single-record semantics; they do not certify accepted completion.

## Accounting and completion rules

One `RunRecord` is one workflow/task outcome. `usageScope` selects the canonical
usage level: `workflow` uses only `RunRecord.usage`, treating stage usage as
non-additive detail; `stages` uses only constituent stage usage and requires
`RunRecord.usage: null`. Without stages, the existing workflow accounting applies.
Stage-scope counters must cover disjoint work, including relevant handoff,
receiving-context, retries, review and repair. Do not supply inclusive parent and
child counters as disjoint stages. The loader cannot verify counter provenance.
Benchmark/judge overhead belongs outside the evaluated workflow's records.

| Usage field | Meaning |
| --- | --- |
| `inputTokens` | Inclusive input total, including cache reads |
| `outputTokens` | Inclusive output total, including reasoning tokens where present |
| `uncachedInputTokens` | Non-cached input subset |
| `cacheReadTokens` | Cached input subset; never added again to input |
| `cacheWriteTokens` | Separately exposed write counter; never added to input/output or assumed to be disjoint from input |
| `source` | Concise counter provenance; required when a breakdown is supplied |

Input and output totals retain their existing required numeric fields within a
non-null usage object. Breakdown fields are optional. Omitted/null means unknown;
`unsupported` means the source cannot expose that category; `not-applicable`
requires a source explaining why the category does not apply. Numeric zero is a
measurement. The no-model extractor records zero input/output/reads and marks
cache writes not applicable. No cache-write count is invented or inferred.

Available uncached input plus cache reads cannot exceed inclusive input; when
both are accounted for, they must equal it (`not-applicable` contributes no
tokens). Records with incompatible provider definitions must leave the breakdown
unknown instead of relabeling counters. Cache writes have no universal additive
relationship imposed by this harness. All token counts must be safe nonnegative
integers; durations/operator time must be finite and nonnegative. Unsafe token
sums are rejected.

Each category is summed independently. Partial sums show **known** measurements
and counts of unknown, unsupported or not-applicable entries. A missing category
does not hide other measurements. Legacy aggregate input/output stays null if
any canonical usage is unavailable; the detailed table preserves available sums.
Complete attribution now requires all five token categories and known provenance
at the selected level. Even complete supplied token attribution is not complete
billing evidence or a cost/savings result. Old records without breakdowns still
render, with unavailable observations explicitly unknown.

Workflow `latencyMs` means elapsed time to the reported endpoint; it is not the
sum of stage durations. Aggregate elapsed time sums workflow values, not concurrent
wall time. `operatorMinutes` remains separate. Counts/rates use declared outcomes;
response-content grades and `requiredChecksPassed` are separately visible.
A command mention is not an executed check. A pass with failed/unknown required
checks is not verified completion. Required review and the authorized stopping
boundary remain part of a future experiment's acceptance criteria.

Context continuity does not prove cache reuse; a cache miss does not prove lost
context. Receiving input includes composed instructions, tools, role prompts and
retained context, not just a handoff packet. Record only exposed observations and
concise provenance, never private reasoning traces, raw prompts or secrets.
Model/effort choices remain hypotheses: equal effort labels do not mean equal
compute or quality, and an accepted plan does not prove inexpensive execution.

## Deferred work

This does not resolve #3655's owner-gated live comparison. The corrected
`astra-defaults.json` label now identifies its uniform-medium comparison role;
it does not reconstruct shipped role efforts. Upgrading the executor's
response-content fixture into an actual editing/check-running experiment remains
separate work; existing Luna configs and Sparkshell are preserved.
