# oh-my-codex 0.21.23

`0.21.23` is a patch release for evidence requirements in generated team tasks and non-directory plugin cache recovery guidance (5 commits, 14 files, +914/−58; PRs #3840, #3846).

## Highlights

- **Evidence requirements for generated team tasks (#3840):** Generated team tasks now default to requiring evidence that code changes address the intent, unless the task is explicitly marked as analysis, reporting, or read-only. Task decomposition shares intent classification across CLI and DAG planning to preserve analysis context while requiring evidence for implementation requests. Authored by @shenyankm.

- **Non-directory plugin cache recovery guidance (#3846):** Extend cache recovery guidance to cover non-directory entries (symlinks and other non-directory types) in the plugin cache alongside existing pinned-snapshot handling. The repair command continues to emit fail-closed guidance when safe recovery options cannot be determined. Authored by @Yeachan-Heo.

## Compatibility

- Team task evidence requirements follow existing completion gates; generated tasks must provide evidence to match manual task contracts.
- `omx setup --plugin --repair-plugin-cache` behavior is unchanged for valid recovery scenarios; only guidance for unsafe entries is improved.
- Existing task records and explicit DAG flags are preserved and remain compatible.

## Validation

- Pinned candidate `9d811e2250cfdb277591b6087bd37a9194319e78` passed latest-per-name dev CI: 17 checks succeeded and 8 conditional checks were skipped, with no failures.
- Release branch CI passed with all required checks green.
- All code review findings addressed (PR #3840 has 10 known-gap Codex findings; see Known gaps section).

## Known gaps

- PR #3840 includes 10 unresolved Codex findings regarding edge cases in the implicit natural-language intent heuristic for distinguishing coding tasks from analysis/reporting. A design pass toward a structured intent signal is pending (follow-up #3845, closed pending design review).

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3840](https://github.com/Yeachan-Heo/oh-my-codex/pull/3840) | @shenyankm | fix(team): require evidence for generated coding tasks |
| [#3846](https://github.com/Yeachan-Heo/oh-my-codex/pull/3846) | @Yeachan-Heo | fix(setup): gate cache-removal advice on a typed repair outcome |

## Contributors

Thanks to @shenyankm and @Yeachan-Heo for the team task and cache recovery improvements.

**Full Changelog**: [`v0.21.22...v0.21.23`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.22...v0.21.23)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
