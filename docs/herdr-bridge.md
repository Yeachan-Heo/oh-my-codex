# Herdr lifecycle/status bridge (issue #3241)

OMX reports its lifecycle and Team state to a containing [Herdr](https://github.com/ogulcancelik/herdr)
pane so the Herdr sidebar reflects `working` / `blocked` / `idle` transitions
authored by OMX, instead of relying on Herdr's screen-manifest inference. This
is the **Phase 1** status bridge. The **Phase 2** runtime backend (Herdr as a
pluggable multiplexer replacing OMX's tmux runtime) is out of scope.

## Design goals

- **Opt-in.** No behavior change outside a detected Herdr pane; inert unless OMX
  runs inside Herdr.
- **Best-effort and non-blocking.** A Herdr socket/CLI failure never fails an
  OMX run. No Herdr dependency is required.
- **OMX owns the truth.** OMX is the authoritative source of its lifecycle and
  Team state; Herdr is the rendering/notification consumer.
- **Ordered across processes.** Reports carry a durable per-source monotonic
  `seq` that survives concurrent short-lived hook processes and restarts.
- **Clean handoff.** On whole-session shutdown, OMX releases `omx:runtime`
  authority; a crash is reconciled on the next session-start.

## How it is wired (production path)

The bridge is invoked from the single canonical hook seam, `dispatchHookEvent`
(`src/hooks/extensibility/dispatcher.ts`) — the function **every** dispatch path
funnels through (native Codex hooks via `dispatchHookEventRuntime`, team
transitions via `src/team/runtime.ts` and `team-dispatch.ts`,
`turn-complete`/`session-idle` via `notify-hook.ts`, derived events via
`hook-derived-watcher.ts`, and the CLI hook path). Every native/derived/team
lifecycle event (`session-start`, `run.heartbeat`, `blocked`, `needs-input`,
`run.blocked_on_user`, `turn-complete`, `finished`, `failed`, `stop`,
`session-end`, team transitions, …) reaches `reportHerdrLifecycleEvent`
(`src/adapt/herdr/wiring.ts`), which maps it to a Herdr semantic state and
reports it. The call is gated on a cheap `HERDR_ENV` check so there is zero
import cost outside a Herdr pane, runs regardless of plugin enablement, and is
fully best-effort. On `session-start` it first reconciles any stale authority
left by a crashed prior process.

Team transitions reach the same seam because `src/team/runtime.ts` and
`src/hooks/notify-hook/team-dispatch.ts` emit their events through the dispatcher;
authoritative Team rollup is available via `mapTeamStateToRollup`
(`src/adapt/herdr/team-map.ts`), which consumes the real `WorkerStatus.state`
shape and the leader-attention flag from `src/team/state.ts`.

## Environment detection

Herdr exports these into managed pane processes; OMX reads them:

| Variable | Meaning |
| --- | --- |
| `HERDR_ENV=1` | running inside a Herdr-managed pane |
| `HERDR_PANE_ID` | the pane to report against (e.g. `w1:p1`) |
| `HERDR_SOCKET_PATH` | raw local socket for the JSON API (preferred transport) |
| `HERDR_BIN_PATH` | Herdr binary for the CLI fallback (must be an absolute path) |

The bridge is enabled only when `HERDR_ENV=1` **and** `HERDR_PANE_ID` are present.

## State mapping

| OMX event(s) | Herdr state |
| --- | --- |
| `session-start`, `run.heartbeat`, `worker.assigned`, `worker.recovered`, `test-started`, `pre-tool-use`, `post-tool-use` | `working` |
| `blocked`, `run.blocked_on_user`, `run.blocked_on_system`, `needs-input`, `handoff-needed` | `blocked` |
| `turn-complete`, `finished`, `failed`, `session-idle`, `stop`, `session-end` | `idle` |
| anything unmapped / reconciliation-uncertain | `unknown` |

Only whole-session shutdown (`stop`, `session-end`) is **authority-terminal**:
after reporting `idle` OMX releases authority. Per-run outcomes
(`finished`/`failed`) map to `idle` without releasing, because a single run
ending does not mean OMX has left the pane.

### Team rollup

Precedence: (1) `blocked` if the leader is blocked on user input or a worker is
blocked on user action; (2) otherwise `working` while any worker is active;
(3) otherwise `idle`. A worker blocked on the system alone does not escalate the
pane to `blocked`.

## Durable ordering (`seq`)

Herdr accepts but ignores a report whose `seq <= last accepted seq for the same
source`. Because hooks run as short-lived processes, an in-memory counter would
reset to `1` on every process/restart, so legitimate new reports would be
rejected as stale after a restart and stale reports would not be prevented
across concurrent processes.

`src/adapt/herdr/seq-store.ts` persists a per-source counter under
`.omx/adapters/herdr/seq/<source>.json`, incremented under an atomic
`mkdir`-based lock (with stale-lock recovery). This makes `seq` strictly
increasing per source across concurrent processes and restarts. The same
monotonic stream is used for both report and release. If the lock cannot be
acquired, a wall-clock-floored fallback seq is used so a report is never dropped
and never regresses below the last persisted value.

## Transports

- **Socket (preferred)** — newline-delimited JSON over the local Herdr socket
  using the documented `pane.report_agent` / `pane.release_agent` methods. The
  transport writes the request, then reads reply lines with a **bounded buffer**,
  parses NDJSON, **correlates by request `id`**, and reports `ok` only on a
  matching `{id,result}` (Herdr acceptance). It rejects on `{id,error}`, id
  mismatch, timeout, oversized frame, or a socket close before reply.
- **CLI (fallback)** — `herdr pane report-agent/release-agent …` executed via
  `execFile` (argv array, no shell). The binary is **trust-pinned**: only an
  absolute path to an existing file (`HERDR_BIN_PATH`) is accepted; a bare
  PATH-resolved `herdr` is never used.

## Metadata

Semantic `message` and display-only metadata tokens are bounded and redacted at
the boundary (`src/adapt/herdr/sanitize.ts`): whitespace collapsed, length
capped, token count capped, secret-like keys/values dropped, and absolute paths
redacted, before anything is sent to Herdr. Metadata tokens are transmitted on
the socket transport as `tokens`.

## Release + crash reconciliation

`release` only fires on whole-session shutdown and is suppressed while another
OMX workflow remains active (`workflowActiveFn`). An authority record
(`.omx/adapters/herdr/authority.json`) captures the owning pid; on the next
`session-start`, `reconcileStaleAuthority` clears the record if its owner process
is no longer alive, so a crash does not leave permanent stale Herdr authority.

## Protocol verification

Verified against the official Herdr source at commit
`1f2487554b9fd42118f9e99ee06eb558bbb2391f`:

- `PaneReportAgentParams { seq: Option<u64> }`
- CLI `herdr pane report-agent ... [--seq N]` and `herdr pane release-agent ... [--seq N]`
- the server forwards `seq` into `HookStateReported`

and against the published protocol docs (herdr.dev/docs/socket-api,
/docs/agents): `pane.report_agent`, `pane.release_agent`,
`pane.clear_agent_authority`, `seq`-based ordering, and NDJSON request/response
over a local socket.

## Code layout

- `src/adapt/herdr/semantic.ts` — pure event→state mapping and Team rollup.
- `src/adapt/herdr/seq-store.ts` — durable atomic per-source monotonic seq.
- `src/adapt/herdr/sanitize.ts` — metadata/message bounding + redaction.
- `src/adapt/herdr/transport.ts` — env detection, trust-pinned CLI, socket
  request/response.
- `src/adapt/herdr/team-map.ts` — real Team-state → rollup mapping.
- `src/adapt/herdr/authority.ts` — authority record + crash reconciliation.
- `src/adapt/herdr/bridge.ts` — `HerdrBridge`: opt-in gate, durable seq,
  sanitized reports, gated release.
- `src/adapt/herdr/wiring.ts` — `reportHerdrLifecycleEvent`, invoked from the
  hook dispatcher.
- `src/adapt/herdr.ts` — `omx adapt herdr` target metadata.

## Phase 2 (out of scope)

Using Herdr as a pluggable multiplexer/runtime backend for Team panes/workspaces
(instead of nested tmux) is deferred.
