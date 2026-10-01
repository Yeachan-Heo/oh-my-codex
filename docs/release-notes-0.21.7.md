# oh-my-codex 0.21.7

`0.21.7` is a correctness and robustness release for the frozen range `v0.21.6..38d27ed752d17f18690c43a2acc0f28c7a0e81ed` (49 commits, 102 files, +7246/−642): plugin integrity and template validation, HUD idle CPU optimization and correctness, Team runtime robustness, session management fixes, model catalog expansion, and dependency updates.

## Highlights

- **Plugin skill contract resolution and template validation (#3707, #3708):** plugin skill links now resolve correctly inside the plugin snapshot context, and templates/AGENTS.md is validated in cache provenance checks to prevent corruption.
- **Hook trust preservation during legacy migration (#3704):** foreign hook trust is maintained when upgrading from legacy hook configurations to current native implementations.
- **HUD idle CPU correctness (#3706, #3711):** hook metadata is kept atomic, idle reconciliation CPU storms are eliminated, native fixtures align with authority frames, and tmux probe errors are properly preserved.
- **Team runtime and setup robustness (#3692, #3699, #3700):** queued leader notices remain safe after shutdown, and non-Team guidance is preserved when Team is disabled.
- **Model catalog expansion (#3701, #3716):** GPT-6 Sol and Luna models are recognized, and gpt-6.1-sol is added to model catalogs.

## Fixes and compatibility

- **Plugin system hardening:** validate templates directory structure and AGENTS.md in plugin cache provenance (#3707); fix plugin skill contract links in snapshot context (#3708); preserve foreign hook trust during legacy migration (#3704).
- **HUD and tmux stability:** keep hook metadata atomic and verify idle CPU (#3706); eliminate idle reconciliation CPU storms (#3706); handle tmux question probe errors correctly (#3711); align native hook fixtures with authority frames (#3706).
- **Session management:** native `$ralplan --advisory` resolves thread identity from `session_id` when the hook payload carries no thread field (#3721, #3722); distinguish matching-but-unverified selectors in identity-indeterminate bindings (#3725, #3726); include stderr summary and exit status in detached leader failures (#3723, #3727); deliver exec follow-ups in session-scoped Stop path (#3724, #3728); prevent omx exec --help from attempting session establishment with an active owner (#3731, #3732); add 'ultragoal' to supported state read modes (#3733, #3734).
- **Team runtime:** make queued leader notices safe after shutdown (#3692); preserve non-Team guidance when Team is disabled (#3699, #3700); Team worker instructions are written to a per-worker file passed via `OMX_MODEL_INSTRUCTIONS_FILE`, so they are no longer committed into the leader's `AGENTS.md` (#3717, #3718); `omx setup` no longer writes Codex's removed `features.child_agents_md` flag and strips existing copies (#3719, #3720).
- **Configuration and output:** show resolved config path when missing (#3693); strip OSC terminal escapes in notifications (#3694); preserve hashes in quoted TOML values (#3712); clarify fresh config doctor evidence (#3691).
- **Model support:** recognize GPT-6 Sol and Luna (#3701); add gpt-6.1-sol to model catalogs (#3716).
- **Dependency updates:** `zod` 4.6.5, `@biomejs/biome` 2.5.14, `@types/node` 26.6.3, `@modelcontextprotocol/sdk` 1.30.1 (#3696, #3697, #3698, #3713, #3714).

## Validation evidence

Exact frozen candidate `38d27ed752d17f18690c43a2acc0f28c7a0e81ed` will be fully verified on `dev` CI before promotion. All changes were verified for correctness and integration through development commits, with post-merge validation on release CI before publication.

Full readiness evidence: `docs/qa/release-readiness-0.21.7.md`.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@lee3Q](https://github.com/lee3Q), [@NagyVikt](https://github.com/NagyVikt), [@ev78394](https://github.com/ev78394), [@hiSandog](https://github.com/hiSandog), [@TwegZhang](https://github.com/TwegZhang), [@Xrondev](https://github.com/Xrondev), and [@gaebal-gajae](https://github.com/gaebal-gajae), with dependency updates from Dependabot.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.7/inventory.md`.

**Full Changelog**: [`v0.21.6...v0.21.7`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.6...v0.21.7)
