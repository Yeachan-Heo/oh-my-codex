# Runtime Team Seam Audit - 2026-04-01

Date: **2026-04-01**  
Baseline commit: **`51579ce`** (`upstream/dev`)

## Scope

This note records the remaining high-value runtime seam gaps after the Rust thin-adapter migration wave. It is intentionally documentation-only and does not change runtime behavior.

## Summary

The team/runtime stack is no longer missing a Rust contract surface. As of the
issue #1108 seam-hardening pass, the dispatch/mailbox dual-write gap is closed;
the remaining risk is narrower:

1. **Team metadata resolution still falls back across multiple files**
2. **Compatibility readers still carry legacy/current precedence logic**

These are follow-up seam-hardening gaps, not evidence that the Rust runtime direction was wrong.

## Remaining seam gaps

### 1. Rust runtime ↔ TS team state dual-write

Status: **resolved by issue #1108**

Evidence:

- `src/team/state/dispatch.ts:130-140`
- `src/team/state/mailbox.ts:45-49`

Current state:

- Rust bridge / compat files are now the canonical dispatch and mailbox surface
- legacy TS dispatch/mailbox files remain fallback-only for degraded lanes where the bridge is disabled, unavailable, or unreadable
- watcher/runtime paths were narrowed so bridge-owned success paths no longer semantically dual-write legacy mailbox/dispatch state

Risk:

- residual regressions are now more likely to come from incorrect fallback activation than from active dual-write divergence
- future refactors could accidentally widen fallback behavior unless tests/docs keep the canonical-owner rule explicit

Desired end state:

- Rust owns the semantic transition
- TS stores only adapter-local or presentation-local metadata

### 2. Team metadata resolution still spans multiple files

Evidence:

- `src/team/api-interop.ts:423-438`

Current state:

- worker identity metadata is checked first
- then `manifest.v2.json`
- then `config.json`

Risk:

- working-directory or state-root resolution can depend on fallback order instead of one canonical source

Desired end state:

- one canonical metadata source for team state-root / working-directory resolution
- the remaining files become derived compatibility views only

### 3. Runtime ownership contract vs. cutover reality

Status: **resolved by issue #1108 for dispatch/mailbox ownership**

Evidence:

- `src/runtime/bridge.ts:2-6`
- `src/team/state/dispatch.ts:130-140`
- `src/team/state/mailbox.ts:45-49`

Current state:

- the bridge contract and the team dispatch/mailbox write paths now agree on Rust ownership
- remaining ownership work is outside dispatch/mailbox and focuses on broader metadata/fallback simplification

Risk:

- contributors may still misread broader metadata/fallback layers as ownership layers if the docs are not kept precise
- future compatibility work could accidentally reintroduce JS canonical writes without contract/test coverage

Desired end state:

- Rust is the sole semantic owner for runtime state transitions
- TS remains a thin reader / delivery adapter only

### 4. Compatibility readers still carry fallback precedence logic

Evidence:

- `src/compat/__tests__/rust-runtime-compat.test.ts:47-170`
- `src/hud/state.ts:107-123`
- `src/team/api-interop.ts:432-436`

Current state:

- compatibility readers intentionally preserve legacy/current precedence
- this is useful for migration safety, but it keeps the read path more complex than the target architecture

Risk:

- future format drift can hide inside fallback behavior instead of failing at a single canonical reader boundary

Desired end state:

- compatibility readers keep only the minimum fallback behavior still required by supported migration lanes
- newer paths read one canonical Rust-authored surface first

## Recommended follow-up order

1. Collapse team state-root / working-directory resolution to one canonical metadata source
2. Reduce compatibility fallback layers after the write path is single-owner

## Out of scope

- replacing the existing Rust runtime contract
- removing compatibility readers immediately
- changing release gates in this documentation pass
