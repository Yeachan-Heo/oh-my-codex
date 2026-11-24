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
| `agentModels` | Object mapping agent names to non-empty model strings | Optional per-agent model overrides for generated native agent TOML, AGENTS.md model tables, and role-based worker/Ralph fallback routing. |
| `agentReasoning` | Object mapping agent names to `low`, `medium`, `high`, `xhigh`, or `max` | Optional per-agent reasoning overrides for generated native agent TOML and role-based worker/Ralph staffing guidance.
| `env` | Object of non-empty string values | Fallback environment values for model routing and helper launch paths. Model-related supported keys are listed below. |
| `models` | Object of non-empty string values | Mode defaults and low-complexity model aliases. Supported model-routing keys are listed below. |
| `notifications` | Object | Notification transports, profiles, templates, cooldowns, replies, and OpenClaw/custom aliases. See the notification summary below and the OpenClaw guide for full examples. |
| `stopHookCallbacks` | Legacy object | Backward-compatible legacy session-end notification config for `telegram` and `discord`; prefer `notifications`. |
| `promptRouting` | `{ "triage": { "enabled": boolean } }` | Enables/disables advisory triage prompt routing. Missing key defaults to enabled; malformed shape fails closed to disabled. |
| `autoNudge` | Object | Native auto-continuation settings for matched permission/stall prompts. Supported keys: `enabled`, `patterns`, `response`, `delaySec`, `stallMs`, `ttlMs`, and legacy `cooldownMs`. This is not the deprecated team worker stall/progress nudge path; do not add `OMX_TEAM_PROGRESS_STALL_MS` or `OMX_TEAM_WORKER_TURN_STALL_MS` as operator tuning guidance. |
| `wiki` | Object | Project wiki lifecycle settings. Supported keys: `enabled`, `autoCapture`, `maxContextLines`, `staleDays`, `maxPageSize`, `feedProjectMemoryOnStart`. |

### Notification-owned keys

`notifications` supports the following current shapes:

- Global fields: `enabled`, `verbosity` (`verbose`, `agent`, `session`, or `minimal`), `includeChildAgents`, `defaultProfile`, `profiles`, `events`, `hookTemplates`, `reply`, `dispatchCooldownSeconds`, and `idleCooldownSeconds`.
- Platform fields: `discord`, `discord-bot`, `telegram`, `slack`, `webhook`.
- OpenClaw/custom transport fields: `openclaw`, `custom_webhook_command`, and `custom_cli_command`.
- Event keys under top-level `notifications.events`: `session-start`, `session-stop`, `session-end`, `session-idle`, and `ask-user-question`. Each event can set `enabled`, `messageTemplate`, and platform overrides; per-platform blocks such as `notifications.telegram` do not own an `events` filter.
- Native child-agent/subagent lifecycle hook dispatches are suppressed at `minimal`/`session` verbosity by default. Set `notifications.verbosity` to `agent`/`verbose`, or set `notifications.includeChildAgents: true`, to receive independent child-agent start/finish hook events.
- `hookTemplates` supports `version`, `enabled`, `events`, and `defaultTemplate`; per-event template config supports `enabled`, `template`, and platform template overrides.
- `reply` supports `enabled`, `authorizedDiscordUserIds`, `pollIntervalMs`, `rateLimitPerMinute`, `maxMessageLength`, and `includePrefix`.
- `notifications.openclaw` supports `enabled`, `gateways`, and `hooks`. Gateway entries are HTTP (`type`, `url`, `headers`, `method`, `timeout`) or command (`type`, `command`, `timeout`). Hook entries use `gateway`, `instruction`, and `enabled`.

Use [`docs/discord-integration.md`](../discord-integration.md) for Discord webhook-vs-bot setup and [`docs/openclaw-integration.md`](../openclaw-integration.md) for full notification/OpenClaw examples. Keep credentials in environment variables where possible.

## Supported model/env keys

The model-routing reader supports `env`, `models`, and the per-role override maps `agentModels` and `agentReasoning`. `agentModels` is empty by default; role defaults come from the tier environment variable or built-in tier default.

```json
{
  "env": {
    "OMX_DEFAULT_FRONTIER_MODEL": "gpt-6.2-astra",
    "OMX_DEFAULT_STANDARD_MODEL": "gpt-6.2-sol",
    "OMX_DEFAULT_SPARK_MODEL": "gpt-6-luna"
  },
  "agentModels": {}
}
```

### `env`

`env` provides fallback environment values when the real shell environment did not set them. Shell environment variables still win.

Supported model-related keys:

| Key | Purpose |
| --- | --- |
| `OMX_DEFAULT_FRONTIER_MODEL` | Frontier-agent model override; built-in default is `gpt-6.2-astra`. The root `config.toml` model is not used for agent tiers. |
| `OMX_DEFAULT_STANDARD_MODEL` | Standard-agent model override; built-in default is `gpt-6.2-sol`. Standard agents never inherit the frontier or leader model. |
| `OMX_DEFAULT_SPARK_MODEL` | Spark-agent model override; built-in default is `gpt-6-luna`. Spark agents never inherit the leader model. |
| `OMX_SPARK_MODEL` | Legacy fallback used only within the spark model chain; prefer `OMX_DEFAULT_SPARK_MODEL` for new config. |
| `OMX_TEAM_CHILD_MODEL` | Default child model for specific team-child paths that read this setting directly. |

