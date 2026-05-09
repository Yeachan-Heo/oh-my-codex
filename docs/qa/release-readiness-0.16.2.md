# Release Readiness Verdict - 0.16.2

Target version: **0.16.2**
Date: 2026-05-08
Compare link: [`v0.16.1...v0.16.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.16.1...v0.16.2)
Release: https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.16.2

## Verdict

**SHIPPED.** `0.16.2` is published to GitHub Releases and npm after correcting the release notes/body inventory.

## Release surface

- #2174 — Codex hook feature-flag migration work, audited and corrected during release review.
- #2188 — `$ultragoal` aggregate Codex goal mode and planning/skill/docs guidance.
- #2180 — commit-shared `omx_wiki/` storage plus native compact hooks.
- #2194 — setup-owned Codex hook trust state.
- #2193 — session-isolated stateful workflow state.
- Release-review fixes — updated generated `[features].hooks = true`, repaired legacy hook aliases, preserved plugin-mode hook trust state, and restored the release-body contributors anchor.

## Verification evidence

| Gate | Result |
| --- | --- |
| Official Codex docs check | PASS — lifecycle hooks use `[features].hooks = true`. |
| Local release-review gates | PASS — build, no-unused, targeted setup/config/uninstall/hook tests, native-agent verify, plugin-bundle verify, catalog-doc check, `cargo test`. |
| Main CI | PASS — run `25545439756` on `d1863f72` after rerun of transient `team-state-runtime` lane. |
| Release workflow | PASS — run `25546037771` built native assets, published GitHub release assets, smoke verified archives/global install, and published npm. |
| GitHub release | PASS — `v0.16.2`, non-draft, non-prerelease, 43 native assets. |
| npm | PASS — `npm view oh-my-codex version` returned `0.16.2`. |

## Notes

- Earlier release-body text understated the release scope as only a Codex hook setup blocker. This readiness record and the release notes now list the full `v0.16.1...v0.16.2` PR inventory and the major `$ultragoal`/wiki/state changes.
