# oh-my-codex 0.21.24

`0.21.24` is a patch release for setup plugin-cache repair hardening (9 commits, 5 files, +365/−28; PRs #3851, #3852, #3853, #3854).

## Highlights

- **Repair safety hardening (#3851, #3853, #3854):** The setup repair command now enforces stricter requirements on plugin cache removal, preventing false-safe recommendations for live-pinned or unverified caches:
  1. Mandatory `removalSafe` field validation in dry-run mode, failing closed when safety cannot be verified.
  2. `removalSafe` derived only from verified managed+unpinned cache eligibility.
  3. Idempotent dry-run behavior returning `unchanged` for identical caches, matching actual repair behavior. Authored by @Yeachan-Heo.

- **Late-pin scenario test coverage (#3849):** Comprehensive removalSafe field tests validate hardening logic against edge cases in pinned-cache handling. Authored by @Yeachan-Heo.

- **Session state gitignore (#3852):** The .gitignore now excludes gjc runtime session state to reduce noise in untracked-file listings. Authored by @Yeachan-Heo.

## Compatibility

- `omx setup --plugin --repair-plugin-cache` behavior is unchanged for valid recovery scenarios; only safety validation and edge-case guidance is improved.
- Existing task records, plugin configurations, and DAG flags remain compatible.

## Validation

- Pinned candidate `e5370084006560eb76df4c79aeecf50e4a3f90f0` passed latest-per-name dev CI: 17 checks succeeded and 8 conditional checks were skipped, with no failures.
- Release branch CI passed with all required checks green.
- All code review findings addressed.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3851](https://github.com/Yeachan-Heo/oh-my-codex/pull/3851) | @Yeachan-Heo | fix(setup): require removalSafe and fail closed in dry-run repair |
| [#3852](https://github.com/Yeachan-Heo/oh-my-codex/pull/3852) | @Yeachan-Heo | chore: ignore gjc runtime session state |
| [#3853](https://github.com/Yeachan-Heo/oh-my-codex/pull/3853) | @Yeachan-Heo | fix(setup): derive removalSafe only from verified repair eligibility |
| [#3854](https://github.com/Yeachan-Heo/oh-my-codex/pull/3854) | @Yeachan-Heo | fix(setup): keep identical caches unchanged in repair dry-runs |
| [#3849](https://github.com/Yeachan-Heo/oh-my-codex/pull/3849) | @Yeachan-Heo | test(setup): add comprehensive removalSafe field tests for late-pin scenarios |

## Contributors

Thanks to @Yeachan-Heo for the setup repair hardening and test coverage improvements.

**Full Changelog**: [`v0.21.23...v0.21.24`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.23...v0.21.24)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
