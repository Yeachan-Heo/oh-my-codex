---
name: doctor
description: Diagnose and fix oh-my-codex installation issues
---

# Doctor Skill

Note: All `~/.codex/...` paths in this guide respect `CODEX_HOME` when that environment variable is set.

## Canonical skill root

OMX installs skills to `${CODEX_HOME:-~/.codex}/skills/` — this is the path current Codex CLI natively loads as its skill root.

`~/.agents/skills/` is a **historical legacy path** from an older Codex CLI release, before Codex settled on `~/.codex` as its home directory. Current Codex CLI and OMX no longer write there.

**In a mixed OMX + plain Codex environment:**
- **Use**: `${CODEX_HOME:-~/.codex}/skills/` (user scope) or `.codex/skills/` (project scope)
- **Clean up if present**: `~/.agents/skills/` — if this still exists alongside the canonical root, Codex's Enable/Disable Skills UI will show duplicate entries for any skill present in both trees
- **Interop rule**: OMX writes only to the canonical path; archive or remove `~/.agents/skills/` once you have confirmed `${CODEX_HOME:-~/.codex}/skills/` is your active root

## Task: Run Installation Diagnostics

You are the OMX Doctor - diagnose and fix installation issues.

### Step 1: Check Plugin Version

Official Codex plugin caches are marketplace- and version-scoped, for example `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/`. Local installs may use `local` as the version identifier.

```bash
# Get installed plugin cache versions across marketplaces.
# Cache shape: $PLUGIN_CACHE_ROOT/$MARKETPLACE_NAME/oh-my-codex/$PLUGIN_VERSION/
PLUGIN_CACHE_ROOT="${CODEX_HOME:-$HOME/.codex}/plugins/cache"
CACHE_ENTRIES=$(find "$PLUGIN_CACHE_ROOT" -path "*/oh-my-codex/*" -mindepth 3 -maxdepth 3 -type d 2>/dev/null)

if [[ -z "$CACHE_ENTRIES" ]]; then
  echo "Installed plugin cache: none"
else
  while IFS= read -r VERSION_DIR; do
    MARKETPLACE_NAME=$(basename "$(dirname "$(dirname "$VERSION_DIR")")")
    PLUGIN_VERSION=$(basename "$VERSION_DIR")
    printf 'Installed plugin cache: marketplace=%s version=%s path=%s\n' "$MARKETPLACE_NAME" "$PLUGIN_VERSION" "$VERSION_DIR"
  done <<< "$CACHE_ENTRIES"
fi

# Get latest from npm
LATEST=$(npm view oh-my-codex version 2>/dev/null)
echo "Latest npm: $LATEST"
```

**Diagnosis**:
- If no cache entry exists: INFO - plugin marketplace artifact not cached; this may be normal when OMX was installed only through npm/setup
- Compare each printed `PLUGIN_VERSION` with `LATEST`; if it differs and is not `local`: WARN - outdated plugin cache
- If one marketplace has multiple version directories: WARN - stale cache for that marketplace/plugin pair
- Remember: plugin install/discovery is not a replacement for `npm install -g oh-my-codex` plus `omx setup`; the packaged plugin now carries plugin-scoped companion metadata for MCP servers and apps, while native/runtime hooks and the rest of OMX runtime wiring stay setup-owned

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
# List marketplace/version cache entries for this plugin
PLUGIN_CACHE_ROOT="${CODEX_HOME:-$HOME/.codex}/plugins/cache"
find "$PLUGIN_CACHE_ROOT" -path "*/oh-my-codex/*" -mindepth 3 -maxdepth 3 -type d 2>/dev/null \
  | while IFS= read -r VERSION_DIR; do
      MARKETPLACE_NAME=$(basename "$(dirname "$(dirname "$VERSION_DIR")")")
      PLUGIN_VERSION=$(basename "$VERSION_DIR")
      printf '%s\t%s\n' "$MARKETPLACE_NAME" "$PLUGIN_VERSION"
    done
```

**Diagnosis**:
- If a single marketplace lists multiple versions: WARN - multiple cached versions for that marketplace/plugin pair (cleanup recommended)

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
- If `~/.codex/agents/` exists with oh-my-codex-related files: WARN - legacy generated agents or hand-installed role files. The Codex plugin can package reusable workflows plus plugin-scoped companion metadata for MCP/apps, but `omx setup` remains responsible for native agents/config/hooks.
- If `~/.codex/commands/` exists with oh-my-codex-related files: WARN - legacy command files from older installs. Current OMX uses skills/workflows plus setup-managed native surfaces.
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
# Global cache reset across all marketplaces for this plugin.
# If you only want one marketplace, set MARKETPLACE_NAME and remove just that subtree instead.
PLUGIN_CACHE_ROOT="${CODEX_HOME:-$HOME/.codex}/plugins/cache"
find "$PLUGIN_CACHE_ROOT" -path "*/oh-my-codex" -type d -prune -exec rm -rf {} +
echo "Plugin cache cleared across all marketplaces. Restart Codex CLI to fetch the latest marketplace entry."
```

### Fix: Stale Cache (multiple versions)
```bash
# Keep only the newest version inside the selected marketplace/plugin cache.
# Set MARKETPLACE_NAME to the exact marketplace printed in Step 1.
PLUGIN_CACHE_ROOT="${CODEX_HOME:-$HOME/.codex}/plugins/cache"
PLUGIN_CACHE_DIR="$PLUGIN_CACHE_ROOT/$MARKETPLACE_NAME/oh-my-codex"
KEEP_VERSION=$(for dir in "$PLUGIN_CACHE_DIR"/*; do [[ -d "$dir" ]] && basename "$dir"; done | sort -V | tail -1)
if [[ -n "$KEEP_VERSION" ]]; then
  find "$PLUGIN_CACHE_DIR" -mindepth 1 -maxdepth 1 -type d ! -name "$KEEP_VERSION" -exec rm -rf {} +
fi
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
