# Runtime command / event / snapshot schema

This document defines the Rust-owned runtime contract used by the first greenfield cutover.

## Scope
- Commands describe semantic requests.
- Events describe semantic outcomes.
- Snapshots describe the current truth of the runtime.
- Transport details (JSON, IPC, files) are implementation details layered on top.

## Command shapes

| Command | Required fields | Meaning |
|---|---|---|
| `acquire-authority` | `owner`, `lease_id`, `leased_until` | Claim the single semantic authority lease. |
| `renew-authority` | `owner`, `lease_id`, `leased_until` | Extend the current lease without changing ownership. |
| `queue-dispatch` | `request_id`, `target` | Add one dispatch request to the backlog. |
| `mark-notified` | `request_id`, `channel` | Record that a queued dispatch has been delivered to an observer or target. |
| `mark-delivered` | `request_id` | Record successful delivery completion. |
| `mark-failed` | `request_id`, `reason` | Record failed delivery completion. |
| `request-replay` | `cursor` | Ask the runtime to replay from a durable cursor. |
| `capture-snapshot` | none | Emit the current semantic snapshot. |

## Event shapes

| Event | Required fields | Meaning |
|---|---|---|
| `authority-acquired` | `owner`, `lease_id`, `leased_until` | A new authority lease is active. |
| `authority-renewed` | `owner`, `lease_id`, `leased_until` | The active lease was renewed. |
| `dispatch-queued` | `request_id`, `target` | A request entered backlog. |
| `dispatch-notified` | `request_id`, `channel` | A request moved out of pending and into notification. |
| `dispatch-delivered` | `request_id` | The request completed successfully. |
| `dispatch-failed` | `request_id`, `reason` | The request completed with failure. |
| `replay-requested` | `cursor` | Replay or recovery work was requested. |
| `snapshot-captured` | none | A snapshot was emitted for observers. |
| `run.heartbeat` | `owner`, `phase` | The active runtime is alive and still making forward-progress observations. |
| `run.blocked_on_user` | `owner`, `reason` | The runtime is explicitly waiting for user input or approval. |
| `run.blocked_on_system` | `owner`, `reason` | The runtime is blocked on tooling, environment, or system repair. |
| `worker.assigned` | `worker`, `task_id` | A worker received an authoritative task assignment. |
| `worker.stalled` | `worker`, `reason` | A worker crossed the supervisor intervention threshold and needs recovery attention. |
| `worker.recovered` | `worker`, `recovery` | A stalled or interrupted worker recovered, resumed, or was relaunched. |

## Snapshot fields

| Field | Meaning |
|---|---|
| `schema_version` | Contract version for the runtime snapshot. |
| `authority.owner` | The current semantic owner, if any. |
| `authority.lease_id` | Lease identifier for the current owner. |
| `authority.leased_until` | Lease expiry marker. |
| `authority.stale` | Whether the current owner is stale or expired. |
| `backlog.pending` | Dispatches awaiting notification. |
| `backlog.notified` | Dispatches that were notified and are waiting for completion. |
| `backlog.delivered` | Dispatches that completed successfully. |
| `backlog.failed` | Dispatches that completed with failure. |
| `replay.cursor` | Durable replay cursor, if any. |
| `replay.pending_events` | Number of replayable events not yet applied. |
| `replay.last_replayed_event_id` | Last replayed event marker. |
| `replay.deferred_leader_notification` | Whether leader notification was intentionally deferred. |
| `readiness.ready` | Whether the runtime is ready for operator traffic. |
| `readiness.reasons` | Human-readable blockers when the runtime is not ready. |

## JSON serialization format

Commands use `#[serde(tag = "command")]` — the variant name becomes the `"command"` field, remaining fields are flattened inline:

```json
{"command":"AcquireAuthority","owner":"w1","lease_id":"l1","leased_until":"2026-03-19T02:00:00Z"}
{"command":"RenewAuthority","owner":"w1","lease_id":"l2","leased_until":"2026-03-19T03:00:00Z"}
{"command":"QueueDispatch","request_id":"req-1","target":"worker-2"}
{"command":"MarkNotified","request_id":"req-1","channel":"tmux"}
{"command":"MarkDelivered","request_id":"req-1"}
{"command":"MarkFailed","request_id":"req-1","reason":"timeout"}
{"command":"RequestReplay","cursor":"cursor-1"}
{"command":"CaptureSnapshot"}
```

Events use `#[serde(tag = "event")]` — the variant name becomes the `"event"` field, remaining fields are flattened inline:

```json
{"event":"AuthorityAcquired","owner":"w1","lease_id":"l1","leased_until":"2026-03-19T02:00:00Z"}
{"event":"AuthorityRenewed","owner":"w1","lease_id":"l2","leased_until":"2026-03-19T03:00:00Z"}
{"event":"DispatchQueued","request_id":"req-1","target":"worker-2"}
{"event":"DispatchNotified","request_id":"req-1","channel":"tmux"}
{"event":"DispatchDelivered","request_id":"req-1"}
{"event":"DispatchFailed","request_id":"req-1","reason":"timeout"}
{"event":"ReplayRequested","cursor":"cursor-1"}
{"event":"SnapshotCaptured"}
{"event":"run.heartbeat","owner":"leader","phase":"execute"}
{"event":"run.blocked_on_user","owner":"leader","reason":"needs-user-clarification"}
{"event":"run.blocked_on_system","owner":"leader","reason":"sandbox-denied"}
{"event":"worker.assigned","worker":"worker-2","task_id":"17"}
{"event":"worker.stalled","worker":"worker-2","reason":"stdout-stale"}
{"event":"worker.recovered","worker":"worker-2","recovery":"relaunch"}
```

Snapshot fields are flat JSON at the top level, with nested objects for each section:

```json
{
  "schema_version": 1,
  "authority": {
    "owner": "w1",
    "lease_id": "l1",
    "leased_until": "2026-03-19T02:00:00Z",
    "stale": false,
    "stale_reason": null
  },
  "backlog": {
    "pending": 1,
    "notified": 0,
    "delivered": 0,
    "failed": 0
  },
  "replay": {
    "cursor": null,
    "pending_events": 0,
    "last_replayed_event_id": null,
    "deferred_leader_notification": false
  },
  "readiness": {
    "ready": true,
    "reasons": []
  }
}
```

## Invariants
- Exactly one semantic authority owner may be active at a time.
- Dispatches must move `pending -> notified -> delivered|failed`.
- Replay state must be durable and deduplicated.
- Readiness is derived from Rust-owned truth, not from JS-side inference.

