# oh-my-codex 0.21.24

`0.21.24` is a patch release for setup plugin-cache repair hardening (9 commits, 5 files, +365/−28; PRs #3851, #3852, #3853, #3854, plus test additions in #3849).

Versioning continues the 0.21.x patch train. This release strengthens the setup repair command by hardening the `removalSafe` field derivation logic, enforcing fail-closed behavior in dry-run mode, and ensuring repair idempotency.

## Highlights

- **Repair safety hardening (#3851, #3853, #3854):** The setup repair command now enforces stricter requirements on plugin cache removal. The three-part hardening improves:
  1. Mandatory `removalSafe` field validation: Dry-run repair now requires explicit determination of safe removal eligibility before advising users; recommendations fail closed when safety cannot be verified (#3851).
  2. Verified eligibility derivation: `removalSafe` is computed only from caches verified as both managed and unpinned, preventing false-safe recommendations for live-pinned or unverified entries (#3853).
  3. Idempotent dry-run behavior: Running repair dry-run on an identical cache now returns `unchanged` status, matching the behavior of actual repair runs and improving test predictability (#3854).
  Authored by @Yeachan-Heo.

- **Test coverage for late-pin scenarios (#3849):** Comprehensive removalSafe field tests validate the hardening logic against edge cases in pinned-cache handling, ensuring repair recommendations remain fail-closed when plugin caches change during the inspection window. Authored by @Yeachan-Heo.

- **Session state gitignore (#3852):** The .gitignore now excludes gjc runtime session state artifacts, reducing noise in untracked-file listings and keeping the repository clean during interactive development. Authored by @Yeachan-Heo.

## Compatibility

- `omx setup --plugin --repair-plugin-cache` behavior is unchanged for valid recovery scenarios; the hardening only affects safety validation and edge-case guidance.
- Existing task records and plugin configurations remain compatible.
- Test changes do not impact runtime behavior.

## Known gaps

- None. All findings from prior releases remain documented in their respective release-readiness files.

## Validation evidence

The pinned candidate `e5370084006560eb76df4c79aeecf50e4a3f90f0` passed latest-per-name dev CI: 17 checks succeeded with 8 conditional checks skipped, and no failures.

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
