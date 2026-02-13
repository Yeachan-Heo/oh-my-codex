# oh-my-codex (OMX)

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Multi-agent orchestration for [OpenAI Codex CLI](https://github.com/openai/codex). Inspired by [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode).

## Why oh-my-codex?

Codex CLI is powerful on its own. OMX makes it **orchestrated**:

| Vanilla Codex CLI | With oh-my-codex |
|-------------------|-------------------|
| Single agent, single prompt | 30 specialized agents with role-specific prompts |
| Manual workflow management | 39 workflow skills (autopilot, team, plan, ralph...) |
| No persistent context | Project memory, session notepad, mode state via MCP |
| No multi-agent coordination | Team pipeline with verify/fix loops, up to 6 concurrent agents |
| No verification protocol | Evidence-backed verification with architect sign-off |

**Key design decision**: OMX is a pure add-on -- not a fork. It uses Codex CLI's native extension points so you always stay on upstream.

## Prerequisites

- **Node.js** >= 20
- **[OpenAI Codex CLI](https://github.com/openai/codex)** installed (`npm install -g @openai/codex`)
- **OpenAI API key** configured

## Quick Start

```bash
# Install
npm install -g oh-my-codex

# Setup (installs prompts, skills, configures Codex CLI)
omx setup

# Verify installation
omx doctor

# Start using
omx
```

Inside a Codex CLI session:

```
> /prompts:architect "analyze the authentication module"
> /prompts:executor "add input validation to the login flow"
> $autopilot "build a REST API for user management"
> $team 3:executor "fix all TypeScript errors"
```

## How It Works

OMX installs into Codex CLI's native extension points:

| Extension Point | What OMX Uses It For |
|----------------|---------------------|
| `AGENTS.md` | Orchestration brain loaded at session start |
| `~/.codex/prompts/*.md` | 30 agent definitions as `/prompts:name` commands |
| `~/.agents/skills/*/SKILL.md` | 39 workflow skills invoked via `$name` |
| `config.toml` MCP servers | State management + project memory |
| `config.toml` notify | Post-turn logging and metrics |
| `config.toml` features | `collab` (sub-agents) + `child_agents_md` |

```
User -> Codex CLI -> AGENTS.md (orchestration brain)
                  -> ~/.codex/prompts/*.md (30 agents)
                  -> ~/.agents/skills/*/SKILL.md (39 skills)
                  -> config.toml (MCP, notify, features)
                  -> .omx/ (state, memory, notepad, plans)
```

## Agent Catalog (30 agents)

Invoke agents with `/prompts:name` in Codex CLI.

### Build & Analysis
| Agent | Tier | Description |
|-------|------|-------------|
| `/prompts:explore` | Low | Codebase discovery, symbol/file mapping |
| `/prompts:analyst` | High | Requirements clarity, acceptance criteria |
| `/prompts:planner` | High | Task sequencing, execution plans, risk flags |
| `/prompts:architect` | High | System design, boundaries, interfaces |
| `/prompts:debugger` | Standard | Root-cause analysis, failure diagnosis |
| `/prompts:executor` | Standard | Code implementation, refactoring |
| `/prompts:deep-executor` | High | Complex autonomous goal-oriented tasks |
| `/prompts:verifier` | Standard | Completion evidence, claim validation |

### Review
| Agent | Tier | Description |
|-------|------|-------------|
| `/prompts:style-reviewer` | Low | Formatting, naming, lint conventions |
| `/prompts:quality-reviewer` | Standard | Logic defects, anti-patterns |
| `/prompts:api-reviewer` | Standard | API contracts, versioning |
| `/prompts:security-reviewer` | Standard | Vulnerabilities, OWASP Top 10 |
| `/prompts:performance-reviewer` | Standard | Hotspots, complexity optimization |
| `/prompts:code-reviewer` | High | Comprehensive review across concerns |

### Domain Specialists
| Agent | Tier | Description |
|-------|------|-------------|
| `/prompts:dependency-expert` | Standard | External SDK/API evaluation |
| `/prompts:test-engineer` | Standard | Test strategy, coverage |
| `/prompts:quality-strategist` | Standard | Release readiness, risk assessment |
| `/prompts:build-fixer` | Standard | Build/toolchain failures |
| `/prompts:designer` | Standard | UX/UI architecture |
| `/prompts:writer` | Low | Docs, migration notes |
| `/prompts:qa-tester` | Standard | Interactive CLI validation |
| `/prompts:scientist` | Standard | Data/statistical analysis |
| `/prompts:git-master` | Standard | Commit strategy, history hygiene |
| `/prompts:researcher` | Standard | External documentation research |

### Product
| Agent | Tier | Description |
|-------|------|-------------|
| `/prompts:product-manager` | Standard | Problem framing, PRDs |
| `/prompts:ux-researcher` | Standard | Heuristic audits, usability |
| `/prompts:information-architect` | Standard | Taxonomy, navigation |
| `/prompts:product-analyst` | Standard | Product metrics, experiments |

### Coordination
| Agent | Tier | Description |
|-------|------|-------------|
| `/prompts:critic` | High | Plan/design critical challenge |
| `/prompts:vision` | Standard | Image/screenshot analysis |

## Skills (39 skills)

Invoke skills with `$name` in Codex CLI (e.g., `$autopilot "build a REST API"`).

### Execution Modes
| Skill | Description |
|-------|-------------|
| `$autopilot` | Full autonomous execution from idea to working code |
| `$ralph` | Persistence loop with architect verification |
| `$ultrawork` | Maximum parallelism with parallel agent orchestration |
| `$team` | N coordinated agents on shared task list |
| `$pipeline` | Sequential agent chaining with data passing |
| `$ecomode` | Token-efficient execution using lightweight models |
| `$ultrapilot` | Parallel autopilot with file ownership partitioning |
| `$ultraqa` | QA cycling: test, verify, fix, repeat |

### Planning
| Skill | Description |
|-------|-------------|
| `$plan` | Strategic planning with optional consensus/review modes |
| `$ralplan` | Consensus planning (planner + architect + critic) |

### Agent Shortcuts
| Skill | Routes To | Trigger |
|-------|-----------|---------|
| `$analyze` | debugger | "analyze", "debug", "investigate" |
| `$deepsearch` | explore | "search", "find in codebase" |
| `$tdd` | test-engineer | "tdd", "test first" |
| `$build-fix` | build-fixer | "fix build", "type errors" |
| `$code-review` | code-reviewer | "review code" |
| `$security-review` | security-reviewer | "security review" |
| `$frontend-ui-ux` | designer | UI/component work |
| `$git-master` | git-master | Git/commit work |

### Utilities
`$cancel` `$doctor` `$help` `$note` `$trace` `$skill` `$learner` `$research` `$deepinit` `$release` `$hud` `$omx-setup` `$configure-telegram` `$configure-discord` `$writer-memory` `$psm` `$ralph-init` `$learn-about-omx` `$review`

## Team Orchestration

The `$team` skill provides a staged multi-agent pipeline:

```
team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)
```

Each stage uses specialized agents. The verify/fix loop is bounded by max attempts. Terminal states: `complete`, `failed`, `cancelled`.

```
$team 3:executor "fix all TypeScript errors across the project"
$team 5:designer "implement responsive layouts for all pages"
$team ralph "build a complete REST API"   # team + ralph persistence
```

## MCP Servers

OMX provides two MCP servers configured via `config.toml`:

- **`omx_state`** -- Mode lifecycle state (autopilot, ralph, ultrawork, team, etc.)
- **`omx_memory`** -- Project memory and session notepad

## Magic Keywords

The AGENTS.md orchestration brain detects keywords and activates skills automatically:

| Say this... | Activates |
|-------------|-----------|
| "ralph", "don't stop", "keep going" | `$ralph` persistence loop |
| "autopilot", "build me" | `$autopilot` autonomous pipeline |
| "team", "coordinated team" | `$team` multi-agent orchestration |
| "plan this", "let's plan" | `$plan` strategic planning |
| "fix build", "type errors" | `$build-fix` build error resolution |

## CLI Commands

```bash
omx --yolo    # Launch Codex with low-friction execution flags
omx --madmax  # Launch Codex with full approval+sandbox bypass (dangerous)
omx setup     # Install and configure OMX
omx doctor    # Run 9 installation health checks
omx tmux-hook # Manage tmux prompt-injection workaround (init/status/validate/test)
omx status    # Show active mode state
omx cancel    # Cancel active execution modes
omx hud       # Show HUD statusline (--watch, --json, --preset=NAME)
omx version   # Print version info
omx help      # Usage guide
```

## Launch Options

- `--yolo`
  Launch shorthand for `omx launch --yolo`.

- `--madmax`
  Launches Codex with `--dangerously-bypass-approvals-and-sandbox` (native Codex flag).
  This bypasses approval prompts and sandboxing.
  Use only in externally sandboxed/trusted environments.

## Tmux Injection Workaround (Opt-In)

OMX includes a production-safe workaround for Codex hook limitations: it can inject a continuation prompt into a tmux pane from `scripts/notify-hook.js`.

Safety defaults:
- Disabled by default (`enabled: false`)
- No shell interpolation for tmux commands (argv-based subprocess execution)
- Guardrails: allowed-mode gating, dedupe keying, cooldown, max injections/session, marker loop guard
- Failures are non-fatal and logged

Initialize config:

```bash
omx tmux-hook init
```

Check status/state:

```bash
omx tmux-hook status
```

Validate tmux target:

```bash
omx tmux-hook validate
```

Run an end-to-end synthetic hook turn:

```bash
omx tmux-hook test
```

Config file: `.omx/tmux-hook.json`  
Runtime state: `.omx/state/tmux-hook-state.json`  
Structured logs: `.omx/logs/tmux-hook-YYYY-MM-DD.jsonl`

Compatibility note:
- OMX writes `notify` as a TOML array by default.
- Override with `OMX_NOTIFY_FORMAT=string` before `omx setup` for environments that require string notify syntax.

## Setup Details

`omx setup` performs 7 steps:

1. Creates directories (`~/.codex/prompts/`, `~/.agents/skills/`, `.omx/state/`)
2. Installs 30 agent prompt files to `~/.codex/prompts/`
3. Installs 39 skill directories to `~/.agents/skills/`
4. Updates `~/.codex/config.toml` with MCP servers, features, notify hook, and `[tui] status_line`
5. Generates `AGENTS.md` orchestration brain in the current project root
6. Configures the post-turn notification hook
7. Creates `.omx/hud-config.json` with default HUD preset

## Coverage

~92% feature parity with oh-my-claudecode (excluding MCP tools). See [COVERAGE.md](COVERAGE.md) for the detailed matrix and known gaps.

## Project Structure

```
oh-my-codex/
  bin/omx.js              # CLI entry point
  src/
    cli/                   # CLI commands (setup, doctor, version, tmux-hook, status, cancel, hud, help)
    hud/                   # HUD statusline (state readers, ANSI renderer, presets)
    config/                # config.toml generator
    agents/                # Agent definitions registry
    mcp/                   # MCP servers (state, memory)
    hooks/                 # Hook emulation layer + keyword detector
    modes/                 # Mode lifecycle management
    team/                  # Team orchestration (staged pipeline)
    verification/          # Verification protocol
    notifications/         # Desktop/Discord/Telegram notifications
    utils/                 # Path resolution, package utilities
  prompts/                 # 30 agent prompt files (*.md)
  skills/                  # 39 skill directories (*/SKILL.md)
  templates/               # AGENTS.md template
  scripts/                 # notify-hook.js, tmux-hook-engine.js
```

## Development

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm link
omx setup && omx doctor
```

## Acknowledgments

oh-my-codex is inspired by [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode), which pioneered multi-agent orchestration for Claude Code. OMX adapts the same concepts -- agent roles, workflow skills, orchestration brain, mode lifecycle -- to work with OpenAI's Codex CLI through its native extension points.

## License

MIT
