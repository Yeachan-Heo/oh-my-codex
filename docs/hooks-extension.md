# Hooks Extension (Custom Plugins)

OMX supports an additive hooks extension point for user plugins under `.omx/hooks/*.mjs`.

> Compatibility guarantee: `omx tmux-hook` remains fully supported and unchanged.
> The new `omx hooks` command group is additive and does **not** replace tmux-hook workflows.

## Quick start

```bash
omx hooks init
omx hooks status
omx hooks validate
OMX_HOOK_PLUGINS=1 omx hooks test
```

This creates a scaffold plugin at:

- `.omx/hooks/sample-plugin.mjs`

## Enablement model

Plugins are **disabled by default**.

Enable plugin dispatch explicitly:

```bash
export OMX_HOOK_PLUGINS=1
```

Optional timeout tuning (default: 1500ms):

```bash
export OMX_HOOK_PLUGIN_TIMEOUT_MS=1500
```

## Native event pipeline (v1)

Native events are emitted from existing lifecycle/notify paths:

- `session-start`
- `session-end`
- `turn-complete`
- `session-idle`

Envelope fields include:

- `schema_version: "1"`
- `event`
- `timestamp`
- `source` (`native` or `derived`)
- `context`
- optional IDs: `session_id`, `thread_id`, `turn_id`, `mode`

## Derived signals (opt-in)

Best-effort derived events are gated and disabled by default.

```bash
export OMX_HOOK_DERIVED_SIGNALS=1
```

Derived signals include:

- `needs-input`
- `pre-tool-use`
- `post-tool-use`

Derived events are labeled with:

- `source: "derived"`
- `confidence`
- parser-specific context hints

## Team-safety behavior

In team-worker sessions (`OMX_TEAM_WORKER` set), plugin side effects are skipped by default.
This keeps the lead session as the canonical side-effect emitter and avoids duplicate sends.

## Plugin contract

Each plugin must export:

```js
export async function onHookEvent(event, sdk) {
  // handle event
}
```

SDK surface includes:

- `sdk.tmux.sendKeys(...)`
- `sdk.log.info|warn|error(...)`
- `sdk.state.read|write|delete|all(...)` (plugin namespace scoped)

## Logs

Plugin dispatch and plugin logs are written to:

- `.omx/logs/hooks-YYYY-MM-DD.jsonl`
