# Ralph Cancellation Contract (Normative)

This contract defines required post-conditions for Ralph cancellation, whether
Ralph was started directly or linked from the real `omx team ralph ...` launch
path.

## Required post-conditions

After cancelling Ralph, implementations MUST ensure:

1. Targeted Ralph state is terminal and non-active:
   - `active=false`
   - `current_phase='cancelled'` (or propagated linked terminal phase when team-linked)
   - `completed_at` is set (ISO8601)
2. Linked mode behavior:
   - If Ralph is linked to Ultrawork/Ecomode in the same scope, that linked mode MUST also be terminal/non-active.
   - Unrelated unlinked modes in the same scope SHOULD remain unchanged.
3. Team-linked ordering:
   - If `linked_team=true`, Team cancellation/terminalization MUST happen before Ralph terminalization.
   - Ralph MUST record `linked_team_terminal_phase` and `linked_team_terminal_at` when propagated.
4. Cross-session safety:
   - Cancellation MUST NOT mutate mode state in unrelated sessions.

## Implementation alignment points

- `src/cli/index.ts` (`cancelModes`) enforces scoped cancellation and linked cleanup ordering.
- `skills/cancel/SKILL.md` documents scope-aware cancellation behavior and compatibility fallback policy.
- `scripts/notify-hook.js` enforces linked team→ralph terminal synchronization in current scope only.

## Linked terminal phases

Only terminal phases can be propagated from team to Ralph:

- `complete`
- `failed`
- `cancelled`

All other team phases must normalize to `cancelled` for Ralph terminalization during cancellation.
