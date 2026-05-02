---
name: omx-setup
description: Setup and configure oh-my-codex using current CLI behavior
---

# OMX Setup

Use this skill when users want to install or refresh oh-my-codex for the **current project plus user-level OMX directories**.

## Command

```bash
omx setup [--force] [--merge-agents] [--dry-run] [--verbose] [--scope <user|project>] [--plugin|--legacy|--install-mode <legacy|plugin>]
```

If you only want lightweight `AGENTS.md` scaffolding for an existing repo or subtree, use `omx agents-init [path]` instead of full setup.

Supported setup flags (current implementation):
- `--force`: overwrite/reinstall managed artifacts where applicable
- `--merge-agents`: when `AGENTS.md` already exists, preserve user-authored content and insert/refresh OMX-managed generated sections between explicit `<!-- OMX:AGENTS:START -->` / `<!-- OMX:AGENTS:END -->` markers
- `--dry-run`: print actions without mutating files
- `--verbose`: print per-file/per-step details
- `--scope`: choose install scope (`user`, `project`)
- `--plugin`: use Codex plugin delivery for bundled skills while archiving/removing legacy OMX-managed prompts/native agents and keeping setup-owned runtime hooks
- `--legacy`: use legacy setup delivery, overriding any persisted plugin install mode
- `--install-mode`: explicitly choose setup delivery mode (`legacy` or `plugin`); canonical form for scripted setup

## What this setup actually does

`omx setup` performs these steps:

1. Resolve setup scope:
   - `--scope` explicit value
   - else persisted `./.omx/setup-scope.json` (with automatic migration of legacy values)
   - if a TTY user has persisted setup preferences, `omx setup` first summarizes the recorded choices and asks whether to **keep**, **review/change**, or **reset** them
   - else interactive prompt on TTY (default `user`)
   - else default `user` (safe for CI/tests)
2. If scope is `user`, resolve user skill delivery mode:
   - explicit `--plugin`, `--legacy`, or `--install-mode legacy|plugin`, if present
   - persisted install mode in `./.omx/setup-scope.json`, if present and the TTY review decision is `keep`
   - else discovered installed plugin cache under `${CODEX_HOME:-~/.codex}/plugins/cache/**/.codex-plugin/plugin.json` with `name: oh-my-codex` makes `plugin` the default
   - else interactive prompt on TTY (`legacy` by default, or `plugin` when a plugin cache is discovered)
   - else default `legacy` unless a plugin cache is discovered
3. Create directories and persist effective scope/install mode
4. In legacy mode, install prompts/native agents/skills and merge full config.toml. In plugin mode, archive/remove legacy OMX-managed prompts/native agents/skills but keep native Codex hooks installed.
5. Verify Team CLI API interop markers exist in built `dist/cli/team.js`
6. Generate AGENTS.md defaults only when selected/allowed (or legacy behavior outside plugin mode)
7. Configure notify hook references outside plugin mode and write `./.omx/hud-config.json`

## Important behavior notes

- `omx setup` prompts for scope when no scope is provided and stdin/stdout are TTY. If `./.omx/setup-scope.json` already exists, setup now summarizes the saved choices first and asks whether to keep them, review/change them, or reset and behave like a fresh setup run.
- Non-interactive setup never blocks for this review prompt: it keeps deterministic CLI/persisted/default behavior for CI and scripted installs.
- In `user` scope, `omx setup` also prompts for skill delivery mode when no prior install mode is kept; installed plugin cache discovery makes plugin mode the default prompt/non-interactive choice.
- Local project orchestration file is `./AGENTS.md` (project root).
- If `AGENTS.md` exists and neither `--force` nor `--merge-agents` is used, interactive TTY runs ask whether to overwrite. Non-interactive runs preserve the file.
- Use `--merge-agents` to keep existing project guidance while allowing setup to refresh OMX-managed AGENTS sections and the generated model capability table idempotently.
- Scope targets:
  - `user`: user directories (`~/.codex`, `~/.codex/skills`, `~/.omx/agents`)
  - `project`: local directories (`./.codex`, `./.codex/skills`, `./.omx/agents`)
- User-scope skill delivery targets:
  - `legacy`: keep installing/updating OMX skills in the resolved user skill root
  - `plugin`: rely on Codex plugin discovery for bundled skills and archive/remove legacy OMX-managed prompts/skills/native agents; setup still installs native Codex hooks and setup-owned runtime feature flags (`codex_hooks = true`, `goals = true`) because plugins do not carry hooks or enable Codex goal mode by themselves.
