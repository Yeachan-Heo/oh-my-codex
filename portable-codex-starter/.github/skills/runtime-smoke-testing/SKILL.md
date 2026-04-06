# Runtime Smoke Testing

Use this skill when you need quick runtime confidence, not just static reasoning.

## Use when

- a feature "should work" but needs real execution proof
- a CLI, HTTP endpoint, or boot path must be checked
- you need a compact PASS/FAIL report with actual output

## Workflow

1. Identify the smallest realistic path that proves the claim.
2. Verify prerequisites first: commands, ports, fixtures, credentials.
3. Start any required background process with captured logs.
4. Wait for readiness with bounded polling.
5. Run the smoke command or request.
6. Record actual output before making assertions.
7. Stop background processes and clean temp artifacts.

## Output

- commands run
- expected behavior
- actual behavior
- PASS / FAIL
- cleanup performed

## Guardrails

- Do not implement fixes in this skill.
- Do not leave orphaned processes.
- Prefer the lightest useful smoke path over broad end-to-end exploration.
