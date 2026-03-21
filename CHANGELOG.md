# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.11.6] - 2026-03-21

Patch release for Ralph continue-steer restart throttling.

### Fixed
- **Ralph continue-steer restart throttling** — fallback watcher cooldown anchors now survive restarts and malformed persisted timestamps, preventing repeated continue-steer injection spam after Ralph resumes. (PR [#998](https://github.com/Yeachan-Heo/oh-my-codex/pull/998), closes [#996](https://github.com/Yeachan-Heo/oh-my-codex/issues/996))

## [0.11.5] - 2026-03-21

Hotfix release for stale leader nudge false-positives and README onboarding clarity.

### Fixed
- **False-positive leader stale nudges** — leader activity freshness check now considers any recent leader activity, preventing spurious stale nudges when the leader is actively working. (PR [#993](https://github.com/Yeachan-Heo/oh-my-codex/pull/993))

### Changed
- **README onboarding refocused** — README now centers onboarding around the real default OMX path for clearer first-run guidance. (PR [#992](https://github.com/Yeachan-Heo/oh-my-codex/pull/992))

## [0.11.4] - 2026-03-20


Hotfix release for team worker delivery regressions.

### Fixed
- **Packaged watcher entrypoint resolution** — team fallback watcher startup and one-shot flush paths now resolve shipped `dist/scripts/*.js` entrypoints instead of nonexistent top-level `scripts/*.js`, restoring worker message delivery and state-change delivery in packed installs.
- **CI smoke coverage for packaged watcher paths** — smoke CI now exercises the packaged watcher path-resolution contract so future release builds catch this class of regression before shipping.

## [0.11.2] - 2026-03-20

6 PRs landed since `v0.11.1`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo).

### Added
- **Bidirectional Telegram/Discord reply support** — reply listeners now support polling-based bidirectional messaging for Telegram and Discord integrations. (PR [#984](https://github.com/Yeachan-Heo/oh-my-codex/pull/984))
- **OMX SDK architecture enhancements** — improved SDK facade contracts and verification patterns for external integrations. (PR [#985](https://github.com/Yeachan-Heo/oh-my-codex/pull/985))

### Fixed
- **Deep-interview state mode compatibility** — deep-interview workflow now correctly uses OMX state APIs instead of legacy OMC state paths. (PR [#987](https://github.com/Yeachan-Heo/oh-my-codex/pull/987), closes [#1783](https://github.com/Yeachan-Heo/oh-my-codex/issues/1783))
- **Real tmux test isolation** — tmux/session tests are now isolated from live maintainer sessions to prevent interference. (PR [#980](https://github.com/Yeachan-Heo/oh-my-codex/pull/980), closes [#960](https://github.com/Yeachan-Heo/oh-my-codex/issues/960))
- **npm pack dry-run race condition** — prevented parallel test runs from rebuilding dist during npm pack dry-runs. (PR [#986](https://github.com/Yeachan-Heo/oh-my-codex/pull/986))
- **Ambient tmux bootstrap restoration** — restored ambient tmux bootstrap for state tools with aligned fake tmux fixtures. (hotfix commits)

### Changed
- **Hook SDK documentation alignment** — unified hook enablement wording and messaging across help, init, and status commands.

## [0.11.1] - 2026-03-20

5 PRs landed since `v0.11.0`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo).

### Fixed
- **Pane detection regression** — auto-nudge fixtures aligned with canonical pane routing, preventing hook nudges from landing in the HUD pane. (PR [#981](https://github.com/Yeachan-Heo/oh-my-codex/pull/981))
- **Live session interference in tests** — tmux/session discovery is now isolated from live maintainer state. (PR [#979](https://github.com/Yeachan-Heo/oh-my-codex/pull/979), closes [#963](https://github.com/Yeachan-Heo/oh-my-codex/issues/963))
- **Packed install strict allowlist** — explore harness now fails fast for non-rg allowlist misses while keeping packed installs alive without requiring ripgrep. (PR [#978](https://github.com/Yeachan-Heo/oh-my-codex/pull/978), closes [#964](https://github.com/Yeachan-Heo/oh-my-codex/issues/964))
- **Release smoke focus** — smoke tests now focus on boot-safe packed installs. (PR [#983](https://github.com/Yeachan-Heo/oh-my-codex/pull/983), closes [#982](https://github.com/Yeachan-Heo/oh-my-codex/issues/982))

### Changed
- **CI workflow cleanup** — streamlined release smoke tests and reduced external tool dependencies in test environments.

## [0.11.0] - 2026-03-19

Version bump for release.

## [0.10.3] - 2026-03-18

46 commits across 21 PRs from `v0.10.2..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@lifrary](https://github.com/lifrary) (SEUNGWOO LEE).

### Added
- **Lore commit protocol in AGENTS.md template** — executor prompt and AGENTS.md template now include a Lore commit protocol for structured commit metadata. (PR [#916](https://github.com/Yeachan-Heo/oh-my-codex/pull/916))
- **AGENTS.md model capability table auto-generated during setup** — `omx setup` now generates a model capability table in AGENTS.md for quick reference. (PR [#894](https://github.com/Yeachan-Heo/oh-my-codex/pull/894))
- **Native skill_ref bridges and subagent tracking** — skill references can now bridge to native subagents with lifecycle tracking. (PR [#892](https://github.com/Yeachan-Heo/oh-my-codex/pull/892))
- **Codex native subagent integration phase 1** — first-pass integration of Codex CLI native subagent spawning and coordination. (PR [#886](https://github.com/Yeachan-Heo/oh-my-codex/pull/886))
- **AGENTS autonomy directive** — AGENTS.md now includes an explicit autonomy directive for self-directed agent operation. (PR [#883](https://github.com/Yeachan-Heo/oh-my-codex/pull/883))
- **Autoresearch novice deep-interview intake bridge** — autoresearch can now route novice users through the deep-interview intake flow before launching autonomous research. (PR [#906](https://github.com/Yeachan-Heo/oh-my-codex/pull/906))
- **`omx cleanup` for orphaned MCP servers** — new cleanup command detects and removes orphaned MCP server processes. (PR [#901](https://github.com/Yeachan-Heo/oh-my-codex/pull/901), closes [#900](https://github.com/Yeachan-Heo/oh-my-codex/issues/900))
- **Stale `/tmp` cleanup in `omx cleanup`** — cleanup now also removes stale temporary files from `/tmp`. (PR [#912](https://github.com/Yeachan-Heo/oh-my-codex/pull/912), closes [#908](https://github.com/Yeachan-Heo/oh-my-codex/issues/908))
- **Autoresearch showcase hub** — added showcase index, runner script, and completed demos for adaptive sorting, latent subspace discovery, noisy bayesopt, and kaggle-style ML missions. (PRs [#884](https://github.com/Yeachan-Heo/oh-my-codex/pull/884))

### Changed
- **Autoresearch contracts and runtime deslopped** — cleaned up autoresearch contract interfaces and runtime for clarity and consistency. (PR [#918](https://github.com/Yeachan-Heo/oh-my-codex/pull/918))

### Fixed
- **Packed-install smoke deps bootstrapped in worktrees** — worktree-based CI now correctly bootstraps smoke test dependencies for packed installs. (PR [#919](https://github.com/Yeachan-Heo/oh-my-codex/pull/919), closes [#917](https://github.com/Yeachan-Heo/oh-my-codex/issues/917))
- **Deep-interview launch for autoresearch intake** — autoresearch intake now correctly uses the deep-interview launch path. (PR [#915](https://github.com/Yeachan-Heo/oh-my-codex/pull/915), closes [#911](https://github.com/Yeachan-Heo/oh-my-codex/issues/911))
- **musl Linux assets preferred before glibc** — native asset resolution now prefers musl-linked Linux binaries over glibc for broader compatibility. (PRs [#914](https://github.com/Yeachan-Heo/oh-my-codex/pull/914), [#907](https://github.com/Yeachan-Heo/oh-my-codex/pull/907))
- **Autoresearch worktree paths use project-local `.omx/`** — worktrees are now created under `.omx/worktrees/` instead of global paths. (PR [#913](https://github.com/Yeachan-Heo/oh-my-codex/pull/913))
- **Stale obsolete native agents cleaned up** — removed leftover native agent files that were no longer in use. (PR [#899](https://github.com/Yeachan-Heo/oh-my-codex/pull/899))
- **Skill agent generation stopped** — setup no longer generates agent files for skills, reducing file bloat. (PR [#897](https://github.com/Yeachan-Heo/oh-my-codex/pull/897))
- **`__dirname` ESM error in autoresearch guided flow** — resolved CommonJS `__dirname` reference in ESM context. (PR [#903](https://github.com/Yeachan-Heo/oh-my-codex/pull/903))
- **macOS test compatibility for autoresearch** — replaced `execFileSync('cat')` with `readFileSync` and fixed BSD `find` incompatibilities. (PR [#891](https://github.com/Yeachan-Heo/oh-my-codex/pull/891) — @lifrary)
- **High-severity transitive vulnerabilities patched** — updated transitive dependencies to resolve high-severity CVEs and added dependabot config. (PR [#889](https://github.com/Yeachan-Heo/oh-my-codex/pull/889), closes [#888](https://github.com/Yeachan-Heo/oh-my-codex/issues/888))

## [0.10.2] - 2026-03-16

3 PRs landed after the `0.10.1` release tag and before this `0.10.2` release-prep commit: all 3 are targeted fixes. The `0.10.1` tag landed at `2026-03-16 06:57 UTC`; the last shipped merge (`#878`) landed at `2026-03-16 08:43 UTC`, for a turnaround of about 1 hour 46 minutes before release prep closed the patch.

### Fixed
- **Autoresearch codex args normalized for sandbox bypass** — ensures `--dangerously-bypass-approvals-and-sandbox` flag is correctly normalized when composing codex launch arguments, preventing double-flag or missing-flag edge cases. (PR [#875](https://github.com/Yeachan-Heo/oh-my-codex/pull/875))
- **Duplicate `[tui]` config sections auto-repaired before Codex CLI launch** — detects and merges duplicate `[tui]` sections in `config.toml` before invoking Codex, preventing TOML parse failures. (PR [#876](https://github.com/Yeachan-Heo/oh-my-codex/pull/876))
- **tmux launch policy on darwin** — uses the correct tmux launch policy on macOS to prevent session startup failures when tmux server is not yet running. (PR [#878](https://github.com/Yeachan-Heo/oh-my-codex/pull/878))

### CI
- Release workflow now sets the GitHub Release title and body from `RELEASE_BODY.md` via `softprops/action-gh-release`.

## [0.10.1] - 2026-03-16

6 PRs landed after the `0.10.0` release bump and before this `0.10.1` release-prep commit: 4 urgent hotfix PRs, 1 fast-follow autoresearch UX PR, and 1 docs follow-up. The `0.10.0` bump commit landed at `2026-03-15 17:22 UTC`; the urgent hotfix train was merged by `2026-03-16 03:18 UTC`, and the last shipped `dev` follow-up merge landed at `2026-03-16 05:59 UTC`, for a turnaround of about 12 hours 37 minutes before release prep closed the patch.

### Added
- **Guided autoresearch setup and `init` scaffolding** — `omx autoresearch` now supports an interactive guided setup on TTYs plus a scriptable `omx autoresearch init` path for creating mission files and launching the supervisor cleanly. (PR [#873](https://github.com/Yeachan-Heo/oh-my-codex/pull/873), closes [#863](https://github.com/Yeachan-Heo/oh-my-codex/issues/863))

### Fixed
- **Autoresearch now bypasses approvals and sandbox by default** — prevents autonomous runs from stalling on approval/sandbox prompts unless callers already supplied their own flags. (PR [#856](https://github.com/Yeachan-Heo/oh-my-codex/pull/856), closes [#855](https://github.com/Yeachan-Heo/oh-my-codex/issues/855))
- **Autoresearch worktree cleanliness ignores `.omx/` runtime artifacts** — avoids false dirty-worktree failures caused by session state and other runtime files. (PR [#858](https://github.com/Yeachan-Heo/oh-my-codex/pull/858), closes [#857](https://github.com/Yeachan-Heo/oh-my-codex/issues/857))
- **Installed skills are deduplicated across project and user scopes** — project-local skills now take precedence and shadowed duplicates are filtered from composed AGENTS/team instructions. (PR [#864](https://github.com/Yeachan-Heo/oh-my-codex/pull/864), closes [#861](https://github.com/Yeachan-Heo/oh-my-codex/issues/861))
- **Team worker readiness detection matches Codex 0.114.0 startup behavior** — accepts the new welcome-helper text and uses a safer ready wait path to reduce false startup failures. (PR [#868](https://github.com/Yeachan-Heo/oh-my-codex/pull/868), closes [#866](https://github.com/Yeachan-Heo/oh-my-codex/issues/866))

### Docs
- Added the Discord community server badge to the primary multilingual READMEs. (PR [#869](https://github.com/Yeachan-Heo/oh-my-codex/pull/869))

## [0.10.0] - 2026-03-15

54 commits across 26 PRs from `v0.9.1..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@HaD0Yun](https://github.com/HaD0Yun).

### Added
- **`omx autoresearch`** _(experimental)_ — new autonomous research mode that iteratively explores topics and self-terminates after repeated noop iterations. (PRs [#847](https://github.com/Yeachan-Heo/oh-my-codex/pull/847), [#849](https://github.com/Yeachan-Heo/oh-my-codex/pull/849))
- **`omx exec` wrapper** — first-pass execution wrapper that lets users run commands through the OMX orchestration layer directly. (PR [#832](https://github.com/Yeachan-Heo/oh-my-codex/pull/832))
- **Team worktrees enforced by default** — team mode now creates isolated git worktrees for each worker by default, improving parallel safety. (PR [#804](https://github.com/Yeachan-Heo/oh-my-codex/pull/804))
- **Deep-interview intent-first mode** — deep-interview now classifies user intent upfront before entering the Socratic question loop. (PR [#829](https://github.com/Yeachan-Heo/oh-my-codex/pull/829))
- **Incremental worktree merge tracking** — team worktree merges are now tracked incrementally, enabling smarter conflict detection and resolution. (PR [#846](https://github.com/Yeachan-Heo/oh-my-codex/pull/846))

### Changed
- **Deep-interview execution handoff contract documented** — the bridge between interview and autonomous execution is now an explicit, testable contract. (PR [#851](https://github.com/Yeachan-Heo/oh-my-codex/pull/851))
- **Team event/docs contract clarified** — interop contract now documents canonical event reads, wakeable vs audit-only signals, and `allocation_reason` review seam.
- **CI Rust runtime alignment reverted** — crates runtime packaging was reverted after compatibility issues. (PRs [#821](https://github.com/Yeachan-Heo/oh-my-codex/pull/821), [#840](https://github.com/Yeachan-Heo/oh-my-codex/pull/840))

### Fixed
- **Windows psmux bootstrap hardened** — detached psmux bootstrap on Windows now handles edge cases that caused silent failures. (PR [#854](https://github.com/Yeachan-Heo/oh-my-codex/pull/854), closes [#853](https://github.com/Yeachan-Heo/oh-my-codex/issues/853))
- **Team worktree continuous integration** — hybrid merge strategy with auto-commit and cross-worker rebase for reliable worktree synchronization. (PR [#852](https://github.com/Yeachan-Heo/oh-my-codex/pull/852))
- **Setup skill validation** — skills are now validated before install to prevent broken skill directories. (PR [#845](https://github.com/Yeachan-Heo/oh-my-codex/pull/845), issue [#844](https://github.com/Yeachan-Heo/oh-my-codex/issues/844))
- **Ralph auto-expand iterations** — active Ralph sessions now auto-expand `max_iterations` instead of halting prematurely. (PR [#843](https://github.com/Yeachan-Heo/oh-my-codex/pull/843), issue [#842](https://github.com/Yeachan-Heo/oh-my-codex/issues/842))
- **Setup defaults to CODEX_HOME** — user skills path now correctly defaults to `CODEX_HOME`. (PR [#839](https://github.com/Yeachan-Heo/oh-my-codex/pull/839))
- **Post-ralplan team context preserved** — team follow-up context no longer lost after ralplan completes. (PR [#833](https://github.com/Yeachan-Heo/oh-my-codex/pull/833))
- **Pipeline planning artifact checks unified** — planning-complete artifact detection now uses a single consistent check. (PR [#828](https://github.com/Yeachan-Heo/oh-my-codex/pull/828), issue [#827](https://github.com/Yeachan-Heo/oh-my-codex/issues/827))
- **Config.toml merge fix** — existing notify and tui entries are now preserved during config merge. (PR [#826](https://github.com/Yeachan-Heo/oh-my-codex/pull/826), issue [#825](https://github.com/Yeachan-Heo/oh-my-codex/issues/825))
- **Project .omx gitignore sync** — fixed gitignore sync for project-scoped `.omx` directories. (PR [#824](https://github.com/Yeachan-Heo/oh-my-codex/pull/824), issue [#823](https://github.com/Yeachan-Heo/oh-my-codex/issues/823))
- **Team HUD full-width** — team HUD layout now spans the full terminal width. (PR [#822](https://github.com/Yeachan-Heo/oh-my-codex/pull/822), issue [#822](https://github.com/Yeachan-Heo/oh-my-codex/issues/822))
- **tmux mouse state leak** — stopped leaking server-global mouse state across sessions. (PR [#820](https://github.com/Yeachan-Heo/oh-my-codex/pull/820), issue [#817](https://github.com/Yeachan-Heo/oh-my-codex/issues/817))
- **Sparkshell glibc fallback** — sparkshell now falls back gracefully when encountering glibc mismatch on older Linux systems. (PR [#813](https://github.com/Yeachan-Heo/oh-my-codex/pull/813), issue [#812](https://github.com/Yeachan-Heo/oh-my-codex/issues/812))
- **macOS clipboard image paste** — preserved correct clipboard image paste path on macOS. (PR [#810](https://github.com/Yeachan-Heo/oh-my-codex/pull/810), issue [#809](https://github.com/Yeachan-Heo/oh-my-codex/issues/809))
- **Release smoke hydration** — localized smoke hydration assets for offline validation. (PR [#806](https://github.com/Yeachan-Heo/oh-my-codex/pull/806))

### Internal
- Removed unused `sendRebaseConflictMessageToWorker` function. (PR [#852](https://github.com/Yeachan-Heo/oh-my-codex/pull/852))
- Isolated dirty-worktree test helpers for better test hygiene. (PR [#849](https://github.com/Yeachan-Heo/oh-my-codex/pull/849))

## [0.9.1] - 2026-03-13

### Fixed
- **Release smoke hydration hotfix** — cherry-picked PR [#806](https://github.com/Yeachan-Heo/oh-my-codex/pull/806)'s packed-install smoke fix onto `main` so hydration assets are localized correctly during release verification. (commit `d86165d`)

### Changed
- **Release metadata for the superseding patch release** — bumped package/workspace versions to `0.9.1` and added release notes/readiness docs that explicitly preserve the historical record: `v0.9.0` remains red, and `v0.9.1` is the clean superseding release.

## [0.9.0] - 2026-03-12

55 non-merge commits from `v0.8.15..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo/oh-my-codex), Bellman, 2233admin, [@seunghwaneom](https://github.com/seunghwaneom), [@hoky1227](https://github.com/hoky1227).

### Added
- **`omx explore` native harness and packaging flow** — OMX now ships a dedicated read-only exploration entrypoint backed by a Rust harness, packaged/source fallback logic, and release-aware native asset resolution. (commit `fb07c3c`)
- **`omx sparkshell` operator-facing native sidecar** — added a direct shell-native specialist surface plus explicit tmux-pane summarization support for operator inspection workflows. (commit `71858c3`)
- **Cross-platform native release publishing** — release automation now publishes native archives for both `omx-explore-harness` and `omx-sparkshell`, with generated release-manifest metadata and a packed-install smoke gate. (commit `23d1cf5`, `559089f`)
- **`build:full` one-shot build path** — added a release-oriented build command that compiles TypeScript plus the packaged explore harness and sparkshell binaries, and validated it in CI. (commit `d12e5f4`, `99ce264`)

### Changed
- **Qualifying `omx explore` shell-native prompts can route through sparkshell** — simple read-only shell tasks now use sparkshell as a backend when that is the cheaper fit, while preserving explicit fallback to the direct explore harness. (PR [#782](https://github.com/Yeachan-Heo/oh-my-codex/pull/782))
- **Default model resolution is now centralized** — runtime/docs/tests now align around one OMX default-model resolution path instead of scattered model-default handling. (PR [#787](https://github.com/Yeachan-Heo/oh-my-codex/pull/787))
- **Release/runtime guidance now documents the native exploration stack more explicitly** — README and guidance surfaces better describe explore/sparkshell routing, native hydration, and raw-vs-summary expectations. (commit `25bdd23`, `c83223d`)

### Fixed
- **Explore/sparkshell fallback hardening** — hardened sparkshell fallback behavior, missing-native-manifest handling, and release-asset/native-cache lookup so packaged installs fail more cleanly and recover more predictably. (commit `dc83dfd`, `7aee91d`)
- **Sparkshell summary behavior is more stable under noisy output** — summary reasoning was constrained and stress coverage added so long-output summaries stay more predictable and preserve salient facts. (PR [#781](https://github.com/Yeachan-Heo/oh-my-codex/pull/781), commit `a653376`)
- **CLI/help/runtime polish around the new stack** — local `ask`/`hud` help routing, HUD branch/config handling, Windows Codex command probing, and team runtime lifecycle/cleanup paths were tightened during the same release window. (PRs [#785](https://github.com/Yeachan-Heo/oh-my-codex/pull/785), [#786](https://github.com/Yeachan-Heo/oh-my-codex/pull/786), [#788](https://github.com/Yeachan-Heo/oh-my-codex/pull/788), [#793](https://github.com/Yeachan-Heo/oh-my-codex/pull/793))

## [0.8.13] - 2026-03-11

19 non-merge commits from `main..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@HaD0Yun](https://github.com/HaD0Yun), [@gobylor](https://github.com/gobylor).

### Added
- **Top-level `omx resume` command** — added `omx resume` passthrough so OMX mirrors `codex resume`, with CLI/help/docs coverage. (PR [#752](https://github.com/Yeachan-Heo/oh-my-codex/pull/752) — @gobylor)
- **Team allocation and conservative rebalance policy seams** — team startup assignment is now lane-aware, and runtime monitoring can safely reassign reclaimed pending work to eligible idle workers without rewriting the claim model. (PR [#761](https://github.com/Yeachan-Heo/oh-my-codex/pull/761) — @HaD0Yun)

### Changed
- **Team policy manifest boundaries are clearer** — persisted transport/runtime policy is now separated from lifecycle governance so nested-team checks, approval/delegation gates, and shutdown cleanup rules come from the authoritative runtime side. (PR [#753](https://github.com/Yeachan-Heo/oh-my-codex/pull/753), issue [#746](https://github.com/Yeachan-Heo/oh-my-codex/issues/746))
- **Shared tmux stall heuristics now drive both hook and runtime paths** — common stall/bootstrap/ready/active-task detection moved into a shared engine reused by notify-hook dispatch/guard logic and the team tmux session runtime. (PR [#758](https://github.com/Yeachan-Heo/oh-my-codex/pull/758), issue [#732](https://github.com/Yeachan-Heo/oh-my-codex/issues/732))
- **Team-mode docs and guidance were refreshed** — README copy now positions OMX more clearly around Team Mode, and the root guidance wording was tightened for direct execution and evidence-backed verification. (PR [#765](https://github.com/Yeachan-Heo/oh-my-codex/pull/765), commit [`5ced66d`](https://github.com/Yeachan-Heo/oh-my-codex/commit/5ced66db873b2cf729f66075062df3c2a8599357))

### Fixed
- **Fallback team delivery and stale-alert latency** — faster fallback watcher cadence, leader nudge evaluation on fallback ticks, and a larger default dispatch ack budget reduce lag in team message delivery and stale alerts. (PR [#739](https://github.com/Yeachan-Heo/oh-my-codex/pull/739), issue [#738](https://github.com/Yeachan-Heo/oh-my-codex/issues/738))
- **Invalid Codex TOML detection in `omx doctor`** — doctor now flags malformed `~/.codex/config.toml` with a clearer duplicate-table hint. (PR [#740](https://github.com/Yeachan-Heo/oh-my-codex/pull/740), related issue [#486](https://github.com/Yeachan-Heo/oh-my-codex/issues/486))
- **Linked Team Ralph lifecycle synchronization** — `omx team ralph` now establishes linked Ralph state on launch, propagates linked terminal cancellation directly from runtime transitions, and keeps continue-steer alive when the launcher parent exits while Ralph work is still active. (PR [#749](https://github.com/Yeachan-Heo/oh-my-codex/pull/749), issue [#742](https://github.com/Yeachan-Heo/oh-my-codex/issues/742); PR [#750](https://github.com/Yeachan-Heo/oh-my-codex/pull/750), issue [#743](https://github.com/Yeachan-Heo/oh-my-codex/issues/743); PR [#751](https://github.com/Yeachan-Heo/oh-my-codex/pull/751))
- **Team worker and leader nudges are more actionable** — auto-nudge follow-up phrases are detected more reliably, leader nudges now derive next actions from live team state, mailbox guidance is more explicit, and stale “keep polling” wording was replaced with orchestration guidance. (PR [#754](https://github.com/Yeachan-Heo/oh-my-codex/pull/754); PR [#759](https://github.com/Yeachan-Heo/oh-my-codex/pull/759), issue [#759](https://github.com/Yeachan-Heo/oh-my-codex/issues/759); PR [#763](https://github.com/Yeachan-Heo/oh-my-codex/pull/763); PR [#766](https://github.com/Yeachan-Heo/oh-my-codex/pull/766))
- **HUD cleanup during team shutdown** — interactive shutdown now tears down the HUD pane cleanly to avoid stale panes across rapid relaunch cycles. (PR [#764](https://github.com/Yeachan-Heo/oh-my-codex/pull/764), issue [#764](https://github.com/Yeachan-Heo/oh-my-codex/issues/764))
- **CLI startup no longer eagerly loads `doctor`** — the `doctor` command is now lazy-loaded so unrelated CLI invocations avoid unnecessary work. (commit [`2503d95`](https://github.com/Yeachan-Heo/oh-my-codex/commit/2503d9528d175a032bbc247f61137c5daf547923))

## [0.8.12] - 2026-03-11

12 non-merge commits from `v0.8.11..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@HaD0Yun](https://github.com/HaD0Yun), [@gobylor](https://github.com/gobylor).

### Added
- **Team orchestrator brain and executor lane split** — team workflow now uses dedicated `team-orchestrator` and `team-executor` agent roles for clearer separation of planning and execution concerns. (PR [#715](https://github.com/Yeachan-Heo/oh-my-codex/pull/715))
- **Session history search command** — `omx session-history search` (alias: `omx sh search`) enables full-text search across command history, prompts, and tool interactions with multi-field matching and interactive filtering. (PR [#724](https://github.com/Yeachan-Heo/oh-my-codex/pull/724))
- **Team idle and stall read APIs** — `omx team api` now exposes `idle-read` and `stall-read` operations for programmatic monitoring of team worker states. (PR [#720](https://github.com/Yeachan-Heo/oh-my-codex/pull/720))
- **Ralph periodic active continue steer** — Ralph mode now periodically prompts active agents to continue when progress has stalled, reducing idle wait times. (PR [#733](https://github.com/Yeachan-Heo/oh-my-codex/pull/733))
- **Team leader status monitoring hints** — improved leader-side status hints for better visibility into team member progress and stalled states. (PR [#734](https://github.com/Yeachan-Heo/oh-my-codex/pull/734))

### Changed
- **Low-confidence analysis prompts stay single-lane** — team decomposition now keeps analysis prompts in a single lane when confidence is low, preventing fragmentation of uncertain work. (PR [#726](https://github.com/Yeachan-Heo/oh-my-codex/pull/726))

### Fixed
- **Windows psmux detached launch stability** — resolved process detachment issues when launching team workers on Windows. (PR [#725](https://github.com/Yeachan-Heo/oh-my-codex/pull/725))
- **Skip tmux bootstrap when tmux unavailable** — graceful fallback when tmux is not installed or not in PATH. (PR [#722](https://github.com/Yeachan-Heo/oh-my-codex/pull/722) — @gobylor)
- **Stalled team leader nudge before stale gate** — team leaders now receive proactive nudges before hitting stale detection thresholds. (PR [#729](https://github.com/Yeachan-Heo/oh-my-codex/pull/729))

### Reverted
- **Experimental Rust CLI parity harness** — commits #728 and #730 were reverted from dev to maintain TypeScript CLI stability. (PR [#736](https://github.com/Yeachan-Heo/oh-my-codex/pull/736))

## [0.8.11] - 2026-03-10

Generated from the latest merged `dev` runtime/model-default work and validated on `dev` before release.

### Added
- **Additive team event-query APIs** — `omx team api` now exposes dedicated event-query operations so team runtime signals can be consumed more structurally. (PR [#714](https://github.com/Yeachan-Heo/oh-my-codex/pull/714))
- **Explicit model-default contract** — runtime/docs/tests now align around the intended main/spark default model behavior (`gpt-5.4` / `gpt-5.3-codex-spark`). (PR [#718](https://github.com/Yeachan-Heo/oh-my-codex/pull/718))

### Changed
- **Team prompt decomposition is less brittle for prose prompts** — natural-language task prompts are no longer fragmented into pathological subtasks as easily. (PR [#712](https://github.com/Yeachan-Heo/oh-my-codex/pull/712))

### Fixed
- **Shell-pane notification cleanup after terminal team states** — team notify injection now stays out of shell panes after completion. (PR [#668](https://github.com/Yeachan-Heo/oh-my-codex/pull/668))
- **Clawhip lifecycle event noise reduction** — operational event emission is quieter while preserving needed visibility. (PR [#713](https://github.com/Yeachan-Heo/oh-my-codex/pull/713))
- **Team runtime hardening across startup/worktree/idle-launch-arg paths** — includes the merged fixes from PRs [#696](https://github.com/Yeachan-Heo/oh-my-codex/pull/696), [#697](https://github.com/Yeachan-Heo/oh-my-codex/pull/697), [#700](https://github.com/Yeachan-Heo/oh-my-codex/pull/700), [#707](https://github.com/Yeachan-Heo/oh-my-codex/pull/707), [#708](https://github.com/Yeachan-Heo/oh-my-codex/pull/708), and [#711](https://github.com/Yeachan-Heo/oh-my-codex/pull/711).
- **Release gate stability for setup refresh tests** — setup AGENTS overwrite coverage now stays non-interactive under test so the release gate no longer hangs on a model-upgrade prompt.

## [0.8.10] - 2026-03-09

5 non-merge commits from `v0.8.9..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@HaD0Yun](https://github.com/HaD0Yun).

### Added
- **Release-critical regression coverage and test-environment isolation** — expanded CLI auto-update regression coverage across success, decline, failure, and already-up-to-date paths, and hardened CLI/OpenClaw integration suites against ambient `CODEX_HOME` leakage so release validation stays deterministic. (direct commit `aedd068` — @Yeachan-Heo)

### Changed
- **Root prompt contracts now bias more explicitly toward direct execution and evidence-backed verification** — tightened the top-level `AGENTS.md` / template contracts and simplified core prompt surfaces while preserving workflow, team, and verification guarantees. (PR [#646](https://github.com/Yeachan-Heo/oh-my-codex/pull/646) — @HaD0Yun)
- **Local development artifacts are now ignored by git** — `.codex/` and `coverage/` are ignored to avoid committing local session state and generated coverage data. (direct commit `3149747` — @Yeachan-Heo)

### Fixed
- **Auto-update now refreshes OMX setup immediately after a successful global install** — successful `omx` self-updates now force a setup refresh so prompts, skills, and `AGENTS.md` stay in sync without a separate manual refresh. (PR [#648](https://github.com/Yeachan-Heo/oh-my-codex/pull/648) — @Yeachan-Heo)
- **tmux Enter submission is more reliable in alternate-screen UIs** — added a settle delay before the first `C-m` submit and mirrored that protection in the hook extensibility tmux submission path. (PR [#649](https://github.com/Yeachan-Heo/oh-my-codex/pull/649) — @Yeachan-Heo, fixes [#647](https://github.com/Yeachan-Heo/oh-my-codex/issues/647))

## [0.8.9] - 2026-03-08

2 non-merge commits from `v0.8.8..dev`. Contributor: [@Yeachan-Heo](https://github.com/Yeachan-Heo).

### Changed
- **Team worker startup now uses per-role instruction surfaces end-to-end** — routed worker roles now persist into live team config/identity, compose per-worker startup `AGENTS.md` files from the resolved role prompt, and continue to apply role-based default reasoning unless explicit launch overrides are present. (PR [#643](https://github.com/Yeachan-Heo/oh-my-codex/pull/643))

### Fixed
- **Scaled task bootstrap now persists canonical task state before worker handoff** — dynamic scale-up writes new tasks through canonical team state first, preserving stable task ids/owners/roles for worker inboxes and role resolution instead of reconstructing synthetic task metadata during bootstrap.

## [0.8.8] - 2026-03-08

5 non-merge commits from `main..dev`. Contributor: [@Yeachan-Heo](https://github.com/Yeachan-Heo).

### Added
- **Anti-slop workflow and catalog wiring** — added the anti-slop workflow contract to root/template guidance, introduced a dedicated `ai-slop-cleaner` skill, and updated catalog manifests/tests so the new workflow is part of the generated skill surface. (PR [#634](https://github.com/Yeachan-Heo/oh-my-codex/pull/634))
- **Per-teammate reasoning-effort allocation for team runs** — team orchestration can now resolve reasoning effort per worker, with updated runtime/model-contract behavior plus regression coverage for runtime, tmux-session, and model selection paths. (PR [#642](https://github.com/Yeachan-Heo/oh-my-codex/pull/642))

### Changed
- **Team launch/model contracts were tightened** — worker launch args, scaling paths, tmux session handling, and README / skill guidance were adjusted so teammate-specific reasoning effort is propagated more consistently during team execution.

### Fixed
- **Deep-interview auto-approval injection is now lock-protected** — keyword detection and notify-hook auto-nudge paths were hardened so deep-interview auto-approval injection stays bounded, with expanded regression coverage around notify-hook modules and keyword routing. (PR [#637](https://github.com/Yeachan-Heo/oh-my-codex/pull/637))
- **Published npm bin path normalization** — normalized the package bin path contract and updated the package-bin regression test to keep the published `omx` entrypoint aligned. (PR [#638](https://github.com/Yeachan-Heo/oh-my-codex/pull/638))
- **Worker role reservation remains team-only** — prompt-guidance contract enforcement now reserves the worker role for team mode explicitly, backed by routing regression coverage.

## [0.8.7] - 2026-03-08

12 non-merge commits from `v0.8.6..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@HaD0Yun](https://github.com/HaD0Yun), [@marlocarlo](https://github.com/marlocarlo).

### Added
- **Prompt-guidance contract docs and reusable fragments** — added a first-class prompt-guidance contract document, reusable guidance fragments, a sync script, and shared contract test helpers so root instructions, templates, and prompts can stay aligned more systematically. (PR [#620](https://github.com/Yeachan-Heo/oh-my-codex/pull/620) — @Yeachan-Heo)
- **Team hardening benchmark and deeper runtime/worktree coverage** — added a dedicated hardening benchmark plus broader runtime, state, worktree, and end-to-end regression coverage for expired-claim recovery and worker hygiene. (PR [#624](https://github.com/Yeachan-Heo/oh-my-codex/pull/624) — @HaD0Yun)
- **Centralized MCP stdio lifecycle bootstrap** — state, memory, code-intel, trace, and team MCP servers now share a common `autoStartStdioMcpServer` helper and a dedicated lifecycle regression suite for idle teardown. (PR [#626](https://github.com/Yeachan-Heo/oh-my-codex/pull/626), [#627](https://github.com/Yeachan-Heo/oh-my-codex/pull/627) — @Yeachan-Heo)
- **Package-bin contract coverage for global installs** — added an explicit contract test to keep the published npm bin path aligned with global `omx` installation behavior. (PR [#633](https://github.com/Yeachan-Heo/oh-my-codex/pull/633) — @Yeachan-Heo)

### Changed
- **Prompt surfaces were normalized around contract-driven XML structure** — prompt guidance validation was centralized, shared fragments were extracted, all agent prompts were migrated from Markdown-style headings to XML-tag structure, and the 2-layer orchestrator/role-prompt model was clarified across docs, templates, and config generation. (PR [#619](https://github.com/Yeachan-Heo/oh-my-codex/pull/619), [#623](https://github.com/Yeachan-Heo/oh-my-codex/pull/623) — @HaD0Yun)
- **Fast-path agent reasoning defaults were rebalanced** — analyst, planner, and related fast-lane agent defaults were tuned downward to better match their intended operating posture.

### Fixed
- **Windows native startup and tmux capability detection** — OMX now checks tmux capability instead of hard-blocking on `win32`, supports `psmux`, uses Windows-appropriate command resolution where needed, and documents the platform setup path more clearly. (PR [#616](https://github.com/Yeachan-Heo/oh-my-codex/pull/616) — @marlocarlo)
- **Leader-only orchestration boundaries in prompt surfaces** — worker-facing and role-specific prompts now preserve leader orchestration responsibilities more explicitly, with regression coverage for the boundary contract. (PR [#625](https://github.com/Yeachan-Heo/oh-my-codex/pull/625) — @HaD0Yun)
- **npm global-install bin contract** — corrected the published `omx` bin path entry in `package.json` and locked it down with a dedicated contract test for packed tarballs and global installation behavior. (PR [#633](https://github.com/Yeachan-Heo/oh-my-codex/pull/633) — @Yeachan-Heo)

## [0.8.6] - 2026-03-07

4 non-merge commits from `main..dev`. Contributor: [@Yeachan-Heo](https://github.com/Yeachan-Heo).

### Added
- **Event-aware team waiting and canonical event normalization** — team runtime/state handling now includes additive `wake_on=event` / `after_event_id` waiting in `omx_run_team_wait`, shared event normalization/cursor helpers, canonical event typing across runtime/state/API layers, and new `omx team await <team-name>` CLI support. Runtime now emits `worker_state_changed` while preserving legacy `worker_idle` compatibility. (PR [#609](https://github.com/Yeachan-Heo/oh-my-codex/pull/609) — @Yeachan-Heo)
- **GPT-5.4 prompt-guidance rollout across core prompt surfaces** — root/template `AGENTS.md`, executor/planner/verifier prompts, generated `developer_instructions`, and regression coverage were updated to encode compact output defaults, low-risk follow-through, localized task-update overrides, and dependency-aware tool persistence more explicitly. (PR [#611](https://github.com/Yeachan-Heo/oh-my-codex/pull/611) — @Yeachan-Heo, addresses [#608](https://github.com/Yeachan-Heo/oh-my-codex/issues/608))
- **GPT-5.4 prompt-guidance expansion across the wider prompt catalog and execution-heavy skills** — the same guidance was extended across the remaining agent prompts plus execution-heavy skills including `analyze`, `autopilot`, `plan`, `ralph`, `ralplan`, `team`, `ultraqa`, `code-review`, `security-review`, and `build-fix`, with scenario-focused regression coverage added for prompt catalogs, wave-two guidance, and skill contracts. (PR [#612](https://github.com/Yeachan-Heo/oh-my-codex/pull/612) — @Yeachan-Heo, follow-up to [#611](https://github.com/Yeachan-Heo/oh-my-codex/pull/611))

### Fixed
- **Leader follow-up, watcher drain visibility, and idle/nudge coordination** — team leader follow-up behavior was hardened without repurposing worker-only nudges; watcher/dispatch drain liveness is now surfaced more clearly in runtime/state paths, with stronger regression coverage for event-mode wait, dispatch dedupe, all-workers-idle, and leader notification flows. (PR [#609](https://github.com/Yeachan-Heo/oh-my-codex/pull/609))
- **`team-ops` gateway contract regression** — removed an accidental `teamEventLogPath` re-export so the strict `team-ops` contract remains stable after the event-aware waiting changes. (PR [#610](https://github.com/Yeachan-Heo/oh-my-codex/pull/610))

## [0.8.5] - 2026-03-06

7 non-merge commits from `v0.8.4..dev`. Contributors: [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@HaD0Yun](https://github.com/HaD0Yun), [@sjals93](https://github.com/sjals93).

### Added
- **Posture-aware agent routing** — agents now carry Sisyphus-style posture metadata (`frontier-orchestrator`, `deep-worker`, `fast-lane`) that separates role, reasoning tier, and operating style. Native agent configs include `## OMX Posture Overlay`, `## Model-Class Guidance`, and `## OMX Agent Metadata` sections. (PR [#588](https://github.com/Yeachan-Heo/oh-my-codex/pull/588), [#592](https://github.com/Yeachan-Heo/oh-my-codex/pull/592) — @HaD0Yun)
- **Maintainers section** added to README with @Yeachan-Heo and @HaD0Yun.

### Fixed
- **Windows ESM import crash** — `bin/omx.js` now converts absolute paths to `file://` URLs before `import()`, fixing `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows. (PR [#589](https://github.com/Yeachan-Heo/oh-my-codex/pull/589) — @sjals93, fixes [#557](https://github.com/Yeachan-Heo/oh-my-codex/issues/557))
- **tmux capture-pane history flag** — replaced invalid `-l` flag with the correct `-S` negative-offset form so `capture-pane` actually returns recent output. (PR [#593](https://github.com/Yeachan-Heo/oh-my-codex/pull/593), fixes [#591](https://github.com/Yeachan-Heo/oh-my-codex/issues/591))
- **Legacy model alias cleanup** — removed stale `gpt-5.3-codex` / `o3` references from 15 prompt files and runtime agent metadata generation, preventing confusion when posture routing is active. (part of PR [#592](https://github.com/Yeachan-Heo/oh-my-codex/pull/592))

## [0.8.4] - 2026-03-06

Generated from `v0.8.3..dev` (non-merge commits) and release validation on `dev`.

### Changed
- Bumped package version to `0.8.4`.
- `omx setup` now refreshes managed OMX artifacts by default while preserving backups of overwritten files where applicable.

### Added
- Setup refresh coverage for managed artifact replacement, scope-aware updates, and uninstall compatibility paths.

### Fixed
- Setup now prompts before upgrading managed Codex model references from `gpt-5.3-codex` to `gpt-5.4`, reducing surprise config churn during refreshes.
- Config generation and setup refresh flows are more idempotent and resilient across repeated runs and scoped installs.

### Docs
- Refreshed setup guidance in the README to document the new refresh/upgrade behavior.

### CI / Test
- Hardened the notify-fallback watcher streaming test to wait for watcher shutdown before temp-directory cleanup during full-suite runs.
- Removed an unused setup overwrite prompt code path caught by the `check:no-unused` release gate.

## [0.8.3] - 2026-03-06

Generated from the Gemini worker hotfix on `dev`, plus release-validation hardening and verification on `dev`.

### Changed
- Bumped package version to `0.8.3`.

### Fixed
- Team runtime now seeds Gemini workers with a prompt-interactive launch (`--approval-mode yolo -i <inbox prompt>`) instead of relying on stdin-only startup behavior (`#585`).
- Gemini workers now drop non-Gemini default model passthroughs unless an explicit Gemini model was requested, preventing invalid mixed-provider startup args (`#585`).
- Expanded runtime and tmux-session coverage for Gemini prompt-mode worker startup and argument translation (`#585`).

### CI / Test
- Hardened the notify-fallback watcher streaming test to wait for watcher readiness before asserting EOF-tail behavior during full-suite runs.

## [0.8.2] - 2026-03-06

Generated from `v0.8.1..main` (non-merge commits) and release validation on `main`.

### Added
- Gemini CLI worker support for OMX team mode, including mixed CLI maps and `--model` passthrough (`#576`, `#579`, related issue `#573`).
- Default frontier-model fallback is now centralized through `DEFAULT_FRONTIER_MODEL` (currently `gpt-5.4`) instead of hardcoded references (`#583`).
- `configure-notifications` is now the canonical shipped notification-setup skill, with catalog/setup behavior aligned to match docs (`#584`).

### Changed
- Bumped package version to `0.8.2`.
- Setup/install now follows the catalog manifest more strictly and `--force` cleans stale shipped / legacy notification skill directories (`#575`, `#580`, `#584`, closes `#574`).
- Expanded OpenClaw integration docs and localized navigation links (`#571`).

### Fixed
- `omx setup` now skips writing the deprecated `[tui]` section for Codex CLI `>= 0.107.0` (`#572`, fixes `#564`).
- Prevented unresolved placeholder leakage in OpenClaw hook instruction templates (`#581`, closes `#578`).
- Hardened explicit multi-skill ordering and blocked implicit keyword auto-activation for direct `/prompts:<name>` invocations (`#582`).

### Docs
- Aligned notification skill inventory/docs with the canonical `configure-notifications` model and improved prior release-note readability.

## [0.8.1] - 2026-03-05

Generated from `4141fd6..HEAD` (non-merge commits) and release validation on `dev`.

### Added
- Team CLI interop API (`omx team api ...`) with hard deprecation of legacy `team_*` MCP tools.
- Finalized CLI-first team interop/dispatch reliability flow.

### Changed
- Bumped package version to `0.8.1`.
- Refactored notification setup into a unified `configure-notifications` flow.
- Updated docs to prefer the CLI-first team protocol + interop contract.

### Fixed
- Enforced CLI-first dispatch policy and removed dead state-server helpers.
- OpenClaw command timeout is now configurable with bounded safety limits.

### CI / Test / Docs
- Added comprehensive team API interop tests for coverage gating.
- Added configure-notifications setup guidance to README.
- Expanded OpenClaw docs with token/command safety guidance and a dev runbook.

## [0.8.0] - 2026-03-04

Generated from `v0.7.6..dev` (non-merge commits) and release validation on `dev`.

### Added
- New canonical provider advisor command: `omx ask <claude|gemini> "<prompt>"`.
- Ouroboros-inspired ambiguity-gated deep interview workflow (`$deep-interview`) for requirement clarification.
- Required pre-context intake gates for execution-heavy flows (autopilot, ralph, team, ralplan, and deep-interview preflight).
- New `$web-clone` skill for URL-driven website cloning and verification loops.
- Built-in `ask-claude` and `ask-gemini` skills in the catalog.
- Visual-verdict feedback loop support for visual Ralph iterations.

### Changed
- Bumped package version to `0.8.0`.
- `ask-claude` and `ask-gemini` skill guidance now routes to canonical `omx ask ...` usage.
- Ask docs/CLI parsing now explicitly align with provider help flags (`claude --print|-p`, `gemini --prompt|-p`).
- Legacy wrapper/npm script entrypoints remain available as transitional compatibility paths with migration hints.
- Refactored team state facade into bounded modules and extracted canonical state-root resolution.
- Improved CLI behavior around `omx ralph --prd`, `--version` routing, and PRD-focused help guidance.
- Hardened runtime quality/performance/concurrency paths (dispatch polling backoff, notepad atomicity, scaling rollback, shutdown guards).

### Fixed
- Closed multiple security issues (including shell-injection vector replacement and security hardening sweep).
- Fixed launch worktree reuse to gracefully handle pre-existing paths.
- Fixed team claim lifecycle contract enforcement (`releaseTaskClaim` token validation) and worker bootstrap lifecycle docs.
- Fixed `writeAtomic` ENOENT masking behavior and team rebase/typecheck regressions.
- Fixed onboarding warning copy clarity in `omx doctor`.
- Fixed missing pre-context gate text for team/ralplan skill docs.

### CI / Test / Docs
- Added Node `20/22` CI matrix for core checks.
- Added required CI lint gate and team/state coverage gate with reporting.
- Expanded tests for idle nudge branch/throttle behavior and team ops contracts.
- Completed multilingual README translations for all 12 languages.

## [0.7.6] - 2026-03-02

### Changed
- Package version bumped to `0.7.6` after `0.7.5` publication.

### Notes
- Detailed release notes prepared in `docs/release-notes-0.7.6.md`, including smoke verification evidence.

## [0.7.5] - 2026-03-02

Generated strictly from commit logs in `main..dev`:

- Commit window: **26 non-merge commits** (`2026-02-28` to `2026-03-02`)
- Diff snapshot (`main...dev`): **55 files changed, +4,437 / -242**
- Source commands:
  - `git rev-list --no-merges --count main..dev`
  - `git diff --shortstat main...dev`
  - `git log --no-merges --date=short --pretty=format:'%ad %h %s' --reverse main..dev`

### Added (from `feat(...)` subjects)
- `c235a5a` feat(team): add dedicated ralph auto-run cleanup policy (#407) (#412)
- `1653aa7` feat(team): add dedicated tmux session mode for worker isolation (#416)
- `7413fe3` feat(team): add per-worker role routing and task decomposition

### Changed / Docs / CI / Refactor
- `0c68a02` docs: OpenClaw integration guide for notifications (#413)
- `56091a4` ci: add CI Status gate job for branch protection (#423)
- `3f6b3fd` refactor(mcp): extract omx_run_team_* to dedicated team-server.ts (#431)
- `6c1c4eb` docs(changelog): update unreleased notes for main...dev

### Fixed (from `fix(...)` subjects)
- `8d3fef0` fix(notifications): native OpenClaw gateway support (#414) (#415)
- `383d79d` fix(tmux): source shell profile (.zshrc/.bashrc) for detached session launch
- `d4f6803` fix(team): revert dedicated tmux session mode, restore split-pane default
- `576ec9c` fix(ralph): exclude option values from CLI task description (#424)
- `6eed3c6` fix(notify-hook): add structured logging for visual-verdict parse/persist failures (#428)
- `b5dc657` fix(team): fix 3 regressions in team/ralph shutdown and resume paths (#430)
- `c3d1220` fix(team): switch dedicated tmux session to opt-in with worker location hint (#432)
- `454e69d` fix(team): force cleanup on failed/cancelled runs, await worktree rollback, refresh dead-worker panes (#438)
- `c8632fa` fix(team): fix leader pane targeting in notify-hook dispatch and runtime fallback (#433, #437) (#439)
- `587ec94` fix(team): harden autoscaling pane cleanup and teardown
- `12dea24` fix(team): preserve layout during scale-up and add regression test
- `f5d47f4` fix(tmux): skip injection when pane returns to shell (#441) (#442)
- `cc64635` fix(tmux): target correct session when spawning team panes
- `d33ecfc` fix(team): remove unused symbols flagged in PR review
- `f0cc833` fix(tmux): restore injection when scoped mode state is missing
- `baeb8e7` fix(skills): restore visual-verdict contract and ralph visual-loop guidance
- `e0c5974` fix(skills): normalize forked OMC references to OMX canonical paths

### Reverts
- `ee72e1f` Revert "fix(team): switch dedicated tmux session to opt-in with worker location hint (#432)"
- `a5f2b77` Revert "fix(skills): restore visual-verdict contract and ralph visual-loop guidance"

### Full `main..dev` commit log (`git log --reverse` history order; not strict date sort)
- `2026-02-28` `c235a5a` feat(team): add dedicated ralph auto-run cleanup policy (#407) (#412)
- `2026-02-28` `8d3fef0` fix(notifications): native OpenClaw gateway support (#414) (#415)
- `2026-03-01` `1653aa7` feat(team): add dedicated tmux session mode for worker isolation (#416)
- `2026-03-01` `0c68a02` docs: OpenClaw integration guide for notifications (#413)
- `2026-03-01` `383d79d` fix(tmux): source shell profile (.zshrc/.bashrc) for detached session launch
- `2026-03-01` `d4f6803` fix(team): revert dedicated tmux session mode, restore split-pane default
- `2026-03-01` `56091a4` ci: add CI Status gate job for branch protection (#423)
- `2026-03-01` `576ec9c` fix(ralph): exclude option values from CLI task description (#424)
- `2026-03-01` `6eed3c6` fix(notify-hook): add structured logging for visual-verdict parse/persist failures (#428)
- `2026-03-01` `b5dc657` fix(team): fix 3 regressions in team/ralph shutdown and resume paths (#430)
- `2026-03-01` `3f6b3fd` refactor(mcp): extract omx_run_team_* to dedicated team-server.ts (#431)
- `2026-03-01` `ee72e1f` Revert "fix(team): switch dedicated tmux session to opt-in with worker location hint (#432)"
- `2026-03-02` `c3d1220` fix(team): switch dedicated tmux session to opt-in with worker location hint (#432)
- `2026-03-02` `454e69d` fix(team): force cleanup on failed/cancelled runs, await worktree rollback, refresh dead-worker panes (#438)
- `2026-03-02` `c8632fa` fix(team): fix leader pane targeting in notify-hook dispatch and runtime fallback (#433, #437) (#439)
- `2026-03-01` `587ec94` fix(team): harden autoscaling pane cleanup and teardown
- `2026-03-02` `12dea24` fix(team): preserve layout during scale-up and add regression test
- `2026-03-02` `f5d47f4` fix(tmux): skip injection when pane returns to shell (#441) (#442)
- `2026-03-02` `7413fe3` feat(team): add per-worker role routing and task decomposition
- `2026-03-02` `cc64635` fix(tmux): target correct session when spawning team panes
- `2026-03-02` `d33ecfc` fix(team): remove unused symbols flagged in PR review
- `2026-03-02` `f0cc833` fix(tmux): restore injection when scoped mode state is missing
- `2026-03-02` `baeb8e7` fix(skills): restore visual-verdict contract and ralph visual-loop guidance
- `2026-03-02` `a5f2b77` Revert "fix(skills): restore visual-verdict contract and ralph visual-loop guidance"
- `2026-03-02` `6c1c4eb` docs(changelog): update unreleased notes for main...dev
- `2026-03-02` `e0c5974` fix(skills): normalize forked OMC references to OMX canonical paths

## [0.7.3] - 2026-02-28

55 files changed. Pipeline orchestrator, uninstall command, team dispatch hardening, and config idempotency.

### Added
- Configurable pipeline orchestrator with stage-based execution (ralph-verify, ralplan, team-exec) (#398).
- `omx uninstall` command with `--dry-run`, `--keep-config`, `--purge`, and `--scope` options (#389).
- Openclaw dispatcher passes originating channel context to webhook hooks (#387).

### Fixed
- CLI subcommand `--help` flag now shows help text instead of executing the command (#404).
- Team idle/dispatch detection parity between Claude and Codex workers (#402).
- Team dispatch lock timeout and binary path mismatch resolved (#401).
- Team dispatch retries on Codex trust prompt instead of rolling back (#395).
- Team dispatch draft consumption verified before marking notified (#392).
- Config generator prevents duplicate OMX blocks on repeated `omx setup` (#386).
- Team operator docs now clarify Claude-pane Enter (`C-m`) can queue while busy and document state-first/safe manual intervention guidance for `$team`.

### Changed
- Deprecated ultrapilot, pipeline, and ecomode modes (#399).
- Removed unused `DEPRECATED_MODE_MAP` from state-server.
- Updated pipeline test state file paths and regenerated catalog.
- Added links to CLI reference, notifications, and workflows in README.

## [0.7.2] - 2026-02-26

Hotfix: team shutdown `--force` flag was not being parsed from CLI arguments.

### Fixed
- Team shutdown `--force` flag now correctly parsed from CLI args instead of being hardcoded to `false` (`src/cli/team.ts`).
- Added `shutdown_gate_forced` audit event when force-bypass is used, closing an observability gap in the event log.

### Changed
- Updated usage string to document `[--force]` option: `omx team shutdown <team-name> [--force]`.
- Added `shutdown_gate_forced` to `TeamEventType` union and `TEAM_EVENT_TYPES` constant.

## [0.7.1] - 2026-02-26

4 files changed. Team dispatch reliability improvements — state-first routing with hook-preferred fallback.

### Changed
- Team dispatch rewritten to be state-first and hook-preferred, improving reliability when leader pane targeting varies (#379).
- Leader mailbox delivery uses hook-preferred dispatch path for consistent message routing (#378).

### Fixed
- Leader fallback parity guarded to only target real pane destinations, preventing dispatch to stale or missing panes (#379).
- Hook dispatch reliability paths hardened with additional error guards and fallback sequencing (#378).

## [0.7.0] - 2026-02-26

153 files changed, +12,852 / -1,044 lines. Major feature additions, comprehensive audit fixes, and hardened reliability.

### Added

#### Team & Scaling
- Dynamic team worker scaling — Phase 1 manual `scale_up` / `scale_down` mid-session (#363).
- Per-worker idle notification forwarded to leader pane (#335).
- Prompt-mode worker launch transport for interactive team workflows (#264).
- Worker model defaults resolved from config with `OMX_TEAM_WORKER_CLI_MAP` (#263).
- Worker hard cap raised to 20 (#343).
- Team shutdown gated on unresolved tasks to prevent premature teardown (#320, #322).
- MSYS2 / Git Bash tmux worker support (#266).
- Centralized team/state contracts module (`contracts.ts`) for shared type definitions (#319, #323).

#### Planning & Execution
- RALPLAN-DR structured deliberation for consensus planning — planner + architect + critic loop (#366).
- Ralplan-first execution gate enforced: ralph blocks implementation until `prd-*.md` and `test-spec-*.md` exist (#261).
- Task-size detector (`task-size-detector.ts`) for pre-execution scoping guidance with dedicated test suite.
- Keyword trigger registry (`keyword-registry.ts`) as canonical single source of truth for all 31 keyword triggers.

#### Notifications
- Full notification engine overhaul from OMC 4.5.x (#373): template engine, idle cooldown, hook-config types, session registry.
- Slack / Discord / Telegram env-var configuration via `buildConfigFromEnv()`.
- Reply listener per-channel gating and credential isolation for disabled channels.
- Skill-active lifecycle tracking in notify hook for auto-continuation (#262).
- Language reminder injection for non-Latin user input (#260).

#### OpenClaw
- OpenClaw gateway integration (`src/openclaw/`) for waking external automations and AI agents on hook events — config, dispatcher, and full test suite.

#### CLI & Setup
- Star-prompt CLI command (`star-prompt.ts`) for prompt management with test coverage.
- Setup simplified from 3 scopes to 2 (user, project) (#245).
- Setup prompts before overwriting existing AGENTS.md (#242).
- Setup `--force` overwrite controls for both agents and skills installation (#275).
- Repo name included in tmux session name for worktree launches (#360, #362).

#### MCP & Code Intelligence
- MCP bootstrap module (`bootstrap.ts`) with auto-start guards (#317).
- Memory validation layer (`memory-validation.ts`) for project memory writes.
- `includeDeclaration` honored in `lsp_find_references` (#299, #327).

#### HUD
- HUD watch render serialization to prevent overlapping writes (#274).
- Quota rendering (5-hour and weekly limit percentages) in focused preset.
- Session duration rendering (seconds / minutes / hours format).
- Last-activity rendering from hudNotify turn timestamps.

#### Infrastructure
- `tsconfig.no-unused.json` — dedicated config for unused-symbol CI gate (#312, #333).
- Session lifecycle hooks with archive and overlay strip on exit.
- Direct coverage for key production modules (#321, #324).
- Dedicated hooks coverage for extensibility dispatcher and loader (#316).

### Changed
- `KEYWORD_TRIGGERS` derived from `KEYWORD_TRIGGER_DEFINITIONS` — template and runtime registry always in sync, eliminating drift.
- Team/swarm keyword detection tightened with intent-aware matching to avoid false triggers on natural language (#292, #356).
- Ralph contract enforces lifecycle invariants and integer counters (#355).
- Ralph contract validation enforced in direct state writers (#296, #353).
- State writes are atomic and serialized via file locking (#354).
- Max-iteration termination enforced in notify hook (#345).
- Canonical targets enforced for alias/merged catalog entries (#318, #344).
- Doctor diagnostics downgrade unattributed tmux orphan warnings (#277).
- HUD delayed reconcile fallback reduced from 10s to 2s.
- Removed unused HUD color helper exports (#280).
- Removed dead TS fallback path from CLI entrypoint (#283).
- Removed production dead code and added unused-symbol CI gate (#312, #333).
- `packageRoot` made ESM-safe without `require()` (#310, #330).
- Tmux hook engine type declarations synced with runtime exports (#313, #328).

### Fixed
- **CI**: Resolved typecheck (6 unused imports) and 7 test failures — HUD NaN/future timestamp handling, state mode validation, slack config `deepStrictEqual`, keyword template-registry sync.
- **Team**: Deterministic prompt worker teardown (#349). Verification protocol wired into runtime completion gates (#298, #351). False prompt-mode resume readiness prevented (#352). Shutdown continues when resize hook unregister fails (#302, #347). Team path guards for explicit state root.
- **Ralph**: Exclusive lock checks fail on malformed state (#357). Lifecycle invariants enforced in direct state writers (#296, #353).
- **Notifications**: Reply config validates and honors enabled channels (#281, #287). Notifier HTTP status and timeout checks enforced (#286). Slack config omits `mention` property when undefined.
- **Hooks**: Plugin dispatch timeout resolution guaranteed (#269). Parent hook plugin import validation skipped correctly (#268). Keyword activation timestamp reset on skill switch (#290).
- **Setup**: Skill overwrite skipped unless `--force` (#275).
- **Code Intelligence**: AST-grep rewrites applied when `dryRun=false` (#295, #358).
- **Code Simplifier**: Untracked files included in selection (#308). CI test failures from `trim()` and `homedir()` resolved.
- **MCP**: Notepad `daysOld` bounds validated (#309, #334).
- **Config**: Windows MCP server paths escaped in `mergeConfig` (#307, #337).
- **Session**: PID-reuse false positives in stale detection fixed (#338).
- **Trace**: Memory usage on large JSONL histories fixed (#336).
- **Tmux**: Hook indices clamped to signed 32-bit range (#240, #241). HUD resize noise quieted on macOS. Signed 32-bit hook hash coercion enforced (#265).
- **Misc**: Lifecycle best-effort failure warnings surfaced (#315, #346). Notify-hook cross-worktree tests isolated from inherited team env.

### Security
- MCP `workingDirectory` handling hardened with validation and allowlist policy (#289).
- Path traversal prevention for state and team tool calls with mode allowlist enforcement.
- HUD dynamic text sanitized to prevent terminal escape injection (#271).

### Tests
- 1,472 tests across 308 suites — all passing.
- New test suites: `scaling.test.ts`, `task-size-detector.test.ts`, `session.test.ts`, `consensus-execution-handoff.test.ts`, `notify-hook-worker-idle.test.ts`, `template-engine.test.ts`, `hook-config.test.ts`, `idle-cooldown.test.ts`, `reply-config.test.ts`, `path-traversal.test.ts`, `memory-server.test.ts`, `memory-validation.test.ts`, `bootstrap.test.ts`, `code-intel-server.test.ts`, `openclaw/*.test.ts`, `star-prompt.test.ts`, `setup-agents-overwrite.test.ts`, `setup-skills-overwrite.test.ts`, `error-handling-warnings.test.ts`, `catalog-contract.test.ts`.
- Code-simplifier hook coverage made deterministic (#311, #348).
- Ralph persistence gate verification matrix in CI.

## [0.6.4] - 2026-02-24

### Fixed
- Team Claude worker startup now explicitly launches with `--dangerously-skip-permissions`, preventing interactive permission prompts during tmux team runs.

### Tests
- Added regression coverage for the worker CLI override path to ensure Claude launch args are translated correctly and Codex-only flags are not forwarded.

## [0.6.3] - 2026-02-24

### Added
- Client-attached HUD reconcile hook for detached-launch initial pane layout reconciliation.

### Fixed
- Hardened detached session resize hook flow to prevent race conditions when tmux windows drift.
- Hardened HUD/team resize reconciliation for consistent pane organization across attach/detach cycles.
- Reduced HUD delayed reconcile fallback from 10s to 2s for faster layout correction.
- Client-attached hook is now tracked and properly unregistered during rollback.

### Tests
- Added tmux session and CLI sequencing tests for resize/reconcile paths.

## [0.6.2] - 2026-02-24

### Fixed
- Team Claude worker launch now uses plain `claude` with no injected launch args, so local `settings.json` remains authoritative.
- Team startup resolution logging is now Claude-aware: Claude paths report `model=claude source=local-settings` and omit `thinking_level`.

### Changed
- Clarified docs for Team worker CLI behavior in README and `skills/team/SKILL.md` to reflect plain-Claude launch semantics.
- Added regression coverage to preserve Codex reasoning behavior while enforcing Claude no-args launch behavior.

## [0.6.1] - 2026-02-23

### Added
- Added a new "What's New in 0.6.0" section to the docs site homepage with highlights for mixed Codex/Claude teammates and reliability updates.

### Changed
- Clarified `skills/team/SKILL.md` docs that `N:agent-type` selects worker role prompts (not CLI choice), and documented `OMX_TEAM_WORKER_CLI` / `OMX_TEAM_WORKER_CLI_MAP` usage for launching Claude teammates.

## [0.6.0] - 2026-02-23

### Added
- Mixed team worker CLI routing via `OMX_TEAM_WORKER_CLI_MAP` so a single `$team` run can launch Codex and Claude workers together (e.g. `codex,codex,claude,claude`).
- Leader-side all-workers-idle nudge fallback for Claude teams, so leader notifications still fire even when worker-side Codex hooks are unavailable.
- Adaptive trigger submit retry guard helper and tests to reduce false-positive resend escalation.

### Changed
- Team trigger fallback now uses a safer ready-prompt + non-active-task gate before adaptive resend.
- Adaptive retry fallback behavior now uses clear-line + resend instead of interrupt escalation in auto mode.

### Fixed
- Pre-assigned worker tasks can now be claimed by their assigned owner in `pending` state, unblocking Codex worker bootstrap claim flow.
- `OMX_TEAM_WORKER_CLI_MAP` parsing now rejects empty entries and reports map-specific validation errors.
- `OMX_TEAM_WORKER_CLI_MAP=auto` now resolves from launch args/model detection and no longer inherits `OMX_TEAM_WORKER_CLI` overrides unexpectedly.
- Team leader nudge targeting now prioritizes `leader_pane_id`, improving reliability with mixed/Claude worker setups.

## [0.5.1] - 2026-02-23

### Added
- **Native worktree orchestration for team mode**: Workers now launch in git worktrees with canonical state-root metadata, enabling true isolation for parallel team workstreams.
- **Cross-worktree team state resolution**: MCP state tools and the notify hook resolve team state across worktrees, so the leader always sees the correct shared state regardless of which worktree a worker is running in.
- **`omx ralph` CLI subcommand**: `omx ralph "<task>"` starts a ralph persistence loop directly from the command line, removing the need to manually invoke the skill inside a session (closes #153).
- **Scoped ralph state with canonical persistence migration**: Ralph state is now scoped per session/worktree and migrated from legacy flat paths to the canonical `.omx/state/sessions/` layout automatically.
- **Claim-safe team transition tool for MCP interop**: New `team_transition_task` MCP tool applies state transitions atomically with claim-token verification, preventing race conditions between concurrent workers.
- **Clean tmux pane output before notifications**: Notification content is sanitized (ANSI escapes, tmux artifacts stripped) before being sent to notification integrations, eliminating garbled messages.
- **Startup codebase map injection hook**: Session start injects a lightweight file-tree snapshot into the agent context so workers have structural awareness of the project without extra exploration turns (closes #136).

### Changed
- **`notify-hook.js` refactored into layered sub-modules**: The monolithic hook script is split into focused modules (event routing, tmux integration, notification dispatch) for maintainability and easier extension (closes #177).
- **`ralplan` defaults to non-interactive consensus mode**: The planning loop no longer pauses for interactive prompts by default; pass `--interactive` to restore the prompt-gated flow (closes #144).
- **Removed `/research` skill**: The `$research` skill has been fully removed. Use `$scientist` for data/analysis tasks or `$external-context` for web searches (closes #148).

### Fixed

#### Security
- **Command injection in `capturePaneContent`** prevented by switching from string shell interpolation to a safe argument array (closes #156).
- **Command injection in notifier** fixed by replacing `exec` string interpolation with `execFile` + args array (closes #157).
- **Stale/reused PID risk in reply-listener**: The process-kill path now verifies process identity before sending signals, preventing an unrelated process from being killed if a PID is recycled (closes #158).
- **Path traversal in MCP state/team tool identifiers**: Tool inputs are validated and normalized to prevent `../` escapes from reaching the filesystem (closes #159).
- **Untracked files excluded from codebase map** to prevent accidental filename leakage of unintended files into agent context.

#### Team / Claim Lifecycle
- Claim lease expiry enforced in task transition and release flows — expired claims are rejected before any state mutation (closes #176).
- Duplicate `task_completed` events from `monitorTeam` eliminated; events are deduplicated at the source (closes #161).
- `claimTask` returns `task_not_found` (not a generic error) for missing task IDs, improving worker error handling (closes #167).
- Claims on already-completed or already-failed tasks are rejected upfront (closes #160).
- Ghost worker IDs (workers that no longer exist) are rejected in `claimTask` (closes #179).
- Terminal → non-terminal status regressions in `transitionTaskStatus` are blocked; once a task reaches `completed`/`failed`, its status cannot be unwound.
- In-progress claim takeover prevented when `expected_version` is omitted from the request (closes #173).
- `releaseTaskClaim` no longer reopens a terminal task — release on a completed/failed task is a no-op (closes #174).
- `task_failed` event is now emitted instead of the misleading `worker_stopped` event on task failure (closes #171).
- `team_update_task` rejects lifecycle field mutations (`status`, `claimed_by`) that arrive without a valid claim token (closes #172).
- `updateTask` payload validation added to prevent partial/corrupted task objects from being persisted (closes #163).
- `team_leader_nudge` added to the `team_append_event` MCP schema enum so the nudge event passes schema validation (closes #175).
- Canonical session names used consistently in `getTeamTmuxSessions` (closes #170).

#### Worktree / CLI
- `--worktree <name>` space-separated argument form is now consumed correctly; previously the branch name was silently dropped (closes #203).
- Orphan `--model` flag dropped from worker argv to prevent duplicate flags causing Codex CLI parse errors (closes #162).
- `spawnSync` sleep replaced with `Atomics.wait` so timing delays work reliably even when the `sleep` binary is absent (closes #164).

#### Hooks / tmux
- Copy-mode scroll and clipboard copy re-enabled in `xhigh`/`madmax` tmux sessions (closes #206).
- Thin orchestrator restored in `notify-hook.js` after refactor inadvertently removed it (closes #205).

#### Dependencies
- `ajv` pinned to `>=8.18.0` and `hono` to `>=4.11.10` via npm `overrides` to resolve transitive vulnerability advisories.

### Performance
- `listTasks` file reads parallelized with `Promise.all`, reducing task-list latency for teams with many tasks (closes #168).

## [0.5.0] - 2026-02-21

### Added
- Consolidated the prompt/skill catalog and hardened team runtime contracts after the mainline merge (PR #137).
- Added setup scope-aware install modes (`user`, `project`) with persisted scope behavior.
- Added spark worker routing via `--spark` / `--madmax-spark` so team workers can use `gpt-5.3-codex-spark` without forcing the leader model.
- Added notifier verbosity levels for CCNotifier output control.

### Changed
- Updated setup and docs references to match the consolidated catalog and current supported prompt/skill surfaces.

### Fixed
- Hardened tmux runtime behavior, including pane targeting and input submission reliability.
- Hardened tmux pane capture input handling (post-review fix).
- Removed stale references to removed `scientist` prompt and `pipeline` skill (post-review fix).

### Removed
- Removed deprecated prompts: `deep-executor`, `scientist`.
- Removed deprecated skills: `deepinit`, `learn-about-omx`, `learner`, `pipeline`, `project-session-manager`, `psm`, `release`, `ultrapilot`, `writer-memory`.

## [0.4.4] - 2026-02-19

### Added
- Added code-simplifier stop hook for automatic refactoring.
- Registered OMX agents as Codex native multi-agent agent roles.

### Fixed
- Fixed team mode notification spam with runtime tests.
- Removed deprecated `collab` flag from generated config.
- Fixed tmux session name handling.

## [0.4.2] - 2026-02-18

### Added
- Added broader auto-nudge stall detection patterns (for example: "next I can", "say go", and "keep driving") with a focused last-lines hot zone.
- Added worker-idle aggregation notifications so team leaders are alerted when all workers are idle/done (with cooldown and event logging).
- Added automatic tmux mouse scrolling for team sessions (opt-out via `OMX_TEAM_MOUSE=0`).

### Fixed
- Fixed worker message submission reliability by adding settle/delay timing before and during submit key rounds.
- Fixed CLI exit behavior by awaiting `main(...)` in `bin/omx.js` so `/exit` terminates cleanly.
- Replaced deprecated `collab` feature references with `multi_agent` across generator logic, docs, and tests.

### Tests
- Added coverage for `all workers idle` notify-hook behavior and expanded auto-nudge pattern tests.
- Added new unit suites for hook extensibility runtime, HUD rendering/types/colors, verifier, and utility helpers.
- Added tests for tmux mouse-mode enablement behavior.

## [0.4.0] - 2026-02-17

### Added
- Added hook extensibility runtime with CLI integration.
- Added example-event test coverage for hook extensions.

### Fixed
- Standardized tmux `send-keys` submission to `C-m` across the codebase.

## [0.3.9] - 2026-02-15

### Changed
- Updated planner handoff guidance to use actionable `$ralph` / `$team` commands instead of the removed `/oh-my-codex:start-work` command.
- Updated team skill docs to describe team-scoped `worker-agents.md` composition (no project `AGENTS.md` mutation).

### Fixed
- Preserved and restored pre-existing `OMX_MODEL_INSTRUCTIONS_FILE` values during team start rollback/shutdown to avoid clobbering leader config.

## [0.3.8] - 2026-02-15

### Fixed
- Fixed `omx` not launching tmux session when run outside of tmux (regression in 0.3.7).

## [0.3.7] - 2026-02-15

### Added
- Added guidance schema documentation for AGENTS surfaces in `docs/guidance-schema.md`.
- Added stronger overlay safety coverage for worker/runtime AGENTS marker interactions.
- Added broader hook and worker bootstrap test coverage for session-scoped behavior.

### Changed
- Defaulted low-complexity team workers to `gpt-5.3-codex-spark`.
- Improved `omx` CLI behavior for session-scoped `model_instructions_file` handling.
- Hardened worker bootstrap/orchestrator guidance flow and executor prompt migration.
- Improved HUD pane dedupe and `--help` launch behavior in tmux workflows.

### Fixed
- Fixed noisy git-branch detection behavior in non-git directories for HUD state tests.
- Fixed merge-order risk by integrating overlapping PR branches conservatively into `dev`.

## [0.2.2] - 2026-02-13

### Added
- Added pane-canonical tmux hook routing tests for heal/fallback behavior.
- Added shared mode runtime context wrapper to capture mode tmux pane metadata.
- Added tmux session name generation in `omx-<directory>-<branch>-<sessionid>` format.

### Changed
- Switched tmux hook targeting to pane-canonical behavior with migration from legacy session targets.
- Improved tmux key injection reliability by sending both `C-m` and `Enter` submit keys.
- Updated `tmux-hook` CLI status output to focus on pane tracking with legacy session visibility.
- Bumped package version to `0.2.2`.
