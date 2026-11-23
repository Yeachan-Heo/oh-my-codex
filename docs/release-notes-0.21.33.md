# oh-my-codex 0.21.33

`0.21.33` is a patch release that recovers team dispatch finalizations from torn journal lines (PR #3893).

This release fixes a critical issue where the `runtime-finalizations.jsonl` journal file could be corrupted after a crash mid-append. When the process crashed while writing a dispatch finalization record, subsequent appends would be lost because the parser couldn't recover from the truncated line. The fix adds tolerant parsing to recover valid commands from corrupted journals and uses newline-isolated appends to protect new entries from torn tails.

## Highlights

- **CRASH RECOVERY: Tolerant parsing of corrupted dispatch finalization journals (#3893):** After a crash mid-append to `runtime-finalizations.jsonl`, the file could contain truncated JSON lines that blocked the entire reconciliation and caused subsequent receipts to be lost. The fix adds `parseRuntimeFinalizationJournal()` which skips malformed lines and recovers all valid dispatch finalization commands, allowing the runtime to gracefully recover from corruption and replay pending operations without data loss.
- **Newline-isolated journal appends (#3893):** New dispatch finalization records are now prepended with a newline separator, ensuring they remain isolable even if a previous append was incomplete. Combined with tolerant parsing, this prevents cascading failures where one corrupted entry blocks recovery of all subsequent entries.
- **Comprehensive test coverage (#3893):** New test suite (`dispatch-finalization-journal.test.ts`) validates recovery from various corruption scenarios: torn lines, null entries, array entries, and unterminated tails. Tests confirm that valid commands are preserved and replayed correctly while malformed lines are safely skipped.

## Compatibility

- No breaking API changes; dispatch recovery improvement only.
- **Team runtime users:** If the runtime crashed during dispatch finalization writes in earlier versions, upgrade to v0.21.33 to recover any pending operations. Recovery is automatic and requires no configuration.
- Existing sessions remain unaffected unless they were interrupted by runtime crashes and had unrecovered dispatch finalizations.
- The fix improves resilience without changing the dispatch API contract.

## Known gaps

None. The recovery mechanism is fully implemented and tested. No Codex findings or outstanding issues remain.

## Validation evidence

The pinned candidate (release branch HEAD, commit `fa9b223d`) passed all gates:
- `npm run build` ✓
- `npm run check:no-unused` ✓
- `npm run lint` ✓
- Dispatch finalization journal recovery tests ✓
- All macOS Ralplan preflight security jobs ✓

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3893](https://github.com/Yeachan-Heo/oh-my-codex/pull/3893) | @shenyankm | fix: recover team dispatch finalizations from torn journal lines |

## Contributors

Thanks to @shenyankm for the dispatch recovery fix, and @Claude Code for release validation.

**Full Changelog**: [`v0.21.32...v0.21.33`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.32...v0.21.33)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
