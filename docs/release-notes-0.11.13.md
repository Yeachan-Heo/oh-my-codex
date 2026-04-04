# Release notes — 0.11.13

## Summary

`0.11.13` is a patch release after `0.11.12` that restores the release branch to a buildable state, improves team/runtime delivery integrity for leader nudges and mailbox handoff, and keeps Windows/worktree supervision paths more stable.

## Included fixes and changes

- restore `src/hooks/__tests__/notify-fallback-watcher.test.ts` after accidental placeholder corruption on the release branch
- team leader mailbox delivery remains reliable across runtime/CLI seams
- busy Codex leader panes can receive queued nudges instead of silent deferral
- false team-coordination signals during runtime handoff are suppressed
- Windows/worktree HUD targeting and leader activity polling stay more reliable in detached/worktree launches
- fallback nudges honor active deep-interview input locks
- uninstall warns cleanly about legacy skills and shutdown cleanup reaps detached worker descendants more safely
- release metadata is aligned to `0.11.13` across Node, Cargo workspace metadata, lockfiles, and release collateral

## Verification evidence

### Release-focused verification suite

- `cargo test -p omx-runtime-core` ✅
- `npm run build` ✅
- `npm run lint` ✅
- `node --test dist/hooks/__tests__/notify-fallback-watcher.test.js` ✅
- `node --test dist/cli/__tests__/version-sync-contract.test.js` ✅
- `npm test` ✅
- `npm run smoke:packed-install` ✅
- `git diff --check origin/main...HEAD` ✅

## Remaining risk

Release verification evidence is recorded in `docs/qa/release-readiness-0.11.13.md`.

- This verification pass is release-focused and local; it is not a full GitHub Actions matrix rerun.
- The patch includes broad runtime/team surfaces since `0.11.12`, so post-release monitoring should pay extra attention to leader mailbox/nudge behavior and Windows worktree flows.
