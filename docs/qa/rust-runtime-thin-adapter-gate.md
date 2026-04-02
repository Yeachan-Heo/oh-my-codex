# Rust Runtime Thin-Adapter Release Gate

This checklist is a hard gate for the Rust-core + thin-adapter cutover.
CI/release validation MUST fail when any required scenario below is missing or
failing.

## Verification matrix gate

| ID | Scenario | Required evidence | Status |
|---|---|---|---|
| G1 | Team status reads the manifest-authored compatibility view | `src/compat/__tests__/rust-runtime-compat.test.ts` | [x] |
| G2 | Doctor preserves manifest-first tmux/session precedence | `src/compat/__tests__/rust-runtime-compat.test.ts` | [x] |
| G3 | HUD preserves session-scoped state precedence over root fallback | `src/compat/__tests__/rust-runtime-compat.test.ts` | [x] |
| G4 | Thin-adapter contract docs stay aligned with the reader compatibility lane | `docs/contracts/rust-runtime-thin-adapter-contract.md` + `src/verification/__tests__/rust-runtime-thin-adapter-gate.test.ts` | [x] |
| G5 | Watcher send-keys parity stays covered by the Step 3 companion suites | `src/hooks/__tests__/notify-hook-team-dispatch.test.ts`, `src/hooks/__tests__/notify-hook-team-leader-nudge.test.ts`, `src/notifications/__tests__/tmux-detector.test.ts` | [x] |

## Pre-mortem scenario mapping

| Pre-mortem scenario | Gate(s) |
|---|---|
| Semantic leakage survives into legacy readers | G1, G2, G3, G4 |
| Reader precedence drifts between config/manifest or session/root scopes | G1, G2, G3 |
| Watcher send-keys parity breaks | G5 |
| Mux contract stays tmux-shaped instead of Rust-canonical | G4 |

## Required docs

- `docs/contracts/rust-runtime-thin-adapter-contract.md`
- `docs/interop-team-mutation-contract.md`
- `docs/qa/runtime-team-seam-audit-2026-04-01.md` (non-gating follow-up seam snapshot)

## Non-gating follow-up audit

The current thin-adapter cutover still carries a small number of known seam gaps
that are intentionally tracked outside the release gate. See
`docs/qa/runtime-team-seam-audit-2026-04-01.md` for the remaining
metadata-resolution and compatibility-reader follow-ups.
