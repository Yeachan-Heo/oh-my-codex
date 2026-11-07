# oh-my-codex v0.21.47

## Summary

This patch release keeps psmux worker panes alive on native Windows by embedding the split receipt safely in tmux commands for all platforms.

## Fixed

- **PSMUX WINDOWS WORKER LAUNCH (#4008, fixes #4007):** On native Windows with psmux, `omx team` workers exited at launch because OMX appended a `# omx_source_...` receipt to the worker command. psmux does not treat `#` as a comment starter, so the receipt reached `powershell.exe` as extra arguments. The receipt is now appended as a final '; # <receipt>' statement inside the PowerShell script before -EncodedCommand encoding; POSIX keeps ' # <receipt>' inside the sh -c string; and paneHasReceipt decodes encoded commands for ambiguous-split reconciliation.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.47` on dev by #4003, so the release branch does not bump those values again. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.47` at the pinned source.

## Verification

- `npm ci` — passed; 172 packages installed and lifecycle hooks completed.
- `npm run build` — passed.
- `npm test` — passed on the subsequent full run: runtime build, all 475 Node test files, generated catalog check, and prompt-inventory check completed.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files. Biome emitted the existing `linter.rules.recommended` deprecation notice; no lint fixes were applied.
- Focused native-config regression tests — passed: 36 passed, 0 failed.
- Focused `codex-hooks.test.js` regression suite — passed: 74 passed, 1 skipped, 0 failed.

## Contributors

Thanks to @Yeachan-Heo for the psmux receipt embedding fix (#4008) and to @aglikman for reporting the issue (#4007).

**Full Changelog**: [`v0.21.46...v0.21.47`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.46...v0.21.47)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
