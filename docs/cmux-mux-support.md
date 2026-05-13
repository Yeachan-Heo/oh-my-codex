# cmux mux support contract

OMX historically called `tmux` directly from hook and team-runtime paths. The
runtime now has a narrow mux adapter bridge so those legacy call sites can keep
their existing tmux behavior while cmux surfaces can opt in.

## Selection

The mux kind is resolved in this order:

1. `OMX_MUX=tmux` or `OMX_MUX=cmux`
2. `OMX_MUX=auto` plus a cmux terminal environment (`CMUX_SURFACE_ID` or
   `CMUX_WORKSPACE_ID`)
3. default `tmux`

Binary overrides:

- `OMX_TMUX_BIN` / `OMX_TEST_TMUX_BIN`
- `OMX_CMUX_BIN` / `OMX_TEST_CMUX_BIN`
- generic fallback `OMX_MUX_BIN` / `OMX_TEST_MUX_BIN`

`tmux` remains the default and the legacy `TMUX` / `TMUX_PANE` state keys remain
valid. cmux uses `CMUX_WORKSPACE_ID` as the session/workspace target and
`CMUX_SURFACE_ID` as the pane/surface target, with legacy tmux env values as
fallbacks where needed. cmux terminal variables alone do not override the tmux
default; use `OMX_MUX=auto` for env-driven cmux detection or `OMX_MUX=cmux` for
an explicit cmux run. `CMUX_SOCKET_PATH` is not enough to auto-select cmux
because it can be configured outside an attached cmux terminal.

## Command subset

The initial cmux bridge covers the prompt-injection subset OMX needs most often:

| OMX legacy tmux argv | cmux argv |
| --- | --- |
| `send-keys -t <surface> -l <text>` | `send --surface <surface> <text>` |
| `send-keys -t <surface> C-m` | `send-key --surface <surface> Enter` |
| `capture-pane -t <surface> -p -S -<n>` | `capture-pane --surface <surface> --scrollback --lines <n>` |
| `display-message -p ... '#{pane_in_mode}'` | `display-message -p 0` |
| `display-message -p ... '#{pane_id}'` | `display-message -p <surface>` |
| `display-message -p ... '#S'` | `display-message -p <workspace>` |

Unknown commands are passed through to cmux so its own tmux-compatible aliases
can handle them when available.

## Intentional limits

- Live cmux is not required in CI; tests use mock binaries.
- Attach/detach remain tmux-specific in the Rust mux contract because cmux
  attachment is managed by the cmux app.
- Broad file renames from `tmux-*` to `mux-*` are intentionally deferred to keep
  the compatibility PR reviewable.

## Verification

Recommended checks for this surface:

```sh
npm run build
node --test dist/hooks/__tests__/mux-adapter.test.js dist/hooks/__tests__/notify-hook-team-tmux-guard.test.js
cargo test -p omx-mux
```
