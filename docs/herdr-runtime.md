# Herdr team runtime backend (issue #3241, Phase 2)

OMX team workers can run on [Herdr](https://herdr.dev) — the agent-aware
terminal multiplexer — instead of nested tmux. When selected, one Herdr
workspace is created per team and every worker becomes a Herdr tab hosting a
recognized agent (`agent start --kind codex|claude|gemini`). Workers are then
driven through Herdr's semantic agent surface (`agent prompt`, `agent read`,
`agent list`) rather than raw keystrokes, and the Herdr sidebar replaces the
tmux HUD watch pane with per-agent `working` / `blocked` / `done` states.

This is the runtime backend deferred by the Phase 1 status bridge
([docs/herdr-bridge.md](herdr-bridge.md)); the two layers are independent and
compose — a team running *on* the Herdr backend still reports lifecycle state
when OMX itself runs inside a Herdr pane.

## Selecting the backend

Resolution mirrors `readTeamModeConfig` (highest wins):

1. env `OMX_MULTIPLEXER=tmux|herdr`
2. project `.omx/setup-scope.json` → `"multiplexer"`
3. `$CODEX_HOME/.omx-config.json` → `"multiplexer"` (or `features.multiplexer`)
4. default `tmux` — zero behavior change

An explicit `OMX_TEAM_WORKER_LAUNCH_MODE=prompt` still wins over the
multiplexer setting (prompt workers need no multiplexer at all). Invalid values
fall back to `tmux`.

## Mapping

| Team concept | tmux backend | herdr backend |
| --- | --- | --- |
| team session | `omx-team-<name>` session | `omx-team-<name>` workspace (label) |
| worker pane | split-window pane (`%N`) | one tab per worker; pane `wN:pM` |
| worker process | startup script in pane | `agent start omx-<team>-<hash>-w<i> --kind <cli>` |
| task submit | `send-keys -l` + Enter rounds | `agent prompt` (submission-verified, honors bracketed paste) |
| output capture | `capture-pane -J -p` | `pane read --source recent-unwrapped` |
| liveness | `#{pane_dead}` / PID proof | presence in live `agent list` (names clear on exit) |
| interrupt | `send-keys C-c` | `agent send-keys ctrl+c` |
| worker teardown | `kill-pane` | `pane close` |
| session teardown | `kill-session` | `workspace close` |
| HUD watch pane | split below leader | not used — Herdr sidebar is the HUD |

Engine: `src/team/herdr-session.ts`. All invocations are `execFile` argv arrays
(no shell); the binary is trust-pinned to `HERDR_BIN_PATH` when that env var
holds an absolute path to an existing file (same policy as the Phase 1 bridge).

Idle nudges (`src/team/idle-nudge.ts`) are backend-aware: pane ids matching
the herdr grammar (`wN:pM`, alphanumeric past 9) capture through
`pane read --source recent-unwrapped` — the same joined-line semantics as
`capture-pane -J`, so the shared `paneLooksReady` / `paneHasActiveTask`
classifiers apply unchanged — and the nudge itself is submitted through
`agent prompt` instead of tmux send-keys.

## Server bootstrap

Herdr CLI commands fail with `server_not_running` when no Herdr server owns
`~/.config/herdr/herdr.sock`. When the backend is selected, OMX starts the
headless server (`herdr server`, detached) on demand and polls until it
answers. The server — and therefore the workers — outlive the OMX process,
matching Herdr's model; stop everything with `herdr server stop`.

Herdr restores previous workspaces on server start. OMX only ever addresses
resources by the explicit IDs it created (`--workspace` is always passed to
`tab create`); it never operates on the user's other workspaces.

## Persistence

`TeamConfig.worker_launch_mode` gains `'herdr'`; the tmux session field holds
the `herdr-<team>` sentinel (the prompt mode uses `prompt-<team>` the same
way). `WorkerInfo.pane_id` stores the Herdr pane id (`wN:pM`) — the workspace
id is derivable from any worker pane id, so no schema fields were added.
Stale-team detection and `findActiveTeams` prove herdr-team liveness through
the agent inventory instead of `tmux list-sessions`.

## Rust MuxAdapter

`crates/omx-mux` ships `HerdrAdapter` next to `TmuxAdapter`, implementing the
same generic `MuxAdapter` trait (resolve-target / send-input / capture-tail /
inspect-liveness / attach / detach) against the pane-addressed Herdr CLI:
`agent prompt` for SendInput (the submit policy's Enter presses are satisfied
by the semantic submission), `pane read --source recent-unwrapped` for
CaptureTail, and the live `agent list` inventory for liveness. Targets are
validated against the `wN:pM` grammar before any process is spawned, and the
binary honors the same `HERDR_BIN_PATH` trust-pin as the TypeScript backend.
Detach is `Unsupported` — detaching is a Herdr TUI keybinding with no CLI
surface.

## Detached launch design (not yet implemented)

Detached (madmax) launch remains tmux-only. This section records why a
mechanical port is not possible and what a herdr-native implementation would
look like, so the follow-up does not rediscover the mapping.

