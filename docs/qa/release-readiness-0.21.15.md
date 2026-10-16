# Release readiness: 0.21.15

## Range

- Previous published tag: `v0.21.14` (GitHub tag peels to `a0d49ddebf64dcbc8900440a92ff6db397e95ae0`)
- Frozen dev candidate: `38bbaab4c818cadcfe2b69de22c52cf56e670ca0`
- Compare range: `v0.21.14..38bbaab4c818cadcfe2b69de22c52cf56e670ca0`, 6 commits, 39 files, +2,199/−152
- Merged PRs in the range: #3798, #3806, #3807, #3808, #3809, and #3811.

## Version choice and carriers

`0.21.15` (patch), continuing the established 0.21.x patch train. `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` (all six workspace crates), and `plugins/oh-my-codex/.codex-plugin/plugin.json` are aligned at `0.21.15`. The version-sync contract test verifies package, plugin, workspace, and Rust member alignment. `cargo metadata --locked --format-version 1 --no-deps` succeeds; `npm run sync:plugin:check` verifies plugin metadata and all 24 canonical skill directories.

## Dev CI on the candidate

- Candidate SHA: `38bbaab4c818cadcfe2b69de22c52cf56e670ca0`
- Latest-per-name check runs: 17 success, 8 skipped, 0 failing or incomplete.

## Local gates (Linux x64)

| Gate | Result |
|---|---|
| `npm ci` | pass; 172 packages installed |
| `npm run build` | pass; TypeScript compilation and build completed |
| `npm run check:no-unused` | pass |
| `npm run lint` | pass; 881 files checked |
| `npm run build:runtime` | pass; Rust runtime crates compiled |
| `cargo metadata --locked --format-version 1 --no-deps` | pass; all six workspace crates report `0.21.15` |
| `npm run sync:plugin:check` | pass; 24 canonical skill directories and plugin metadata verified |
| Targeted compiled Node tests | pass; 20 relevant test files executed with per-file isolation and no failures |
| `git diff --check` | pass |
| Release-body footer check | pass; exactly one owner footer in `RELEASE_BODY.md` |

No host-environment failures were observed. The full Node test suite was not rerun; frozen-candidate CI passed the reported checks.

## Registry baseline

Before publication, `npm view oh-my-codex version` returned `0.21.14`; `npm view oh-my-codex dist-tags --json` returned `{"latest":"0.21.14"}`. The GitHub v0.21.14 release is published and non-draft.

## Workspace tag note

This worktree already contained a local `v0.21.14` tag pointing to `b7f1777e3609cfe25fbca96bf94bc38d42ea3475`; the canonical GitHub tag peels to `a0d49ddebf64dcbc8900440a92ff6db397e95ae0`, which includes PR #3805's release-footer correction before the tag was published. A `git fetch --tags` refused to overwrite the local ref. The local tag was left untouched; the release range was verified against the canonical remote tag, and the release workflow checks out that tag in a fresh runner.

## Known gaps

The full Node suite, release PR CI, tag workflow, npm trusted publication, npm registry readback for `0.21.15`, and GitHub Release readback are not completed by this readiness record.
