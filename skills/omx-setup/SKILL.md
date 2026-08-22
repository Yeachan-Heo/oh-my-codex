---
name: omx-setup
description: Setup and configure oh-my-codex using current CLI behavior
---

# OMX Setup

Use this task card to install or refresh OMX for the current project and/or user scope. Shared safety, lifecycle, hook, team, autonomy, and cancellation rules live in `templates/AGENTS.md`. Do not infer new CLI behavior from this card; the implementation is authoritative.

## Command and alternatives

```bash
omx setup [--force] [--merge-agents|--no-merge-agents|--clear-merge-agents-policy] [--dry-run] [--verbose] [--scope <user|project>] [--plugin|--legacy|--install-mode <legacy|plugin>] [--mcp <none|compat>] [--no-mcp|--with-mcp] [--disable-team|--enable-team|--team-mode <enabled|disabled>]
omx agents-init [path] [--dry-run] [--force] [--verbose]
```

Use `agents-init` for lightweight AGENTS.md scaffolding only, not a full install.

Supported setup options:
- `--force`: overwrite/reinstall managed artifacts; transient, not persisted or replayed.
- `--merge-agents`, `--no-merge-agents`, `--clear-merge-agents-policy`: exact bare selectors (no values/equals). Repeated identical selectors are idempotent; conflicting selectors fail before mutations. Set persists an explicit policy per invoking project root; clear removes it and cannot combine with a set. Merge refreshes managed sections; no-merge only suppresses that branch and is not a preserve mode.
- `--dry-run`, `--verbose`: preview actions or show per-file/per-step detail.
- `--scope user|project`: choose user (`~/.codex`, `~/.omx/agents`) or project (`./.codex`, `./.omx/agents`) targets.
- `--plugin` / `--legacy`: select delivery mode; `--install-mode legacy|plugin` is the canonical scripted spelling. Conflicting mode flags fail.
- `--mcp none|compat` (plus `--no-mcp` / `--with-mcp`): omit or enable first-party MCP compatibility and shared registry sync.
- `--disable-team`, `--enable-team`, `--team-mode enabled|disabled`: select Team skill/context generation; conflicting selectors fail.

## Resolve setup

1. Scope: explicit flag, valid persisted `./.omx/setup-scope.json`, TTY choice (default `user`), or non-interactive `user`. Legacy `project-local` migrates to `project`.
2. Mode: explicit flag, persisted mode when retained, discovered `${CODEX_HOME:-~/.codex}/plugins/cache/**/.codex-plugin/plugin.json` with `name: oh-my-codex` (plugin default), otherwise legacy. TTY reruns summarize saved choices and offer keep/review/reset; non-interactive runs do not block.
3. Create required directories and atomically persist preferences only after successful setup.

## What setup changes

- Legacy mode installs prompts/native agents/skills and merges full config.toml.
- Plugin mode archives/removes legacy OMX-managed prompts/skills, refreshes installable native agent TOMLs and stale generated non-installable agents, and keeps setup-owned runtime hooks.
- Both modes verify Team CLI interop markers in built `dist/cli/team.js`, generate AGENTS defaults only when selected/allowed, and write `./.omx/hud-config.json`; notification hook references are setup-owned outside plugin skill delivery.
- `AGENTS.md` is `./AGENTS.md`. Without `--force` or `--merge-agents`, interactive runs ask before overwrite and non-interactive runs preserve it. Active-session safeguards may skip writes. Plugin mode may separately prompt for AGENTS and `developer_instructions` defaults; non-interactive runs preserve existing files.
- Plugin mode enables setup-owned runtime flags (`plugin_hooks`, `goals`, or legacy `hooks`/`codex_hooks` fallback). Project scope uses `CODEX_HOME=./.codex` unless explicitly overridden.

## Verify

```bash
omx setup --force --verbose
omx doctor
```

Expect doctor evidence for prompts and skills in the selected scope, project-root AGENTS.md, `.omx/state`, and CLI-first config in the scope target `config.toml`. First-party MCP and shared registry sync are omitted unless setup used `--mcp compat` (if supported by the installed CLI).

If using local source, run `npm run build` before `node dist/cli/omx.js setup --force --verbose` and `node dist/cli/omx.js doctor`. If AGENTS was not overwritten or merged, stop the active OMX session and rerun with `--force` or `--merge-agents`; do not edit lifecycle state manually.

## Discovery troubleshooting

If `$omx-setup` is absent/stale: run `omx setup --verbose`, then `omx doctor`; verify `./.codex/skills/omx-setup/SKILL.md` for project scope or `${CODEX_HOME:-~/.codex}/skills/omx-setup/SKILL.md` for legacy user scope. In plugin mode verify the oh-my-codex plugin is installed/discovered. For duplicates, inspect historical `~/.agents/skills` overlap and follow doctor/setup cleanup guidance.

## Exit contract

Report selected scope/mode, dry-run versus mutation, AGENTS policy, affected roots, and doctor indicators. Stop only after setup completes successfully and verification identifies the expected files/config; on failure preserve the exact command output and rerun the smallest corrective command. Do not claim installation from a dry-run alone.
