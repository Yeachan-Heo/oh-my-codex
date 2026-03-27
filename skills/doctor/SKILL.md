---
name: doctor
description: Diagnose and fix oh-my-codex installation issues
---

# Doctor Skill

Note: All `~/.codex/...` paths in this guide respect `CODEX_HOME` when that environment variable is set.

## Task: Run Installation Diagnostics

You are the OMX Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

```bash
# Get installed version
INSTALLED=$(ls ~/.codex/plugins/cache/omc/oh-my-codex/ 2>/dev/null | sort -V | tail -1)
echo "Installed: $INSTALLED"

# Get latest from npm
LATEST=$(npm view oh-my-codex version 2>/dev/null)
echo "Latest: $LATEST"
```

**Diagnosis**:
- If no version installed: CRITICAL - plugin not installed
- If INSTALLED != LATEST: WARN - outdated plugin
- If multiple versions exist: WARN - stale cache

### Step 2: Check Hook Configuration (config.toml + legacy settings.json)

Check `~/.codex/config.toml` first (current Codex config), then check legacy `~/.codex/settings.json` only if it exists.

Look for hook entries pointing to removed scripts like:
- `bash $HOME/.codex/hooks/keyword-detector.sh`
- `bash $HOME/.codex/hooks/persistent-mode.sh`
- `bash $HOME/.codex/hooks/session-start.sh`

**Diagnosis**:
- If found: CRITICAL - legacy hooks causing duplicates

### Step 3: Check for Legacy Bash Hook Scripts

```bash
ls -la ~/.codex/hooks/*.sh 2>/dev/null
```

**Diagnosis**:
- If `keyword-detector.sh`, `persistent-mode.sh`, `session-start.sh`, or `stop-continuation.sh` exist: WARN - legacy scripts (can cause confusion)

### Step 4: Check AGENTS.md

```bash
# Check if AGENTS.md exists
ls -la ~/.codex/AGENTS.md 2>/dev/null

# Check for OMX marker
grep -q "oh-my-codex Multi-Agent System" ~/.codex/AGENTS.md 2>/dev/null && echo "Has OMX config" || echo "Missing OMX config"
```

**Diagnosis**:
- If missing: CRITICAL - AGENTS.md not configured
- If missing OMX marker: WARN - outdated AGENTS.md

### Step 5: Check for Stale Plugin Cache

```bash
# Count versions in cache
ls ~/.codex/plugins/cache/omc/oh-my-codex/ 2>/dev/null | wc -l
```

**Diagnosis**:
- If > 1 version: WARN - multiple cached versions (cleanup recommended)

### Step 6: Check for Legacy Curl-Installed Content

Check for legacy agents, commands, and historical legacy skill roots from older installs/migrations:

```bash
# Check for legacy agents directory
ls -la ~/.codex/agents/ 2>/dev/null

# Check for legacy commands directory
ls -la ~/.codex/commands/ 2>/dev/null

# Check canonical current skills directory
ls -la ${CODEX_HOME:-~/.codex}/skills/ 2>/dev/null

# Check historical legacy skill directory
ls -la ~/.agents/skills/ 2>/dev/null
```

**Diagnosis**:
- If `~/.codex/agents/` exists with oh-my-codex-related files: WARN - legacy agents (now provided by plugin)
- If `~/.codex/commands/` exists with oh-my-codex-related files: WARN - legacy commands (now provided by plugin)
- If `${CODEX_HOME:-~/.codex}/skills/` exists with OMX skills: OK - canonical current user skill root
- If `~/.agents/skills/` exists: WARN - historical legacy skill root that can overlap with `${CODEX_HOME:-~/.codex}/skills/` and cause duplicate Enable/Disable Skills entries

Look for files like:
- `architect.md`, `researcher.md`, `explore.md`, `executor.md`, etc. in agents/
- `ultrawork.md`, `deepsearch.md`, etc. in commands/
- Any oh-my-codex-related `.md` files in skills/

---

## Report Format

After running all checks, output a report:

```
## OMX Doctor Report

### Summary
[HEALTHY / ISSUES FOUND]

### Checks

| Check | Status | Details |
|-------|--------|---------|
| Plugin Version | OK/WARN/CRITICAL | ... |
| Hook Config (config.toml / legacy settings.json) | OK/CRITICAL | ... |
| Legacy Scripts (~/.codex/hooks/) | OK/WARN | ... |
| AGENTS.md | OK/WARN/CRITICAL | ... |
| Plugin Cache | OK/WARN | ... |
| Legacy Agents (~/.codex/agents/) | OK/WARN | ... |
| Legacy Commands (~/.codex/commands/) | OK/WARN | ... |
| Skills (${CODEX_HOME:-~/.codex}/skills) | OK/WARN | ... |
| Legacy Skill Root (~/.agents/skills) | OK/WARN | ... |

### Issues Found
1. [Issue description]
2. [Issue description]

### Recommended Fixes
[List fixes based on issues]
```

---

## Auto-Fix (if user confirms)

If issues found, ask user: "Would you like me to fix these issues automatically?"

If yes, apply fixes:

### Fix: Legacy Hooks in legacy settings.json
If `~/.codex/settings.json` exists, remove the legacy `"hooks"` section (keep other settings intact).

### Fix: Legacy Bash Scripts
```bash
rm -f ~/.codex/hooks/keyword-detector.sh
rm -f ~/.codex/hooks/persistent-mode.sh
rm -f ~/.codex/hooks/session-start.sh
rm -f ~/.codex/hooks/stop-continuation.sh
```

### Fix: Outdated Plugin
```bash
rm -rf ~/.codex/plugins/cache/omc/oh-my-codex
echo "Plugin cache cleared. Restart Codex CLI to fetch latest version."
```

### Fix: Stale Cache (multiple versions)
```bash
# Keep only latest version
cd ~/.codex/plugins/cache/omc/oh-my-codex/
ls | sort -V | head -n -1 | xargs rm -rf
```

### Fix: Missing/Outdated AGENTS.md
Fetch latest from GitHub and write to `~/.codex/AGENTS.md`:
```
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/docs/AGENTS.md", prompt: "Return the complete raw markdown content exactly as-is")
```

### Fix: Legacy Curl-Installed Content

Remove legacy agents/commands plus the historical `~/.agents/skills` tree if it overlaps with the canonical `${CODEX_HOME:-~/.codex}/skills` install:

```bash
# Backup first (optional - ask user)
# mv ~/.codex/agents ~/.codex/agents.bak
# mv ~/.codex/commands ~/.codex/commands.bak
# mv ~/.agents/skills ~/.agents/skills.bak

# Or remove directly
rm -rf ~/.codex/agents
rm -rf ~/.codex/commands
rm -rf ~/.agents/skills
```

**Note**: Only remove if these contain oh-my-codex-related files. If user has custom agents/commands/skills, warn them and ask before removing.

---

## Post-Fix

After applying fixes, inform user:
> Fixes applied. **Restart Codex CLI** for changes to take effect.
