# Release notes — 0.16.3

`0.16.3` is a post-`0.16.2` reliability release for Codex native-hook setup, Team/Ralph runtime state boundaries, approved handoff context, planning context-pack guidance, and release-review blocker fixes discovered before promotion.

## Highlights

- **Codex native-hook setup is aligned with the supported feature flag** — generated setup/runtime config now emits and migrates to `[features].hooks = true`, removes stale legacy `codex_hooks = true` aliases inside the features table, preserves user-owned hook state, and keeps project runtime `CODEX_HOME` hook trust pointed at the mirrored runtime `hooks.json`.
- **User-owned notification hooks are safer across setup/uninstall** — project setup with `notifyCommand: false` preserves non-OMX `notify` commands, managed notify detection no longer relies on basename-only matches, uninstall keeps user hook enablement intact, and Windows/global install hook commands avoid unsafe self-updates.
- **Team, planning, and approved handoffs are more durable** — approved handoff context is surfaced to workers, ready context-pack role references are exposed, symbolic Team launch signatures survive planning, role-agnostic approved hints are preserved, and Team startup-evidence tests now isolate local state roots from global OMX state.
- **Ralph/autoresearch/native compact hooks avoid stale or malformed lifecycle behavior** — stale Ralph sessions no longer auto-resume, blocked autoresearch Stop reconciliation is explicit, and PreCompact/PostCompact native hook output remains valid JSON.

## Fixes and compatibility notes

- Project-scope release review fixed hook trust placement and runtime mirror dedupe regressions from the `0.16.2` train.
- Notify-hook managed-CWD detection no longer treats bare stale `.omx/state` or `.omx/logs` directories as OMX-owned.
- Planning artifact reads and Team runtime state roots now prefer repository-local `.omx` paths unless an explicit Team state root is configured.
- The release keeps legacy cleanup/migration coverage for older unsupported hook aliases without documenting them as current setup guidance.

## Merged PR inventory

- [#2186](https://github.com/Yeachan-Heo/oh-my-codex/pull/2186) — fix: surface Codex startup exits
- [#2190](https://github.com/Yeachan-Heo/oh-my-codex/pull/2190) — Fix runtime hook mirror dedupe and hooks feature flag
- [#2191](https://github.com/Yeachan-Heo/oh-my-codex/pull/2191) — Fix Windows Codex hook command generation
- [#2196](https://github.com/Yeachan-Heo/oh-my-codex/pull/2196) — Fix notify setup scope handling
- [#2200](https://github.com/Yeachan-Heo/oh-my-codex/pull/2200) — fix: preserve user hook enablement on uninstall
- [#2199](https://github.com/Yeachan-Heo/oh-my-codex/pull/2199) — fix: dedupe managed hook trust state
- [#2201](https://github.com/Yeachan-Heo/oh-my-codex/pull/2201) — Fix hooks.json trust state placement
- [#2202](https://github.com/Yeachan-Heo/oh-my-codex/pull/2202) — fix(planning): preserve team launch signatures
- [#2203](https://github.com/Yeachan-Heo/oh-my-codex/pull/2203) — fix(team): preserve role-agnostic approved hints
- [#2204](https://github.com/Yeachan-Heo/oh-my-codex/pull/2204) — feat(planning): expose ready context-pack role refs
- [#2207](https://github.com/Yeachan-Heo/oh-my-codex/pull/2207) — Fix PostCompact native hook JSON output
- [#2208](https://github.com/Yeachan-Heo/oh-my-codex/pull/2208) — feat(team): add approved handoff context section
- [#2212](https://github.com/Yeachan-Heo/oh-my-codex/pull/2212) — Defer startup self-updates on Windows/global installs
- [#2213](https://github.com/Yeachan-Heo/oh-my-codex/pull/2213) — Fix autoresearch Stop reconciliation for blocked verdicts
- [#2216](https://github.com/Yeachan-Heo/oh-my-codex/pull/2216) — fix: migrate Codex hooks feature flag
- [#2217](https://github.com/Yeachan-Heo/oh-my-codex/pull/2217) — Fix PreCompact native hook JSON output
- [#2220](https://github.com/Yeachan-Heo/oh-my-codex/pull/2220) — Prevent stale Ralph sessions from auto-resuming
- Release-review fixes — exact supported hook feature flag generation, project notify preservation, runtime hook trust remapping, Team startup-evidence state-root isolation, and notify guard tightening.

## Validation

- Local release-review gates: `npm run build`, `npm run lint`, `npm run check:no-unused`, targeted setup/config/uninstall/hook/Team Node tests, and `git diff --check`.
- Release collateral generated from the `v0.16.2...v0.16.3` compare range and verified with `generate-release-body.js` before tagging.
- GitHub CI and publication evidence are recorded in `docs/qa/release-readiness-0.16.3.md`.

**Full Changelog**: [`v0.16.2...v0.16.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.16.2...v0.16.3)
