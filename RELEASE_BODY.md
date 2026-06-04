# oh-my-codex 0.18.9

`0.18.9` is a patch release after `0.18.8` for update-channel reliability, project-local runtime state lookup, tmux/cmux question rendering, Autopilot/Ultragoal gate visibility, and release/CI hardening. It preserves existing package layout and CLI compatibility while tightening how dev-source updates, review lanes, HUD reconciliation, and release evidence behave.

## Highlights

- **Stable/dev update channels are explicit** — OMX update now distinguishes stable and dev channels, dev-source updates build installable package artifacts from a local checkout, and Windows update paths fall back to `npm.cmd` when direct `npm` lookup fails.
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

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.9.md`.

Local gates before tagging include version sync, build, lint/no-unused, native-agent/plugin-bundle verification, catalog docs check, full tests, targeted compatibility/runtime tests, live OMX/Codex smoke where prerequisites are available, mandatory UltraQA, release body generation and review, `git diff --check`, `npm pack --dry-run`, packed-install smoke, and native asset/manifest verification evidence.

The GitHub release workflow remains the authoritative cross-platform native asset gate after tag push, including the uploaded `native-release-manifest.json`. During publication, npm provenance signing hit repeated Fulcio `ECONNRESET` failures; a temporary GitHub Actions fallback published the exact `v0.18.9` tag artifact with `npm publish --provenance=false`, matching the prior release-train outage procedure.

## Contributors

Thanks to the contributors who landed the `v0.18.8...v0.18.9` delta:

- [@Yeachan-Heo](https://github.com/Yeachan-Heo)
- [@iqdoctor](https://github.com/iqdoctor)
- [@Bongseop-Kim](https://github.com/Bongseop-Kim)

**Full Changelog**: [`v0.18.8...v0.18.9`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.8...v0.18.9)
