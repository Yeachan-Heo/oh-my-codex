# Opt-in GPT-6 fixed-medium comparison declarations

These three configurations declare Astra, Sol, and Luna comparisons at the same
OMX baseline, `cc02c05952fdee620ffe4342f87c32d1cd463ab3`. Every evaluated role
uses `medium` effort. Astra is the comparison baseline for this set; that label
does not select a runtime default or claim that Astra performs better.

The configurations are declarations only. They do not establish model
availability, supported effort, launch resolution, or runtime verification.
Equal effort labels do not imply equal compute or quality. Service tier and
cache conditions remain unknown until separately observed. This addition makes
no performance, cost, savings, or default-routing recommendation.

## Load or report

From the checkout root, after installing dependencies and running
`npm run build`, report separately supplied records with the existing CLI:

```sh
node dist/scripts/eval/eval-astra-defaults.js \
  missions/astra-default-evaluation \
  --report /absolute/path/to/supplied-records.json \
  --configs missions/astra-default-evaluation/gpt6-fixed-medium/configs
```

Replace the records path with an actual records file. The existing CLI requires
`--report` whenever `--configs` is used; there is no configs-only CLI validation
mode. Tests can load the declarations with
`loadSuite(missionDir, configsDir)` without supplying records or calling models.

The supplied JSON envelope contains `evidence` (`synthetic` or `observed`) and a
nonempty `records` array. Records must use the existing fixture IDs and one of
`gpt6-astra-medium`, `gpt6-sol-medium`, or `gpt6-luna-medium` as `configId`.
Checks must match the selected fixture's check names and kinds. These configs
declare no stages, so records must not contain stage rows. See the existing
[supplied-record contract](../stage-transitions.md) for outcomes, provenance,
unknown measurements, and accounting rules. Do not relabel historical records as
GPT-6 results; matching declaration IDs does not establish runtime identity.

Reporting reuses the six existing fixtures and adds their two deterministic
no-model controls. It imports records and renders a report; it neither launches
models nor collects observations. A successful report exit means input
validation and rendering succeeded, not that a task or required command ran.
The loader does not independently verify a submitter's `observed` label.

The historical `../configs` set and stage-transition synthetic example remain
separate. The default command still selects three historical configurations and
returns six fixtures and two deterministic baselines. No existing synthetic
report is regenerated for this opt-in set.

## Focused checks

```sh
node --test dist/evals/astra-defaults/__tests__/suite.test.js \
  dist/evals/astra-defaults/__tests__/stage-transition.test.js
node dist/scripts/eval/eval-astra-defaults.js
```

Live comparisons and a collector remain separate work requiring their own
authorization and runtime evidence.
