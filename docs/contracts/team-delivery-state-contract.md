# Team delivery / integration state contract

This document records the currently-audited ownership contract for the states
called out in issue #1243.

## Scope

- dispatch lifecycle: `pending`, `notified`, `delivered`, `failed`
- integration lifecycle: `integrated`
- readiness / leader-activity lifecycle: `stale`

## Authoritative owners

### Team mailbox isolation

The JS bridge requires the `team-mailbox-scope-v1` runtime capability before
mutating runtime state, including notification hooks. Sends validate before writing
provisional shadows, and dispatch validates before reserving cooldowns or injecting
into a pane. A runtime rejected after provisional creation removes only that
send's provisional row. Mutations use `exec-scoped`, which checks Team isolation
in the executing runtime process before opening state. Older binaries reject this
subcommand, including when swapped into the configured path after the schema probe.
The bridge executes the configured binary in place and does not require an executable
temporary directory. Queue creation propagates schema, unsupported-subcommand,
and semantic runtime-state failures; only classified transport failures use
the JSON fallback.
If the runtime becomes unavailable or incompatible after pane input (hook, direct, or broadcast), runtime-backed dispatch saves its outcome
and a pending runtime-finalization journal, including delivered receipts. Before claiming more work, the hook
replays those outcomes against event-derived runtime state and clears the journal;
an incompatible or disabled bridge leaves recovery blocked without re-injection.
A pane-confirmed injection persists its notified/delivered receipt before runtime
finalization; a semantic rejection remains an error, while the next hook drain
reconciles that receipt before claiming work so it cannot inject the prompt again.
Journal creation uses the atomically published dispatch identity ledger, avoiding
partially rewritten event/projection files; replay checks the request's Team before mutation.
Pure JSON queues keep their completion in JSON without creating runtime authority.
Older runtimes are rejected;
rebuild or upgrade the runtime rather than allowing it to discard Team scope.

Teams may share a runtime state directory and reuse names such as `worker-1`
and `leader-fixed`. New mailbox creation commands, creation events, and records
carry the canonical `team_name`; mailbox reads and mutations require that Team
and the addressed worker. Rust rejects a missing or different Team on mutations
of scoped records and rejects duplicate creation IDs within a Team while
permitting reuse across Teams. Notification hooks and shutdown retirement follow
the same ownership rule.
Proven JSON-only messages can still be acknowledged after enabling a compatible
runtime if no persisted runtime authority exists yet, or a valid mailbox projection
contains no record that could belong to the selected Team. Proven fallback rows
remain visible alongside runtime records and can be retired without a runtime
mutation. Same-Team or unscoped ID collisions and malformed compatibility state
continue through strict runtime acknowledgement checks; an ID scoped to another
Team does not shadow a proven fallback row.
Acknowledgement events retain the selected record's Team for replay. Older
acknowledgement events without a Team are replayed only for globally unique IDs.

Older records without `team_name` remain readable only when both the Team's
per-worker shadow and its `message_received` creation journal prove ownership.
Duplicate IDs among candidate unscoped or same-Team records, or conflicting
sender, recipient, or nonempty body across those shadow and runtime records,
cannot prove legacy ownership; those records remain hidden and require manual
recovery. A row scoped to another Team cannot invalidate the selected Team's
creation-journal proof.
Shadows alone are insufficient: older readers could copy another Team's records
into them. Unproven old records are retained on disk but hidden from mailbox
operations, including when the bridge is disabled. Disabling the bridge selects
the legacy JSON storage lane; it does not bypass Team ownership checks. In
particular, an old send that crashed before appending its creation event requires
manual recovery rather than guessing ownership.

Scoped records remain readable and can be retired if their shadow is missing;
their Team ownership survives persistence and event replay. Event replay restores
mailbox creations and acknowledgements absent from a stale compatibility snapshot,
and an unreadable existing mailbox snapshot fails closed rather than discarding
recoverable message bodies.

Mailbox creation only falls back for recognized runtime process-launch failures.
State-load, persistence, semantic, timeout, and malformed-response failures propagate;
the sender removes only its provisional shadow and does not emit a successful creation event.
Creation acknowledgements must identify the expected event, message and participants;
optional Team and body fields must match when present. Syntactically valid JSON
without that acknowledgement is a protocol failure, not successful creation.
Before creating a new ID, a retry checks matching Team-scoped creation events and
replays the runtime when necessary. It verifies that those IDs reached the mailbox
projection before deduplicating or creating another message. A failed or unverifiable
recovery remains an error, including when the runtime executable is unavailable;
partial persistence cannot silently become a second JSON-only or runtime message.
Deduplication uses the same verified projection, including when another process
completed recovery after the sender's initial mailbox read.

