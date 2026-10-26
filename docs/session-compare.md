# Compare session execution

`omx session compare <baseline-id> <candidate-id>` compares two local Codex
transcripts. Use it after changing a prompt, workflow, or tool configuration to
inspect changes in execution counts, explicit tool failures, and observed tool
latency. Choose sessions that performed comparable work; this is a descriptive
comparison, not a controlled benchmark or a token/billing report.

```bash
omx session compare <before> <after>
omx session compare <before> <after> --sort duration --limit 10
omx session compare <before> <after> --tool read --namespace filesystem
omx session compare <before> <after> --json --output comparison.json
```

## Selecting transcripts

Both selectors accept exact IDs or unique prefixes and search active and archived
histories using the same home discovery as `omx session timeline`. An exact ID
takes precedence over prefix matches; ambiguous transcripts produce an error.
Use `omx session search` to find IDs. To inspect copied histories or compare two
snapshots of the same ID from separate homes:

```bash
omx session compare <before> <after> --codex-home /path/to/home
omx session compare <id> <id> \
  --baseline-home /path/to/before-home \
  --candidate-home /path/to/after-home
```

Side-specific home flags override `--codex-home` for their respective selectors.
The comparison reads the baseline and then the candidate; the two reads are not
an atomic snapshot. For reproducible results, use finished sessions or copied
histories. An active-history file is not evidence that the session is running.

## Metrics and missing evidence

Session metrics include the first-to-last timestamp span, tool calls, recorded
completions, explicit failures, incomplete calls, orphan results, turn boundaries,
and compactions. Tools are joined by the exact `(namespace, name)` pair. Missing
names and namespaces are kept distinct from literal placeholder strings.

Each metric contains `baseline`, `candidate`, `delta` (candidate minus baseline),
and `percent_change`. Unknown measurements stay `null`. A zero baseline and
positive candidate has a known absolute delta but no finite percentage; zero
versus zero has a zero percent change. Percentages are calculated before display
rounding.

Tool rows distinguish `both`, `added`, and `removed`. An absent tool contributes
zero calls, failures, and incomplete calls, but its durations are unknown, not
zero. Duration totals sum measured call-to-result intervals; parallel calls can
overlap. The mean divides that total by `measured_calls`, not all calls. The
report shows both measurement coverage and `latency_comparable`: latency is
eligible for regression assessment only when both tools exist and every call in
both tools has a measured duration. Increased call volume alone does not imply
a mean-latency regression.

Status and pairing semantics come from [session timeline](./session-timeline.md),
including namespace separation, MCP lifecycle results, and compaction pairing.
Completed means a result without a recognized explicit failure, not proven task
success. Incomplete means no uniquely paired result, not necessarily a running
call. No timings or outcomes are inferred from conversation text.

## Regression assessment and automation

By default, the report identifies these regressions:

- Increased explicit failures or incomplete calls for any individual tool,
  including newly added tools. Failures moving from one tool to another remain
  visible even if the overall failure count is unchanged.
- Increased recorded aborted turns.
- Mean tool duration increasing by **more than 20%**, with full timing coverage
  on both sides. `--max-duration-increase <percent>` changes this threshold
  (0–1000000; decimals accepted). A measured zero baseline followed by any
  positive duration exceeds any finite percentage threshold.

Assessment uses every tool and both whole-session summaries. `--tool`,
`--namespace`, `--sort`, and `--limit` affect displayed tool rows only; they never
hide regressions from `assessment.regressions` or change the exit status.
`--sort regression` puts tools with more regression findings first, then larger
mean-duration increases. `--sort duration` sorts by absolute mean-duration delta,
largest first and unknown last; `--sort name` orders by namespace/name identity.
The default limit is 20, with a maximum of 1000.

Malformed records, invalid/reversed timestamps, ambiguous call IDs, orphan
outputs, unmeasured or incomplete calls, unmatched turn-start counts, and histories without tool calls are
reported in `assessment.gaps`. If any regression is observed, status is
`regression`, even with gaps. Otherwise, gaps produce `inconclusive`; only a
comparison without findings or gaps reports `no_regression`. Tools present on
only one side have no latency comparison. `no_regression` means none of the
specified checks found an increase; it does not certify correctness, equal
workload, or support for every possible transcript event type.

```bash
omx session compare <before> <after> \
  --max-duration-increase 10 \
  --fail-on-regression --json --output comparison.json
```

| Exit code | Meaning |
| --- | --- |
| 0 | Report produced; with `--fail-on-regression`, no assessed regression or gap |
| 1 | Invalid arguments, unresolved session, or read/write failure |
| 2 | `--fail-on-regression` and at least one observed regression |
| 3 | `--fail-on-regression` and inconclusive evidence without a regression |

Without `--fail-on-regression`, all successfully generated reports exit 0.
The report is fully written before the CLI returns an assessment exit code.
Consumers should check `schema_version: 1` and `assessment.status`; an unknown
percentage is serialized as JSON `null`, never `Infinity` or a fabricated zero.

## Output and privacy

The default format is plain text; `--json` returns a structured report. Without
`--output`, the report goes to stdout. Output files are created exclusively with
owner-only permissions (0600 on POSIX), so existing files, source transcripts,
and symlink destinations are never overwritten. File-write failures exit 1
instead of returning a regression code.

Reports retain session IDs, timestamps, tool names/namespaces, counters, and
diagnostics. They exclude messages, instructions, reasoning, tool arguments and
outputs, call/turn IDs, and full filesystem paths. Metadata labels are not
anonymized. Human output strips terminal control characters; JSON retains label
values as escaped strings. The command does not alter histories, session
pointers, or locks and does not invoke a model or start a Codex session.
