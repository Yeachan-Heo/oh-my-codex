# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Your codex is not alone.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[OpenClaw Integration Guide](./docs/openclaw-integration.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Multi-agent orchestration layer for [OpenAI Codex CLI](https://github.com/openai/codex).

## Featured Guides

- [OpenClaw / Generic Notification Gateway Integration Guide](./docs/openclaw-integration.md)

## Languages

- [English](./README.md)
- [한국어 (Korean)](./README.ko.md)
- [日本語 (Japanese)](./README.ja.md)
- [简体中文 (Chinese Simplified)](./README.zh.md)
- [繁體中文 (Chinese Traditional)](./README.zh-TW.md)
- [Tiếng Việt (Vietnamese)](./README.vi.md)
- [Español (Spanish)](./README.es.md)
- [Português (Portuguese)](./README.pt.md)
- [Русский (Russian)](./README.ru.md)
- [Türkçe (Turkish)](./README.tr.md)
- [Deutsch (German)](./README.de.md)
- [Français (French)](./README.fr.md)
- [Italiano (Italian)](./README.it.md)


OMX turns Codex from a single-session agent into a coordinated system with:
- Role prompts (`/prompts:name`) for specialized agents
- Workflow skills (`$name`) for repeatable execution modes
- Team orchestration (`omx team`, `$team`) with tmux interactive mode (default) or non-tmux prompt mode
- Persistent state + memory via MCP servers

## Why OMX

