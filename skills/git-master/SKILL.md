---
name: git-master
description: "Delegates git operations to the git-master specialist agent. Use when you need atomic conventional commits, interactive rebasing, branch cleanup, or history rewriting — say 'git master', 'clean up my commits', 'squash and rebase', or 'fix my git history'."
---

# Git Master Command

Routes to the git-master agent for git operations.

## Usage

```
/git-master <git task>
```

## Routing

```
delegate(role="git-master", tier="STANDARD", task="{{ARGUMENTS}}")
```

## Capabilities
- Atomic commits with conventional format
- Interactive rebasing
- Branch management
- History cleanup
- Style detection from repo history

Task: {{ARGUMENTS}}
