# oh-my-codex 0.20.2

`0.20.2` is a patch release for the reliability and workflow-safety work in the exact range `v0.20.1..f5e4753135ebc86342e7353300ac3ec5d9ae3d8d`.

## Highlights

- Authenticated fresh App leaders can bootstrap Ralplan role intent in-turn through durable, fail-closed leader attestation and atomic recovery (#3184; issue #3181).
- Native `spawn_agent` role routing is surface-aware; adapted-role tracker/marker binding is transactional, recoverable, and protected by cross-process lock cleanup (#3152, #3166; issue #3118). Native subagents can stop without a generic auto-nudge (#3180).
- Prompt/session provenance is isolated across concurrent chats, fallback notifications are deduplicated across processes, and canonical Ralplan state rejects ambiguous session aliases (#3168, #3165, #3158).
- Setup preserves explicit `AGENTS.md` merge policy, Team honors an explicit worker policy, and stale foreign state-transition mirrors are ignored (#3164, #3136, #3172).

## Additional fixes

- Explicit prompt-leading workflow invocation prevents accidental activation from quoted, negated, documented, malformed, or other non-invocation mentions (#3140; issue #3133).
- Authenticated deep-interview terminal state writes succeed (#3179); foreign Codex hook coordinates are preserved (#3151); BOM-prefixed state input is accepted (#3169); and detached panes retain tmux-owned terminal environment values (#3183; issue #3175).

## Dependencies and release collateral

- Updated `actions/setup-node` 6 → 7 (#3154), TypeScript 6.0.3 → 7.0.2 (#3155), `@types/node` 26.1.0 → 26.1.1 (#3156), and `@biomejs/biome` 2.5.2 → 2.5.3 (#3157).
- #3129 reconciled 0.20.1 post-publish evidence; its direct branch commit and merge commit are release-collateral-only. `29bdeb5c5670c133d9f2feda7512ee01e80a63d5` is the version-development preparation commit.

## Merged PRs since v0.20.1

#3129, #3136, #3140, #3151, #3152, #3154, #3155, #3156, #3157, #3158, #3164, #3165, #3166, #3168, #3169, #3172, #3179, #3180, #3183, #3184. Issues #3118, #3133, #3162, #3163, #3175, #3177, and #3181 are associated issues, not additional PRs.

## Compatibility

Patch release with no intentional breaking CLI or package-layout changes.

## Validation

Local build, lint, typecheck, full Node/Rust tests, packed-install smoke, independent review, `dev` and `main` candidate CI, all seven native builds, native-asset verification, GitHub release publication, npm provenance publication, and isolated public-registry install/CLI boot passed for the shipped candidate. The packed smoke used the exact Codex CLI 0.142.5 boundary. Full evidence is recorded in `docs/qa/release-readiness-0.20.2.md`.

## Contributors

Thanks to Bellman (@Yeachan-Heo), @cristph, @terwox, and @dependabot[bot] for commits in this range.

**Full Changelog**: [`v0.20.1...v0.20.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.1...v0.20.2)
