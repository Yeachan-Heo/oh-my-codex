---
name: omx-setup
description: Setup and configure oh-my-codex using current CLI behavior
---

# OMX Setup

Use this skill when users want to install or refresh oh-my-codex for the **current project plus user-level OMX directories**.

## Command

```bash
omx setup [--force] [--dry-run] [--verbose] [--scope <user|project-local|project>]
```

Supported setup flags (current implementation):
- `--force`: overwrite/reinstall managed artifacts where applicable
- `--dry-run`: print actions without mutating files
- `--verbose`: print per-file/per-step details
- `--scope`: choose install scope (`user`, `project-local`, `project`)

## What this setup actually does

`omx setup` performs these steps:

1. Resolve setup scope:
   - `--scope` explicit value
   - else persisted `./.omx/setup-scope.json`
   - else interactive prompt on TTY (default `user`)
   - else default `user` (safe for CI/tests)
2. Create project OMX directories (`./.omx/state`, `./.omx/plans`, `./.omx/logs`) and persist effective scope
3. For `user`/`project-local` scope:
   - install prompts
   - remove legacy prompt shims
   - install native agent configs
   - install skills
   - merge OMX config.toml
4. For `project` scope: skip prompt/skill/config/native-agent installs with console messages
6. Verify required team MCP comm tool exports exist in built `dist/mcp/state-server.js`
7. Generate project-root `./AGENTS.md` from `templates/AGENTS.md` (or skip when existing and no force)
8. Configure notify hook references and write `./.omx/hud-config.json`

## Important behavior notes

- `omx setup` only prompts for scope when no scope is provided/persisted and stdin/stdout are TTY.
- Local project orchestration file is `./AGENTS.md` (project root).
- Scope targets:
  - `user`: user directories (`~/.codex`, `~/.agents/skills`, `~/.omx/agents`)
  - `project-local`: local directories (`./.codex`, `./.agents/skills`, `./.omx/agents`)
  - `project`: project-only OMX setup (`./.omx/*`, `AGENTS.md`, HUD)
- If persisted scope is `project-local`, `omx` launch automatically uses `CODEX_HOME=./.codex` unless user explicitly overrides `CODEX_HOME`.
- With `--force`, AGENTS overwrite may still be skipped if an active OMX session is detected (safety guard).

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
- Prompts installed (scope-dependent: user or project-local)
- Skills installed (scope-dependent: user or project-local)
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
