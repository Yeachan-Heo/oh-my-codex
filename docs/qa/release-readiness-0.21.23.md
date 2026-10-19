# Release readiness: 0.21.23

## Range

- Previous tag: `v0.21.22` (`860350f4`)
- Frozen candidate: `9d811e2250cfdb277591b6087bd37a9194319e78` (dev CI candidate)
- Compare range: `v0.21.22..9d811e2250cfdb277591b6087bd37a9194319e78`, 5 commits, 14 files, +914/−58
- PRs: #3840 (evidence requirements for generated tasks), #3846 (non-directory cache recovery guidance)

## Version choice

`0.21.23` (patch). The release improves team task decomposition by requiring evidence for generated coding tasks and extends plugin cache recovery guidance to cover non-directory entries alongside pinned snapshots.

## Version carriers

`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` (omx-api, omx-explore-harness, omx-mux, omx-runtime, omx-runtime-core, omx-sparkshell), and `plugins/oh-my-codex/.codex-plugin/plugin.json` are set to `0.21.23`. `cargo metadata --locked --format-version 1 --no-deps` confirms all six Rust workspace crates resolve to `0.21.23`; `npm run sync:plugin:check` verifies plugin metadata and the canonical skill directories.

## Dev CI on the candidate

- Candidate SHA: `9d811e2250cfdb277591b6087bd37a9194319e78`
- Check runs: 17 success, 8 skipped
- Conclusion: success; all latest-per-name checks completed with no failures. Build dist artifact, CI Status, Lint, Typecheck, Coverage Gate, and Node/platform lanes passed. Conditional Rust/Publish/Docs jobs were skipped.
- Timestamp: 2026-10-19T19:15:00Z (gate verified at 19:15Z, none failing)

## Local gates (Linux x64, gate verified 2026-10-19 19:16Z)

| Gate | Result |
|---|---|
| `npm ci` | pass (installed dependencies) |
| `npm run build` | pass (TypeScript compilation successful) |
| `npm run check:no-unused` | pass (no unused types) |
| `cargo metadata --locked --format-version 1 --no-deps` | pass (6 crates at 0.21.23) |
| `npm run sync:plugin:check` | pass (plugin metadata verified) |

Relevant test lanes (team decomposition, completion evidence, intent classification) were passed in CI. No host-environment failures observed.

## Known gaps

- PR #3840 includes 10 unresolved Codex findings regarding edge cases in the implicit natural-language intent heuristic for distinguishing coding tasks from analysis/reporting. A design pass toward a structured intent signal is pending (follow-up #3845, closed pending design review).
- Main promotion, tag publication, and registry/GitHub Release readback remain release steps, not candidate readiness gates.