### Why the tmux step machine does not port

`buildDetachedSessionBootstrapSteps` (src/cli/index.ts) emits raw tmux argv
steps, and `launchDetachedSession` drives them through an authority envelope
that is tmux-specific at every joint:

- **Identity fences**: `DetachedLeaderAuthority` / `DetachedHudAuthority` bind
  `(session_name, session_id $N, session_created, window_index, window_id @N,
  pane_id %N, pane_pid)`. Herdr has no session/window/PID identities — its
  stable unit is the never-reused pane id `wN:pM`.
- **Guarded mutations**: tag/history-limit/remain-on-exit/split/HUD effects run
  through `if-shell` receipt-fenced commands (`runDetachedLeaderMutation`,
  `runDetachedLeaderSplit`, `tagDetachedHudPane`) that re-prove the exact pane
  incarnation immediately before each server-side effect. This machinery
  exists because tmux recycles pane ids; herdr ids are never reused, so the
  fences would be both unimplementable (no if-shell/set-option) and
  unnecessary.
- **HUD sub-machine**: the detached HUD is a tmux split with
  resize/client-attached `set-hook`s, delayed resizes, and window-cramping
  checks. Herdr teams already declare the sidebar the HUD; there is no
  herdr equivalent and none is needed.
- **Readiness binding**: the leader-written release-marker report is
  backend-independent, but `isDetachedReadyReportAuthorized` binds it to the
  tmux pane id + pane PID.

### Herdr-native sketch (Phase 3)

- **Leader container**: `herdr workspace create --cwd <cwd> --label
  omx-detached-<session> --no-focus` (a label prefix distinct from
  `omx-team-`); never operate on the focused workspace. Env delivery rides
  `tab create --env KEY=VALUE` (control-plane keys, `CODEX_HOME`,
  `OMX_TEAM_WORKER_LAUNCH_ARGS`, notify temp contract, inherited model) —
  the tab replaces `new-session -e`.
- **Leader process**: `herdr pane run <pane> "<omx leader command>"` in the
  created tab's root pane (plain shell command + Enter; the startup-script
  machinery from `buildDetachedSessionLeaderCommand` can be reused verbatim
  since `pane run` executes a shell string).
- **Readiness**: keep the release-marker protocol; authorize the report with
  a herdr binding `(nonce, sessionId, workspace label, paneId)` plus the
  agent identity from `agent get` instead of pane PID.
- **Attach**: `herdr agent attach <pane>` (interactive) or workspace focus in
  the TUI; `session attach` binds to herdr *sessions*, a different concept —
  verify before relying on it.
- **Rollback/teardown**: `workspace close <id>` reaps the whole topology in
  one idempotent step; `pane_not_found` on individual closes proves
  convergence (same invariant the scaling paths use).
- **Liveness**: live `agent list` inventory.

The authority story simplifies rather than translates: because herdr pane ids
are never reused and every command pins an explicit workspace/pane id, the
recorded id itself is the effect authority — the receipt fences collapse into
"verify the recorded id still resolves, then act", which is what
`src/team/herdr-session.ts` + the scaling paths already do.

Recommended first step when implementing: an explicit gate in the detached
launch path that returns a clear "detached launch is tmux-only" error when
`multiplexer=herdr` is resolved (today it silently launches via tmux, which
is harmless but surprising), then the workspace/tab leader container above.

## Current limitations (follow-ups)

- **Detached (madmax) launch** and the HUD watch pane remain tmux-only
  (design above).

## Scaling

`team scale up` / `scale down` work on the herdr backend. Scale-up derives the
team workspace from any existing worker pane id (`wN:pM` → `wN`), ensures the
Herdr server is running, and spawns each new worker as a tab + agent inside
that workspace (`spawnOneHerdrWorker`, the same per-worker core
`createHerdrTeam` uses: env via `tab create --env`, trust-dialog dismissal,
agent-name collision fallback). Bootstrap dispatch goes through
`agent prompt` instead of tmux send-keys. Because herdr pane ids are never
recycled, the tmux recycled-pane proofs (PID pinning, owner tags,
session/window receipts) do not apply: teardown addresses the recorded pane id
directly, and a `pane_not_found` answer proves convergence. Worker records
carry no `pid`/`session_id`/`window_id`; scale-down cleanup debt journals
herdr panes with `pid: null`.

## Verification

- `src/team/__tests__/herdr-session.test.ts` — unit coverage (argv builders,
  envelope/error handling, agent naming, create + rollback, ops).
- `src/team/__tests__/herdr-session-realherdr.test.ts` — integration test
  against a real `herdr` binary (self-skipping when not installed, like the
  real-tmux suites): creates a workspace + real `codex` agent, proves
  liveness/capture, tears down, and leaves the machine as found.
- Verified manually against Herdr **v0.9.5** (latest stable at the time of
  writing); the control-command JSON envelope (`{"id","result"|"error"}`) and
  `server_not_running` / `agent_name_taken` error codes are load-bearing.