Codex CLI is strong for direct tasks. OMX adds structure for larger work:
- Decomposition and staged execution (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- Persistent mode lifecycle state (`.omx/state/`)
- Memory + notepad surfaces for long-running sessions
- Operational controls for launch, verification, and cancellation

OMX is an add-on, not a fork. It uses Codex-native extension points.

## Positioning: CLI-first orchestration, MCP-backed state

OMX is best used as an **outer CLI orchestration layer**:
- **Control plane (CLI/runtime):** `omx team`, tmux workers, lifecycle commands
- **Capability/state plane (MCP):** task state, mailbox, memory, diagnostics tools

Practical mode split:
- **`$team` / `omx team`**: durable, inspectable, resumable multi-worker execution
- **`$ultrawork`**: lightweight parallel fanout for independent tasks (component mode)

Low-token team profile example:

```bash
OMX_TEAM_WORKER_CLI=codex \
OMX_TEAM_WORKER_LAUNCH_ARGS='--model gpt-5.3-codex-spark -c model_reasoning_effort="low"' \
omx team 2:explore "short scoped analysis task"
```

## Requirements

- Node.js >= 20 (CI validates Node 20 and current LTS, currently Node 22)
- Codex CLI installed (`npm install -g @openai/codex`)
- Codex auth configured

### Platform & tmux

OMX features like `omx team` require **tmux**:

| Platform       | tmux provider                                            | Install                |
| -------------- | -------------------------------------------------------- | ---------------------- |
| macOS          | [tmux](https://github.com/tmux/tmux)                    | `brew install tmux`    |
| Ubuntu/Debian  | tmux                                                     | `sudo apt install tmux`|
| Fedora         | tmux                                                     | `sudo dnf install tmux`|
| Arch           | tmux                                                     | `sudo pacman -S tmux`  |
| Windows        | [psmux](https://github.com/marlocarlo/psmux) (native)   | `winget install psmux` |
| Windows (WSL2) | tmux (inside WSL)                                        | `sudo apt install tmux`|

> **Windows users:** [psmux](https://github.com/marlocarlo/psmux) provides a native `tmux` binary for Windows with 76 tmux-compatible commands. No WSL required.

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

## New in v0.5.0

- **Scope-aware setup** with `omx setup --scope user|project` for flexible install modes.
- **Spark worker routing** via `--spark` / `--madmax-spark` so team workers can use `gpt-5.3-codex-spark` without forcing the leader model.
- **Catalog consolidation** — removed deprecated prompts (`deep-executor`, `scientist`) and 9 deprecated skills for a leaner surface.
- **Notifier verbosity levels** for fine-grained CCNotifier output control.

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
    -> ~/.codex/prompts/*.md (agent prompt catalog)
    -> ~/.agents/skills/*/SKILL.md (skill catalog)
    -> ~/.codex/config.toml (features, notify, MCP)
    -> .omx/ (runtime state, memory, plans, logs)
```

## Experimental: posture-aware routing

This branch includes an experimental routing layer that separates:

- `role`: agent responsibility (`executor`, `planner`, `architect`)
- `tier`: reasoning depth / cost (`LOW`, `STANDARD`, `THOROUGH`)
- `posture`: operating style (`frontier-orchestrator`, `deep-worker`, `fast-lane`)

Current intent of the experiment:

- **Frontier-orchestrator**: leader/router posture for steerable frontier models
- **Deep-worker**: implementation-first posture for executor-style roles
- **Fast-lane**: lightweight triage/search posture for fast models

This is designed to make OMX's initial routing behavior more Sisyphus-like without removing the existing Hephaestus-like execution lane.

### How to test this experiment

1. Build the project:

```bash
npm run build
```

2. Reinstall native agent configs:

```bash
node bin/omx.js setup
```

3. Inspect generated native agent configs in `~/.omx/agents/` and confirm they now include:
   - `## OMX Posture Overlay`
   - `## Model-Class Guidance`
   - `## OMX Agent Metadata`

4. Spot-check representative roles:
   - `planner` / `architect` / `critic` -> `frontier-orchestrator`
   - `executor` / `build-fixer` / `test-engineer` -> `deep-worker`
   - `explore` / `writer` -> `fast-lane`

5. Run focused tests:

```bash
node --test dist/agents/__tests__/definitions.test.js dist/agents/__tests__/native-config.test.js
```

This experiment currently changes native prompt generation and metadata, not the full prose of every prompt file.

## Main Commands

```bash
omx                # Launch Codex (+ HUD in tmux when available)
omx setup          # Install prompts/skills/config by scope + project AGENTS.md/.omx
omx doctor         # Installation/runtime diagnostics
omx doctor --team  # Team/swarm diagnostics
omx ask ...        # Ask local provider advisor (claude|gemini), writes .omx/artifacts/*
omx team ...       # Start/status/resume/shutdown team workers (interactive tmux by default)
omx ralph          # Launch Codex with ralph persistence mode active
omx status         # Show active modes
omx cancel         # Cancel active execution modes
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (plugin extension workflow)
omx hud ...        # --watch|--json|--preset
omx version        # Show version information
omx help           # Show help message
```

Ask command examples:

```bash
omx ask claude "review this diff"
omx ask gemini "brainstorm alternatives"
omx ask claude --agent-prompt executor "implement feature X with tests"
omx ask gemini --agent-prompt=planner --prompt "draft a rollout plan"
# underlying provider flags from CLI help:
# claude -p|--print "<prompt>"
# gemini -p|--prompt "<prompt>"
```

Non-tmux team launch (advanced):

```bash
OMX_TEAM_WORKER_LAUNCH_MODE=prompt omx team 2:executor "task"
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
--yolo              # Launch Codex in yolo mode
--high              # High reasoning effort (shorthand for -c model_reasoning_effort="high")
--xhigh             # xhigh reasoning effort (shorthand for -c model_reasoning_effort="xhigh")
--madmax            # DANGEROUS: bypass Codex approvals and sandbox
--spark             # Use Codex spark model for team workers only (~1.3x faster)
--madmax-spark      # spark model for workers + bypass approvals for leader and workers
-w, --worktree[=<name>]  # Launch Codex in a git worktree (detached when no name given)
--force             # Enable destructive maintenance (for example stale/deprecated skill cleanup)
--dry-run           # Show what would be done without doing it
--keep-config       # Skip config.toml cleanup during uninstall
--purge             # Remove .omx/ cache directory during uninstall
--verbose           # Show detailed output
--scope <user|project>  # setup only
```

`--madmax` maps to Codex `--dangerously-bypass-approvals-and-sandbox`.
Use it only in trusted/external sandbox environments.

### MCP workingDirectory policy (optional hardening)

By default, MCP state/memory/trace tools accept caller-provided `workingDirectory`.
To constrain this, set an allowlist of roots:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

When set, `workingDirectory` values outside these roots are rejected.

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
omx team --help
omx team api --help
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Important rule: do not shutdown while tasks are still `in_progress` unless aborting.

### Ralph Cleanup Policy

When a team runs in ralph mode (`omx team ralph ...`), the shutdown cleanup
applies a dedicated policy that differs from the normal path:

| Behavior | Normal team | Ralph team |
|---|---|---|
| Force shutdown on failure | Throws `shutdown_gate_blocked` | Bypasses gate, logs `ralph_cleanup_policy` event |
| Auto branch deletion | Deletes worktree branches on rollback | Preserves branches (`skipBranchDeletion`) |
| Completion logging | Standard `shutdown_gate` event | Additional `ralph_cleanup_summary` event with task breakdown |

The ralph policy is auto-detected from team mode state (`linked_ralph`) or
can be passed explicitly via `omx team shutdown <name> --ralph`.

Worker CLI selection for team workers:

```bash
OMX_TEAM_WORKER_CLI=auto    # default; uses claude when worker --model contains "claude"
OMX_TEAM_WORKER_CLI=codex   # force Codex CLI workers
OMX_TEAM_WORKER_CLI=claude  # force Claude CLI workers
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # per-worker CLI mix (len=1 or worker count)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # optional: disable adaptive queue->resend fallback
```

Notes:
- Worker launch args are still shared via `OMX_TEAM_WORKER_LAUNCH_ARGS` for model/config inheritance.
- `OMX_TEAM_WORKER_CLI_MAP` overrides `OMX_TEAM_WORKER_CLI` for per-worker selection.
- Team mode now allocates `model_reasoning_effort` per teammate from the resolved worker role (`low` / `medium` / `high`) unless an explicit reasoning override already exists in `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- When a worker resolves to a concrete task role, OMX composes a per-worker startup instructions file that layers the corresponding role prompt on top of the shared team worker protocol; explicit `model_instructions_file` launch overrides still win.
- Trigger submission uses adaptive retries by default (queue/submit, then safe clear-line+resend fallback when needed).
- In Claude worker mode, OMX spawns workers as plain `claude` (no extra launch args) and ignores explicit `--model` / `--config` / `--effort` overrides so Claude uses default `settings.json`.

## What `omx setup` writes

- `.omx/setup-scope.json` (persisted setup scope)
- Scope-dependent installs:
  - `user`: `~/.codex/prompts/`, `~/.agents/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`
  - `project`: `./.codex/prompts/`, `./.agents/skills/`, `./.codex/config.toml`, `./.omx/agents/`
- Launch behavior: if persisted scope is `project`, `omx` launch auto-uses `CODEX_HOME=./.codex` (unless `CODEX_HOME` is already set).
- Managed OMX artifacts refresh by default in both interactive and non-interactive runs: prompts, skills, native agent configs, project `AGENTS.md`, and the managed OMX portion of `config.toml`
- If a managed file differs and will be overwritten, setup creates a backup first under `.omx/backups/setup/<timestamp>/...` (project scope) or `~/.omx/backups/setup/<timestamp>/...` (user scope)
- Active-session safety still blocks `AGENTS.md` overwrite while an OMX session is running
- `config.toml` updates (for both scopes):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `model = "gpt-5.4"` when root `model` is absent
  - if the existing root model is `gpt-5.3-codex`, interactive `omx setup` asks whether to upgrade it to `gpt-5.4`; non-interactive runs preserve the existing model
  - `model_context_window = 1000000` and `model_auto_compact_token_limit = 900000` only when the effective root model is `gpt-5.4` and both context keys are absent
  - `[features] multi_agent = true, child_agents_md = true`
  - MCP server entries (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- Project `AGENTS.md`
- `.omx/` runtime directories and HUD config
- Default setup output includes a compact per-category refresh summary; `--verbose` adds changed-file detail
- `--force` is reserved for stronger maintenance behavior such as stale/deprecated skill cleanup; it is no longer required for ordinary refresh
- The 1M GPT-5.4 context settings are experimental and can increase usage because requests beyond the standard context budget may count more heavily

## Agents and Skills

- Prompts: `prompts/*.md` (installed to `~/.codex/prompts/` for `user`, `./.codex/prompts/` for `project`)
- Skills: `skills/*/SKILL.md` (installed to `~/.agents/skills/` for `user`, `./.agents/skills/` for `project`)

Examples:
- Agents: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skills: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

### Notification Setup Skill (`$configure-notifications`)

Use `$configure-notifications` as the unified entry point for notification setup:

- Discord (webhook/bot)
- Telegram (bot)
- Slack (webhook)
- OpenClaw / custom webhook / custom CLI command

Examples:

```text
$configure-notifications "configure discord notifications"
$configure-notifications "configure slack notifications"
$configure-notifications "configure openclaw notifications"
```

For OpenClaw with **clawdbot agent turns** (instead of direct message forwarding),
configure a command gateway using `clawdbot agent --deliver --reply-channel ... --reply-to ...`
and map hook events (`session-start`, `session-idle`, `ask-user-question`, `session-stop`, `session-end`).

For dev teams using `#omc-dev`, the OpenClaw guide includes a dedicated runbook for:
- Korean-only hook responses
- `sessionId` + `tmuxSession` tracing
- `SOUL.md`-based follow-up workflow

See: `docs/openclaw-integration.md` (Dev Guide section).

Required env gates for OpenClaw command mode:

```bash
export OMX_OPENCLAW=1
export OMX_OPENCLAW_COMMAND=1
```

### Visual QA Loop (`$visual-verdict`)

Use `$visual-verdict` when a task depends on visual fidelity (reference image(s) + generated screenshot).

- Return structured JSON: `score`, `verdict`, `category_match`, `differences[]`, `suggestions[]`, `reasoning`
- Recommended pass threshold: **90+**
- For visual tasks, run `$visual-verdict` every iteration before the next edit
- Use pixel diff / pixelmatch overlays as **secondary debugging aids** (not the primary pass/fail signal)

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
npm run lint
npm run build
npm test
```

## Documentation

- **[Full Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** - Complete guide
- **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** - All `omx` commands, flags, and tools
- **[Notifications Guide](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** - Discord, Telegram, Slack, OpenClaw, and custom command/webhook setup
- **[Recommended Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** - Battle-tested skill chains for common tasks
- **[Prompt Guidance Contract](./docs/prompt-guidance-contract.md)** - Contributor reference for the GPT-5.4 prompt behavior contract
- **[Release Notes](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** - What's new in each version

## Notes

- Full changelog: `CHANGELOG.md`
- Migration guide (post-v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Coverage and parity notes: `COVERAGE.md`
- Hook extension workflow: `docs/hooks-extension.md`
- OpenClaw integration examples: `docs/openclaw-integration.md`
- Setup and contribution details: `CONTRIBUTING.md`

## Maintainers

- [Yeachan-Heo](https://github.com/Yeachan-Heo)
- [HaD0Yun](https://github.com/HaD0Yun)

## Acknowledgments

Inspired by [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), adapted for Codex CLI.

## License

MIT
