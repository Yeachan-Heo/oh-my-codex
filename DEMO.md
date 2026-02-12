# oh-my-codex Demo Guide

## Prerequisites

- Node.js >= 18
- [Codex CLI](https://github.com/openai/codex) installed (`npm install -g @openai/codex`)
- OpenAI API key configured

## Setup (< 2 minutes)

```bash
# Clone and install
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm link

# Run setup (installs prompts, skills, configures Codex CLI)
omx setup
```

**Expected output:**
```
oh-my-codex setup
=================

[1/6] Creating directories...
  Done.

[2/6] Installing agent prompts...
  Installed 30 agent prompts.

[3/6] Installing skills...
  Installed 39 skills.

[4/6] Updating config.toml...
  Done.

[5/6] Generating AGENTS.md...
  Generated AGENTS.md in project root.

[6/6] Configuring notification hook...
  Done.

Setup complete! Run "omx doctor" to verify installation.
```

## Verify Installation

```bash
omx doctor
```

**Expected output:**
```
oh-my-codex doctor
==================

  [OK] Codex CLI: installed
  [OK] Node.js: v18+
  [OK] Codex home: ~/.codex
  [OK] Config: config.toml has OMX entries
  [OK] Prompts: 30 agent prompts installed
  [OK] Skills: 39 skills installed
  [OK] AGENTS.md: found in project root
  [OK] State dir: .omx/state
  [OK] MCP Servers: 2 servers configured (OMX present)

Results: 9 passed, 0 warnings, 0 failed
```

## Demo 1: Agent Slash Commands

Start Codex CLI in any project directory:

```bash
codex
```

Then use agent slash commands:

```
> /architect "analyze the authentication module"
```

**Expected:** The architect agent analyzes code with file:line references, root cause diagnosis, and trade-off analysis.

```
> /security-reviewer "review the API endpoints"
```

**Expected:** OWASP Top 10 analysis with severity-prioritized findings and remediation code examples.

```
> /explorer "find all database query patterns"
```

**Expected:** Structural codebase search with file listings and pattern summaries.

## Demo 2: AGENTS.md Orchestration Brain

The generated `AGENTS.md` in your project root acts as the orchestration brain. It provides:

- Delegation rules (when to use which agent)
- Model routing (haiku for quick lookups, sonnet for implementation, opus for architecture)
- 30-agent catalog with descriptions
- 39 skill descriptions with trigger patterns
- Team compositions for common workflows
- Verification protocols

Codex CLI loads this automatically at session start.

## Demo 3: CLI Status Commands

```bash
# Check version
omx version

# Check all active modes
omx status

# Cancel any active mode
omx cancel
```

**Expected output for `omx version`:**
```
oh-my-codex v0.1.0
Node.js v18+
Platform: linux x64
```

**Expected output for `omx status` (no active modes):**
```
oh-my-codex status
==================

No active modes.
```

## Demo 4: Skills in Codex CLI

Skills are automatically discovered by Codex CLI. In a Codex session:

```
> /autopilot "build a REST API for task management"
```

**Expected:** Full autonomous pipeline: requirements analysis -> technical design -> parallel implementation -> QA cycling -> multi-perspective validation.

```
> /team 3:executor "fix all TypeScript errors"
```

**Expected:** Spawns 3 coordinated executor agents working on a shared task list with staged pipeline (plan -> prd -> exec -> verify -> fix loop).

## Demo 5: MCP State Management

The MCP servers are configured in `config.toml` and provide state/memory tools to the agent:

```
> Use state_read to check if any modes are active
> Use project_memory_read to see project context
> Use notepad_write_working to save a note about current progress
```

**Expected:** Agent accesses `.omx/state/` and `.omx/project-memory.json` through MCP tool calls.

## File Inventory

| Component | Count | Location |
|-----------|-------|----------|
| Agent prompts | 30 | `~/.codex/prompts/*.md` |
| Skills | 39 | `~/.agents/skills/*/SKILL.md` |
| MCP servers | 2 | Configured in `~/.codex/config.toml` |
| CLI commands | 6 | `omx setup/doctor/version/status/cancel/help` |
| AGENTS.md | 1 | Project root (generated) |

## Troubleshooting

**Codex CLI not found:** Install with `npm install -g @openai/codex`

**Slash commands not appearing:** Run `omx setup --force` to reinstall prompts

**MCP servers not connecting:** Check `~/.codex/config.toml` for `[mcp_servers.omx_state]` and `[mcp_servers.omx_memory]` entries

**Doctor shows warnings:** Run `omx setup` to install missing components
