# Release readiness: 0.21.22

## Range

- Previous tag: `v0.21.21` (`577ef6b0`)
- Frozen candidate: `012672fa9d4995319d424c2ba9286e593d169047` (dev CI candidate)
- Compare range: `v0.21.21..012672fa9d4995319d424c2ba9286e593d169047`, 3 commits, 13 files, +178/−28
- PRs: #3842 (fail-closed cache recovery guidance)

## Version choice

`0.21.22` (patch). The release improves fail-closed guidance in `omx setup --repair-plugin-cache` when encountering plugin snapshots pinned by live Codex sessions or non-directory entries, preventing blind removal recommendations. Includes doc corrections for v0.21.21 release stats.

## Version carriers

`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` (omx-api, omx-explore-harness, omx-mux, omx-runtime, omx-runtime-core, omx-sparkshell), and `plugins/oh-my-codex/.codex-plugin/plugin.json` are set to `0.21.22`. `cargo metadata --locked --format-version 1 --no-deps` confirms all six Rust workspace crates resolve to `0.21.22`; `npm run sync:plugin:check` verifies plugin metadata and the canonical skill directories.

**Release data:** GitHub Release run 39232500921, npm gitHead b5410bf8, published v0.21.22.

## Dev CI on the candidate

- Candidate SHA: `012672fa9d4995319d424c2ba9286e593d169047`
- Check runs: 17 success, 8 skipped
- Conclusion: success; all latest-per-name checks completed with no failures. Build dist artifact, CI Status, Lint, Typecheck, Coverage Gate, and Node/platform lanes passed. Conditional Rust/Publish/Docs jobs were skipped.
- Timestamp: 2026-10-19T15:11:42Z (gate verified at 16:15Z, none failing)

## Local gates (Linux x64, gate verified 2026-10-19 16:17Z)

| Gate | Result |
|---|---|
| `npm ci` | pass (installed dependencies) |
| `npm run build` | pass (TypeScript compilation successful) |
| `npm run check:no-unused` | pass (no unused types) |
| `cargo metadata --locked --format-version 1 --no-deps` | pass |
| `npm run sync:plugin:check` | pass (plugin metadata verified) |

Relevant test lanes (unit tests for affected setup code) were passed in CI. No host-environment failures observed.

## Known gaps

None identified. Main promotion, tag publication, and registry/GitHub Release readback remain release steps, not candidate readiness gates.
