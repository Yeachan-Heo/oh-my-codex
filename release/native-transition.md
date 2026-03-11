# Native Release Transition

This directory captures the release-path contract for the OMX Rust migration.

## Goals

- make native binaries the primary release artifact
- keep any npm package strictly transitional (downloader/launcher only)
- define the platform matrix and smoke checks before cutover

## Transition phases

1. **Baseline**
   - existing Node package/bin contract stays green
   - compatibility harness records current CLI behavior
2. **Transition**
   - native bundles are produced for every supported platform
   - npm, if still published, only locates/downloads/launches the native binary
   - no new CLI logic runs through Node in published install flows
   - install/update docs distinguish the native-bundle path from any temporary npm shim path
3. **Cutover**
   - release approval requires native-only smoke coverage on each supported platform
   - install docs point to the native bundles as the supported path
   - README / release notes / update guidance all describe npm as transitional only (if it still exists)
4. **Cleanup**
   - remove any remaining transitional launcher wrapper, `dist/`, and TypeScript release-path CI only after verifier sign-off

## Source-of-truth artifacts

- `release/native-bundle-contract.json` — expected bundle names, archive layout, and smoke commands
- `release/platform-capability-matrix.md` — supported/degraded behavior by platform

## Release gates

A native cutover is blocked unless all of the following are true:

- every bundle in `native-bundle-contract.json` exists
- each bundle contains exactly one `omx` executable at the documented path
- platform smoke commands pass on Linux, macOS, Windows native, and WSL2
- any npm package still in circulation behaves only as a native launcher/downloader shim

## Install/update documentation contract

During the transition and cutover phases, user-facing docs should follow this wording contract:

- **Primary install path:** platform-native release bundle containing the `omx` executable.
- **Primary update path:** replace/update the native bundle or use a native-aware updater.
- **npm path (if temporarily retained):** launcher/downloader shim only; it must not be documented as the authoritative runtime.
- **Forbidden wording:** any install or release note that implies normal OMX execution still depends on `dist/cli/index.js`.

This keeps docs aligned with the release gate: Rust is the runtime authority, while Node may remain only as a temporary distribution shim.
