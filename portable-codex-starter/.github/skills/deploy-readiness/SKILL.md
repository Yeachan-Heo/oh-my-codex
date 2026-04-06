# Deploy Readiness

Use this skill when preparing a branch or PR for release, merge, or deployment.

## Use when

- you want a release-readiness checklist
- you need to confirm that build, tests, docs, and risks are aligned
- you need a concise go / no-go recommendation

## Workflow

1. Identify the deployment surface: package, app, workflow, service, or library.
2. Check the expected validation commands for this repo.
3. Confirm environment-sensitive files changed: workflows, secrets references, config, migrations.
4. Review rollback or mitigation notes for risky changes.
5. Summarize blockers separately from non-blocking follow-ups.

## Output

- validation completed
- blockers
- follow-ups
- deployment risk level
- go / no-go recommendation

## Guardrails

- Prefer explicit evidence over assumptions.
- Do not call something deploy-ready if key validation was skipped.
- Treat workflow, secret, and migration changes as higher risk by default.
