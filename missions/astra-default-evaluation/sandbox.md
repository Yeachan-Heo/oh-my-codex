---
evaluator:
  command: node dist/scripts/eval/eval-astra-defaults.js
  format: json
  keep_policy: score_improvement
---

# Sandbox rules

- Keep task fixtures free of model configuration; configuration belongs in `configs/`.
- Do not weaken a quality check to make a configuration pass.
- Do not invent usage, latency, or operator-effort numbers. Unattributed values are `null` and are
  reported as `unknown`.
- Required workflow stages and independent review stay intact in every evaluated configuration.
- Adding a fixture requires its quality checks; adding a configuration requires the effective model
  and reasoning effort for every surface the fixtures exercise.

# Evaluation policy

- `pass=true` means the suite validates and every deterministic no-model baseline reproduces its
  fixture's expected answer.
- `score` is the fraction of deterministic baselines that pass, from `0.00` to `1.00`.
- Higher scores are better.
