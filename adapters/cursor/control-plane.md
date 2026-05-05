# Cursor Control Plane Contract

## Contract

1. Model decision steps (design/apply/review) are initiated from Cursor.
2. External systems (CI, n8n, monitoring) are execution surfaces, not decision surfaces.
3. Evidence flows back to repository artifacts (`openspec/`, PR comments, logs).

## Mandatory audit fields

- `triggered_by`
- `model_role`
- `model_name`
- `trace_id`
- `decision`

## Pause-on-loop guardrail

When the same failing test is fixed 3 times without success:

- Stop auto-fixing.
- Output hypothesis, conflict points, and two options.
- Require human confirmation to continue.

