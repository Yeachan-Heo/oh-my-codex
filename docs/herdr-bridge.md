# Herdr lifecycle/status bridge (issue #3241)

OMX can report its lifecycle and Team state to a containing [Herdr](https://github.com/ogulcancelik/herdr)
pane so the Herdr sidebar reflects `working` / `blocked` / `idle` transitions
authored by OMX, instead of relying on Herdr's screen-manifest inference. This
is the **Phase 1** status bridge. The **Phase 2** runtime backend (Herdr as a
pluggable multiplexer replacing OMX's tmux runtime) is intentionally out of
scope for this work.

## Design goals

- **Opt-in.** No behavior change outside a detected Herdr pane. The bridge is
  inert unless OMX runs inside Herdr.
- **Best-effort and non-blocking.** A Herdr socket/CLI failure never fails an
  OMX run. No Herdr dependency is required.
- **OMX owns the truth.** OMX is the authoritative source of its lifecycle and
  Team state; Herdr is the rendering/notification consumer.
- **Ordered.** Reports carry a monotonically increasing per-source `seq` so late
  hook processes cannot overwrite newer state.
- **Clean handoff.** On terminal states / shutdown, OMX releases `omx:runtime`
  authority so Herdr returns to its normal Codex screen detection.

## Environment detection

Herdr exports the following into managed pane processes; OMX reads them:

| Variable | Meaning |
| --- | --- |
| `HERDR_ENV=1` | running inside a Herdr-managed pane |
| `HERDR_PANE_ID` | the pane to report against (e.g. `w1:p1`) |
| `HERDR_SOCKET_PATH` | raw local socket for the JSON API (preferred transport) |
| `HERDR_BIN_PATH` | Herdr binary for CLI fallback |

The bridge is enabled only when `HERDR_ENV=1` **and** `HERDR_PANE_ID` are present.

## State mapping

OMX hook lifecycle events map to Herdr semantic states:

| OMX event(s) | Herdr state |
| --- | --- |
| `session-start`, `run.heartbeat`, `worker.assigned`, `worker.recovered`, `test-started`, `pre-tool-use`, `post-tool-use` | `working` |
| `blocked`, `run.blocked_on_user`, `run.blocked_on_system`, `needs-input`, `handoff-needed` | `blocked` |
| `turn-complete`, `finished`, `failed`, `stop`, `session-end`, `session-idle` | `idle` |
| anything unmapped / reconciliation-uncertain | `unknown` |

Events `finished`, `failed`, `stop`, and `session-end` are **terminal**: after
reporting `idle`, OMX releases authority.

### Team rollup

For Team mode the bridge uses an authoritative rollup rather than pane-output
inference (precedence):

1. `blocked` if the leader is blocked on user input, or an authoritative
   worker/task is blocked on user action;
2. otherwise `working` while any worker/task is active;
3. otherwise `idle` when the run is terminal.

A worker blocked on the system alone does not escalate the whole pane to
`blocked`.

## Transports

Both transports are injectable (for testing) and shell-free:

- **CLI** — `herdr pane report-agent <pane> --source omx:runtime --agent codex
  --state <state> --seq <n>` and `herdr pane release-agent <pane> --source
  omx:runtime --seq <n>`, executed via `execFile` (argv array, never a shell),
  so pane ids / messages cannot inject shell syntax.
- **Socket** — newline-delimited JSON over the local Herdr socket, using the
  documented dot-notation methods `pane.report_agent` and `pane.release_agent`.

The socket transport is preferred when `HERDR_SOCKET_PATH` is exported.

## Protocol verification

The `seq` and authority-release surfaces were verified against the official
Herdr source at commit `1f2487554b9fd42118f9e99ee06eb558bbb2391f`:

- `PaneReportAgentParams { seq: Option<u64> }`
- CLI `herdr pane report-agent ... [--seq N]` and `herdr pane release-agent ... [--seq N]`
- the server forwards `seq` into `HookStateReported`

and against the published protocol docs (herdr.dev/docs/socket-api,
/docs/agents), which document `pane.report_agent`, `pane.release_agent`,
`pane.clear_agent_authority`, and `seq`-based ordering.

## Code layout

- `src/adapt/herdr/semantic.ts` — pure event→state mapping and Team rollup.
- `src/adapt/herdr/transport.ts` — env detection + CLI/socket transports.
- `src/adapt/herdr/bridge.ts` — `HerdrBridge`: opt-in gate, monotonic seq,
  terminal release, failure isolation.
- `src/adapt/herdr.ts` — `omx adapt herdr` target metadata (probe/status/
  envelope/doctor/init).

## Phase 2 (out of scope)

Using Herdr as a pluggable multiplexer/runtime backend for Team panes/workspaces
(instead of nested tmux) is deferred. The status bridge delivers value through
the stable Herdr API without replacing OMX's tmux runtime.
