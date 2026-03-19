---
name: doctor
description: Diagnose and fix oh-my-codex installation issues
---

# Doctor Skill

Note: All `~/.codex/...` paths in this guide respect `CODEX_HOME` when that environment variable is set.

## Task: Run OMX Health Diagnostics

You are the OMX Doctor — validate the current installation using the **built-in `omx doctor` surfaces first**, then recommend the lightest fix that matches the reported issue.

## Primary workflow

### Step 1: Run the standard health check

```bash
omx doctor
```

This is the source of truth for current OMX installation health.

### Step 2: Optional team-runtime check

If the user asks about team/swarm runtime health, also run:

```bash
omx doctor --team
```

### Step 3: Interpret the result

Current `omx doctor` checks include:
- Codex CLI installed
- Node.js available
- Explore harness readiness
- Codex home exists
- `config.toml` contains OMX entries
- prompts installed
- skills installed
- `AGENTS.md` present
- `.omx/state` present
- MCP servers configured

### Step 4: Recommend the matching fix

Use the narrowest fix that matches the warning/failure:

- **Prompts / skills / AGENTS / config drift**
  ```bash
  omx setup --force
  ```
- **Wrong installation scope**
  ```bash
  omx setup --scope user --force
  # or
  omx setup --scope project --force
  ```
- **Explore harness warning** (`cargo` missing or no packaged native binary)
  - install Rust / `cargo`, or
  - set `OMX_EXPLORE_BIN`, or
  - accept that only `omx explore` native acceleration is degraded while core OMX remains healthy
- **Codex config missing OMX entries**
  ```bash
  omx setup --force
  ```
- **MCP issues after reinstall/update**
  ```bash
  omx setup --force
  omx doctor
  ```

## Scope + current install locations

Current OMX installs to these active locations:

- **User scope**
  - prompts: `~/.codex/prompts/`
  - skills: `~/.codex/skills/`
  - native agents: `~/.codex/agents/`
  - config: `~/.codex/config.toml`
  - AGENTS: `~/.codex/AGENTS.md`
- **Project scope**
  - prompts: `./.codex/prompts/`
  - skills: `./.codex/skills/`
  - native agents: `./.codex/agents/`
  - config: `./.codex/config.toml`
  - AGENTS: `./AGENTS.md`

## Report format

After running diagnostics, output:

```markdown
## OMX Doctor Report

### Summary
[HEALTHY / WARNINGS / FAILURES]

### Checks
| Check | Status | Details |
|-------|--------|---------|
| Codex CLI | OK/WARN/FAIL | ... |
| Node.js | OK/WARN/FAIL | ... |
| Explore Harness | OK/WARN | ... |
| Codex Home | OK/WARN/FAIL | ... |
| Config | OK/WARN/FAIL | ... |
| Prompts | OK/WARN/FAIL | ... |
| Skills | OK/WARN/FAIL | ... |
| AGENTS.md | OK/WARN/FAIL | ... |
| State Dir | OK/WARN/FAIL | ... |
| MCP Servers | OK/WARN/FAIL | ... |

### Recommended Fixes
1. ...
2. ...
```

## Important guardrails

- Do **not** describe `~/.codex/skills/` or `~/.codex/agents/` as legacy; they are the active current install locations.
- Prefer `omx doctor` / `omx setup --force` over stale manual cleanup recipes.
- Only recommend destructive cleanup when you have concrete evidence of stale or conflicting files.
- After fixes, rerun `omx doctor` and report the new status.
