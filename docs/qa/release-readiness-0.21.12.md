# Release readiness: 0.21.12

## Range

- Previous tag: `v0.21.11` (`e62bbe2e48fbc005d4a0af75c4c193377b3bb7b4`)
- Frozen candidate: `6937884f4d09a485d5b4f16498517bcd05384e06`
- Compare range: `v0.21.11..6937884f4d09a485d5b4f16498517bcd05384e06`, 6 commits, 15 files, +998/−19
- PRs: #3786, #3788, #3789, #3791, #3794, #3797. See `artifacts/release-0.21.12/inventory.md`.

## Version choice

`0.21.12` (patch), continuing the established 0.21.x patch train. The completion-evidence requirement applies to tasks explicitly marked `requires_code_change: true`; the release does not change CLI operation names, the envelope schema, or package layout. Compatibility requirements are documented in `docs/release-notes-0.21.12.md` and `docs/interop-team-mutation-contract.md`.

## Version carriers

`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` (all six workspace crates), and `plugins/oh-my-codex/.codex-plugin/plugin.json` are set to `0.21.12`. `cargo metadata --locked --format-version 1 --no-deps` confirms the workspace manifests resolve successfully; `npm run sync:plugin:check` verifies plugin metadata and all 24 canonical skill directories.

## Dev CI on the candidate

- Run: [38717580036](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/38717580036)
- Candidate SHA: `6937884f4d09a485d5b4f16498517bcd05384e06`
- Latest-per-name conclusion: 24 success, 1 skipped (`Publish npm (trusted publishing)`, conditional release job); no failures.

## Local gates (Linux x64)

| Gate | Result |
|---|---|
| `npm ci` | pass (172 packages installed) |
| `npm run build` | pass |
| `npm run check:no-unused` | pass |
| `npm run build:runtime` | pass |
| `cargo metadata --locked --format-version 1 --no-deps` | pass |
| `npm run sync:plugin:check` | pass (24 canonical skill directories and plugin metadata verified) |
| Focused HUD and Team tests (`index`, `state`, `tmux`, `completion-evidence`) | pass (186 passed, 1 skipped, 0 failed) |

The first focused test attempt ran before the native `omx-runtime` binary had been built and failed in a state test with `spawn omx-runtime ENOENT`. After `npm run build:runtime`, the same four test files passed. No residual host-environment failures were observed. The full local test suite was not rerun; candidate CI test lanes passed.

## Known gaps

Main promotion, tag publication, npm publication, and GitHub Release readback are release steps, not candidate readiness gates.
