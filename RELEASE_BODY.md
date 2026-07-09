# oh-my-codex 0.19.1

`0.19.1` is a patch release after `0.19.0` focused on Ultragoal/Ralplan terminal-state reliability, direct Team state roots, mission queue execution, and dependency hygiene.

## Highlights

- Repair Ultragoal conductor provenance and task-scoped aggregate completion state (#3074, #3072).
- Handle invalid mission summary JSON without breaking release/runtime flows (#3070).
- Fix Ralplan terminalization tracker lag and terminal Stop cache loops (#3068, #3058).
- Fix state roots for direct Team state directory usage (#3062).
- Add the mission queue runner MVP (#3063).
- Refresh dev dependencies: @types/node 26.1.0 and @biomejs/biome 2.5.2 (#3065, #3066).
- Avoid stale catalog counts in the contributing guide (#3069).

## Compatibility

No breaking CLI, package, plugin-layout, native asset, or configuration changes are intended.

## Validation

Release validation is based on the green dev CI for `59a9cb80`, local build/package checks before tagging, main promotion CI, and the tag-triggered GitHub release workflow.

## Contributors

Thanks to the contributors who made this release possible.

**Full Changelog**: [`v0.19.0...v0.19.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.19.0...v0.19.1)
