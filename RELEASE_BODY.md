# oh-my-codex v0.11.13

**Patch release for team/runtime delivery integrity, busy-leader nudge handling, release-hygiene repairs, and Windows/worktree reliability follow-through**

`0.11.13` follows `0.11.12` with a focused patch train from `v0.11.12..dev`: it restores a corrupted test file on the release branch, tightens team/runtime delivery behavior around leader nudges and mailbox handoff, and keeps Windows/worktree supervision stable while syncing release metadata for the new patch cut.

## Highlights

- Team leader delivery is more reliable across runtime/CLI seams, including busy Codex leader panes that should queue nudges instead of dropping them.
- False team-coordination signals during runtime handoff are suppressed, reducing noisy or misleading orchestration state.
- Windows/worktree HUD and leader activity polling paths stay stable in detached/worktree scenarios.
- Release metadata and collateral are aligned to `0.11.13`, and the accidental placeholder corruption in `src/hooks/__tests__/notify-fallback-watcher.test.ts` is repaired before ship.

## What’s Changed

### Fixes
- harden leader mailbox delivery across runtime + CLI seams and keep busy leader nudges deliverable
- suppress false team coordination signals during runtime handoff
- preserve Windows worktree/HUD/leader polling reliability across detached launches
- honor deep-interview input locks in fallback nudges, clean up legacy-skill uninstall warnings, and reap detached worker descendants more safely on shutdown

### Changed
- bump release metadata from `0.11.12` to `0.11.13` across Node and Cargo workspace manifests/lockfiles
- refresh `CHANGELOG.md`, `docs/release-notes-0.11.13.md`, and `RELEASE_BODY.md` for the release cut
- restore the malformed `notify-fallback-watcher` regression test file so the release branch builds cleanly again

## Verification

- `cargo test -p omx-runtime-core`
- `npm run build`
- `npm run lint`
- `node --test dist/hooks/__tests__/notify-fallback-watcher.test.js`
- `node --test dist/cli/__tests__/version-sync-contract.test.js`
- `npm test`
- `npm run smoke:packed-install`
- `git diff --check origin/main...HEAD`

## Remaining risk

- This release verification is still a local release gate, not a full GitHub Actions matrix rerun.
- The patch train remains relatively broad for a patch cut, so future follow-up should keep an eye on the team/runtime and notify-hook surfaces touched since `0.11.12`.

## Contributors

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) (Bellman)

**Full Changelog**: [`v0.11.12...v0.11.13`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.11.12...v0.11.13)
