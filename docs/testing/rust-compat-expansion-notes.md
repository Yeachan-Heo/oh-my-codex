# Rust compatibility expansion notes

This lane adds a merge-ready parity runner in `scripts/compat/run-rust-parity.js` plus a starter suite in `docs/testing/rust-parity-suite.json`.

## What the runner covers now

- compares a Node baseline command to a Rust candidate command
- checks exit status, signal, stdout, stderr, and spawn errors
- keeps help/version/reasoning checks byte-exact by default
- allows explicit output normalizers for future dynamic suites
- supports per-case overrides for cwd, env, timeout, and case selection

## Default commands

- baseline: `./bin/omx`
- candidate: `${OMX_RUST_BIN:-./target/debug/omx}`

The default baseline intentionally exercises the shipped native launcher shim, so the Rust binary must be present before parity capture.

## Initial suite purpose

The starter suite is intentionally small and stable:

1. `--help`
2. `version`
3. `reasoning --help`
4. `reasoning turbo` (invalid mode error path)

These are the lowest-risk byte-exact checks for the first Rust slice and align with lane 1 ownership around help/version parity.

## Planned next expansions

### Ask/provider parity

Add byte-exact cases for:

- provider argument validation
- `--print` / `--prompt`
- stdout/stderr passthrough
- exact exit-code propagation

Use fixture env overrides so the suite can point `OMX_ASK_ADVISOR_SCRIPT` at deterministic stubs instead of live provider CLIs.

### Setup / doctor / uninstall

Add semantic-plus-artifact comparisons for:

- `setup --dry-run`
- `doctor --team`
- setup scope path creation and backup trees

These cases should write into temp directories and normalize temp paths with explicit suite-level normalizers.

### Team / tmux / runtime

Add semantic cases only after the leader-owned harness lands. Recommended approach:

- keep raw command capture in `scripts/compat/run-rust-parity.js`
- let `docs/testing/compat-harness.md` define higher-level lifecycle assertions
- compare persisted `.omx/state` artifacts instead of terminal text when runtime output is inherently dynamic

### Platform-specific command resolution

Add dedicated suites for Windows-native and WSL coverage using normalizers plus platform-gated expectations from `docs/rust/platform-capability-matrix.md`.

## Suggested leader integration points

When `docs/testing/compat-harness.md` is ready, reference these artifacts:

- `scripts/compat/run-rust-parity.js` as the shared command runner
- `docs/testing/rust-parity-suite.json` as the seed byte-exact suite
- this note as the backlog for next command-family additions

## Example usage

```bash
npm run build
OMX_RUST_BIN=./target/debug/omx node scripts/compat/run-rust-parity.js
```

Run a subset during iterative bring-up:

```bash
npm run build
OMX_RUST_BIN=./target/debug/omx node scripts/compat/run-rust-parity.js --case help --case version
```
