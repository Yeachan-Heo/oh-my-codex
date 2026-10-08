# Session token usage

`omx session usage` reads local Codex rollout logs and reports their recorded
cumulative token counters. It helps find token-heavy sessions and inspect cache
and reasoning usage without exporting conversations.

```sh
omx session usage --since 7d --project current
omx session usage --sort tokens --limit 10
omx session usage --session <id-fragment> --json
omx session usage --codex-home /path/to/codex-home --json > usage.json
```

The command discovers the same default and project runtime homes as session
search, including both `sessions/` and `archived_sessions/`. An explicit
`--codex-home` disables discovery of other homes. It does not modify source
files or start a Codex session.

## What the counters mean

Each transcript contributes its last usable
`event_msg.token_count.info.total_token_usage` snapshot. Earlier cumulative
snapshots, repeated rate-limit notifications and `last_token_usage` are never
added together. A later lower cumulative snapshot replaces an earlier higher
one, including when a provider resets its counters.

Mirrors and archived copies with the same session ID contribute once. Across
copies, the newest timestamped usage snapshot wins. On a timestamp tie, the
larger recorded total wins, then the snapshot with more known fields. No fields
are stitched together from different snapshots. Activity time is the latest
recorded timestamp across copies, and a session is marked archived only when
all discovered copies are archived.

- `input_tokens`: recorded input tokens.
- `cached_input_tokens`: the cached subset of input, not extra input tokens.
- `output_tokens`: recorded output tokens.
- `reasoning_output_tokens`: the reasoning subset of output, not extra output tokens.
- `total_tokens`: the provider's recorded total; it is not recomputed by adding
  the subsets to input/output.

Missing, nonnumeric, negative, fractional and unsafe integer fields remain
unknown. A measured zero is known. Sessions without cumulative snapshots remain
visible, with unknown counters. Totals sum only known measurements and include
per-field coverage. An aggregate beyond JavaScript's safe integer range fails
explicitly instead of reporting rounded counts.

## Filtering and ordering

`--since` accepts durations such as `7d` and `24h`, or an ISO date. It selects
sessions by **last recorded activity**, not by file modification time or session
creation time. The selected counters still represent the entire recorded
session. A resumed session may therefore include tokens from before the cutoff.
This report does not estimate money or account billing-period consumption.
Without `--since`, all discovered sessions are eligible. Unknown activity times
are excluded when a cutoff is supplied.

`--project current` matches the current directory after resolving filesystem
aliases; `all` selects every project, and other values match a case-insensitive
directory fragment. `--session` matches a case-insensitive ID fragment.
`--sort recent` is the default; `--sort tokens` ranks by recorded total tokens,
placing unknown totals last. `--limit` accepts 1–500 (default 20) and affects only
displayed rows. Aggregates and measurement coverage include all matched sessions.

## JSON and read gaps

JSON has `schema_version: 1` and `scope: "session-cumulative"`. `totals` contains
one object per counter, with `known` (number or null), `known_sessions`, and
`unknown_sessions`. `matched_sessions` counts all selected sessions, while
`sessions` contains at most `--limit` rows and `truncated` indicates more matches.
Each row includes snapshot/activity timestamps, archive status, transcript copy
count, counters, and a project basename/hash. It excludes raw messages, tool
arguments/outputs, model instructions and full filesystem paths.

Reads stop at the file size observed when opening each transcript, so a growing
session cannot extend a report indefinitely. Incomplete or malformed JSON lines
are counted and skipped. Files without a valid first session metadata record
are skipped rather than assigned a guessed identity. A file that disappears
during discovery is also skipped; other filesystem errors are surfaced.
`diagnostics` reports scanned/skipped files, malformed records, invalid numeric
fields and duplicate transcripts. Read gaps and missing counters make the
reported totals incomplete; the report preserves that distinction.
