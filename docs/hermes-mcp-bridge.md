# Hermes MCP bridge

OMX exposes a small optional MCP server for Hermes-style coordinators that need to dispatch work, poll status, and fetch result artifacts without scraping tmux panes or terminal text.

Launch target:

```bash
omx mcp-serve hermes
```

The plugin manifest registers it as `omx_hermes` and keeps it disabled by default, like the other first-party OMX MCP servers.

## Boundary

Hermes or another coordinator owns intake, operator Q&A, package shaping, and external approval policy. OMX owns planning, execution, review, and local artifact production inside a bounded worktree/session. The bridge only connects those product-facing responsibilities.

The v1 bridge intentionally does **not** expose:

- interactive `$deep-interview` turn routing
- tmux scrollback scraping or terminal UI control
- broad internal team/control-room operations
- GitHub merge policy, approval gates, or repository mutation outside OMX launch/follow-up/report files

Set `OMX_MCP_WORKDIR_ROOTS` when running this server for an external client to restrict `workingDirectory` values to known safe roots.

## Tools

Read tools:

- `hermes_list_sessions` — list known OMX session-state directories and active mode names.
- `hermes_read_status` — read selected session/mode JSON status.
- `hermes_read_tail` — read `.omx/logs/session-history.jsonl` tail, not tmux scrollback.
- `hermes_list_artifacts` — list safe result artifacts under `.omx/plans`, `.omx/specs`, `.omx/goals`, `.omx/context`, and `.omx/reports`.
- `hermes_read_artifact` — read one safe relative `.omx/...` artifact with byte truncation.

Mutating tools require `allow_mutation: true`:

- `hermes_start_session` — starts `omx --tmux --worktree[=<name>] <prompt>` from the bounded working directory.
- `hermes_send_prompt` — queues one prompt through the existing audited `exec-followups.json` contract for a selected exec session.
- `hermes_report_status` — writes `.omx/state[/sessions/<session_id>]/hermes-coordination.json` with final/blocker/PR summary data.

Failure responses are explicit JSON with `ok: false`, `code`, and `error`, including `no_session`, `prompt_not_accepted`, `artifact_missing`, `artifact_outside_safe_roots`, `mutation_not_allowed`, and `command_failed`.
