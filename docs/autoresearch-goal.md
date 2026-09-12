# Autoresearch Goal (Retired)

`$autoresearch-goal` was removed as a skill in OMX 0.21. The `omx autoresearch-goal` workflow documented on this page is retired as a skill entry point; use `$autoresearch` for the canonical stateful, validator-gated research loop.

## Migration

- Replace `$autoresearch-goal` with `$autoresearch`.
- For intake, use `$deep-interview --autoresearch`, then run `$autoresearch` with the chosen validation mode.
- Treat the old `omx autoresearch-goal` examples as legacy documentation; invoke `$autoresearch` instead.

This page is retained only as a migration notice; it does not document an active `$autoresearch-goal` skill workflow.