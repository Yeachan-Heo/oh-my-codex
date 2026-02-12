# oh-my-codex (OMX)

Multi-agent orchestration layer for [OpenAI Codex CLI](https://github.com/openai/codex). Inspired by [oh-my-claudecode](https://github.com/anthropics/oh-my-claudecode).

## What is this?

OMX brings 30 specialized agent roles, 39 workflow skills, mode lifecycle management, team orchestration, verification protocols, and notification systems to Codex CLI -- without forking the upstream project.

## Architecture

```
User -> Codex CLI -> AGENTS.md (orchestration brain)
                  -> ~/.codex/prompts/*.md (30 agent slash commands)
                  -> ~/.agents/skills/*/SKILL.md (39 skills)
                  -> config.toml (MCP servers, notify hook, features)
                  -> .omx/ (state, memory, notepad, plans)
```

**Key design decision**: OMX is an add-on, not a fork. It uses Codex CLI's native extension points:

| Extension Point | What OMX Uses It For |
|----------------|---------------------|
| `AGENTS.md` | Orchestration brain (equivalent to CLAUDE.md) |
| `~/.codex/prompts/*.md` | 30 agent definitions as slash commands |
| `~/.agents/skills/*/SKILL.md` | 39 workflow skills |
| `config.toml` MCP servers | State management + project memory |
| `config.toml` notify | Post-turn logging and metrics |
| `config.toml` features | collab (sub-agents), child_agents_md |

## Quick Start

```bash
# Install
npm install -g oh-my-codex

# Setup (installs prompts, skills, configures Codex CLI)
omx setup

# Verify installation
omx doctor

# Start using in Codex CLI
codex
> /architect "analyze the auth module"
> /autopilot "build a REST API for user management"
> /team 3:executor "fix all TypeScript errors"
```

## Setup Details

`omx setup` performs these steps:

1. Creates directories (`~/.codex/prompts/`, `~/.agents/skills/`, `.omx/state/`)
2. Installs 30 agent prompt files to `~/.codex/prompts/`
3. Installs 39 skill SKILL.md files to `~/.agents/skills/`
4. Updates `~/.codex/config.toml` with MCP servers and features
5. Generates `AGENTS.md` in the current project root
6. Configures the notify hook for post-turn logging

## Agent Catalog (30 agents)

### Build & Analysis
| Agent | Model | Description |
|-------|-------|-------------|
| `/explore` | haiku | Codebase discovery, symbol/file mapping |
| `/analyst` | opus | Requirements clarity, acceptance criteria |
| `/planner` | opus | Task sequencing, execution plans |
| `/architect` | opus | System design, boundaries, interfaces |
| `/debugger` | sonnet | Root-cause analysis, failure diagnosis |
| `/executor` | sonnet | Code implementation, refactoring |
| `/deep-executor` | opus | Complex autonomous goal-oriented tasks |
| `/verifier` | sonnet | Completion evidence, claim validation |

### Review
| Agent | Model | Description |
|-------|-------|-------------|
| `/style-reviewer` | haiku | Formatting, naming, lint conventions |
| `/quality-reviewer` | sonnet | Logic defects, anti-patterns |
| `/api-reviewer` | sonnet | API contracts, versioning |
| `/security-reviewer` | sonnet | Vulnerabilities, OWASP Top 10 |
| `/performance-reviewer` | sonnet | Hotspots, complexity optimization |
| `/code-reviewer` | opus | Comprehensive review across concerns |

### Domain Specialists
| Agent | Model | Description |
|-------|-------|-------------|
| `/dependency-expert` | sonnet | External SDK/API evaluation |
| `/test-engineer` | sonnet | Test strategy, coverage |
| `/quality-strategist` | sonnet | Release readiness, risk assessment |
| `/build-fixer` | sonnet | Build/toolchain failures |
| `/designer` | sonnet | UX/UI architecture |
| `/writer` | haiku | Docs, migration notes |
| `/qa-tester` | sonnet | Interactive CLI validation |
| `/scientist` | sonnet | Data/statistical analysis |
| `/git-master` | sonnet | Commit strategy, history hygiene |

### Product
| Agent | Model | Description |
|-------|-------|-------------|
| `/product-manager` | sonnet | Problem framing, PRDs |
| `/ux-researcher` | sonnet | Heuristic audits, usability |
| `/information-architect` | sonnet | Taxonomy, navigation |
| `/product-analyst` | sonnet | Product metrics, experiments |

### Coordination
| Agent | Model | Description |
|-------|-------|-------------|
| `/critic` | opus | Plan/design critical challenge |
| `/vision` | sonnet | Image/screenshot analysis |

## Skills (39 skills)

### Execution Modes
- **autopilot** - Full autonomous execution from idea to working code
- **ralph** - Persistence loop with architect verification
- **ultrawork** - Maximum parallelism with parallel agent orchestration
- **team** - N coordinated agents on shared task list
- **pipeline** - Sequential agent chaining with data passing
- **ecomode** - Token-efficient execution using haiku and sonnet
- **ultrapilot** - Parallel autopilot with file ownership partitioning
- **ultraqa** - QA cycling: test, verify, fix, repeat
- **swarm** - Compatibility facade over team

### Planning
- **plan** - Strategic planning with optional consensus/review modes
- **ralplan** - Consensus planning (planner + architect + critic)

### Agent Shortcuts
- **analyze** - Deep analysis and investigation
- **deepsearch** - Thorough codebase search
- **tdd** - Test-driven development workflow
- **build-fix** - Fix build and TypeScript errors
- **code-review** - Comprehensive code review
- **security-review** - Security vulnerability review
- **frontend-ui-ux** - UI/UX design work
- **git-master** - Git operations
- **review** - Plan review/critique

### Utilities
- **cancel** - Cancel any active mode
- **doctor** - Diagnose installation issues
- **help** - Usage guide
- **note** - Save notes to notepad
- **trace** - Agent flow trace timeline
- **skill** - Manage local skills
- **learner** - Extract learned skills
- **research** - Parallel research agents
- **deepinit** - Deep codebase init with AGENTS.md
- **release** - Automated release workflow
- **hud** - Status display configuration
- **omx-setup** - Setup and configure OMX
- **configure-telegram** - Telegram notifications
- **configure-discord** - Discord notifications
- **writer-memory** - Writer memory system
- **project-session-manager** / **psm** - Isolated dev environments
- **ralph-init** - Initialize PRD for ralph-loop
- **learn-about-omx** - OMX usage patterns

## MCP Servers

OMX provides two MCP servers that Codex CLI connects to via config.toml:

### State Server (`omx_state`)
Manages mode lifecycle state for all execution modes.
- `state_read` / `state_write` / `state_clear`
- `state_list_active` / `state_get_status`
- Supports: autopilot, ralph, ultrawork, ecomode, ultrapilot, team, pipeline, ultraqa, ralplan

### Memory Server (`omx_memory`)
Project memory and session notepad.
- `project_memory_read` / `project_memory_write`
- `project_memory_add_note` / `project_memory_add_directive`
- `notepad_read` / `notepad_write_priority` / `notepad_write_working` / `notepad_write_manual`

## Team Orchestration

The team skill provides a staged pipeline:

```
team-plan -> team-prd -> team-exec -> team-verify -> team-fix (loop)
```

Each stage uses specialized agents. The verify/fix loop is bounded by max attempts to prevent infinite loops. Terminal states: `complete`, `failed`, `cancelled`.

## Notification System

Supports three channels (configured in `.omx/notifications.json`):
- **Desktop** - Native notifications (macOS, Linux, Windows)
- **Discord** - Webhook integration with embedded messages
- **Telegram** - Bot API with Markdown formatting

## Verification Protocol

Evidence-backed verification with task sizing:
- **Small** (<5 files, <100 lines): Type check + related tests
- **Standard**: Full type check + test suite + linter
- **Large** (>20 files): Full check + security review + performance assessment + regression testing

## Hook Emulation

Codex CLI has limited hook support (AfterAgent, AfterToolUse only). OMX emulates the full hook pipeline:

| OMC Hook | OMX Equivalent | Capability |
|----------|---------------|------------|
| SessionStart | AGENTS.md native loading | Full |
| PreToolUse | AGENTS.md inline guidance | Partial |
| PostToolUse | notify config hook | Partial |
| UserPromptSubmit | AGENTS.md self-detection | Partial |
| SubagentStart/Stop | Codex CLI collab native | Full |
| Stop | notify config | Full |

## Coverage

**~92% feature parity with oh-my-claudecode** (excluding MCP tools).

See [COVERAGE.md](COVERAGE.md) for the detailed feature matrix.

## Project Structure

```
oh-my-codex/
  bin/omx.js              # CLI entry point
  src/
    cli/                   # CLI commands (setup, doctor, version, status, cancel, help)
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
  scripts/                 # notify-hook.js
  dist/                    # Compiled output
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Type check
npx tsc --noEmit

# Link for local development
npm link
```

## License

MIT
