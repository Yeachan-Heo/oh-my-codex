# oh-my-codex v0.15.0

## Summary

`0.15.0` is a minor release candidate that prepares the plugin delivery and Codex App compatibility train, Visual Ralph, setup install-mode selection, native agent/model routing, hook/runtime hardening, Windows/tmux question reliability, CI hang protection, Rust compatibility fixes, and release collateral for the next release cut.

Release range note: `v0.14.4` exists, but it is not an ancestor of the current `dev` release candidate. The verified reachable base for this candidate is `v0.14.3`; the `0.14.4` metadata/collateral history is retained as historical release context.

## Highlights

- **Plugin delivery and Codex App compatibility** — ships the first-party `plugins/oh-my-codex` bundle, plugin descriptors, marketplace metadata, plugin mirror synchronization, and setup/install-mode coverage.
- **Visual Ralph** — adds the Visual Ralph workflow as a first-class skill with routing, docs, and regression coverage for frontend/UI iteration workflows.
- **Setup/install mode hardening** — setup can preserve project plugin mode, clarify next steps, keep managed hooks/runtime assets aligned, and clean plugin-mode drift safely.
- **Native agent/model routing** — native agent definitions, model table generation, and setup refresh tests align on the `gpt-5.5` frontier, `gpt-5.4-mini` standard, and `gpt-5.3-codex-spark` fast-lane contract.
- **Runtime reliability** — Stop hook parseability, notification fallback watchers, derived watchers, stale tmux sockets, team/runtime guidance, and CI silence handling have targeted hardening.
- **Windows/tmux and Rust compatibility** — question rendering paths cover Windows/non-attached terminals, while the explore harness remains compatible with the supported Rust toolchain.

## Verification

Release readiness evidence is recorded in `docs/qa/release-readiness-0.15.0.md`.

- `npm run build` — see readiness doc
- `npm run lint` — see readiness doc
- `npm run check:no-unused` — see readiness doc
- `npm run verify:native-agents` — see readiness doc
- `npm run verify:plugin-bundle` — see readiness doc
- `npm run sync:plugin:check` — see readiness doc
- `npm test` — see readiness doc
- `npm run test:ci:compiled` — see readiness doc
- `npm run test:explore` — see readiness doc
- `npm run test:sparkshell` — see readiness doc
- `npm run smoke:packed-install` — see readiness doc
- `cargo test --workspace` — see readiness doc

## Upgrade notes

- No tag, npm publish, or GitHub release has been created by this release-prep change.
- Existing CLI users can continue with legacy skill delivery; setup now makes plugin-vs-legacy mode explicit and preserves persisted choices.
- Codex App users should prefer the shipped first-party plugin bundle once the release owner publishes `v0.15.0`.
- Existing model overrides remain respected; default generated guidance continues to use `gpt-5.5` for frontier lanes, `gpt-5.4-mini` for standard lanes, and `gpt-5.3-codex-spark` for fast exploration.

## Contributors

Thanks to everyone who contributed plugin delivery, Visual Ralph, setup/install, runtime hardening, Windows/tmux, CI, Rust compatibility, and documentation work for this release.

**Full Changelog**: [`v0.14.3...v0.15.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.14.3...v0.15.0)
