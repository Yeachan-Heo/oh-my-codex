# Release notes — 0.15.0

## Summary

`0.15.0` prepares a minor release for the current `dev` train: first-party plugin delivery, Codex App compatibility, Visual Ralph, setup install-mode selection, native agent/model routing, hook/runtime hardening, Windows/tmux question reliability, CI hang protection, Rust compatibility, and release readiness collateral.

Range note: `v0.14.4` exists off the current `dev` ancestry and is not a valid reachable base for this candidate. Release comparison and readiness evidence therefore use `v0.14.3` as the verified reachable base, while keeping `0.14.4` release notes/readiness files as historical collateral.

## Highlights

- First-party Codex plugin packaging is now part of the release surface, including `plugins/oh-my-codex`, plugin descriptors, marketplace metadata, package layout tests, and mirror synchronization checks.
- Codex App compatibility paths avoid tmux-only runtime assumptions and preserve plugin-prefixed skill routing.
- Visual Ralph is available as a first-class workflow skill with routing, generated docs, and regression coverage.
- Setup can preserve plugin-vs-legacy install mode, report cleanup/backups clearly, and keep hooks/runtime assets aligned without overwriting local choices.
- Native agent and model-routing contracts are enforced across definitions, generated model tables, setup refresh paths, and runtime guidance.
- Hook/runtime hardening covers Stop-hook parseability, notification fallback watchers, derived watchers, stale tmux sockets, team worker identity, and CI silence protection.
- Windows/tmux question handling and Rust 1.73-compatible explore harness behavior are covered by targeted tests.

## Compatibility

- No user migration is required for existing legacy skill installs.
- Plugin-mode installs should use the bundled first-party plugin after the release owner publishes the package/release.
- Existing model overrides retain their semantics; generated defaults continue to prefer `gpt-5.5`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark` for their respective lanes.
- No release tag or npm publication is performed as part of this preparation step.

## Verification

Release verification evidence is recorded in `docs/qa/release-readiness-0.15.0.md`.
