# oh-my-codex v0.15.3

## Summary

`0.15.3` is a patch release for the `0.15.x` train focused on Team/ralph runtime reliability, approved-handoff safety, startup/session isolation, plugin/setup guardrails, and native release readiness. It promotes the CI-green `dev` line after validating the 0.15.3 package/native version sync and release gates.

## Highlights

- **Safer Team runtime startup and shutdown** — fixes stale team-worker Stop task blocking, prompt-worker startup death handling, same-cwd session isolation, live-session teardown from detached tmux postLaunch, ready-prompt startup evidence, tmux extended-key fallback, runtime role propagation, launch inheritance, and portable launch instructions.
- **Approved handoff and pipeline validation** — validates team handoff paths against approved artifacts, normalizes equivalent/absolute paths, preserves backslashes and quoted handoff tasks, derives team-exec tasks from approved handoffs, and retains approved execution context narrowly.
- **Planning and Ralph lifecycle hardening** — timestamps canonical handoff artifacts, exact-matches approved launch hints, scopes Ralph Stop to the owning session, and prevents stale `skill-active` Stop blocking after ralplan completion.
- **Setup, plugin, and config reliability** — avoids duplicate generated AGENTS instructions, preserves TOML env entries during schema migration, avoids invalid Codex config environment tables, detects mirror CLI calls in spaced paths, and fixes project Codex NUX config pollution.
- **Operational polish and release gates** — keeps OMX MCP serve alive, reduces Team startup assignment latency, makes HUD watch coalescing deterministic, adds oversized `gpt-5.5` context warnings, guides ai-slop-cleaner fallback cleanup, and hardens the 0.15.3 release gates.

## Merged PRs

- #2004 — [codex] Fix Codex config env schema warning (@sean2077)
- #2021 — Warn for oversized gpt-5.5 context settings (@Yeachan-Heo)
- #2024 — Fix Ralph Stop session ownership leak (@Yeachan-Heo)
- #2026 — Avoid duplicate generated AGENTS instructions (@Yeachan-Heo)
- #2029 — Guard sloppy fallback PreToolUse framing (@Yeachan-Heo)
- #2031 — Fix detached tmux postLaunch tearing down live OMX sessions (@chenjiayi8)
- #2032 — Reduce team startup assignment latency after pane split (@HaD0Yun)
- #2034 — Fix project Codex NUX config pollution (@Yeachan-Heo)
- #2036 — Fix tmux extended-keys fallback on older tmux (@Yeachan-Heo)
- #2037 — fix(plugin): detect mirror CLI calls in spaced paths (@lkraider)
- #2038 — test(codex-home): isolate ambient defaults in env-sensitive suites (@lkraider)
- #2040 — Preserve approved execution handoff context (@Yeachan-Heo)
- #2041 — Fix prompt worker startup death handling (@Yeachan-Heo)
- #2042 — fix(team): treat ready prompts as startup evidence (@lkraider)
- #2043 — Fix flaky HUD watch coalescing test (@Yeachan-Heo)
- #2044 — Keep OMX MCP serve process alive (@pgagarinov)
- #2045 — fix(planning): exact-match approved launch hint selection (@lkraider)
- #2046 — fix(team): make runtime launch instruction portable (@lkraider)
- #2047 — feat(planning): timestamp canonical handoff artifacts (@lkraider)
- #2049 — fix(pipeline): validate approved team handoff path (@lkraider)
- #2050 — Fix same-cwd team session isolation (@HaD0Yun)
- #2053 — Fix stale skill-active Stop blocking after ralplan completion (@Yeachan-Heo)
- #2063 — Guide ai-slop-cleaner through fallback cleanup (@Yeachan-Heo)
- #2064 — Fix stale team-worker Stop task blocks (@HaD0Yun)

## Verification

- Dev CI run `25250185636` passed on commit `4d588c11a185c2e4fede0fc1b242436bab29ce5c` before main promotion.
- Local release readiness before promotion: `git diff --check main`, `npm run lint`, `npm run check:no-unused`, `npm test` (4437/4437), and `npm pack --dry-run` for `oh-my-codex-0.15.3.tgz`.
- Release workflow re-verifies package/workspace/tag version sync, builds native assets, smoke-verifies packed install, and publishes npm only after those gates pass.

## Upgrade notes

- This patch is intended to be backward-compatible for existing `0.15.x` users.
- Operators using Team/ralph runtime workflows should see fewer stale Stop blocks, safer same-cwd isolation, and more reliable startup/death detection.
- The release tag must match `package.json`/Cargo workspace version `v0.15.3`; the release workflow rejects mismatches before publishing.

## Contributors

Thanks to @HaD0Yun, @Yeachan-Heo, @chenjiayi8, @lkraider, @pgagarinov, and @sean2077 for contributing to this release.

**Full Changelog**: [`v0.15.2...v0.15.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.15.2...v0.15.3)
