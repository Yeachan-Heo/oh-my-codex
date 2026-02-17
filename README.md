# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Your codex is not alone.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Multi-agent orchestration layer for [OpenAI Codex CLI](https://github.com/openai/codex).

OMX turns Codex from a single-session agent into a coordinated system with:
- Role prompts (`/prompts:name`) for specialized agents
- Workflow skills (`$name`) for repeatable execution modes
- Team orchestration in tmux (`omx team`, `$team`)
- Persistent state + memory via MCP servers

## Why OMX

Codex CLI is strong for direct tasks. OMX adds structure for larger work:
- Decomposition and staged execution (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- Persistent mode lifecycle state (`.omx/state/`)
- Memory + notepad surfaces for long-running sessions
- Operational controls for launch, verification, and cancellation

OMX is an add-on, not a fork. It uses Codex-native extension points.

## Requirements

- macOS or Linux (Windows via WSL2)
- Node.js >= 20
- Codex CLI installed (`npm install -g @openai/codex`)
- Codex auth configured

## Quickstart (3 minutes)

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

Recommended trusted-environment launch profile:

```bash
omx --xhigh --madmax
```

## First Session

Inside Codex:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

From terminal:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Core Model

OMX installs and wires these layers:

```text
User
  -> Codex CLI
    -> AGENTS.md (orchestration brain)
    -> ~/.codex/prompts/*.md (30 agent prompts)
    -> ~/.agents/skills/*/SKILL.md (40 skills)
    -> ~/.codex/config.toml (features, notify, MCP)
    -> .omx/ (runtime state, memory, plans, logs)
```

## Main Commands

```bash
omx                # Launch Codex (+ HUD in tmux when available)
omx setup          # Install prompts, skills, config wiring, AGENTS.md
omx doctor         # Installation/runtime diagnostics
omx doctor --team  # Team/swarm diagnostics
omx team ...       # Start/status/resume/shutdown tmux team workers
omx status         # Show active modes
omx cancel         # Cancel active execution modes
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (plugin extension workflow)
omx hud ...        # --watch|--json|--preset
omx help
```

## Hooks Extension (Additive Surface)

OMX now includes `omx hooks` for plugin scaffolding and validation.

- `omx tmux-hook` remains supported and unchanged.
- `omx hooks` is additive and does not replace tmux-hook workflows.
- Plugin files live at `.omx/hooks/*.mjs`.
- Plugins are off by default; enable with `OMX_HOOK_PLUGINS=1`.

See `docs/hooks-extension.md` for the full extension workflow and event model.

## Launch Flags

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
```

`--madmax` maps to Codex `--dangerously-bypass-approvals-and-sandbox`.
Use it only in trusted/external sandbox environments.

## Codex-First Prompt Control

By default, OMX injects:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

This layers project `AGENTS.md` guidance into Codex launch instructions.
It extends Codex behavior, but does not replace/bypass Codex core system policies.

Controls:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # disable AGENTS.md injection
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Team Mode

Use team mode for broad work that benefits from parallel workers.

Lifecycle:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Operational commands:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Important rule: do not shutdown while tasks are still `in_progress` unless aborting.

## What `omx setup` writes

- `~/.codex/prompts/` (30 prompt files)
- `~/.agents/skills/` (40 skills)
- `~/.codex/config.toml` updates:
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] collab = true, child_agents_md = true`
  - MCP server entries (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- Project `AGENTS.md`
- `.omx/` runtime directories and HUD config

## Agents and Skills

- Prompts: `prompts/*.md` (installed to `~/.codex/prompts/`)
- Skills: `skills/*/SKILL.md` (installed to `~/.agents/skills/`)

Examples:
- Agents: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- `deep-executor` is deprecated; use `executor` for complex implementation tasks.
- Skills: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `ultrapilot`, `research`, `cancel`

## Project Layout

```text
oh-my-codex/
  bin/omx.js
  src/
    cli/
    team/
    mcp/
    hooks/
    hud/
    config/
    modes/
    notifications/
    verification/
  prompts/
  skills/
  templates/
  scripts/
```

## Development

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Notes

- Coverage and parity notes: `COVERAGE.md`
- Hook extension workflow: `docs/hooks-extension.md`
- Setup and contribution details: `CONTRIBUTING.md`

## Acknowledgments

Inspired by [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), adapted for Codex CLI.

## License

MIT
