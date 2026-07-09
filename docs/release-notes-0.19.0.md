# oh-my-codex 0.19.0 release notes

`0.19.0` is a reliability and safety-hardening release after `0.18.17`. It preserves the existing CLI/package/plugin contract while locking down planning-gate and handoff-artifact execution transports, hardening the conductor contract and typed subagent/lane provenance, tightening Ralplan consensus/terminal-state handling, fixing madmax worktree and resume paths, and eliminating a long-standing parallel-test flake in the Rust suite.

## Highlights

- Lock down planning-gate and handoff-artifact execution transports (`.omx/tmp` artifacts, same-command handoff scripts, planning-guard Python/read-only-Bash writes) while still allowing legitimate deep-interview→ralplan artifact handoff.
- Harden the conductor contract, typed subagent provenance, typed-lane fences, shell-guard target parsing, and conductor reuse ledger.
- Tighten Ralplan consensus review evidence, terminal closeout state writes, and heredoc redirect scanning.
- Fix Autopilot ralplan handoff, madmax worktree runtime roots, and madmax resume plugin cache preflight.
- Render superseded Ultragoal goals correctly in the HUD.
- Eliminate the intermittent Rust sparkshell test flake by making `unique_temp_dir()` collision-proof under parallel same-process execution.

## Compatibility

No breaking CLI, package, plugin-layout, or configuration changes are intended.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.19.0.md`.

Release-prep gates include version sync for `v0.19.0`, TS build, native-agent verification, plugin mirror/bundle checks, catalog docs check, the full Rust workspace test suite (rerun repeatedly to prove the flake fix), the full node test suite, and `npm pack --dry-run`. Branch CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm publication proof are appended to readiness evidence after publication.

## Full changelog

[`v0.18.17...v0.19.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.17...v0.19.0)
