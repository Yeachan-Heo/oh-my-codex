# `.omx-config.json` model/env routing reference

This page documents the `.omx-config.json` keys that current `oh-my-codex` code recognizes, with extra detail for **model and environment routing**. Feature-owned settings such as notifications and OpenClaw remain documented near those features, but their supported key shapes are summarized here so this page can act as a safe schema map.

Do not add or edit keys unless your installed OMX version recognizes them. Unknown keys are not a stable extension point, and malformed JSON or wrong-shaped sections may be ignored or may fail closed for the feature reading them.

## Where the file is read

Most `.omx-config.json` readers resolve through the active Codex home:

| Setup shape | Config file | Notes |
| --- | --- | --- |
| User scope | `${CODEX_HOME:-~/.codex}/.omx-config.json` | Default setup shape. `CODEX_HOME` wins when set. |
| Project scope | `./.codex/.omx-config.json` | Used by OMX launch paths when `./.omx/setup-scope.json` says `project` and `CODEX_HOME` is not already set. |

Project-scoped setup also writes `./.codex/config.toml`, `./.codex/hooks.json`, and project-local skills/prompts/agents. User-scoped setup writes the corresponding files under `${CODEX_HOME:-~/.codex}`.

The wiki lifecycle reader is a project-root exception because it runs from hook payload `cwd`: it checks `<root>/.omx-config.json` first, then `${CODEX_HOME:-~/.codex}/.omx-config.json`, and falls back to built-in wiki defaults if neither file has a valid `wiki` object. The project-scope Codex-home file `./.codex/.omx-config.json` still applies when `CODEX_HOME` resolves to `./.codex`; it is not an extra wiki-only lookup path.

`omx setup --scope project` persists the project-scope choice in `./.omx/setup-scope.json`; `omx doctor` prints the resolved setup scope and the Codex home/config paths it is checking.

## Supported top-level keys

Current code recognizes these top-level `.omx-config.json` keys:

| Top-level key | Supported shape | Primary use |
| --- | --- | --- |
| `agentReasoning` | Object mapping agent names to `low`, `medium`, `high`, or `xhigh` | Optional per-agent reasoning overrides for generated native agent TOML and role-based worker/Ralph staffing guidance. |
| `env` | Object of non-empty string values | Fallback environment values for model routing and helper launch paths. Model-related supported keys are listed below. |
| `models` | Object of non-empty string values | Mode defaults and low-complexity model aliases. Supported model-routing keys are listed below. |
| `notifications` | Object | Notification transports, profiles, templates, cooldowns, replies, and OpenClaw/custom aliases. See the notification summary below and the OpenClaw guide for full examples. |
| `stopHookCallbacks` | Legacy object | Backward-compatible legacy session-end notification config for `telegram` and `discord`; prefer `notifications`. |
| `promptRouting` | `{ "triage": { "enabled": boolean } }` | Enables/disables advisory triage prompt routing. Missing key defaults to enabled; malformed shape fails closed to disabled. |
| `autoNudge` | Object | Native auto-continuation settings for matched permission/stall prompts. Supported keys: `enabled`, `patterns`, `response`, `delaySec`, `stallMs`, `ttlMs`, and legacy `cooldownMs`. This is not the deprecated team worker stall/progress nudge path; do not add `OMX_TEAM_PROGRESS_STALL_MS` or `OMX_TEAM_WORKER_TURN_STALL_MS` as operator tuning guidance. |
| `wiki` | Object | Project wiki lifecycle settings. Supported keys: `enabled`, `autoCapture`, `maxContextLines`, `staleDays`, `maxPageSize`, `feedProjectMemoryOnStart`. |

### Notification-owned keys

`notifications` supports the following current shapes:

