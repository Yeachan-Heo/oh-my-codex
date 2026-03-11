# Compatibility Harness

This harness is the first black-box parity layer for the omx Rust migration.

## Goal

Keep strict contract checks that can run against the current native launcher now and future native binaries later.

## Initial scope

The first slice is intentionally low-flake and byte-exact:

1. `omx --help`
2. `omx version`
3. `omx ask ...` stdout/stderr/exit-code passthrough

## Target selection

By default the harness targets the current native launcher shim:

- `bin/omx` (or `bin/omx.cmd` on Windows)

To run the same tests against another target, set `OMX_COMPAT_TARGET`:

```bash
OMX_COMPAT_TARGET=./bin/omx npm run test:compat:node
OMX_COMPAT_TARGET=./target/debug/omx npm run test:compat:node
```

If the target ends with `.js`, the harness launches it with `node`.
Otherwise it executes the target directly.

## Fixture policy

- Keep this first slice byte-exact.
- Update fixtures only when the current contract intentionally changes.
- Do not weaken a fixture to mask regressions.
- If a future slice needs normalized or semantic comparison, document that explicitly in the PRD/test spec and in the corresponding test file.

## Command

```bash
npm run test:compat:node
npm run test:compat:rust   # once the Rust binary matches the targeted slice
./scripts/compat/run-node-baseline.sh
```
