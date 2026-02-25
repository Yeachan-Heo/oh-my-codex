# Migration Guide: post-v0.4.4 mainline changes

This guide covers migration from **v0.4.4** to the current mainline changes merged after it (including PR #137 and follow-up fixes).

## Who is affected

You are affected if you:

- invoke removed prompts or skills from old notes/scripts,
- depend on pre-consolidation catalog names,
- use `omx setup` and need predictable install scope behavior,
- run `omx team`/tmux workflows and want the latest reliability fixes,
- use notifier output and need verbosity control.

## What changed (high level)

- Catalog consolidation for prompts/skills and cleanup of deprecated entries.
- `omx setup` now supports scope-aware install modes (`user`, `project`). Legacy `project-local` values are auto-migrated.
- Spark worker routing added for team workers (`--spark`, `--madmax-spark`).
- Notifier verbosity controls added.
- tmux runtime hardening updates landed, including post-review pane capture/input hardening.
- Stale references to removed `scientist`/`pipeline` were cleaned up.

## Removed prompts and skills

### Removed prompts

- `deep-executor`
- `scientist`

### Removed skills

- `deepinit`
- `learn-about-omx`
- `learner`
- `pipeline`
- `project-session-manager`
- `psm`
- `release`
- `ultrapilot`
- `writer-memory`

## Mapping old references to current ones

Use these replacements in docs, scripts, and personal shortcuts.

| Old reference | Use now | Notes |
|---|---|---|
| `/prompts:deep-executor` | `/prompts:executor` | `deep-executor` was a deprecated alias to executor behavior. |
| `/prompts:scientist` | `/prompts:researcher` | Use researcher for research-focused workflows in current catalog. |
| `$pipeline` | `$team` (or explicit `/prompts:*` sequencing) | Team is the default orchestrator pipeline surface. |
| `$ultrapilot` | `$team` | Use team-based parallel orchestration. |
| `$psm` / `$project-session-manager` | No in-repo replacement | Remove from automation or maintain out-of-tree tooling. |
| `$release` | No in-repo replacement | Use your project release process directly. |
| `$deepinit` | No in-repo replacement | Keep AGENTS/doc initialization manual or in custom local tooling. |
| `$learn-about-omx` / `$learner` / `$writer-memory` | No in-repo replacement | Remove stale references from workflows/docs. |

## Verification checklist after upgrade

Run this checklist after pulling latest mainline:

- [ ] Confirm removed references are gone from local notes/scripts:
  ```bash
  rg -n "deep-executor|scientist|pipeline|project-session-manager|\bpsm\b|ultrapilot|learn-about-omx|writer-memory|learner|deepinit|\brelease\b" README.md docs scripts .omx -S
  ```
- [ ] Confirm current prompt catalog no longer contains removed prompts:
  ```bash
  ls prompts
  ```
- [ ] Confirm current skill catalog no longer contains removed skills:
  ```bash
  ls skills
  ```
- [ ] Validate setup scope options are available:
  ```bash
  omx help | rg -e "--scope|project"
  ```
- [ ] Validate team/tmux health checks:
  ```bash
  omx doctor --team
  ```
- [ ] If using spark worker routing, verify flags are available:
  ```bash
  omx --help | rg "spark|madmax-spark"
  ```

## Related docs

- Release notes: [CHANGELOG.md](../CHANGELOG.md)
- Main overview: [README.md](../README.md)
