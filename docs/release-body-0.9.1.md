# oh-my-codex v0.9.1

<p align="center">
  <img src="https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/v0.9.1/docs/shared/omx-character-spark-initiative.jpg" alt="OMX character sparked for the Spark Initiative" width="720">
</p>

`0.9.1` is a targeted Spark Initiative hotfix release.

## Why this release exists

- `v0.9.0` remains historically red.
- The required packed-install smoke hydration fix landed later on `dev` in PR [#806](https://github.com/Yeachan-Heo/oh-my-codex/pull/806).
- `v0.9.1` is the clean superseding release cut from `main` with that fix applied.

## Included fix

### Localize smoke hydration assets

The packed-install smoke workflow now copies and resolves hydration assets from the local smoke workspace so release verification matches packaged-install behavior more reliably.

Changed files:
- `scripts/smoke-packed-install.mjs`
- `scripts/__tests__/smoke-packed-install.test.mjs`

## Local release verification summary

Planned local release-critical validation for `0.9.1`:

- `node scripts/check-version-sync.mjs --tag v0.9.1`
- `npm run lint`
- `npx tsc --noEmit`
- `npm run check:no-unused`
- `npm test`
- `node --test scripts/__tests__/smoke-packed-install.test.mjs`
- `npm run build:full`
- `npm run smoke:packed-install`
- `npm pack --dry-run`

## Historical note

`v0.9.0` remains historically red; `v0.9.1` is the clean superseding release.