- Global fields: `enabled`, `verbosity` (`verbose`, `agent`, `session`, or `minimal`), `defaultProfile`, `profiles`, `events`, `hookTemplates`, `reply`, `dispatchCooldownSeconds`, and `idleCooldownSeconds`.
- Platform fields: `discord`, `discord-bot`, `telegram`, `slack`, `webhook`.
- OpenClaw/custom transport fields: `openclaw`, `custom_webhook_command`, and `custom_cli_command`.
- Event keys under `events`: `session-start`, `session-stop`, `session-end`, `session-idle`, and `ask-user-question`. Each event can set `enabled`, `messageTemplate`, and platform overrides.
- `hookTemplates` supports `version`, `enabled`, `events`, and `defaultTemplate`; per-event template config supports `enabled`, `template`, and platform template overrides.
- `reply` supports `enabled`, `authorizedDiscordUserIds`, `pollIntervalMs`, `rateLimitPerMinute`, `maxMessageLength`, and `includePrefix`.
- `notifications.openclaw` supports `enabled`, `gateways`, and `hooks`. Gateway entries are HTTP (`type`, `url`, `headers`, `method`, `timeout`) or command (`type`, `command`, `timeout`). Hook entries use `gateway`, `instruction`, and `enabled`.

Use [`docs/discord-integration.md`](../discord-integration.md) for Discord webhook-vs-bot setup and [`docs/openclaw-integration.md`](../openclaw-integration.md) for full notification/OpenClaw examples. Keep credentials in environment variables where possible.

## Supported model/env keys

The model-routing reader supports `env`, `models`, and the role-reasoning override map `agentReasoning`.

```json
{
  "agentReasoning": {
    "architect": "xhigh",
    "critic": "xhigh"
  },
  "env": {
    "OMX_DEFAULT_FRONTIER_MODEL": "gpt-5.5",
    "OMX_DEFAULT_STANDARD_MODEL": "gpt-5.4-mini",
    "OMX_DEFAULT_SPARK_MODEL": "gpt-5.3-codex-spark"
  },
  "models": {
    "default": "gpt-5.5",
    "team": "gpt-5.5",
    "team_low_complexity": "gpt-5.3-codex-spark"
  }
}
```

### `env`

`env` provides fallback environment values when the real shell environment did not set them. Shell environment variables still win.

Supported model-related keys:

| Key | Purpose |
| --- | --- |
| `OMX_DEFAULT_FRONTIER_MODEL` | Main/frontier default used by leaders and frontier-class roles when no stronger config wins. |
| `OMX_DEFAULT_STANDARD_MODEL` | Optional standard-lane override. If omitted, standard agents inherit the main/frontier default. |
| `OMX_DEFAULT_SPARK_MODEL` | Spark/fast-lane default for low-cost exploration and low-complexity workers. |
| `OMX_SPARK_MODEL` | Legacy spark fallback; prefer `OMX_DEFAULT_SPARK_MODEL` for new config. |
| `OMX_TEAM_CHILD_MODEL` | Default child model for specific team-child paths that read this setting directly. |

`readConfiguredEnvOverrides()` also passes through other non-empty string values from `env` for launch helpers such as `omx explore` and `omx sparkshell`. Treat those as advanced environment overrides, not a schema for per-role model routing.

### `models`

`models` maps mode names to explicit model overrides. Values must be non-empty strings.

Supported model-routing keys:

| Key shape | Purpose |
| --- | --- |
| `default` | Fallback for `getModelForMode(mode)` when the requested mode has no explicit key. |
| Any mode key, for example `team`, `autopilot`, `ralph` | Explicit model for that mode when code calls `getModelForMode("mode")`. |
| `team_low_complexity` | Low-complexity team/spark model override. |
| `team-low-complexity` | Alias for `team_low_complexity`. |
| `teamLowComplexity` | Alias for `team_low_complexity`. |

Do not invent per-role maps such as `models.executor`, `models.architect`, or `models.roles` unless your installed version documents that exact key. Current role routing is based on agent definitions and model class, not arbitrary per-role JSON maps.

### `agentReasoning`

`agentReasoning` is the supported per-agent reasoning override map. Keys are agent names and values must be one of `low`, `medium`, `high`, or `xhigh`.

```json
{
  "agentReasoning": {
    "architect": "xhigh",
    "critic": "xhigh"
  }
}
```

These overrides do not change built-in defaults in source. They are user/project configuration that applies when OMX resolves role reasoning for generated native agent TOML and role-based team/Ralph staffing/worker guidance. Rerun `omx setup` after changing this map so setup-managed native agent TOML files are regenerated. Malformed agent names, empty values, and unsupported effort values are ignored.

