# Team coordination protocol

`$team` uses a lightweight Team Big Five + ATEM-inspired coordination gate.

## Activation heuristic

Stay lightweight for independent fan-out: isolated per-file/per-doc work, typo/copy edits, read-only sweeps, or explicit “no shared files/no dependencies” lanes. Workers use the normal concise Team runtime contract: startup ACK, claim-safe lifecycle, status, verification, and completion evidence.

Activate the coordinated protocol when task text or task state shows dependencies, shared files/surfaces/contracts, cross-boundary ownership, handoffs, integration/merge work, blocked lanes, or changed assumptions.

## Coordinated protocol

When active, workers apply a concise boundary checklist:

- Shared mental model / single source of truth: task JSON, inbox, mailbox, approved handoff, and leader updates are canonical.
- Closed-loop communication / ACK-readback handoffs: acknowledge understood scope, affected artifact/path, owner, and next action.
- Mutual performance monitoring at boundaries: check upstream/downstream contracts, shared files, and verification evidence.
- Backup/reassignment behavior: blocked workers report the smallest useful help/reassignment request and continue safe unblocked slices.
- Adaptability checkpoints: changed assumptions, dependencies, or verification results trigger a brief leader-facing update before scope widens.
- Team orientation: optimize for the integrated team outcome; call out integration risks, missing tests, and peer impacts.

ATEM fit is intentionally narrow: use it for agile transition/action/interpersonal moments around team boundaries, not as heavyweight ceremony or provider-specific plugin behavior.
