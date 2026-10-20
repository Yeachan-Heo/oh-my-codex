# oh-my-codex 0.21.27

`0.21.27` is a patch release for subagents tri-state resume_agent availability hardening (3 commits, 10 files, +317/−30; PRs #3867, #3868).

Versioning continues the 0.21.x patch train. This release improves subagent recovery guidance by distinguishing between hosts where the `resume_agent` tool is absent (unsupported environments) and transient unavailability (tool not yet available or unknown state).

## Highlights

- **SessionStart reopen guidance for hosts without resume_agent (#3867):** The subagent recovery system now covers hosts that do not support the `resume_agent` tool, providing accurate fallback instructions instead of treating absence as unknown availability. SessionStart recovery guidance now correctly identifies unsupported hosts and recommends appropriate fallback actions.

- **Tri-state resume_agent availability tracking (#3868):** The subagents contract now implements tri-state availability (available / absent / unknown) for the `resume_agent` tool, enabling recovery guidance to distinguish between:
  1. **Available:** The tool is present and usable for session recovery.
  2. **Absent:** The host environment does not support the tool; fallback guidance applies.
  3. **Unknown:** The tool availability has not yet been determined; conservative recovery behavior applies.

  This tri-state model is now wired through the native hook contract (`codex-native-hook.ts`) and the subagents tracker, enabling accurate recovery path selection based on host capabilities. Addresses issue #3866.

## Compatibility

- SessionStart recovery guidance behavior changes for hosts without `resume_agent`; recovery now emits appropriate fallback instructions instead of treating absence as unknown.
- Existing subagent sessions and recovery state remain compatible.
- No breaking API changes; tri-state availability is an internal contract refinement.

## Known gaps

- None. All findings from prior releases remain documented in their respective release-readiness files.

## Validation evidence

The pinned candidate `b58737f0f1eb427b978cb5561672625144616f29` (release branch HEAD) passed latest-per-name pinned-dev CI: 17 checks succeeded with 8 conditional checks skipped, and no failures.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3867](https://github.com/Yeachan-Heo/oh-my-codex/pull/3867) | @Yeachan-Heo | fix(subagents): cover hosts without resume_agent in SessionStart reopen guidance |
| [#3868](https://github.com/Yeachan-Heo/oh-my-codex/pull/3868) | @Yeachan-Heo | fix(subagents): implement tri-state resume_agent availability (#3866 follow-up) |

## Contributors

Thanks to @Yeachan-Heo for subagent recovery hardening and tri-state availability implementation, addressing issue #3866 (reported by ev78394).

**Full Changelog**: [`v0.21.26...v0.21.27`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.26...v0.21.27)
