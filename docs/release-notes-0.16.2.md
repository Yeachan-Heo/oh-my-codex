# Release notes — 0.16.2

`0.16.2` is a post-`0.16.1` release-train correction and workflow hardening release. It ships the major `$ultragoal` aggregate-goal amendments, commit-shared wiki/compaction support, state isolation fixes, and the Codex native-hook setup corrections found during release review.

## Highlights

- **`$ultragoal` now defaults to aggregate Codex goals** — new plans use one aggregate Codex objective while OMX tracks per-story `G001`/`G002` checkpoints. Existing/no-mode plans keep legacy per-story behavior, and explicit `--codex-goal-mode per-story` remains supported. Planning, ralplan, deep-interview, plugin-skill mirrors, help text, and docs now point users toward `$ultragoal` as the default goal-mode follow-up. ([#2188](https://github.com/Yeachan-Heo/oh-my-codex/pull/2188))
- **Project wiki pages are now commit-shared** — canonical wiki storage moved to repository-root `omx_wiki/`, with legacy `.omx/wiki/` retained as a read-only fallback. Native `PreCompact`/`PostCompact` hooks now preserve and promote durable compaction findings into the shared wiki surface. ([#2180](https://github.com/Yeachan-Heo/oh-my-codex/pull/2180))
- **Stateful workflows are isolated by OMX session** — session-scoped workflow state no longer inherits or autocompletes from root/global state, and explicit `all_sessions` cleanup remains the global reset path. ([#2193](https://github.com/Yeachan-Heo/oh-my-codex/pull/2193))

## Codex native hooks and setup

- Added Codex-compatible trust-state generation for setup-owned `codex-native-hook.js` wrappers so generated hooks can be trusted without manual `/hooks` review, while user hook entries and user-owned hook state remain preserved. ([#2194](https://github.com/Yeachan-Heo/oh-my-codex/pull/2194))
- Updated the hook feature-flag migration so generated setup config uses the Codex CLI 0.130 lifecycle-hook flag, `[features].hooks = true`.
- Migrates legacy `[features].codex_hooks = true` entries forward to `hooks` during setup, while retaining legacy cleanup detection for older configs.

## Merged PR inventory

- [#2174](https://github.com/Yeachan-Heo/oh-my-codex/pull/2174) — fix: use supported Codex hooks feature flag
- [#2188](https://github.com/Yeachan-Heo/oh-my-codex/pull/2188) — Default ultragoal to aggregate Codex goals
- [#2180](https://github.com/Yeachan-Heo/oh-my-codex/pull/2180) — Make OMX wiki commit-shared and add compact hooks
- [#2194](https://github.com/Yeachan-Heo/oh-my-codex/pull/2194) — Trust setup-owned Codex hooks during setup
- [#2193](https://github.com/Yeachan-Heo/oh-my-codex/pull/2193) — Fix stateful workflow session isolation

## Validation

- Local release-review gates: `npm run build`, `npm run check:no-unused`, targeted setup/config/uninstall/hook Node tests, `npm run verify:native-agents`, `npm run verify:plugin-bundle`, catalog-doc check, and `cargo test`.
- Changed-area PR gates included targeted `$ultragoal`, wiki/MCP/storage, state/session, native-hook, setup, lint, no-unused, and plugin-bundle checks.
- GitHub CI passed on `dev` and `main`; the tag release workflow passed native builds, release-asset publishing, smoke verification, packed global install smoke, and npm publish.

**Full Changelog**: [`v0.16.1...v0.16.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.16.1...v0.16.2)
