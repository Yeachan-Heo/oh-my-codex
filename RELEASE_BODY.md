# oh-my-codex v0.21.46

## Summary

This patch release keeps generated native-agent instructions within the assigned scope and clarifies Git Master's task authority for history and remote writes.

## Fixed

- **ASSIGNMENT-SCOPED NATIVE AGENT OVERLAYS (#3989):** Generated posture and exact-model guidance no longer tell read-only or advisory roles to implement or always build. Specialist coverage, completion criteria, and verification requirements follow the assignment and repository/task requirements.
- **GIT MASTER AUTHORITY BOUNDARIES (#3997):** History rewrites and remote writes require task authority. Preserve unrelated dirty and untracked work without stashing, resetting, cleaning, or overwriting it; split independent concerns while keeping a behavior's required tests and support files together.

## Compatibility

No breaking API changes. Release-coupled metadata was already synchronized to `0.21.46` on dev by #3993; the release branch does not bump those surfaces again.

## Verification

- `npm ci` — passed.
- `npm run build` — passed.
- `npm test` — passed on the subsequent full run: all 475 Node test files and the generated catalog and prompt-inventory checks completed. An earlier attempt exceeded the command timeout without a final summary.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files; Biome emitted the existing `linter.rules.recommended` deprecation notice, with no fixes applied.
- Focused `native-config.test.js` regression suite — passed: 36 passed, 0 failed.
- Focused `codex-hooks.test.js` regression suite — passed: 74 passed, 1 skipped, 0 failed.
- Release-coupled version synchronization — passed: `node dist/scripts/check-version-sync.js --tag v0.21.46` and `cargo metadata --locked --format-version 1 --no-deps` report all six OMX workspace crates as `0.21.46`.

## Contributors

Thanks to @ev78394 for the native agent overlay scope fix (#3989) and the Git Master history-operation policy (#3997).

**Full Changelog**: [`v0.21.45...v0.21.46`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.45...v0.21.46)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
