---
name: worktree-cleaner
description: Safely inventory, triage, and clean local Git worktree clutter across Codex, OMX, and Claude. Use when the user asks in English or Korean to clean worktrees / cleanup worktrees / remove stale worktrees / 워크트리 정리 / 워크트리 청소 / worktree 정리, including *.omx-worktrees launch folders, .claude/worktrees, .codex/worktrees, stale Git worktree registry entries, local-only/upstream-gone branches, copied automation folders, and runtime artifacts.
---

# Worktree Cleaner

## Safety contract

Default to **dry-run inventory only**. Do not delete, overwrite, force-prune, remove worktrees, or delete branches until the user explicitly approves the concrete paths or branch names.

Prefer reversible cleanup:
1. move approved paths to a dated quarantine folder or OS Trash;
2. run `git worktree prune --dry-run` before `git worktree prune`;
3. delete local branches only as a separate, explicit step after their worktree paths are gone;
4. verify only the cleanup state; builds/tests are not needed unless source files were edited.

Never remove:
- the current working directory or any parent of it;
- active tmux/process cwd paths;
- dirty worktrees unless explicitly requested for that exact path;
- `main`, `master`, or `develop` working trees/branches without explicit approval;
- credential/config roots such as `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, global `~/.codex`, or global `~/.claude`;
- project source folders outside a clearly stale worktree/copy-folder classification.

Project-local `.claude/worktrees/*` and `.codex/worktrees/*` children are cleanup candidates; the `.claude` / `.codex` config directories themselves are not.

## Quick workflow

1. Identify the scan root. Default to the current repo's parent/workspace; avoid scanning all of `$HOME` unless requested.
2. Run the bundled inventory script:

```bash
python3 ~/.codex/skills/worktree-cleaner/scripts/inventory.py --root . --root .. --format markdown
```

For workspace-wide machine-readable output:

```bash
python3 ~/.codex/skills/worktree-cleaner/scripts/inventory.py --root ~/Documents/workspace --format json > /tmp/worktree-cleanup-inventory.json
```

3. Check Git registry from a real repo root:

```bash
git worktree list --porcelain
git worktree prune --dry-run
```

4. Classify candidates:
   - **Likely removable**: clean, stale generated worktrees such as `*.omx-worktrees/launch-*`, `.claude/worktrees/*`, `.codex/worktrees/*`, old task/team/worker dirs, with no active cwd/process references.
   - **Prune only**: broken entries from `git worktree prune --dry-run`.
   - **Branch cleanup**: local-only or upstream-gone branches associated with already-removed/quarantined clean worktrees. Use `branch_cleanup.py`; do not fold this into path cleanup.
   - **Manual review**: dirty worktrees, protected branches, non-launch copies, copied automation folders, runtime state directories, recently modified items, or anything with unclear ownership.
   - **Keep**: active cwd, parent dirs, global config/credential dirs, protected branches, and unknown source trees.
5. Present a compact cleanup plan with exact paths, reason, branch/status, upstream state, age, and proposed action.
6. Ask approval only for destructive/reversible actions, not for additional dry-run inspection.
7. After cleanup, re-run inventory and `git worktree prune --dry-run`; report remaining candidates.

## Useful commands

Check whether a candidate has local work:

```bash
git -C /path/to/worktree status --short --branch
git -C /path/to/worktree branch --show-current
```

Check active tmux cwd references before proposing removal:

```bash
tmux list-panes -a -F '#{pane_current_path}' | sort -u
```

Move approved paths to quarantine instead of deleting. First dry-run exact paths, then apply only after approval:

```bash
python3 ~/.codex/skills/worktree-cleaner/scripts/quarantine.py /approved/path
python3 ~/.codex/skills/worktree-cleaner/scripts/quarantine.py --apply /approved/path
```

Delete approved local-only/upstream-gone branches only after their worktrees are gone:

```bash
python3 ~/.codex/skills/worktree-cleaner/scripts/branch_cleanup.py --repo /repo/root branch-a branch-b
python3 ~/.codex/skills/worktree-cleaner/scripts/branch_cleanup.py --repo /repo/root --apply branch-a branch-b
```

Use `rm -rf` only when the user explicitly asks for permanent deletion and the exact paths were just shown.

## Reading references

Read `references/policy.md` when classification is uncertain, when deleting branches, or when a candidate path is outside generated worktree containers.
