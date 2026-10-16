# Session execution timeline

`omx session timeline` reconstructs the execution of one local Codex session:
which tools were called, when results were recorded, which calls explicitly
failed, and where turns or context compactions occurred. It does not launch or
resume Codex, recover session pointers, or modify the source transcript.

Find an ID with `omx session search "a phrase you remember"`, then inspect it:

```bash
omx session timeline <session-id>
omx session timeline <session-id> --kind tools --sort duration --limit 10
omx session timeline <session-id> --status failed
omx session timeline <session-id> --tool exec_command --min-duration 1000
omx session timeline <session-id> --tool read --namespace mcp__filesystem
omx session timeline <session-id> --kind turns
omx session timeline <session-id> --kind compactions
omx session timeline <session-id> --json --output timeline.json
```

Tool names and namespaces use exact, case-sensitive matching; copy them from the
report. Use `--namespace` with `--tool` to distinguish namespaced tools that
share a name.
`--min-duration` is an inclusive threshold in milliseconds and excludes unknown
durations, including incomplete calls. It can be combined with `--tool` and
`--status`.

## Session selection and output

An exact session ID takes precedence over prefix matches. Otherwise, the prefix
must identify one transcript. Active `sessions/` and `archived_sessions/` are
searched in the same Codex homes as session export, including associated project
runtime homes. `--codex-home <path>` selects a single home. Ambiguous prefixes or
duplicate transcripts produce an error instead of silently choosing a source.

The default is readable text on stdout. `--json` emits a versioned report with
`schema_version: 1`. `--output <path>` writes either format to a new file with
owner-only permissions where supported and sends confirmation to stderr. Existing
files and symlinks are never overwritten. Omitting `--output` supports piping to
other tools.

Reports contain metadata: session, turn and call IDs, tool names and namespaces,
timestamps, source line numbers, statuses, exit codes, and aggregate counts.
Message text, system/developer instructions, reasoning, tool arguments, tool
outputs, and transcript/project filesystem paths are excluded. The retained IDs,
tool names, and namespaces are not anonymized. Use
`omx session export <session-id> --include-tools` when you need the actual
arguments or output to investigate an event.

## Status and timing semantics

| Status/event | Meaning |
| --- | --- |
| `completed` | A result was recorded without an explicit failure marker. This is not a guarantee of success. |
| `failed` | A result has a nonzero integer exit code, `isError: true`, or `is_error: true`, or its MCP lifecycle event reports `result.Ok.isError: true` or a `result.Err` variant. |
| `incomplete` | A call has no uniquely matched result in the inspected transcript. It may be interrupted, truncated, or still running. |
| `orphan_output` | A result has no uniquely matching earlier call. Its own status is available, but it is not counted as a completed or failed call. |

The parser reads exit codes from the result object's `exit_code` or
`metadata.exit_code`, including JSON-encoded objects. It also recognizes exit codes
in Codex shell-result headers. It does not infer failure from words such as
"error" in program output or parse arbitrary nested output as result metadata.
An unfamiliar error format can therefore appear as `completed`.

Calls are paired by `call_id`, so parallel and interleaved results are supported.
Missing IDs are never guessed. If multiple outstanding calls reuse an ID,
attribution becomes ambiguous: these calls remain incomplete and subsequent
outputs for that ID are recorded as orphan outputs. Sequential reuse after a
matched result is supported.

`duration_ms` is the interval between a call's timestamp and its result's timestamp.
It includes any scheduling or logging delay and is not CPU time or the duration
of a background process launched by a tool. A tool that yields a process handle
is completed when it returns that handle; later polling calls are separate calls.
Missing, invalid, or reversed timestamps produce `null`, not zero. Zero is retained
when both timestamps are valid and equal.

Per-tool `total_duration_ms` sums measured calls, which can overlap. Consequently,
totals may exceed the session's elapsed span. `measured_calls` shows coverage;
total and maximum durations are `null` when no call has a valid measurement.
The session span uses the start metadata and latest valid record timestamp,
including records that are not themselves timeline events. Idle time is included.

## Filtering, ordering, and pagination

| Option | Values/default |
| --- | --- |
| `--kind` | `all` (default), `tools`, `turns`, `compactions` |
| `--tool` | Exact tool name; selects call events only |
| `--namespace` | Exact tool namespace; selects call events only and can be combined with `--tool` |
| `--status` | `completed`, `failed`, `incomplete`; applies to calls and orphan outputs |
| `--min-duration` | Non-negative integer milliseconds; selects measured calls only |
| `--sort` | `chronological` (default) or `duration` |
| `--offset` | Non-negative matching-event offset; default `0` |
| `--limit` | `1`–`10000`; default `100` |

Chronological order follows transcript line order even if timestamps move
backward. A paired call occupies its original call position and includes
`result_line_number` and `completed_at`. Duration order sorts longest measured
calls first, with unknown durations and non-call events last. Ties use line order.

All filters are combined before pagination. Pairing and summaries always use the
whole transcript, so a result outside the displayed page still completes its call.
`summary` always describes the whole session, while `selection.matched_events`
describes the filtered list and `selection.has_more` indicates another page.
For stable histories, continue with the same filters and `--offset` increased by
the number of returned events. A live transcript can grow between invocations;
pagination is not a persistent snapshot.

## Supported records and incomplete evidence

- `response_item`: `function_call`, `custom_tool_call`, and their corresponding
  `*_output` records.
- `event_msg`: `task_started`, `task_complete`, `turn_aborted`, `context_compacted`, and MCP `mcp_tool_call_end` result metadata.
- Top-level `compacted` records.

Each recorded boundary or compaction is shown. A following `context_compacted`
event coalesces with the latest unmatched top-level `compacted` record when only
token-count metadata intervenes; other records break the pairing. Either form is
retained when it appears alone. No turns are invented from message text, and
unsupported tool families are not counted. Histories that contain only conversation
messages can have an empty timeline. Tool calls inside an execution wrapper are
visible only if Codex records them separately. A uniquely matched MCP
`mcp_tool_call_end` `Ok` or `Err` result completes or fails its call even when no
separate output record follows; a later output record refines the result when present.
An unmatched lifecycle result is retained as an `orphan_output`; it coalesces with a
later output using the same ID only when that ID is not ambiguous.

The reader streams JSONL and retains event metadata, not message or output bodies.
It tolerates malformed rows and partially written tails. `diagnostics` reports
malformed records, invalid timestamps, reversed call/result timestamps, and the
number of ambiguous outstanding call IDs. These gaps may leave calls incomplete.
For an actively written transcript, rerun after the session finishes to obtain a
more complete report.
