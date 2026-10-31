# oh-my-codex v0.21.44

## Summary

This patch release fixes the native runtime hydration timeout/abort path reported in #3968.

## Fixed

- **NATIVE RUNTIME HYDRATION (#3977):** Increase postinstall hydration's timeout from 15 seconds to 120 seconds. Timed-out hydration now reports an explicit timeout and underlying error context with diagnostic URLs redacted.
- **FOREGROUND RECOVERY:** Add `omx native-runtime hydrate` to retry hydration in the foreground and report failures. For the affected unsupported Process identity readiness state, `omx doctor` recommends this command and retains the session-pointer recovery note.
- **ACTIONABLE ASSET ERRORS:** Include sanitized manifest and archive URLs and underlying fetch/read errors in native asset hydration diagnostics.

The fix addresses the hydration timeout/abort path; it does not claim to eliminate unrelated causes of native Process identity provider unavailability.

## Compatibility

No breaking API changes. Release-coupled metadata was already synchronized to `0.21.44` on dev by #3976; the release does not bump those surfaces again.

## Verification

- `npm ci` — passed.
- `npm run build` — passed.
- `npm test` — passed, including runtime build/tests, the Node test suite, generated catalog checks, and prompt-invariant checks.
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files; Biome reported the existing `linter.rules.recommended` deprecation notice.

## Contributors

Thanks to the contributors who shipped the native runtime hydration fix.

**Full Changelog**: [`v0.21.43...v0.21.44`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.43...v0.21.44)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
