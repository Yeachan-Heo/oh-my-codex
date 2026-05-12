# Cleanup classification policy

## Path patterns

Generated worktree containers:
- `*.omx-worktrees/`
- `*.worktrees/`
- project-local `.claude/worktrees/`
- project-local `.codex/worktrees/`
- children named `launch-*`, `run-*`, `task-*`, `team-*`, `worker-*`

Likely automation copy folders:
- `oh-my-codex*`
- `omx-*` when clearly outside an active repo and containing prompt/skill/plugin scaffolding
- folders containing `.codex/skills`, `.codex/agents`, or `omx_wiki` copied beside repos

Runtime artifacts to review instead of delete automatically:
- `.omx/state/`
- `.omx/logs/`
- `.omx/plans/`
- `.omx/notepad.md`
- project-local `.codex/` outside `.codex/worktrees/*`
- project-local `.claude/` outside `.claude/worktrees/*`

## Removable path criteria

A path is safe to propose for quarantine when all are true:
- it is not cwd and cwd is not inside it;
- it is not a parent of cwd;
- it is not under a protected global config path;
- if under `.claude` or `.codex`, it is a child of project-local `worktrees/`;
- it is older than the user's freshness threshold or visibly stale;
- if it is a Git worktree, `git status --short` is empty;
- if branch is known, branch is not `main`, `master`, or `develop` unless explicitly approved;
- no running process/tmux pane has cwd under it when that can be checked cheaply.

## Branch cleanup policy

Branch deletion is separate from path quarantine because it rewrites local Git state.

A local branch is safe to propose for `git branch -D` only when all are true:
- the user approved that exact branch name;
- the branch is not `main`, `master`, or `develop`;
- it is not the current branch;
- no worktree currently has the branch checked out;
- its associated worktree path was already removed/quarantined or never existed;
- it is local-only or its upstream is gone.

Branches with live upstreams require a second explicit approval and `--allow-tracking`.
Dirty worktrees, ahead-of-upstream branches, or branches involved in active PRs should be manual-review unless the user explicitly prioritizes local cleanup over preservation.

## Escalation criteria

Stop and ask a concrete question when:
- a dirty worktree may contain unpushed or uncommitted work;
- the path looks like a canonical repo rather than a generated worktree/copy;
- deleting would affect global `~/.codex`, global `~/.claude`, credentials, caches shared by many projects, or package managers;
- the user asks for permanent deletion of many paths at once without a dry-run list;
- branch deletion would remove a live-upstream or ahead/diverged branch.

## Final report checklist

Report:
- scan roots;
- number of candidates by class;
- paths moved/deleted, or that no destructive action was taken;
- branch cleanup commands run or intentionally not run;
- blocked/manual-review paths and why;
- follow-up command if `git worktree prune` is still needed.
