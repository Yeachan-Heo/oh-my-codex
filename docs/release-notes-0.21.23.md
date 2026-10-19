# oh-my-codex 0.21.23

`0.21.23` is a patch release for evidence requirements in generated team tasks and additional cache recovery guidance for non-directory plugin snapshots (5 commits, 14 files, +914/−58; PRs #3840, #3846).

Versioning continues the 0.21.x patch train. This release improves team task decomposition by requiring evidence for generated coding tasks and strengthens the setup repair guidance for non-directory entries in the plugin cache.

## Highlights

- **Evidence requirements for generated team tasks (#3840):** Generated team tasks now default to requiring evidence that code changes address the intent, unless the task is explicitly marked as analysis, reporting, or read-only. The requirement respects explicit role DAG flags and treats unknown roles conservatively. Task decomposition shares intent classification across CLI and DAG planning to preserve analysis context while requiring evidence for implementation requests. Authored by @shenyankm.

- **Improved plugin cache recovery guidance (#3846):** Extend cache recovery guidance to cover non-directory entries (symlinks and other non-directory types) in the plugin cache alongside existing pinned-snapshot handling. The repair command continues to emit fail-closed guidance when safe recovery options cannot be determined. Authored by @Yeachan-Heo.

## Compatibility

- Team task evidence requirements follow existing completion gates; generated tasks must provide evidence to match manual task contracts.
- `omx setup --plugin --repair-plugin-cache` behavior is unchanged for valid recovery scenarios; only guidance for unsafe entries is improved.
- Existing task records and explicit DAG flags are preserved and remain compatible.

## Known gaps

- PR #3840 includes 10 unresolved Codex findings regarding edge cases in the implicit natural-language intent heuristic for coding vs. analysis classification. A follow-up design pass for a structured intent signal is planned (follow-up #3845, closed pending design review).

## Validation evidence

The pinned candidate `9d811e2250cfdb277591b6087bd37a9194319e78` passed latest-per-name dev CI: 17 checks succeeded with 8 conditional checks skipped, and no failures.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3840](https://github.com/Yeachan-Heo/oh-my-codex/pull/3840) | @shenyankm | fix(team): require evidence for generated coding tasks |
| [#3846](https://github.com/Yeachan-Heo/oh-my-codex/pull/3846) | @Yeachan-Heo | fix(setup): gate cache-removal advice on a typed repair outcome |

## Contributors

Thanks to @shenyankm and @Yeachan-Heo for the team task and cache recovery improvements.

**Full Changelog**: [`v0.21.22...v0.21.23`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.22...v0.21.23)