## Effective model precedence

### Main/frontier default

The main default resolves in this order:

1. Shell `OMX_DEFAULT_FRONTIER_MODEL`
2. `.omx-config.json` `env.OMX_DEFAULT_FRONTIER_MODEL`
3. Active Codex `config.toml` root `model`
4. Built-in default: `gpt-5.5`

### Mode-specific model lookup

When code asks for `getModelForMode(mode)`, the mode model resolves in this order:

1. `.omx-config.json` `models[mode]`
2. `.omx-config.json` `models.default`
3. Main/frontier default above

Example: with `models.team = "gpt-5.5"` and `models.default = "gpt-5.4-mini"`, `team` uses `gpt-5.5`; a mode without its own key uses `gpt-5.4-mini`.

### Standard-lane agents

Standard-lane agents resolve in this order:

1. Shell `OMX_DEFAULT_STANDARD_MODEL`
2. `.omx-config.json` `env.OMX_DEFAULT_STANDARD_MODEL`
3. Main/frontier default

This means standard agents inherit the leader/frontier model unless you opt into a standard-lane override.

### Spark/fast-lane agents

Spark/fast defaults resolve in this order:

1. Shell `OMX_DEFAULT_SPARK_MODEL`
2. Shell legacy `OMX_SPARK_MODEL`
3. `.omx-config.json` `env.OMX_DEFAULT_SPARK_MODEL`
4. `.omx-config.json` legacy `env.OMX_SPARK_MODEL`
5. `.omx-config.json` `models.team_low_complexity`, `models.team-low-complexity`, or `models.teamLowComplexity`
6. Built-in default: `gpt-5.3-codex-spark`

For team low-complexity helpers, the exact order depends on the call path: `getSparkDefaultModel()` checks spark env/config values before low-complexity aliases, while `getTeamLowComplexityModel()` checks low-complexity aliases before falling back to the spark default.

## Role/category routing examples

Native agent TOML generation and team model-contract logic use agent definitions with `modelClass` and `reasoningEffort` metadata. Native-agent generation has one important frontier-lane precedence detail: for frontier roles and the `executor` special case, it reads the active Codex `config.toml` root `model` first, then falls back to `getMainDefaultModel()` if that root model is absent. Because `getMainDefaultModel()` is only the fallback in this path, `.omx-config.json` `env.OMX_DEFAULT_FRONTIER_MODEL` does not override an explicit `config.toml` root `model` for generated native-agent TOML.

Examples:

| Role/category | Examples | Model class behavior |
| --- | --- | --- |
| Frontier orchestration | `planner`, `architect`, `critic`, `code-reviewer`, `security-reviewer`, `team-executor`, `vision` | Native-agent generation uses active `config.toml` root `model` first, then the main/frontier default fallback. |
| Standard worker/review | `debugger`, `quality-reviewer`, `api-reviewer`, `performance-reviewer`, `dependency-expert`, `writer`, `researcher` | Uses the standard-lane default, which inherits main/frontier unless `OMX_DEFAULT_STANDARD_MODEL` is set. |
| Fast/low-complexity | `explore`, `style-reviewer` | Uses the spark/low-complexity default. |
| Executor special case | `executor` | Native-agent generation uses active `config.toml` root `model` first, then the main/frontier default fallback; team fallback routing keeps it on the frontier lane. |

Team worker launches add another layer:

1. Explicit `--model ...` inside `OMX_TEAM_WORKER_LAUNCH_ARGS` wins.
2. Inheritable leader launch model args can be passed through to workers.
3. If no explicit/inherited model is present, the worker role's default model class selects the fallback model.
4. Fast roles such as `explore` and role names ending in `-low` use the low-complexity/spark fallback.

Use `omx team status <team-name> --model-inspect` when you need inspect hints for a running team; the regular status path avoids spending model quota on summaries.

## Reasoning effort: supported places only

`.omx-config.json` is **not** the general place to configure root `model_reasoning_effort`. Do not add arbitrary keys such as `reasoningEffort`, `modelReasoningEffort`, `reasoning`, or undeclared per-role reasoning maps. The supported per-agent override map is exactly `agentReasoning`.

