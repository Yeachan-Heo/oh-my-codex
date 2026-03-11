# Compatibility Harness Inventory

## Current baseline assets

| Asset | Current state | Evidence |
| --- | --- | --- |
| Launcher under test | Baseline harness targets the native launcher shim by default, with an override for future Rust binaries via `OMX_COMPAT_TARGET`. | `bin/omx:1-40`, `src/compat/__tests__/cli-baseline-contract.test.ts:15-39` |
| Harness entrypoint | One black-box test file executes the target and compares exact stdout/stderr/exit code. | `src/compat/__tests__/cli-baseline-contract.test.ts:41-88` |
| Golden fixtures | Five checked-in fixtures back the current byte-exact baseline: help, version, and ask passthrough stdout/stderr/exit-code. | `src/compat/fixtures/help.stdout.txt`, `src/compat/fixtures/version.stdout.txt`, `src/compat/fixtures/ask/pass-through.*` |
| Stub dependency | The ask passthrough check already uses a deterministic advisor stub instead of a live provider CLI. | `scripts/fixtures/ask-advisor-stub.js:1-12` |
| npm entrypoint | The dedicated compat command is `npm run test:compat:node`. | `package.json:10-21` |
| Harness doc | The existing harness doc explicitly limits the first slice to help/version/ask passthrough and byte-exact fixtures. | `docs/testing/compat-harness.md:1-34` |

## Current coverage snapshot

### What the compatibility harness covers today

1. `omx --help`
2. `omx version`
3. `omx ask <provider> ...` stdout/stderr/exit-code passthrough via the stub advisor

### What the repository test surface already suggests should become future parity slices

| Contract family | Existing TS/Node evidence | Inventory signal |
| --- | --- | --- |
| CLI dispatch / flags / help | `src/cli/__tests__` | 25 tests already lock broad command routing, shorthand flags, setup/team/version behavior. |
| Team/runtime orchestration | `src/team/__tests__` | 20 tests cover lifecycle, worktree, tmux, worker bootstrap, and runtime contracts. |
| Hooks / workflow routing | `src/hooks/__tests__` | 45 tests indicate a large parity surface that likely needs semantic harness slices later. |
| Notifications / temp mode | `src/notifications/__tests__` | 16 tests map to notify-temp and provider-routing behavior already called out in CLI tests/spec. |
| MCP lifecycle | `src/mcp/__tests__` | 15 tests cover stdio server startup, shutdown, and state-path contracts. |
| Platform command behavior | `src/utils/__tests__/platform-command.test.ts` | Explicit contract source for Windows/macOS/Linux spawn parity. |
| Setup / uninstall / doctor | `src/cli/__tests__/setup-*.test.ts`, `doctor-*.test.ts`, `uninstall.test.ts` | Existing source-level contract is much broader than the current black-box harness. |

## Gaps relative to the approved PRD/test spec

| Required deliverable | Current status | Gap |
| --- | --- | --- |
| Baseline capture for help/version/reasoning/setup/doctor/failure cases | Partial | Only help, version, and ask passthrough are fixture-backed today. |
| Binary-targetable command-family parity suites | Partial | The harness can swap targets, but only one low-flake command slice exists. |
| Platform matrix coverage (Linux/macOS/Windows native/WSL) | Missing | No explicit harness inventory maps current checks to platform-specific acceptance yet. |
| Native release artifact checks | Partial | Packaging now centers a native launcher shim, but full native-bundle-only distribution still needs explicit cutover verification. |
| Semantic parity harnesses for team/MCP/hooks/setup | Missing | Existing tests are source-oriented rather than black-box diff suites. |

## Artifact constraints for this lane

- Leader-owned files were intentionally left untouched: `src/compat/**`, `package.json`, and `docs/testing/compat-harness.md`.
- This inventory is additive only and preserves the current behavior-first parity strategy from the PRD/test spec.
