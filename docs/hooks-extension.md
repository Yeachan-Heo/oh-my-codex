# Hooks Extension (Custom Plugins)

OMX supports an additive hooks extension point for user plugins under `.omx/hooks/*.mjs`.

Native Codex hook ownership is documented separately in
[Codex native hook mapping](./codex-native-hooks.md). In short:

- `.codex/hooks.json` = native Codex hook registrations installed by `omx setup`
- `.omx/hooks/*.mjs` = OMX plugin hooks dispatched by runtime/native events
- `omx tmux-hook` / notify-hook / derived watcher = tmux/runtime fallback surfaces

`omx setup` treats `.codex/hooks.json` as a shared-ownership file: it refreshes only the OMX-managed
wrapper entries that invoke `dist/scripts/codex-native-hook.js` and preserves user hook entries in the
same file. `omx uninstall` removes only those OMX-managed wrappers and leaves `.codex/hooks.json` in
place when user hooks remain.

> Compatibility guarantee: `omx tmux-hook` remains fully supported and unchanged.
> The new `omx hooks` command group is additive and does **not** replace tmux-hook workflows.

## Quick start

```bash
omx hooks init
omx hooks status
omx hooks validate
omx hooks test
```

This creates a scaffold plugin at:

- `.omx/hooks/sample-plugin.mjs`

## Enablement model

Plugins are **enabled by default**.

Disable plugin dispatch explicitly:

```bash
export OMX_HOOK_PLUGINS=0
```

Optional timeout tuning (default: 1500ms):

```bash
export OMX_HOOK_PLUGIN_TIMEOUT_MS=1500
```

## Native event pipeline (v1)

Native/derived plugin events come from two places:

1. Existing lifecycle/notify paths
2. Native Codex hook entrypoint dispatch (`dist/scripts/codex-native-hook.js`)

Current event vocabulary exposed to OMX plugins:

- `session-start`
- `keyword-detector`
- `pre-tool-use`
- `post-tool-use`
- `stop`
- `session-end`
- `turn-complete`
- `session-idle`

OMX keeps this existing event vocabulary rather than exposing raw Codex hook names directly.
That lets native Codex hooks and fallback/derived paths feed one shared plugin/runtime surface.

For clawhip-oriented operational routing, see [Clawhip Event Contract](./clawhip-event-contract.md).

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
- `sdk.omx.session.read()`
- `sdk.omx.hud.read()`
- `sdk.omx.notifyFallback.read()`
- `sdk.omx.updateCheck.read()`

`sdk.omx` is intentionally narrow and read-only in pass one. These helpers read the
repo-root `.omx/state/*.json` runtime files for the current workspace.

Compatibility notes:

- `omx tmux-hook` remains a CLI/runtime workflow, not `sdk.omx.tmuxHook.*`
- pass one does not add `sdk.omx.tmuxHook.*`; tmux plugin behavior stays on `sdk.tmux.sendKeys(...)`
- pass one does not add generic `sdk.omx.readJson(...)`, `sdk.omx.list()`, or `sdk.omx.exists()`
- pass one does not add `sdk.pluginState`; keep using `sdk.state`

## Logs

Plugin dispatch and plugin logs are written to:

- `.omx/logs/hooks-YYYY-MM-DD.jsonl`
