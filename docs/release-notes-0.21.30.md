# oh-my-codex 0.21.30

`0.21.30` is a patch release for Team monitor-path dispatch serialization (4 commits, 10 files, +324/−78; PRs #3879, #3880, #3882).

Versioning continues the 0.21.x patch train. This release extends the dispatch state recovery fixes from v0.21.29 to the monitor-path mailbox delivery route, ensuring complete serialization consistency across all Team event delivery paths.

## Highlights

- **Team monitor-path dispatch serialization (#3879, #3880, #3882):** The v0.21.29 release fixed dispatch retry consistency, mailbox wake acknowledgment, and damaged mailbox recovery for the primary dispatch path. This release extends those same fixes to the secondary monitor-path delivery route (`monitorTeam` → `deliverPendingMailboxMessages` → `dispatchPendingMailboxMessage`):
  - **Monitor-path wake serialization (#3879):** Monitor-created wake conditions now participate in the same serialization barrier applied to acknowledgments, ensuring that wake acknowledgment only occurs after all messages from that wake are complete.
  - **Monitor-path acknowledgement race fix (#3880):** Resolves a race condition in the monitor path where mailbox acknowledgements can race with dispatch, leaving messages undelivered. The fix ensures dispatch requests are enqueued inside the serialization barrier with final re-validation.
  - **Stale notification skipping and proof (#3882):** Implements stale monitor notification detection and skipping, with comprehensive test coverage proving the race condition is resolved across both primary and monitor paths.

## Compatibility

- No breaking API changes; all fixes are internal serialization improvements.
- Existing sessions and Team dispatch workflows remain unaffected; recovery is transparent.
- Monitor-based event delivery is now consistent with primary dispatch retry paths.

## Known gaps

- No unresolved findings from code review or CI.

## Validation evidence

The pinned candidate `0ec816c21af5cacfcd2f013124fce1b11127c39a` (pinned dev HEAD before version bump) passed latest-per-name pinned-dev CI: 17 checks succeeded with 8 conditional checks skipped, and no failures (run conducted at 12:17Z on 2026-10-22).

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3879](https://github.com/Yeachan-Heo/oh-my-codex/pull/3879) | @shenyankm | fix(team): serialize monitor-created wakes with acknowledgements |
| [#3880](https://github.com/Yeachan-Heo/oh-my-codex/pull/3880) | @shenyankm | fix(team): close ack race in monitor mailbox delivery (#3879, #3877) |
| [#3882](https://github.com/Yeachan-Heo/oh-my-codex/pull/3882) | @shenyankm | fix(team): skip stale monitor notifications after acknowledgement and prove the race fix |

## Contributors

Thanks to @shenyankm for the monitor-path dispatch serialization fixes.

**Full Changelog**: [`v0.21.29...v0.21.30`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.29...v0.21.30)
