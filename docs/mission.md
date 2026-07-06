# `omx mission`

`omx mission` runs a simple prompt or checklist file as a sequential batch of `omx exec` tasks.

## Usage

```sh
omx mission ./mission.md --dry-run
omx mission run ./mission.md --continue-on-error -- --model gpt-5
```

## Input format

Use one prompt per non-empty line. Markdown bullets, numbered lists, and task checkboxes are accepted; headings and HTML comments are ignored.

```md
# Release checklist
- [ ] Audit the failing test output and identify the smallest fix.
- [ ] Apply the fix and update focused tests.
- [ ] Summarize verification evidence for the PR.
```

## Behavior

- `omx mission <file>` and `omx mission run <file>` execute tasks in file order.
- Each task is passed to `omx exec` as its prompt. Arguments after `--` are forwarded to `codex exec` for every task.
- The run stops on the first failed task unless `--continue-on-error` is set.
- `omx mission plan <file>` or `--dry-run` validates parsing and writes the same durable summary without executing Codex.

## Artifacts

Each run writes operator-readable state under `.omx/missions/<slug>/`:

- `summary.json` — task list, per-task status, exit codes, counts, and forwarded Codex args.
- `ledger.jsonl` — append-style lifecycle events for the mission and each task.

Use `--summary <path>` to write `summary.json` somewhere else. The ledger still stays under `.omx/missions/<slug>/ledger.jsonl`.
