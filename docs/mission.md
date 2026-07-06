# `omx mission`

`omx mission` runs a simple prompt or checklist file as a sequential batch of `omx exec` tasks.

## Usage

```sh
omx mission ./mission.md --dry-run
omx mission run ./mission.md --continue-on-error -- --model gpt-5
omx mission status ./mission.md
omx mission resume ./mission.md -- --model gpt-5
omx mission mark ./mission.md --task task-002 --status blocked
omx mission rerun ./mission.md --task task-002
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
- `omx mission status <file|slug>` reads an existing `summary.json` and prints the current task states without executing anything. Status counts include `passed`, `failed`, `skipped`, `blocked`, `needs-human-review`, and `planned`.
- `omx mission mark <file|slug> --task <id> --status <blocked|needs-human-review>` lets an operator preserve non-execution blockers in the durable summary without collapsing them into pass/fail/skipped.
- `omx mission resume <file>` reads the existing summary for that mission, skips tasks already marked `passed`, leaves `blocked` and `needs-human-review` tasks untouched for operator follow-up, treats stale `running` tasks as retryable, and continues failed/skipped/planned/pending tasks. The command exits non-zero when blocked/review/failure states remain.
- `omx mission rerun <file> --task <id>` reruns one specific task from the existing summary, including a previously failed, blocked, needs-human-review, or passed task. The command exits non-zero if the mission is still not fully passed afterward.

## Artifacts

Each run writes operator-readable state under `.omx/missions/<slug>/`:

- `summary.json` — task list, per-task status, exit codes, counts, and forwarded Codex args.
- `ledger.jsonl` — append-style lifecycle events for the mission and each task.

Summary-level status is `running` while work is active, then `blocked` when any task is blocked, `needs-human-review` when any remaining task needs review, `failed` when any task failed, `passed` only when every task passed, and otherwise `planned`.

Use `--summary <path>` to write `summary.json` somewhere else. The ledger still stays under `.omx/missions/<slug>/ledger.jsonl`.
