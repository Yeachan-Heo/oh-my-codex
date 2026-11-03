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

## Current limitations (follow-ups)

- **Scaling** (`team scale up`) is tmux-only for now and returns a clear error
  on the herdr backend.
- **Idle nudges** rely on tmux pane capture; on herdr they degrade to no-ops.
- **Detached (madmax) launch**, HUD watch pane, and the Rust `MuxAdapter`
  (`crates/omx-mux`) remain tmux-only.

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
