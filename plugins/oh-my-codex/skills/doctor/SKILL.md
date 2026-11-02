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

Report npm `LATEST` as the published stable channel, not proof that a local/development build is stale. Multiple cache versions may still have active consumers; version order alone does not establish a defect or authorize pruning. Use `omx doctor`'s actual check results and paths. Plugin discovery does not replace npm installation plus scoped `omx setup`; native/runtime wiring remains setup-owned.

### Hooks, AGENTS, and skill roots

```bash
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
ls -la "$CODEX_DIR/config.toml" "$CODEX_DIR/settings.json" 2>/dev/null
rg 'keyword-detector|persistent-mode|session-start|stop-continuation' "$CODEX_DIR/config.toml" "$CODEX_DIR/settings.json" 2>/dev/null || true
ls -la "$CODEX_DIR/hooks"/*.sh 2>/dev/null
rg -n 'OMX:AGENTS:START|omx:generated:agents-md' "$CODEX_DIR/AGENTS.md" ./AGENTS.md 2>/dev/null || true
ls -la "$CODEX_DIR/agents" ./.codex/agents "$CODEX_DIR/commands" "$CODEX_DIR/skills" "$HOME/.agents/skills" 2>/dev/null
omx agents list
```

Check whether legacy hook references are active registrations before reporting duplicate execution; a script's presence alone does not prove it runs. Resolve the expected persistent AGENTS path from the selected setup scope (`$CODEX_DIR/AGENTS.md` for user scope, project-root `AGENTS.md` for project scope) and report the CLI's status rather than assigning a blanket severity.

`${CODEX_HOME:-~/.codex}/skills` is OMX's canonical user skill root. Codex may also discover `~/.agents/skills`; inspect overlapping names without treating that whole tree as disposable. Current setup-owned native TOMLs are expected in both plugin and legacy setup modes: user scope uses `$CODEX_DIR/agents/`, while project scope uses `<project>/.codex/agents/`. Run project checks from the intended project root; `omx agents list` shows both scopes by default. Check their catalog status and generated ownership markers; do not classify the directory itself as legacy. See the [plugin bundle ownership contract](https://github.com/Yeachan-Heo/oh-my-codex/blob/dev/docs/plugin-bundle-ssot.md) for the prompt/native-agent distinction, matching the installed revision when diagnosing version-specific behavior.

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
| Native Agents / Legacy Commands | OK/WARN | ... |
| Skills (canonical / historical root) | OK/WARN | ... |
### Issues Found
1. ...
### Recommended Fixes
...
```

## Remediation within the authorized scope

Diagnostics do not authorize deletion or setup changes. Continue an already-authorized repair without asking again; request only missing authority or a material scope/destructive decision. Before any removal or replacement, record the exact target, ownership evidence, current content/identity, active consumers, preserved dependencies, and intended effect. A directory containing OMX files can also contain user files and is not wholly OMX-owned.

`omx doctor --dry-run --force` is an ownership-check preview, not a repair-eligibility preview or a no-write operation. For non-team invocations, Doctor may recover a native-hook claim journal before that check, even with `--dry-run`. Recovery can restore a canonical file, remove a claim file, and clear the journal. Use Doctor only when that recovery is within the authorized scope. Apply `omx doctor --force` only within the authorized repair scope; it is not a diagnostic-only command or a general cleanup mode.

### Hooks, native agents, and skills

- Prefer the installed CLI's check-specific recovery and scoped setup paths. Preview supported repairs before applying the same selected scope.
- Remove only a confirmed obsolete OMX registration or exact managed file. Preserve unrelated keys in `settings.json`, hook files, custom native roles, custom skills, and discovery links. Do not remove entire `agents/`, `commands/`, or skill roots to resolve a mixed installation.
- Normal setup uses catalog membership and generated markers to distinguish installable native roles from stale generated/non-installable files. Preserve ambiguous or user-authored TOMLs; do not use `--force` as a generic cleanup shortcut.
- For duplicate skill names, identify the exact canonical and duplicate entries and any consumers before changing an entry. Preserve non-overlapping personal skills.

### Persistent AGENTS guidance

For an existing file, use the installed release's scoped merge path instead of replacing the file with raw upstream content. Preserve manual guidance and runtime markers. Choose one scope deliberately; project scope runs from the intended project root:

```bash
omx setup --scope user --merge-agents --dry-run
# Or, from the intended project:
omx setup --scope project --merge-agents --dry-run
```

For a missing persistent AGENTS.md in plugin mode, `--merge-agents` cannot create it because merge mode disables defaults. Confirm that the resolved target is absent, not a dangling symlink, then preview creation with merge mode explicitly disabled (including any persisted merge preference):

```bash
omx setup --scope user --no-merge-agents --dry-run
# Or, from the intended project:
omx setup --scope project --no-merge-agents --dry-run
```

Accept AGENTS.md defaults if prompted. These setup commands can affect other scoped assets and persist the chosen merge preference; inspect all previewed effects and apply only within the authorized setup scope. Inspect the preview and preservation rules, then apply only the authorized chosen command without `--dry-run`. If active-session safeguards skip the guidance write, keep that result visible and use the documented recovery path; do not bypass it by overwriting AGENTS.md manually.

### Plugin cache

Do not prune cache versions by age, lexical/version order, or presence of a newer version. Inspect the exact marketplace/version entry, live pins, sessions, references, and recovery dependencies. Keep active or uncertain entries. For a diagnosed immutable-cache failure, use the installed CLI's exact repair guidance and supported preview rather than recursively deleting the plugin cache. This card does not authorize in-place edits to a live plugin snapshot.

Rerun `omx doctor` after an applied repair. Report changed exact paths, preserved custom assets, held entries and reasons, and before/after evidence. Restart Codex only when the applied discovery/configuration change requires it.

## Exit conditions

Stop with **HEALTHY** only when required paths, hook/config checks, AGENTS marker, plugin cache status, and (when requested) Team checks pass. Otherwise report **ISSUES FOUND**, exact failed evidence, and the smallest confirmed remediation; do not claim a fix from a recommendation alone.