Runtime acknowledgement rejections propagate to the caller. Transport failure
while mutating a visible authoritative row also propagates, so the caller cannot
report a shadow-only acknowledgement as success; a proven JSON-only row may use
the fallback when no selected-Team or unscoped record represents it. Acknowledgements
hold the mailbox lock across their read and mutation. Concurrent delivery repeats
and notification of an already delivered message succeed without another runtime
mutation.
Shadow updates preserve colliding recovery rows; any pending shadow left after
retirement blocks Team cleanup until it is recovered. A proven, unique legacy ID
can reconcile runtime timestamp changes without creating duplicate shadows. Old body-less creation events recover content only
from a unique record with the same Team and message ID.

### `pending` / `notified` / `delivered` / `failed`

Durable owner:

- Rust runtime dispatch log when the bridge is enabled
  - `crates/omx-runtime-core/src/dispatch.rs`
  - surfaced through `src/runtime/bridge.ts`
- legacy JSON fallback only when the bridge is disabled or unreadable
  - `src/team/state/dispatch.ts`
  - `src/team/state.ts`

Observed code paths:

- queue: `DispatchLog::queue()` ↔ `enqueueDispatchRequest()`
- notify: `DispatchLog::mark_notified()` ↔ `markDispatchRequestNotified()`
- deliver: `DispatchLog::mark_delivered()` ↔ `markDispatchRequestDelivered()`
- fail: `DispatchLog::mark_failed()` ↔ `markDispatchRequestFailed()` / `transitionDispatchRequest(..., 'failed')`

Transition contract:

- `pending -> notified`
- `pending -> failed`
- `notified -> delivered`
- `notified -> failed`
- same-state reason/timestamp patching is allowed
- `failed -> notified` is **not** allowed for the same `request_id`

Rationale:

- Rust already enforces `failed` as terminal for a dispatch record.
- TS fallback must mirror that contract so hook, fallback, and replay paths do
  not answer the same state question differently.

### `integrated`

Durable owner:

- team monitor integration snapshot written by runtime integration logic
  - `src/team/runtime.ts`
  - `src/team/state.ts`
  - `src/team/state/monitor.ts`

Observed code paths:

- merge/cherry-pick/rebase decisions in `integrateWorkerCommitsIntoLeader()`
- failure path in `recordIntegrationFailure()`

Success contract:

- `integrated` requires durable git evidence:
  - leader HEAD advanced, and
  - integrated worker commit is actually reachable from leader HEAD

### `stale`

Durable owner depends on subject:

- runtime authority staleness:
  - `crates/omx-runtime-core/src/lib.rs`
  - `crates/omx-runtime-core/src/engine.rs`
  - surfaced via `src/runtime/bridge.ts`
- leader/session staleness:
  - `src/team/leader-activity.ts`
  - `src/hooks/session.ts`

Contract:

- `stale` is an eligibility / readiness signal, not a success state
- tmux/HUD observations may contribute evidence, but they are not the durable
  semantic owner of dispatch or integration success

## First contract hardening change

When a hook-authored dispatch receipt has already become `failed`, later fallback
confirmation must not mutate that same request back to `notified`.

Instead:

- keep the request `failed`
- patch `last_reason` to record the confirmed fallback path
- treat fallback success as an operational recovery event, not as a rewrite of
  the original hook-attempt state machine

Scoped provisional shadows with a different creation timestamp are reconciled by
a unique same-content scoped record during acknowledgement, hook notification,
and retirement, even when a crash prevented the Team creation journal append.
Before retiring fallback-only shadows, existing runtime authority is refreshed
to rule out durable creations missing from the mailbox projection. A failed
refresh blocks cleanup. Queue creation rejects transport fallback whenever
runtime authority exists, so JSON cannot add IDs absent from the runtime ledger.

Before hook claims are built, existing runtime authority is replayed and persisted
to prevent stale pending projections from causing repeat injection. Pending
retry/defer bookkeeping is retained without overriding event-derived status.
Repeated mailbox delivery acknowledges only the uniquely selected scoped record
and preserves its timestamp, allowing retries to persist replay-repaired state.

Mailbox acknowledgements fail closed if existing runtime authority cannot be
refreshed. Hook mailbox notification failures leave the shadow unchanged rather
than recording a receipt that event replay would discard; dispatch injection
receipts remain independently recoverable.

Hook drains claim from the dispatch records returned by CaptureSnapshot, so a
concurrent projection replacement cannot overwrite that authoritative result.
They cache it only when the projection matches the returned records and event
bytes stay unchanged, and reuse it only while event and dispatch bytes remain
unchanged. Older runtimes without returned records refresh on every drain without
caching. This skips repeated idle persistence without
missing event-only queues or changes between Teams. CaptureSnapshot still
refreshes compatibility files and returns SnapshotCaptured, but does not append
that no-op event to replay history; historical SnapshotCaptured events remain
readable.
