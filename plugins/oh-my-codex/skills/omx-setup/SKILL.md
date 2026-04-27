---
name: omx-setup
description: Setup and configure oh-my-codex using current CLI behavior
---

# OMX Setup

Use this skill when users want to install or refresh oh-my-codex for the **current project plus user-level OMX directories**.

## Command

```bash
omx setup [--force] [--dry-run] [--verbose] [--scope <user|project>] [--plugin]
```

If you only want lightweight `AGENTS.md` scaffolding for an existing repo or subtree, use `omx agents-init [path]` instead of full setup.

Supported setup flags (current implementation):
- `--force`: overwrite/reinstall managed artifacts where applicable
- `--dry-run`: print actions without mutating files
- `--verbose`: print per-file/per-step details
- `--scope`: choose install scope (`user`, `project`)
- `--plugin`: use Codex plugin delivery for skills/prompts/agents while keeping setup-owned runtime hooks

## What this setup actually does

`omx setup` performs these steps:

1. Resolve setup scope:
   - `--scope` explicit value
   - else persisted `./.omx/setup-scope.json` (with automatic migration of legacy values)
   - else interactive prompt on TTY (default `user`)
   - else default `user` (safe for CI/tests)
2. If scope is `user`, resolve user skill delivery mode:
   - explicit `--plugin`, if present
   - persisted install mode in `./.omx/setup-scope.json`, if present
   - else discovered installed plugin cache under `${CODEX_HOME:-~/.codex}/plugins/cache/**/.codex-plugin/plugin.json` with `name: oh-my-codex` makes `plugin` the default
   - else interactive prompt on TTY (`legacy` by default, or `plugin` when a plugin cache is discovered)
   - else default `legacy` unless a plugin cache is discovered
3. Create directories and persist effective scope/install mode
4. In legacy mode, install prompts/native agents/skills and merge full config.toml. In plugin mode, remove matching legacy OMX-managed prompts/native agents/skills but keep native Codex hooks installed.
5. Verify Team CLI API interop markers exist in built `dist/cli/team.js`
6. Generate AGENTS.md defaults only when selected/allowed (or legacy behavior outside plugin mode)
7. Configure notify hook references outside plugin mode and write `./.omx/hud-config.json`

## Important behavior notes

- `omx setup` only prompts for scope when no scope is provided/persisted and stdin/stdout are TTY.
- In `user` scope, `omx setup` also prompts for skill delivery mode when no prior install mode is persisted; installed plugin cache discovery makes plugin mode the default prompt/non-interactive choice.
- Local project orchestration file is `./AGENTS.md` (project root).
- If `AGENTS.md` exists and `--force` is not used, interactive TTY runs ask whether to overwrite. Non-interactive runs preserve the file.
- Scope targets:
  - `user`: user directories (`~/.codex`, `~/.codex/skills`, `~/.omx/agents`)
  - `project`: local directories (`./.codex`, `./.codex/skills`, `./.omx/agents`)
- User-scope skill delivery targets:
  - `legacy`: keep installing/updating OMX skills in the resolved user skill root
  - `plugin`: rely on Codex plugin discovery for bundled skills and remove only matching OMX-managed legacy prompts/skills/native agents; setup still installs native Codex hooks and `codex_hooks = true` because plugins do not carry hooks.
- Migration hint: in `user` scope, if historical `~/.agents/skills` still exists alongside `${CODEX_HOME:-~/.codex}/skills`, current setup prints a cleanup hint. **Why the paths differ**: `${CODEX_HOME:-~/.codex}/skills/` is the path current Codex CLI natively loads as its skill root; `~/.agents/skills/` was the skill root in an older Codex CLI release before `~/.codex` became the standard home directory. OMX writes only to the canonical `${CODEX_HOME:-~/.codex}/skills/` path. When both directories exist simultaneously, Codex discovers skills from both trees and may show duplicate entries in Enable/Disable Skills. Archive or remove `~/.agents/skills/` to resolve this.
- If persisted scope is `project`, `omx` launch automatically uses `CODEX_HOME=./.codex` unless user explicitly overrides `CODEX_HOME`.
- Plugin mode prompts separately for optional AGENTS.md defaults and optional `developer_instructions` defaults. If `developer_instructions` already exists, setup asks before overwriting it; non-interactive runs preserve it.
- With `--force`, AGENTS overwrite may still be skipped if an active OMX session is detected (safety guard).
- Legacy persisted scope values (`project-local`) are automatically migrated to `project` with a one-time warning.

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
