#!/usr/bin/env python3
"""Dry-run or delete explicitly approved local Git branches after worktree cleanup.

This is intentionally separate from path quarantine because branch deletion rewrites
local Git state and is less reversible. It never discovers branches by itself; pass
exact branch names and run without --apply first.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

PROTECTED_BRANCHES = {"main", "master", "develop"}


def run(cmd: list[str], cwd: Path) -> tuple[int, str, str]:
    proc = subprocess.run(cmd, cwd=str(cwd), text=True, capture_output=True, check=False)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def current_branch(repo: Path) -> str | None:
    code, out, _ = run(["git", "branch", "--show-current"], repo)
    return out if code == 0 and out else None


def branch_exists(repo: Path, branch: str) -> bool:
    code, _, _ = run(["git", "show-ref", "--verify", f"refs/heads/{branch}"], repo)
    return code == 0


def branch_in_worktree(repo: Path, branch: str) -> str | None:
    code, out, _ = run(["git", "worktree", "list", "--porcelain"], repo)
    if code != 0:
        return None
    current_path: str | None = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            current_path = line.removeprefix("worktree ")
        elif line == f"branch refs/heads/{branch}" and current_path:
            return current_path
    return None


def upstream_state(repo: Path, branch: str) -> str:
    code, out, _ = run(["git", "for-each-ref", "--format=%(upstream:short)", f"refs/heads/{branch}"], repo)
    if code != 0 or not out:
        return "local-only"
    code, _, _ = run(["git", "rev-parse", "--verify", "--quiet", out], repo)
    return "tracking" if code == 0 else "upstream-gone"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("branches", nargs="+", help="Exact local branch names approved for deletion")
    parser.add_argument("--repo", default=".", help="Repository root/main worktree to run git branch in")
    parser.add_argument("--apply", action="store_true", help="Actually run git branch -D. Without this, dry-run only.")
    parser.add_argument(
        "--allow-tracking",
        action="store_true",
        help="Allow deleting branches that still have a live upstream. Default only allows local-only/upstream-gone branches.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo = Path(args.repo).expanduser().resolve()
    current = current_branch(repo)

    refused: list[tuple[str, str]] = []
    allowed: list[tuple[str, str]] = []
    for branch in args.branches:
        if branch in PROTECTED_BRANCHES:
            refused.append((branch, "protected branch"))
            continue
        if branch == current:
            refused.append((branch, "is current branch"))
            continue
        if not branch_exists(repo, branch):
            refused.append((branch, "local branch does not exist"))
            continue
        worktree_path = branch_in_worktree(repo, branch)
        if worktree_path:
            refused.append((branch, f"still checked out by worktree: {worktree_path}"))
            continue
        state = upstream_state(repo, branch)
        if state == "tracking" and not args.allow_tracking:
            refused.append((branch, "has live upstream; pass --allow-tracking only after explicit approval"))
            continue
        allowed.append((branch, state))

    print(f"repo: {repo}")
    print(f"mode: {'apply' if args.apply else 'dry-run'}")

    if refused:
        print("\nrefused:")
        for branch, reason in refused:
            print(f"- {branch} ({reason})")

    if allowed:
        print("\nallowed:")
        for branch, state in allowed:
            print(f"- git branch -D {branch}  # {state}")

    if refused:
        print("\nNo branches deleted because at least one branch was refused.")
        return 2
    if not args.apply:
        print("\nDry-run only. Re-run with --apply after reviewing the exact branch names.")
        return 0

    for branch, _ in allowed:
        code, out, err = run(["git", "branch", "-D", branch], repo)
        if out:
            print(out)
        if err:
            print(err, file=sys.stderr)
        if code != 0:
            return code
    return 0


if __name__ == "__main__":
    sys.exit(main())
