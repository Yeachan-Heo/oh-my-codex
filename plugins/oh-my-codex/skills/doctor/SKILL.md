---
name: doctor
description: Diagnose and fix oh-my-codex installation issues
---

# OMX Doctor

Use this task card to diagnose installation/discovery problems. Shared safety, lifecycle, hook, team, autonomy, and cancellation rules live in `templates/AGENTS.md`. `~/.codex` means `${CODEX_HOME:-~/.codex}` when `CODEX_HOME` is set.

## Run diagnostics

```bash
omx doctor
omx doctor --team             # include Team runtime checks
omx doctor --verbose          # include detailed check evidence
omx doctor --force            # repair eligible repo artifact ownership issues
omx doctor --dry-run --force  # preview eligible ownership repairs
```

For a local source checkout, build first and invoke `node dist/cli/omx.js doctor`. Keep command output and exact paths for the report.

### Plugin cache and version

```bash
PLUGIN_CACHE_ROOT="${CODEX_HOME:-$HOME/.codex}/plugins/cache"
CACHE_ENTRIES=$(find "$PLUGIN_CACHE_ROOT" -path "*/oh-my-codex/*" -mindepth 3 -maxdepth 3 -type d 2>/dev/null)
if [[ -z "$CACHE_ENTRIES" ]]; then
  echo "Installed plugin cache: none"
else
  while IFS= read -r d; do
    m=$(basename "$(dirname "$(dirname "$d")")"); v=$(basename "$d")
    printf 'Installed plugin cache: marketplace=%s version=%s path=%s\n' "$m" "$v" "$d"
  done <<<"$CACHE_ENTRIES"
fi
LATEST=$(npm view oh-my-codex version 2>/dev/null)
echo "Latest npm: $LATEST"
```

No cache is INFO (normal for npm/setup-only installs). A non-`local` cache version differing from `LATEST`, or multiple versions for one marketplace, is WARN. Plugin discovery does not replace npm installation plus `omx setup`; native/runtime wiring remains setup-owned.

### Hooks, AGENTS, and skill roots

```bash
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
ls -la "$CODEX_DIR/config.toml" "$CODEX_DIR/settings.json" 2>/dev/null
rg 'keyword-detector|persistent-mode|session-start|stop-continuation' "$CODEX_DIR/config.toml" "$CODEX_DIR/settings.json" 2>/dev/null || true
ls -la "$CODEX_DIR/hooks"/*.sh 2>/dev/null
ls -la "$CODEX_DIR/AGENTS.md" 2>/dev/null
grep -q "oh-my-codex Multi-Agent System" "$CODEX_DIR/AGENTS.md" 2>/dev/null && echo "Has OMX config" || echo "Missing OMX config"
ls -la "$CODEX_DIR/agents" "$CODEX_DIR/commands" "$CODEX_DIR/skills" "$HOME/.agents/skills" 2>/dev/null
```

Classify legacy hook references as **CRITICAL** (duplicate hooks). The scripts `keyword-detector.sh`, `persistent-mode.sh`, `session-start.sh`, and `stop-continuation.sh` are **WARN**. Missing AGENTS.md is **CRITICAL**; missing the OMX marker is **WARN**. `${CODEX_HOME:-~/.codex}/skills` is the canonical user root. `~/.agents/skills` is historical and overlapping trees can duplicate skill entries. OMX files under legacy `agents/` or `commands/` are **WARN**.

With `--team`, retain any `resume_blocker`, `slow_shutdown`, `delayed_status_lag`, `stale_leader`, or `orphan_tmux_session` diagnostics; failed checks set a non-zero exit status.

## Report contract

```text
## OMX Doctor Report
### Summary
[HEALTHY / ISSUES FOUND]
### Checks
| Check | Status | Details |
| Plugin Version | OK/WARN/INFO | ... |
| Hook Config (config.toml / legacy settings.json) | OK/CRITICAL | ... |
| Legacy Scripts (~/.codex/hooks/) | OK/WARN | ... |
| AGENTS.md | OK/WARN/CRITICAL | ... |
| Plugin Cache | OK/WARN | ... |
| Legacy Agents / Commands | OK/WARN | ... |
| Skills (canonical / historical root) | OK/WARN | ... |
### Issues Found
1. ...
### Recommended Fixes
...
```

## Remediation (after user confirmation and confirming each target is OMX-owned)

Remove only confirmed OMX legacy content; preserve unrelated user files:

```bash
# If settings.json exists, remove only its legacy "hooks" section.
rm -f "$CODEX_DIR/hooks/keyword-detector.sh" "$CODEX_DIR/hooks/persistent-mode.sh" "$CODEX_DIR/hooks/session-start.sh" "$CODEX_DIR/hooks/stop-continuation.sh"
PLUGIN_CACHE_ROOT="${CODEX_HOME:-$HOME/.codex}/plugins/cache"
find "$PLUGIN_CACHE_ROOT" -path "*/oh-my-codex" -type d -prune -exec rm -rf {} +
```

For older curl installs, inspect first and remove only directories containing OMX-managed files:

```bash
ls -la "$CODEX_DIR/agents" "$CODEX_DIR/commands" "$CODEX_DIR/skills" "$HOME/.agents/skills" 2>/dev/null
# Optional backups:
# mv "$CODEX_DIR/agents" "$CODEX_DIR/agents.bak"
# mv "$CODEX_DIR/commands" "$CODEX_DIR/commands.bak"
# mv "$HOME/.agents/skills" "$HOME/.agents/skills.bak"
rm -rf "$CODEX_DIR/agents" "$CODEX_DIR/commands" "$HOME/.agents/skills"
```

If AGENTS.md is missing/outdated, fetch the current raw file and write it to `$CODEX_DIR/AGENTS.md`:

```text
WebFetch(url: "https://raw.githubusercontent.com/Yeachan-Heo/oh-my-codex/main/docs/AGENTS.md", prompt: "Return the complete raw markdown content exactly as-is")
```

To keep only the newest cache version for a selected marketplace:

```bash
PLUGIN_CACHE_DIR="$PLUGIN_CACHE_ROOT/$MARKETPLACE_NAME/oh-my-codex"
KEEP_VERSION=$(for d in "$PLUGIN_CACHE_DIR"/*; do [[ -d "$d" ]] && basename "$d"; done | sort -V | tail -1)
[[ -n "$KEEP_VERSION" ]] && find "$PLUGIN_CACHE_DIR" -mindepth 1 -maxdepth 1 -type d ! -name "$KEEP_VERSION" -exec rm -rf {} +
```

If AGENTS.md is missing or stale, refresh it from the current release source, then rerun `omx doctor`. If legacy `~/.agents/skills` overlaps the canonical root, archive/remove that tree only after checking for custom skills. Restart Codex after fixes and report before/after evidence.

## Exit conditions

Stop with **HEALTHY** only when required paths, hook/config checks, AGENTS marker, plugin cache status, and (when requested) Team checks pass. Otherwise report **ISSUES FOUND**, exact failed evidence, and the smallest confirmed remediation; do not claim a fix from a recommendation alone.