Supported reasoning-effort surfaces are:

- Active Codex `config.toml` root key: `model_reasoning_effort = "medium"`.
- `omx reasoning <low|medium|high|xhigh>`, which edits the active Codex `config.toml`.
- `omx --high` and `omx --xhigh`, which pass `-c model_reasoning_effort="high|xhigh"` to Codex launch.
- Generated native agent TOML files, where OMX writes each role's built-in `reasoningEffort` metadata.
- `.omx-config.json` `agentReasoning`, which overrides selected role defaults for generated native agent TOML and role-based team/Ralph reasoning allocation without changing built-in defaults.
- Team worker launch args, for example:

```bash
OMX_TEAM_WORKER_LAUNCH_ARGS='-c model_reasoning_effort="low" --model gpt-5.3-codex-spark' \
  omx team 3:explore "map the config surfaces"
```

Team runtime can also inject role-default or `agentReasoning`-overridden reasoning for Codex workers when no explicit reasoning override is present. Explicit launch args win.

## Starter configs

JSON does not allow comments, so copy only the JSON blocks.

### Cost-saving starter

This keeps orchestration on the frontier default, routes standard workers to a cheaper standard model, and uses the spark lane for exploration/low-complexity work.

```json
{
  "env": {
    "OMX_DEFAULT_FRONTIER_MODEL": "gpt-5.5",
    "OMX_DEFAULT_STANDARD_MODEL": "gpt-5.4-mini",
    "OMX_DEFAULT_SPARK_MODEL": "gpt-5.3-codex-spark"
  },
  "models": {
    "default": "gpt-5.4-mini",
    "team": "gpt-5.5",
    "team_low_complexity": "gpt-5.3-codex-spark"
  }
}
```

### Max-quality starter

This keeps standard agents inheriting the frontier model by omitting `OMX_DEFAULT_STANDARD_MODEL`, while still preserving a fast spark lane for explicit low-complexity routing.

```json
{
  "agentReasoning": {
    "architect": "xhigh",
    "critic": "xhigh"
  },
  "env": {
    "OMX_DEFAULT_FRONTIER_MODEL": "gpt-5.5",
    "OMX_DEFAULT_SPARK_MODEL": "gpt-5.3-codex-spark"
  },
  "models": {
    "default": "gpt-5.5",
    "team": "gpt-5.5",
    "autopilot": "gpt-5.5",
    "ralph": "gpt-5.5",
    "team_low_complexity": "gpt-5.3-codex-spark"
  }
}
```

## Verifying the effective config

After editing `.omx-config.json` or `config.toml`, run setup/doctor from the same shell and project shape that will launch OMX:

```bash
omx setup
omx doctor
```

`omx doctor` reports the resolved setup scope, Codex home, config path, hook coverage, prompt/skill/agent availability, and selected prompt-routing status. This verifies install wiring and which config tree OMX is checking.

A green `omx doctor` is not proof that the active Codex profile can authenticate or run the selected model. For that, use the same shell/profile/project and run:

```bash
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

If behavior does not match your config, first confirm whether you are in user or project scope and whether `CODEX_HOME` is overriding the expected Codex home.

## Related docs and source surfaces

- Notification and OpenClaw config: [`docs/openclaw-integration.md`](../openclaw-integration.md)
- Project wiki config: [`docs/reference/project-wiki.md`](./project-wiki.md)
- Model routing source: `src/config/models.ts`
- Notification config source: `src/notifications/config.ts`, `src/notifications/types.ts`, `src/notifications/hook-config-types.ts`
- OpenClaw config source: `src/openclaw/types.ts`, `src/openclaw/config.ts`
- Prompt-routing config source: `src/hooks/triage-config.ts`
- Auto-nudge config source: `src/scripts/notify-hook/auto-nudge.ts`
- Wiki lifecycle config source: `src/wiki/types.ts`, `src/wiki/lifecycle.ts`
- Agent role definitions: `src/agents/definitions.ts`
- Native agent TOML generation: `src/agents/native-config.ts`
- Team model contract: `src/team/model-contract.ts`
- Scope/Codex home launch resolution: `src/cli/codex-home.ts`
