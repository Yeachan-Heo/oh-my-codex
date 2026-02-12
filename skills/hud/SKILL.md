---
name: hud
description: Configure HUD display options (layout, presets, display elements)
role: config-writer  # DOCUMENTATION ONLY - This skill writes to ~/.claude/ paths
scope: ~/.claude/**  # DOCUMENTATION ONLY - Allowed write scope
---

# HUD Skill

Configure the OMX HUD (Heads-Up Display) for the statusline.

Note: All `~/.claude/...` paths in this guide respect `CLAUDE_CONFIG_DIR` when that environment variable is set.

## Quick Commands

| Command | Description |
|---------|-------------|
| `/hud` | Show current HUD status (auto-setup if needed) |
| `/hud setup` | Install/repair HUD statusline |
| `/hud minimal` | Switch to minimal display |
| `/hud focused` | Switch to focused display (default) |
| `/hud full` | Switch to full display |
| `/hud status` | Show detailed HUD status |

## Auto-Setup

When you run `/hud` or `/hud setup`, the system will automatically:
1. Check if `~/.claude/hud/omc-hud.mjs` exists
2. Check if `statusLine` is configured in `~/.claude/settings.json`
3. If missing, create the HUD wrapper script and configure settings
4. Report status and prompt to restart Codex CLI if changes were made

**IMPORTANT**: If the argument is `setup` OR if the HUD script doesn't exist at `~/.claude/hud/omc-hud.mjs`, you MUST create the HUD files directly using the instructions below.

### Setup Instructions (Run These Commands)

**Step 1:** Check if setup is needed:
```bash
ls ~/.claude/hud/omc-hud.mjs 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

**Step 2:** Verify the plugin is installed:
```bash
PLUGIN_VERSION=$(ls ~/.claude/plugins/cache/omc/oh-my-codex/ 2>/dev/null | sort -V | tail -1)
if [ -n "$PLUGIN_VERSION" ]; then
  ls ~/.claude/plugins/cache/omc/oh-my-codex/$PLUGIN_VERSION/dist/hud/index.js 2>/dev/null && echo "READY" || echo "NOT_FOUND - try reinstalling: /plugin install oh-my-codex"
else
  echo "Plugin not installed - run: /plugin install oh-my-codex"
fi
```

**Step 3:** If omc-hud.mjs is MISSING or argument is `setup`, create the HUD directory and script:

First, create the directory:
```bash
mkdir -p ~/.claude/hud
```

Then, use the Write tool to create `~/.claude/hud/omc-hud.mjs` with this exact content:

```javascript
#!/usr/bin/env node
/**
 * OMX HUD - Statusline Script
 * Wrapper that imports from plugin cache or development paths
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Semantic version comparison: returns negative if a < b, positive if a > b, 0 if equal
function semverCompare(a, b) {
  // Use parseInt to handle pre-release suffixes (e.g. "0-beta" -> 0)
  const pa = a.replace(/^v/, "").split(".").map(s => parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  // If numeric parts equal, non-pre-release > pre-release
  const aHasPre = /-/.test(a);
  const bHasPre = /-/.test(b);
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return 0;
}

async function main() {
  const home = homedir();
  let pluginCacheDir = null;

  // 1. Try plugin cache first (marketplace: omc, plugin: oh-my-codex)
  const pluginCacheBase = join(home, ".claude/plugins/cache/omc/oh-my-codex");
  if (existsSync(pluginCacheBase)) {
    try {
      const versions = readdirSync(pluginCacheBase);
      if (versions.length > 0) {
        const latestVersion = versions.sort(semverCompare).reverse()[0];
        pluginCacheDir = join(pluginCacheBase, latestVersion);
        const pluginPath = join(pluginCacheDir, "dist/hud/index.js");
        if (existsSync(pluginPath)) {
          await import(pathToFileURL(pluginPath).href);
          return;
        }
      }
    } catch { /* continue */ }
  }

  // 2. Development paths
  const devPaths = [
    join(home, "Workspace/oh-my-claude-sisyphus/dist/hud/index.js"),
    join(home, "workspace/oh-my-claude-sisyphus/dist/hud/index.js"),
    join(home, "Workspace/oh-my-codex/dist/hud/index.js"),
    join(home, "workspace/oh-my-codex/dist/hud/index.js"),
  ];

  for (const devPath of devPaths) {
    if (existsSync(devPath)) {
      try {
        await import(pathToFileURL(devPath).href);
        return;
      } catch { /* continue */ }
    }
  }

  // 3. Fallback - HUD not found (provide actionable error message)
  if (pluginCacheDir) {
    console.log(`[OMX] HUD not built. Run: cd "${pluginCacheDir}" && npm install`);
  } else {
    console.log("[OMX] Plugin not found. Run: /omc-setup");
  }
}

