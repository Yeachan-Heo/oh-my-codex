# oh-my-codex 0.18.9

`0.18.9` is a patch release after `0.18.8` for update-channel reliability, project-local runtime state lookup, tmux/cmux question rendering, Autopilot/Ultragoal gate visibility, and release/CI hardening. It preserves existing package layout and CLI compatibility while tightening how dev-source updates, review lanes, HUD reconciliation, and release evidence behave.

## Highlights

- **Stable/dev update channels are explicit** — OMX update now distinguishes stable and dev channels, dev-source updates build installable package artifacts from a local checkout instead of trying to globally install the git dependency spec, and Windows update paths fall back to `npm.cmd` when direct `npm` lookup fails.
- **Project-local runtime state lookup is safer** — SessionStart project memory lookup works with boxed `OMX_ROOT`, and project-local `omx resume` history listing preserves the intended project history during isolated launches.
- **Deep-interview and question panes are more robust** — `omx question` delivers env vars through an export/prefix path under cmux/tmux shims, short panes keep deep-interview questions visible, and deep-interview handoffs are grounded in repo docs before execution.
- **Autopilot, review, and Ultragoal gates are clearer** — Autopilot ralplan write guards are phase-aware, review subagent model/effort choices are respected, and Ultragoal HUD stays active until goals finish.
- **HUD and CI reliability improved** — repeated tmux HUD reconciliation stays scoped to the emitting pane, fork PR CI avoids self-hosted skips, and self-hosted prerequisite install is hardened.

## Fixes / compatibility

- Existing update, HUD, Autopilot, Ultragoal, deep-interview, and project-local state files remain compatible; this release tightens fallback behavior and release evidence without intentional breaking changes.
- `0.18.8` post-publish evidence cleanup commits are included as internal release-readiness hygiene in the compare range.
- Nested `crates/omx-sparkshell/Cargo.lock` remains a standalone historical lockfile recording `omx-sparkshell` `0.1.0`; workspace package versioning is governed by root `Cargo.toml` and root `Cargo.lock`, both bumped for `0.18.9`.

## Merged PR inventory

#2713, #2711, #2710, #2709, #2708, #2706, #2704, #2703, #2702, #2699, #2697, #2693, #2691, #2690.

- [#2713](https://github.com/Yeachan-Heo/oh-my-codex/pull/2713) — Fix project-local omx resume history listing.
- [#2711](https://github.com/Yeachan-Heo/oh-my-codex/pull/2711) — Fix dev update installs from source.
- [#2710](https://github.com/Yeachan-Heo/oh-my-codex/pull/2710) — Add OMX update stable/dev channels.
- [#2709](https://github.com/Yeachan-Heo/oh-my-codex/pull/2709) — fix: deliver omx question env via export prefix under cmux (tmux -e shim workaround).
- [#2708](https://github.com/Yeachan-Heo/oh-my-codex/pull/2708) — Fix SessionStart project memory lookup with boxed OMX_ROOT.
- [#2706](https://github.com/Yeachan-Heo/oh-my-codex/pull/2706) — Fix Windows omx update npm.cmd fallback.
- [#2704](https://github.com/Yeachan-Heo/oh-my-codex/pull/2704) — ci: harden self-hosted prerequisite install.
- [#2703](https://github.com/Yeachan-Heo/oh-my-codex/pull/2703) — Keep repeated tmux HUD reconciliation scoped to the emitting pane.
- [#2702](https://github.com/Yeachan-Heo/oh-my-codex/pull/2702) — Keep deep-interview questions visible in short tmux panes.
- [#2699](https://github.com/Yeachan-Heo/oh-my-codex/pull/2699) — Keep Ultragoal HUD active until goals finish.
- [#2697](https://github.com/Yeachan-Heo/oh-my-codex/pull/2697) — Respect review subagent model and effort settings.
- [#2693](https://github.com/Yeachan-Heo/oh-my-codex/pull/2693) — Keep fork PR CI from self-hosted skips.
- [#2691](https://github.com/Yeachan-Heo/oh-my-codex/pull/2691) — Keep Autopilot ralplan write guards phase-aware.
- [#2690](https://github.com/Yeachan-Heo/oh-my-codex/pull/2690) — Improve deep-interview doc grounding.

## Internal/no-PR commits in compare range

- `6a897a81` — Avoid self-invalidating release sync evidence.
- `757b84a8` — Fix final readiness audit evidence.
- `a7482450` — Correct final 0.18.8 sync evidence.
- `dd7f369f` — Normalize 0.18.8 release readiness evidence.
- `320fe769` — Document release publish fallback evidence.
- `403e2549` — Unblock npm publish during Fulcio outage.

## Issues

No separately closed GitHub issues were found for the `v0.18.8..HEAD` release range during local release prep; the release scope is represented by the merged PR inventory above.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.9.md`.

Release gates included version sync, build, lint/no-unused, native-agent and plugin-bundle verification, catalog docs check, full tests, targeted compatibility/runtime tests, live OMX/Codex smoke where prerequisites were available, mandatory UltraQA, generated release body review, `git diff --check`, `npm pack --dry-run`, packed-install smoke, native asset/manifest verification evidence, and npm publication proof. The GitHub release includes `native-release-manifest.json`; npm provenance signing hit repeated Fulcio `ECONNRESET` failures, so the exact `v0.18.9` tag artifact was published with `npm publish --provenance=false` via temporary GitHub Actions fallback.

**Full Changelog**: [`v0.18.8...v0.18.9`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.8...v0.18.9)
