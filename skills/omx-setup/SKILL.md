---
name: omx-setup
description: Setup and configure oh-my-codex using current CLI behavior
---

# OMX Setup

Use this skill when users want to install or refresh oh-my-codex for the **current project plus user-level OMX directories**.

## Command

```bash
omx setup [--force] [--dry-run] [--verbose] [--scope <user|project>]
```

Supported setup flags (current implementation):
- `--force`: overwrite/reinstall managed artifacts where applicable
- `--dry-run`: print actions without mutating files
- `--verbose`: print per-file/per-step details
- `--scope`: choose install scope (`user`, `project`)

## What this setup actually does

`omx setup` performs these steps:

1. Resolve setup scope:
   - `--scope` explicit value
   - else persisted `./.omx/setup-scope.json` (with automatic migration of legacy values)
   - else interactive prompt on TTY (default `user`)
   - else default `user` (safe for CI/tests)
2. Create directories and persist effective scope
3. Install prompts, native agent configs, skills, and merge config.toml (scope determines target directories)
4. Verify required team MCP comm tool exports exist in built `dist/mcp/state-server.js`
5. Generate project-root `./AGENTS.md` from `templates/AGENTS.md` (or skip when existing and no force)
6. Configure notify hook references and write `./.omx/hud-config.json`

## Important behavior notes

- `omx setup` only prompts for scope when no scope is provided/persisted and stdin/stdout are TTY.
- Local project orchestration file is `./AGENTS.md` (project root).
- If `AGENTS.md` exists and `--force` is not used, interactive TTY runs ask whether to overwrite. Non-interactive runs preserve the file.
- Scope targets:
  - `user`: user directories (`~/.codex`, `~/.agents/skills`, `~/.omx/agents`)
  - `project`: local directories (`./.codex`, `./.agents/skills`, `./.omx/agents`)
- If persisted scope is `project`, `omx` launch automatically uses `CODEX_HOME=./.codex` unless user explicitly overrides `CODEX_HOME`.
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
