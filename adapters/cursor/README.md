# Cursor Adapter for oh-my-codex

This adapter makes `oh-my-codex` usable as a Cursor-driven control plane while preserving OMX core runtime.

## Goals

1. Keep OMX execution capabilities intact.
2. Route model-facing decisions through Cursor.
3. Add OpenSpec + drift gate + prompt assets for spec-first delivery.

## Quick start

```bash
# From repository root
./scripts/omc.sh doctor
./scripts/omc.sh new feature-auth-timeout
./scripts/omc.sh plan feature-auth-timeout
./scripts/omc.sh apply feature-auth-timeout
./scripts/omc.sh review feature-auth-timeout
```

## Adapter files

- `adapters/cursor/model-routing.yaml`
- `adapters/cursor/control-plane.md`
- `.cursor/rules/*`
- `scripts/bootstrap-change.sh`
- `scripts/check-drift.sh`
- `scripts/omc.sh`
- `.github/workflows/cursor-pr-gate.yml`

## Notes

- This adapter is additive and does not replace OMX's native flow.
- Existing OMX commands and scripts remain available.

