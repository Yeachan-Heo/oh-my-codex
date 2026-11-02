# oh-my-codex v0.21.45

## Summary

This patch release fixes `omx doctor` falsely reporting an unsafe trust migration for an unchanged foreign Codex hook group whose matcher is the empty string (#3984).

## Fixed

- **EMPTY FOREIGN HOOK MATCHER TRUST (#3985, fixes #3984):** Preserve any string matcher, including `""`, in the foreign hook trust hash input. Previously the truthiness check omitted an empty matcher, causing the calculated hash to differ from Codex's stored trust hash and `omx doctor` to report `unsafe_managed_removal` for an unchanged trusted hook group.

The fix targets the empty-matcher hash mismatch. The separately reported SessionEnd outlier is not addressed.

## Compatibility

No breaking API changes. Release-coupled metadata was already synchronized to `0.21.45` on dev by #3982; the release does not bump those surfaces again.

## Verification

- `npm ci` — passed.
- `npm run build` — passed.
- `npm test` — passed, including runtime build/tests, all 475 Node test files, generated catalog checks, and prompt-invariant checks.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files; Biome reported the existing `linter.rules.recommended` deprecation notice.

## Contributors

Thanks to @Kelvinkim for reporting the empty-matcher trust-hash issue and to the contributors who shipped the fix.

**Full Changelog**: [`v0.21.44...v0.21.45`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.44...v0.21.45)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
