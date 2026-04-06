# Security Review Gate

Use this skill when a change touches auth, secrets, permissions, workflows, input validation, or external integrations.

## Use when

- reviewing security-sensitive diffs
- checking workflow and secret exposure risk
- validating least-privilege assumptions
- producing a merge gate for risky code paths

## Workflow

1. Identify trust boundaries and sensitive assets.
2. Inspect changed code and automation for secret leaks, privilege escalation, unsafe shelling out, and missing validation.
3. Check whether the change increases blast radius through workflows or deployment config.
4. Separate exploitable findings from hygiene suggestions.
5. Summarize required fixes before merge.

## Output

- critical findings
- medium findings
- low findings
- required fixes before merge
- residual risks

## Guardrails

- Prioritize real attack paths over style opinions.
- Workflow and secret handling changes deserve extra scrutiny.
- If a claim depends on runtime behavior, ask for or run verification instead of guessing.