main();
```

**Step 3:** Make it executable:
```bash
chmod +x ~/.claude/hud/omc-hud.mjs
```

**Step 4:** Update settings.json to use the HUD:

Read `~/.claude/settings.json`, then update/add the `statusLine` field.

**IMPORTANT:** The command must use an absolute path, not `~`, because Windows does not expand `~` in shell commands.

First, determine the correct path:
```bash
node -e "const p=require('path').join(require('os').homedir(),'.claude','hud','omc-hud.mjs');console.log(JSON.stringify(p))"
```

Then set the `statusLine` field using the resolved path. On Unix it will look like:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node /home/username/.claude/hud/omc-hud.mjs"
  }
}
```

On Windows it will look like:
```json
{
  "statusLine": {
    "type": "command",
    "command": "node C:\\Users\\username\\.claude\\hud\\omc-hud.mjs"
  }
}
```

Use the Edit tool to add/update this field while preserving other settings.

**Step 5:** Clean up old HUD scripts (if any):
```bash
rm -f ~/.claude/hud/sisyphus-hud.mjs 2>/dev/null
```

**Step 6:** Tell the user to restart Codex CLI for changes to take effect.

## Display Presets

### Minimal
Shows only the essentials:
```
[OMX] ralph | ultrawork | todos:2/5
```

### Focused (Default)
Shows all relevant elements:
```
[OMX] ralph:3/10 | US-002 | ultrawork skill:planner | ctx:67% | agents:2 | bg:3/5 | todos:2/5
```

### Full
Shows everything including multi-line agent details:
```
[OMX] ralph:3/10 | US-002 (2/5) | ultrawork | ctx:[████░░]67% | agents:3 | bg:3/5 | todos:2/5
├─ O architect    2m   analyzing architecture patterns...
├─ e explore     45s   searching for test files
└─ s executor     1m   implementing validation logic
```

## Multi-Line Agent Display

When agents are running, the HUD shows detailed information on separate lines:
- **Tree characters** (`├─`, `└─`) show visual hierarchy
- **Agent code** (O, e, s) indicates agent type with model tier color
- **Duration** shows how long each agent has been running
- **Description** shows what each agent is doing (up to 45 chars)

## Display Elements

| Element | Description |
|---------|-------------|
| `[OMX]` | Mode identifier |
| `ralph:3/10` | Ralph loop iteration/max |
| `US-002` | Current PRD story ID |
| `ultrawork` | Active mode badge |
| `skill:name` | Last activated skill (cyan) |
| `ctx:67%` | Context window usage |
| `agents:2` | Running subagent count |
| `bg:3/5` | Background task slots |
| `todos:2/5` | Todo completion |

## Color Coding

- **Green**: Normal/healthy
- **Yellow**: Warning (context >70%, ralph >7)
- **Red**: Critical (context >85%, ralph at max)

## Configuration Location

HUD config is stored at: `~/.claude/.omc/hud-config.json`

## Manual Configuration

You can manually edit the config file. Each option can be set individually - any unset values will use defaults.

```json
{
  "preset": "focused",
  "elements": {
    "omcLabel": true,
    "ralph": true,
    "prdStory": true,
    "activeSkills": true,
    "lastSkill": true,
    "contextBar": true,
    "agents": true,
    "backgroundTasks": true,
    "todos": true,
    "showCache": true,
    "showCost": true,
    "maxOutputLines": 4
  },
  "thresholds": {
    "contextWarning": 70,
    "contextCritical": 85,
    "ralphWarning": 7
  }
}
```

## Troubleshooting

If the HUD is not showing:
1. Run `/hud setup` to auto-install and configure
2. Restart Codex CLI after setup completes
3. If still not working, run `/doctor` for full diagnostics

Manual verification:
- HUD script: `~/.claude/hud/omc-hud.mjs`
- Settings: `~/.claude/settings.json` should have `statusLine` configured

---

*The HUD updates automatically every ~300ms during active sessions.*
