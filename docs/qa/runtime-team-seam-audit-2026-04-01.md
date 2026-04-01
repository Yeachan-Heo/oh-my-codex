# Runtime Team Seam Audit - 2026-04-01

Date: **2026-04-01**  
Baseline commit: **`51579ce`** (`upstream/dev`)

## Scope

This note records the remaining high-value runtime seam gaps after the Rust thin-adapter migration wave. It is intentionally documentation-only and does not change runtime behavior.

## Summary

The team/runtime stack is no longer missing a Rust contract surface. The remaining risk is narrower:

1. **Rust runtime ↔ TS team state is still dual-written in cutover paths**
2. **Team metadata resolution still falls back across multiple files**
3. **The declared Rust semantic-owner model is ahead of some TS canonical writers**
4. **Compatibility readers still carry legacy/current precedence logic**

These are follow-up seam-hardening gaps, not evidence that the Rust runtime direction was wrong.

## Remaining seam gaps

### 1. Rust runtime ↔ TS team state dual-write

Evidence:

- `src/team/state/dispatch.ts:130-140`
- `src/team/state/mailbox.ts:45-49`

Current state:

- Rust bridge writes are attempted first
- bridge failures are explicitly non-fatal
- TS file writes remain canonical during cutover

Risk:

- state divergence between Rust-authored compatibility output and TS-owned team files
- harder debugging when status, delivery, or mailbox transitions disagree

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

Evidence:

- `src/runtime/bridge.ts:2-6`
- `src/team/state/dispatch.ts:130-140`
- `src/team/state/mailbox.ts:45-49`

Current state:

- the bridge contract says semantic mutations route through Rust
- the team cutover paths still treat TS files as canonical in some flows

Risk:

- contributor confusion about which layer is allowed to establish semantic truth
- longer-lived dual-write migration pressure

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

1. Remove semantic dual-write from dispatch transitions
2. Remove semantic dual-write from mailbox transitions
3. Collapse team state-root / working-directory resolution to one canonical metadata source
4. Reduce compatibility fallback layers after the write path is single-owner

## Out of scope

- replacing the existing Rust runtime contract
- removing compatibility readers immediately
- changing release gates in this documentation pass