`readConfiguredEnvOverrides()` also passes through other non-empty string values from `env` for launch helpers such as `omx explore` and `omx sparkshell`. Treat those as advanced environment overrides, not a schema for per-role model routing.

For `omx sparkshell`, the documented helper-specific environment keys are:

| Key | Purpose |
| --- | --- |
| `OMX_SPARKSHELL_BIN` | Override the native `omx-sparkshell` binary path. |
| `OMX_SPARKSHELL_MODEL` | Override the primary summary model. |
| `OMX_SPARKSHELL_FALLBACK_MODEL` | Override the retry summary model when the primary model is unavailable. |
| `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE` | Override the packaged lightweight summary instructions file. |
| `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS` | Override the local API summary timeout in milliseconds. |

Both Sparkshell summary model defaults are `gpt-6-astra` (independent of the agent tier defaults). To retry with a distinct model when the primary is unavailable, explicitly set `OMX_SPARKSHELL_FALLBACK_MODEL` to a different model.

### `models`

`models` maps mode names to explicit model overrides. Values must be non-empty strings.

Model names configured under `models` are mode-specific and do not change agent tiers. The built-in frontier-agent default is `gpt-6.2-astra`, the standard-agent default is `gpt-6.2-sol`, and the spark-agent default is `gpt-6-luna`. The known-alias list contains `gpt-6-astra`, `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6.1-terra`, and `gpt-6-luna`, plus the configurable GPT-5.6 alternatives `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. Legacy prior-generation names (for example `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`) are not aliases and carry no special routing meaning; like any provider-specific model name, they pass through only as opaque override strings. The known-alias list is used for display and contract tests, not as a closed allow-list.

Supported model-routing keys:

| Key shape | Purpose |
| --- | --- |
| `default` | Fallback for `getModelForMode(mode)` when the requested mode has no explicit key. |
| Any mode key, for example `team`, `autopilot`, `ralph` | Explicit model for that mode when code calls `getModelForMode("mode")`. If `models.autopilot` or the inherited main/default model is cheap/mini, Autopilot records dedicated planner ownership for heavy ralplan planning. |
| `team_low_complexity` | Low-complexity team/spark model override. |
| `team-low-complexity` | Alias for `team_low_complexity`. |
| `teamLowComplexity` | Alias for `team_low_complexity`. |

Do not invent per-role maps such as `models.executor`, `models.architect`, or `models.roles` unless your installed version documents that exact key. Current role routing is based on agent definitions and model class, not arbitrary per-role JSON maps.

### `agentModels`

`agentModels` is the supported per-agent model override map. Keys are normalized OMX agent names using the same normalization as `agentReasoning`: case-insensitive agent names containing letters, numbers, underscores, and hyphens. Values must be non-empty strings. Malformed agent names, empty values, and non-string values are ignored rather than fatal.

These overrides do not change built-in defaults in source. They are user/project configuration that applies when OMX resolves generated native agent TOML, generated developer metadata/instructions, AGENTS.md model capability tables, and role-based team/Ralph fallback model selection. Rerun `omx setup --force` after changing this map so setup-managed native agent TOML and AGENTS.md managed sections are regenerated.

For every role, effective model precedence is `.omx-config.json` `agentModels[role]` > the role's tier environment variable > the built-in model for that tier.

`agentModels` is the durable per-role surface. Do not put per-role models under `models.executor`, `models.architect`, or `models.roles`.

### `agentReasoning`

`agentReasoning` is the supported **per-agent** reasoning override map. Keys are normalized agent names; configured string values are trimmed and case-normalized to exactly `low`, `medium`, `high`, `xhigh`, or `max`. This normalization is configuration-only: it does not make `max` a root CLI value or launch shorthand.

`max` is passed unchanged to generated native-agent TOML and Team role defaults. Its availability remains capability-dependent on the installed Codex version, selected model, and provider; OMX does not probe capability, downgrade or retry it as `xhigh`, or hide downstream errors. `ultra` is unsupported on OMX-owned `agentReasoning` surfaces and is not an alias for `max`.

```json
{
  "agentReasoning": {
    "architect": "MAX",
    "critic": "xhigh"
  }
}
```

These overrides do not change built-in defaults in source. Every built-in `AgentDefinition.reasoningEffort` remains required and one of `low`, `medium`, `high`, or `xhigh`; it is never omitted, `max`, or `ultra`. A valid override affects only that normalized agent key. Malformed agent names, empty/non-string values, `ultra`, and unknown values are ignored, so valid sibling overrides remain effective and an affected role keeps its unchanged built-in fallback. Rerun `omx setup --force` after changing this map so setup-managed native agent TOML files are regenerated.

### Effective model precedence for native agents

For every role, model precedence is `.omx-config.json` `agentModels[role]` > the tier environment variable > the built-in tier default. The tier assignment and defaults are:

| Tier | Environment variable | Built-in default | Roles |
| --- | --- | --- | --- |
| Frontier | `OMX_DEFAULT_FRONTIER_MODEL` | `gpt-6.2-astra` | `planner`, `architect`, `critic` |
| Standard | `OMX_DEFAULT_STANDARD_MODEL` | `gpt-6.2-sol` | Every other non-spark role, including `researcher`, `analyst`, `security-reviewer`, `test-engineer`, `code-reviewer`, `code-simplifier`, `team-executor`, and `executor` |
| Spark | `OMX_DEFAULT_SPARK_MODEL` | `gpt-6-luna` | `explore`, `style-reviewer`, `vision` |

The standard tier never inherits the frontier model. The spark tier never inherits the main/leader model. Existing reasoning effort defaults remain per role; `agentReasoning` is the per-role override.

The root `config.toml` model is the main/leader session model only. Setup seeds it to `gpt-6.2-sol` when no root model exists and preserves an existing user model unless an explicit model change is requested; it does not set agent tiers. The leader model resolves from shell `OMX_DEFAULT_FRONTIER_MODEL`, then `.omx-config.json` `env.OMX_DEFAULT_FRONTIER_MODEL`, then the root model, then the built-in leader default `gpt-6.2-sol`.

Native agent TOML behavior depends on the provider. With a built-in or implicit provider, the resolved tier model is written for every role. With a custom provider, `model` is omitted unless `.omx-config.json` `agentModels[role]` is set. A configured role override still takes precedence in instruction `resolved_model` metadata; otherwise, custom-provider metadata uses the configured root/profile model or is absent when none is configured.

The example under “Supported model/env keys” is sufficient for agent tiers: it uses only tier environment values and leaves `agentModels` empty.

The spark chain may also use the legacy `OMX_SPARK_MODEL` environment setting and low-complexity `models` aliases; these apply only to spark roles.

### Mode-specific model lookup

When code asks for `getModelForMode(mode)`, the mode model resolves in this order:

1. `.omx-config.json` `models[mode]`
2. `.omx-config.json` `models.default`
3. Main/leader session default

For example, with `models.team = "gpt-5.6-sol"` and `models.default = "gpt-5.6-terra"`, `team` uses `gpt-5.6-sol`; a mode without its own key uses `gpt-5.6-terra`. Mode-specific values do not change per-role agent tiers.

### Team worker model selection

A distinct `OMX_TEAM_WORKER_LAUNCH_ARGS --model` wins first. Otherwise, for a known role, `resolveAgentDefaultModel()` uses `.omx-config.json` `agentModels[role]` > the role's tier environment variable > the built-in tier default, and that role model wins over an inherited leader model. Spark's legacy `OMX_SPARK_MODEL` and low-complexity aliases apply only within the spark chain.

Use `omx team status <team-name> --model-inspect` when you need inspect hints for a running team; the regular status path avoids spending model quota on summaries.

## Reasoning effort: supported places only

`.omx-config.json` is **not** the general place to configure root `model_reasoning_effort`. Do not add arbitrary keys such as `reasoningEffort`, `modelReasoningEffort`, `reasoning`, or undeclared per-role reasoning maps. The supported per-agent override map is exactly `agentReasoning`.

Root and per-agent reasoning vocabularies are deliberately separate:

- Root `config.toml` accepts `model_reasoning_effort = "low"`, `"medium"`, `"high"`, or `"xhigh"`.
- `omx reasoning <low|medium|high|xhigh>` edits that root setting. There is no `omx reasoning max`, `omx --max`, or root `max` shorthand.
- `omx --high` and `omx --xhigh` pass `-c model_reasoning_effort="high|xhigh"` to Codex launch.
- `.omx-config.json` `agentReasoning` accepts the five configured per-agent values described above and overrides selected role defaults for generated native agent TOML and role-based Team/Ralph staffing without changing built-in defaults.
- Generated native agent TOML files otherwise write each role's unchanged built-in `reasoningEffort` metadata.

Team runtime can inject a role-default or `agentReasoning`-overridden value when no explicit reasoning override is present. Explicit raw `-c model_reasoning_effort=...` is opaque Codex passthrough: it wins over configured and built-in role defaults, is forwarded unchanged (including `ultra` or future values), and preserves inherited Team explicit reasoning precedence over environment explicit reasoning. OMX does not validate, normalize, downgrade, retry, or claim provider support for that raw value.

The launch parser has one narrow end-of-options rule: literal `--max` and `--ultra` are rejected as OMX shorthands before `--`, but `omx -- --max` and `omx -- --ultra` are passed through unchanged to Codex. This does not make unrelated post-`--` arguments an OMX configuration surface.

## Starter config

The environment-only example above selects the built-in default models explicitly and leaves `agentModels` empty. Change only the tier environment values you want to override; `config.toml` remains the leader model setting, not an agent-tier setting.

## Verifying the effective config

After editing `.omx-config.json` `agentReasoning` or `config.toml`, regenerate setup-managed native agent TOML from the same shell and project shape that will launch OMX:

```bash
omx setup --force
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
