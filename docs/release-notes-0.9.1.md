# oh-my-codex v0.9.1

Drafted: 2026-03-13

Patch hotfix release built from `main` to clear the red `v0.9.0` release state.

## Summary

`0.9.1` is the clean superseding release for the Spark Initiative line.

- `v0.9.0` remains historically red.
- `v0.9.1` carries the packed-install smoke hydration fix merged on `dev` in PR [#806](https://github.com/Yeachan-Heo/oh-my-codex/pull/806).
- No new feature scope is introduced beyond the release hotfix path and version/metadata updates required for the superseding release.

## Included hotfix

### Packed-install smoke hydration assets are localized

The packaged-install smoke flow now localizes hydration assets into the test workspace instead of relying on paths that are only valid in the source checkout layout.

Included changes:
- `scripts/smoke-packed-install.mjs`
- `scripts/__tests__/smoke-packed-install.test.mjs`

Source history:
- hotfix commit: `d86165d` — `fix(release): localize smoke hydration assets`
- merged on `dev` via PR [#806](https://github.com/Yeachan-Heo/oh-my-codex/pull/806)

## Release positioning

- Base feature release remains **Spark Initiative** (`0.9.0`).
- Historical note: **`v0.9.0` remains red** because the release smoke hotfix landed only after that tag.
- Clean superseding release: **`v0.9.1`**.

## Recommended release message

Use language that keeps the historical record accurate:

> `v0.9.0` remains historically red; `v0.9.1` is the clean superseding release with the packed-install smoke hydration hotfix.
