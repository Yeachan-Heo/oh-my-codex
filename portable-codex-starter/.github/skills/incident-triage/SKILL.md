# Incident Triage

Use this skill when something broke and you need fast stabilization.

## Use when

- a build suddenly fails
- a regression appears after a merge
- a service or flow works locally but fails in CI or runtime
- you need a shortest-path root-cause summary

## Workflow

1. Capture the failure symptom exactly.
2. Separate signal from noise: first failing command, first bad log line, changed files, recent branch context.
3. Reproduce with the smallest deterministic command.
4. Identify the most likely owner path: code, config, workflow, secret, dependency, or environment.
5. Propose the next smallest safe action.

## Output

- symptom
- likely cause
- evidence
- immediate containment step
- next corrective action

## Guardrails

- Lead with the first useful failure signal, not the longest log.
- Distinguish confirmed cause from informed suspicion.
- Prefer containment and clarity over broad speculative fixes.
