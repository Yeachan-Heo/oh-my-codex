# oh-my-codex 0.21.7

`0.21.7` is a correctness and robustness release for the frozen range `v0.21.6..dev` (49 commits, 102 files, +7246/−642): plugin integrity and template validation, HUD idle CPU optimization and correctness, Team runtime robustness, session management fixes, model catalog expansion, and dependency updates.

## Highlights

- **Plugin skill contract resolution and template validation:** plugin skill links now resolve correctly inside the plugin snapshot context (#3708), and templates/AGENTS.md is validated in cache provenance checks to prevent corruption (#3707). Foreign hook trust is maintained during legacy hook migration (#3704).
- **HUD idle CPU correctness:** hook metadata is kept atomic (#3706), idle reconciliation CPU storms are eliminated, native fixtures align with authority frames (#3706), and tmux probe errors are properly preserved (#3711).
- **Team runtime and setup robustness:** queued leader notices remain safe after shutdown (#3692), and non-Team guidance is preserved when Team is disabled (#3699, #3700).
- **Session management fixes:** session identity binding is corrected (#3725, #3726), stderr summary is included in detached leader failures (#3727), and exec follow-ups are delivered in scoped Stop paths (#3728).
- **Model catalog expansion:** GPT-6 Sol and Luna models are recognized (#3701), and gpt-6.1-sol is added to model catalogs (#3716).

## Fixes and compatibility

- Plugin system hardening: validate templates directory structure and AGENTS.md in plugin cache provenance (#3707); fix plugin skill contract links in snapshot context (#3708); preserve foreign hook trust during legacy migration (#3704).
- HUD and tmux stability: keep hook metadata atomic and verify idle CPU (#3706); eliminate idle reconciliation CPU storms; align native hook fixtures with authority frames (#3706); handle tmux question probe errors correctly (#3711).
- Session management: native `$ralplan --advisory` resolves thread identity from `session_id` when the hook payload carries no thread field (#3721, #3722); distinguish matching-but-unverified selectors in identity-indeterminate bindings (#3725, #3726); include stderr summary and exit status in detached leader failures (#3723, #3727); deliver exec follow-ups in session-scoped Stop path (#3724, #3728); prevent omx exec --help from attempting session establishment with an active owner (#3731, #3732); add 'ultragoal' to supported state read modes (#3733, #3734).
- Team runtime: make queued leader notices safe after shutdown (#3692); preserve non-Team guidance when Team is disabled (#3699, #3700).
- Configuration and output: show resolved config path when missing (#3693); strip OSC terminal escapes in notifications (#3694); preserve hashes in quoted TOML values (#3712); clarify fresh config doctor evidence (#3691).
- Dependency updates: `zod` 4.6.5, `@biomejs/biome` 2.5.14, `@types/node` 26.6.3, `@modelcontextprotocol/sdk` 1.30.1 (#3696, #3697, #3698, #3713, #3714).

## Validation evidence

Frozen candidate verified with all core gates passing: TypeScript typecheck (tsc --noEmit), Biome lint (860 files, no issues), plugin mirror sync verification (24 directories), capabilities lock validation, prompt guidance verification, native agents verification (18 agents, 32 assets), and prompt inventory synchronization. All 49 commits in the range are verified present with clear user-visible changes.

Full readiness evidence: `docs/qa/release-readiness-0.21.7.md`.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@lee3Q](https://github.com/lee3Q), [@NagyVikt](https://github.com/NagyVikt), [@ev78394](https://github.com/ev78394), [@hiSandog](https://github.com/hiSandog), [@TwegZhang](https://github.com/TwegZhang), [@Xrondev](https://github.com/Xrondev), and [@gaebal-gajae](https://github.com/gaebal-gajae), with dependency updates from Dependabot.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.7/inventory.md`.

**Full Changelog**: [`v0.21.6...v0.21.7`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.6...v0.21.7)
