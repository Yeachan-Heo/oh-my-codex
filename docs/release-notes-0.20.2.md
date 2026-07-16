# oh-my-codex 0.20.2 release notes

Release date: 2026-07-16

`0.20.2` is a patch release covering the exact frozen range `v0.20.1..f5e4753135ebc86342e7353300ac3ec5d9ae3d8d`. It contains 20 merged PRs, one release-development preparation commit, and the branch-plus-merge commits for #3129 release collateral.

## Highlights

- **Authenticated Ralplan bootstrap** — a fresh authenticated App leader can write Ralplan role intent during its first turn. Durable leader attestation, atomic tracker-locked intent publication, single-flight behavior, restart recovery, and subagent/provenance exclusion fail closed on ambiguity (#3184; issue #3181).
- **Native subagents and hooks** — App `spawn_agent` routing follows a surface-aware role contract; adapted-role tracker evidence and routing markers bind transactionally, recover after crashes, and clean abandoned cross-process lock artifacts (#3152, #3166; issue #3118). Recognized native children can stop without an auto-nudge (#3180).
- **Provenance and notification correctness** — prompt session provenance is isolated between concurrent chats, fallback notification delivery deduplicates across processes, and canonical Ralplan ownership refuses ambiguous session aliases (#3168, #3165, #3158).
- **Setup, Team, and state safety** — setup persists explicit root-local `AGENTS.md` merge policy, Team validates and honors explicit worker policy before tmux startup, and foreign stale transition mirrors cannot alter current workflow state (#3164, #3136, #3172).

## Other fixes

- Workflow activation requires an explicit prompt-leading invocation, preventing accidental activation from quoted, negated, documented, malformed, fenced, or otherwise non-invocation text (#3140; issue #3133).
- Authenticated deep-interview terminal-state writes are accepted (#3179); foreign Codex hook coordinates remain preserved during setup/refresh/doctor/uninstall (#3151); BOM-prefixed state input is accepted (#3169); and detached panes retain tmux-owned terminal environment values (#3183; issue #3175).

## Dependencies and release collateral

- `actions/setup-node` changed from 6 to 7 (#3154), TypeScript from 6.0.3 to 7.0.2 (#3155), `@types/node` from 26.1.0 to 26.1.1 (#3156), and `@biomejs/biome` from 2.5.2 to 2.5.3 (#3157).
- #3129 reconciled 0.20.1 post-publish evidence. Both its direct branch commit and merge commit are included for complete range accounting but are not 0.20.2 product headlines. The version-development commit is likewise release preparation only.

## Range inventory

| Commit | Classification | Summary |
|---|---|---|
| `c628486896ffa8b9188335b91a76192571e32c9d` | Direct branch commit for PR #3129; release collateral | Reconciled 0.20.1 evidence. |
| `fce27bfd6c17c7665a6f1505b6b8384cc2c8edd5` | Merge commit for PR #3129; release collateral | Promoted the 0.20.1 post-publish evidence reconciliation. |
| `29bdeb5c5670c133d9f2feda7512ee01e80a63d5` | Direct commit; release preparation | Started 0.20.2 development and synchronized version metadata. |
| `93eda27d9ec2a52ba0f563f75073c248357ad0c8` | PR #3136 | Validated and honored explicit Team worker policy before tmux startup. |
| `2a633a3939e63be2d356dd65016890bb7b0995ea` | PR #3158 | Kept Ralplan terminal state on the canonical session and rejected ambiguous aliases. |
| `90601c96fca7a69bd65c25e0b66316e188672eb0` | PR #3155; dependency | Bumped TypeScript 6.0.3 → 7.0.2. |
| `c5f03c3498186bee4d6a97099a43435889ede428` | PR #3154; dependency | Bumped `actions/setup-node` 6 → 7. |
| `d6e0349f5aed7ce4702c6c1dbb22190f16862fdf` | PR #3157; dependency | Bumped `@biomejs/biome` 2.5.2 → 2.5.3. |
| `9f4f8f09bd2f098c4cbe56ae4798dfbfb7085666` | PR #3156; dependency | Bumped `@types/node` 26.1.0 → 26.1.1. |
| `24a991d6bbe3b7e02eac3fb947d8f585d19aeac8` | PR #3164; issue #3163 | Persisted explicit `AGENTS.md` merge policy across setup refreshes. |
| `e87d05a8037c9a6fef32b2a1aee307d57383e75c` | PR #3165; issue #3162 | Deduplicated fallback notification delivery across processes. |
| `bb37005b4a0a4b12c8b6d48db6fc704debb9506f` | PR #3152; issue #3118 | Added surface-aware App native-subagent role contract. |
| `e6b0509533039e4467f53699b7ad4e74492e7f59` | PR #3168 | Isolated prompt session provenance across concurrent chats. |
| `e8e9467804a73cba0c982b3ed99a0ce8b6843d2c` | PR #3169 | Accepted BOM-prefixed state input files. |
| `4e57bf33bf97e0c03c6ecf57ba4b504b633df33d` | PR #3172 | Ignored foreign stale workflow-transition mirrors. |
| `91289b2eedb2d3eea77e23e0411137d4a7bb418f` | PR #3151 | Preserved foreign Codex hook coordinates. |
| `8a997dc0bcdb6820e24f967f33867887ede38322` | PR #3166; issue #3118 | Made adapted tracker/marker binding transactional and cleaned lock artifacts. |
| `3532caacbe3e24e2c529709b806b6d200766ac85` | PR #3179; issue #3177 | Allowed authenticated deep-interview terminal-state writes. |
| `1ee7fb6b022a049ec08eb40d31e792c125124768` | PR #3140; issue #3133 | Required explicit workflow invocation. |
| `69707f9cd6791b19d955b96a5dd91a48557e83e9` | PR #3180 | Let native subagents stop without auto-nudge. |
| `ce358f99c0ec54b96dbf5adcededb11620e42b24` | PR #3183; issue #3175 | Preserved tmux-owned detached-pane environment. |
| `f5e4753135ebc86342e7353300ac3ec5d9ae3d8d` | PR #3184; issue #3181; frozen base | Added authenticated in-turn leader bootstrap for App Ralplan role intent. |

All 22 commits in the range are represented above. Exactly 20 merged PRs are in scope: #3129, #3136, #3140, #3151, #3152, #3154, #3155, #3156, #3157, #3158, #3164, #3165, #3166, #3168, #3169, #3172, #3179, #3180, #3183, and #3184. Issues #3118, #3133, #3162, #3163, #3175, #3177, and #3181 are associated issues, not additional PRs.

## Compatibility

This patch release has no intentional breaking CLI or package-layout changes.

## Validation status

Local build, lint, typecheck, full Node/Rust tests, packed-install smoke, independent review, `dev` and `main` candidate CI, all seven native builds, native-asset verification, GitHub release publication, npm provenance publication, and isolated public-registry install/CLI boot passed for the shipped candidate. The packed smoke used the exact Codex CLI 0.142.5 boundary. Full evidence is recorded in `docs/qa/release-readiness-0.20.2.md`.

## Contributors

Commit evidence identifies Bellman (@Yeachan-Heo), @cristph, @terwox, and @dependabot[bot].

## Full changelog

[`v0.20.1...v0.20.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.1...v0.20.2)
