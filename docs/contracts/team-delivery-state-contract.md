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
send's provisional row.
Older runtimes are rejected;
rebuild or upgrade the runtime rather than allowing it to discard Team scope.

Teams may share a runtime state directory and reuse names such as `worker-1`
and `leader-fixed`. New mailbox creation commands, creation events, and records
carry the canonical `team_name`; mailbox reads and mutations require that Team
and the addressed worker. Rust rejects a missing or different Team on mutations
of scoped records. Notification hooks and shutdown retirement follow the same
ownership rule.
Acknowledgement events retain the selected record's Team for replay. Older
acknowledgement events without a Team are replayed only for globally unique IDs.

Older records without `team_name` remain readable only when both the Team's
per-worker shadow and its `message_received` creation journal prove ownership.
Duplicate IDs in the shadow or shared runtime cannot prove legacy ownership;
those records remain hidden and require manual recovery.
Shadows alone are insufficient: older readers could copy another Team's records
into them. Unproven old records are retained on disk but hidden from bridge-backed
mailbox operations, including the JSON fallback. In particular, an old send that
crashed before appending its creation event requires manual recovery rather than
guessing ownership. Explicitly disabling the bridge keeps the legacy JSON lane.

Scoped records remain readable and can be retired if their shadow is missing;
their Team ownership survives persistence and event replay.

Runtime acknowledgement rejections propagate to the caller; only transport
failures may use the JSON fallback. Acknowledgements hold the mailbox lock across
their read and mutation. Concurrent delivery repeats and notification of an already
delivered message succeed without another runtime mutation.
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
