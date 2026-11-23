# oh-my-codex 0.21.31

`0.21.31` is a patch release for setup symlink safety and dispatch read reliability (PRs #3881, #3883).

Versioning continues the 0.21.x patch train. This release improves setup robustness by refusing symlinked managed destinations and fixes dispatch read failures in team delivery.

## Highlights

- **Unified setup symlink guard (#3887):** Consolidated all symlink validation into a single authoritative helper `assertManagedDestination`. The guard validates ALL managed writes BEFORE reading/comparing contents and BEFORE mkdir operations, addressing Codex findings 4351464979, 4351464989, 4351560207, 4351560219. Validates scope root boundaries correctly, respects CODEX_HOME environment variable, and allows OS-level symlinks in scope ancestors (e.g., /tmp on macOS). This is a security and correctness improvement that makes setup fail fast on invalid configurations.
- **Setup symlink destination refusal (#3881):** The `omx setup` command now detects and rejects symlinked managed destinations (including dangling links) before reading, backing up, or writing. This prevents scenarios where a committed `.gitignore` or prompt path symlink could cause `ensureBackup` to overwrite files outside the repository. The check validates every path component without following symlinks, not just the leaf destination, preventing writes through symlinked ancestor directories. The check is applied to all write paths: `.gitignore`, native agent TOMLs and manifest, HUD config, and skill receipt. This is a behavioral change: setup now fails closed on symlinked managed destinations.
- **Fix dispatch read failures (#3883):** Improve state machine transitions in team delivery to handle read failures correctly. Correct test hook timing to run after mailbox discovery instead of before, ensuring comprehensive test coverage of dispatch race conditions.

## Compatibility

- No breaking API changes; setup security improvement only.
- Existing sessions remain unaffected unless they have symlinked managed destinations (which will now be rejected with a clear error message and workarounds).
- Setup now fails fast on symlinked destinations instead of silently writing through them.

## Known gaps

None. All Codex findings for this release have been addressed:
- **4350822390** - Test fixture updated to use managed path ✓ Fixed
- **4350822403** - Release-readiness doc pinned to final candidate ✓ Fixed
- **4351464979** - Validation before filesDiffer ✓ Fixed
- **4351464989** - Validation before readFile ✓ Fixed
- **4351560195** - CODEX_HOME handling ✓ Fixed
- **4351560207** - Validation before compare ✓ Fixed
- **4351560219** - Validation before mkdir ✓ Fixed

## Validation evidence

The pinned candidate (release branch HEAD with unified guard and dispatch fix merged) passed all local gates:
- `npm run build` ✓
- `npm run check:no-unused` ✓
- `npm run lint` ✓
- Setup symlink tests (6 tests) ✓

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3887](https://github.com/Yeachan-Heo/oh-my-codex/pull/3887) | @gajae-gajae | refactor(setup): unified assertManagedDestination symlink guard |
| [#3883](https://github.com/Yeachan-Heo/oh-my-codex/pull/3883) | @shenyankm | Fix dispatch read failure and test hook timing issues |
| [#3881](https://github.com/Yeachan-Heo/oh-my-codex/pull/3881) | @shenyankm | fix(setup): refuse symlinked managed destinations |

## Contributors

Thanks to @shenyankm for the setup symlink safety and dispatch read reliability improvements, @gajae-gajae for the unified symlink guard refactoring, and @Claude Code for co-authorship.

**Full Changelog**: [`v0.21.30...v0.21.31`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.30...v0.21.31)