- Migration hint: in `user` scope, if historical `~/.agents/skills` still exists alongside `${CODEX_HOME:-~/.codex}/skills`, current setup prints a cleanup hint. **Why the paths differ**: `${CODEX_HOME:-~/.codex}/skills/` is the path current Codex CLI natively loads as its skill root; `~/.agents/skills/` was the skill root in an older Codex CLI release before `~/.codex` became the standard home directory. OMX writes only to the canonical `${CODEX_HOME:-~/.codex}/skills/` path. When both directories exist simultaneously, Codex discovers skills from both trees and may show duplicate entries in Enable/Disable Skills. Archive or remove `~/.agents/skills/` to resolve this.
- If persisted scope is `project`, `omx` launch automatically uses `CODEX_HOME=./.codex` unless user explicitly overrides `CODEX_HOME`.
- Plugin mode prompts separately for optional AGENTS.md defaults and optional `developer_instructions` defaults. If `developer_instructions` already exists, setup asks before overwriting it; non-interactive runs preserve it.
- With `--force` or `--merge-agents`, AGENTS updates may still be skipped if an active OMX session is detected (safety guard).
- Legacy persisted scope values (`project-local`) are automatically migrated to `project` with a one-time warning.

## Setup-owned configuration surfaces

Use this map when reconciling setup behavior or debugging a confusing install:

| Surface | Owner | Notes |
| --- | --- | --- |
| `./.omx/setup-scope.json` | `omx setup` | Persists setup scope and user-scope skill delivery mode. TTY reruns summarize it and offer keep/review/reset. |
| `~/.codex/config.toml` / `./.codex/config.toml` | `omx setup` generated blocks + user edits | Setup refreshes OMX-managed blocks while preserving supported manual content; setup-owned runtime feature flags include `multi_agent`, `child_agents_md`, `codex_hooks`, and `goals`. |
| `~/.codex/hooks.json` / `./.codex/hooks.json` | `omx setup` shared ownership | Setup owns OMX native hook wrappers and preserves user-owned hooks. |
| prompts, skills, native agents | `omx setup` or Codex plugin delivery | Legacy mode installs local files; plugin mode relies on plugin discovery for bundled skills and archives/removes legacy OMX-managed prompt/native-agent copies. |
| `AGENTS.md` | `omx setup` with overwrite safety | Generated defaults or managed refreshes are guarded by force/session checks. |
| `./.omx/hud-config.json` | `omx setup` / `$hud` | Setup creates the focused default; `$hud` can adjust it later. |
| notification hooks | `omx setup` / `$configure-notifications` | Setup wires defaults outside plugin skill delivery; notification skill owns deeper provider configuration. |

## If `$omx-setup` is missing or stale

The source repo ships `skills/omx-setup/SKILL.md` and the catalog marks it active. If Codex does not show `$omx-setup`, treat it as an installation/discovery issue rather than a missing source skill:

1. Run `omx setup --verbose` in the intended scope.
2. Run `omx doctor` and check the reported setup scope, Codex home, skill root, and hook/config status.
3. If using project scope, confirm `./.codex/skills/omx-setup/SKILL.md` exists.
4. If using user scope, confirm `${CODEX_HOME:-~/.codex}/skills/omx-setup/SKILL.md` exists in legacy mode, or that the oh-my-codex plugin is installed/discovered in plugin mode.
5. If duplicate/stale skills appear, check for legacy `~/.agents/skills` overlap and follow the cleanup hint printed by setup/doctor.

## Recommended workflow

1. Run setup:

```bash
omx setup --force --verbose
```

2. Verify installation:

```bash
omx doctor
```

3. Start Codex with OMX in the target project directory.

## Expected verification indicators

From `omx doctor`, expect:
- Prompts installed (scope-dependent: user or project)
- Skills installed (scope-dependent: user or project)
- AGENTS.md found in project root
- `.omx/state` exists
- OMX MCP servers configured in scope target `config.toml` (`~/.codex/config.toml` or `./.codex/config.toml`)

## Troubleshooting

- If using local source changes, run build first:

```bash
npm run build
```

- If your global `omx` points to another install, run local entrypoint:

```bash
node bin/omx.js setup --force --verbose
node bin/omx.js doctor
```

- If AGENTS.md was not overwritten during `--force`, stop active OMX session and rerun setup.
- If AGENTS.md was not merged during `--merge-agents`, stop active OMX session and rerun setup.
