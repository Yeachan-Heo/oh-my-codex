#!/usr/bin/env python3
"""Inventory local Git/Codex/Claude/OMX worktree cleanup candidates.

Read-only by design. It prints candidate paths and metadata so an agent can
propose a safe cleanup plan without guessing or deleting Git state.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

SKIP_DIR_NAMES = {
    ".git",
    "node_modules",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
    ".turbo",
    ".cache",
    "Library",
    "Applications",
    "Movies",
    "Music",
    "Pictures",
}

PROTECTED_DIRS = {
    ".ssh",
    ".aws",
    ".gnupg",
    ".config",
    ".codex",
    ".claude",
}

WORKTREE_CONTAINER_SUFFIXES = (".omx-worktrees", ".worktrees")
WORKTREE_CONTAINER_NAMES = {"worktrees"}
CLAUDE_WORKTREES_MARKER = (".claude", "worktrees")
CODEX_WORKTREES_MARKER = (".codex", "worktrees")
LAUNCH_PREFIXES = ("launch-", "run-", "task-", "team-", "worker-")
COPY_PATTERNS = ("oh-my-codex", "omx-copy", "omx_backup", "omx-backup", "codex-copy")
PROTECTED_BRANCHES = {"main", "master", "develop"}


@dataclass(frozen=True)
class Candidate:
    classification: str
    path: str
    reason: str
    action: str
    age_days: float | None
    branch: str | None = None
    dirty: bool | None = None
    upstream: str | None = None
    upstream_state: str | None = None
    ahead: int | None = None
    behind: int | None = None
    protected: bool = False
    notes: str | None = None


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 5) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def age_days(path: Path) -> float | None:
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    now = datetime.now(timezone.utc).timestamp()
    return round(max(0.0, (now - mtime) / 86400), 2)


def is_git_worktree(path: Path) -> bool:
    return (path / ".git").exists()


def git_branch(path: Path) -> str | None:
    code, out, _ = run(["git", "branch", "--show-current"], cwd=path)
    return out if code == 0 and out else None


def git_dirty(path: Path) -> bool | None:
    code, out, _ = run(["git", "status", "--short"], cwd=path)
    if code != 0:
        return None
    return bool(out)


def parse_ahead_behind(status_line: str) -> tuple[int | None, int | None]:
    ahead: int | None = None
    behind: int | None = None
    if "[" not in status_line or "]" not in status_line:
        return ahead, behind
    bracket = status_line.split("[", 1)[1].split("]", 1)[0]
    for part in [p.strip() for p in bracket.split(",")]:
        if part.startswith("ahead "):
            try:
                ahead = int(part.split()[1])
            except (IndexError, ValueError):
                pass
        elif part.startswith("behind "):
            try:
                behind = int(part.split()[1])
            except (IndexError, ValueError):
                pass
    return ahead, behind


def git_upstream_info(path: Path) -> tuple[str | None, str | None, int | None, int | None]:
    code, out, _ = run(["git", "status", "--short", "--branch"], cwd=path)
    if code != 0 or not out:
        return None, None, None, None
    first = out.splitlines()[0]
    if not first.startswith("## "):
        return None, None, None, None
    text = first[3:]
    ahead, behind = parse_ahead_behind(text)
    if "..." not in text:
        return None, "local-only", ahead, behind
    upstream_part = text.split("...", 1)[1]
    upstream = upstream_part.split(" ", 1)[0]
    if "[gone]" in text:
        state = "upstream-gone"
    elif ahead and behind:
        state = "diverged"
    elif ahead:
        state = "ahead"
    elif behind:
        state = "behind"
    else:
        state = "tracking"
    return upstream, state, ahead, behind


def cwd_relationship(path: Path, cwd: Path) -> str | None:
    try:
        resolved = path.resolve()
        cwd_resolved = cwd.resolve()
    except OSError:
        return None
    if resolved == cwd_resolved:
        return "is current working directory"
    if resolved in cwd_resolved.parents:
        return "contains current working directory"
    return None




def related_path_note(path: Path, other: Path, label: str) -> str | None:
    try:
        resolved = path.resolve()
        other_resolved = other.resolve()
    except OSError:
        return None
    if resolved == other_resolved:
        return f"is active {label}"
    if resolved in other_resolved.parents:
        return f"contains active {label}"
    return None


def active_tmux_cwds() -> list[Path]:
    code, out, _ = run(["tmux", "list-panes", "-a", "-F", "#{pane_current_path}"], timeout=3)
    if code != 0 or not out:
        return []
    paths: list[Path] = []
    seen: set[str] = set()
    for line in out.splitlines():
        if not line:
            continue
        path = Path(line).expanduser()
        key = str(path)
        if key not in seen:
            paths.append(path)
            seen.add(key)
    return paths

def has_marker(path: Path, marker: tuple[str, str]) -> bool:
    parts = path.parts
    for idx in range(len(parts) - 1):
        if parts[idx] == marker[0] and parts[idx + 1] == marker[1]:
            return True
    return False


def marker_child_depth(path: Path, marker: tuple[str, str]) -> int | None:
    parts = path.parts
    for idx in range(len(parts) - 1):
        if parts[idx] == marker[0] and parts[idx + 1] == marker[1]:
            return len(parts) - (idx + 2)
    return None


def is_allowed_nested_worktree_path(path: Path) -> bool:
    """Allow project-local .claude/.codex/worktrees children without unprotecting global config roots."""
    for marker in (CLAUDE_WORKTREES_MARKER, CODEX_WORKTREES_MARKER):
        depth = marker_child_depth(path, marker)
        if depth is not None and depth >= 1:
            return True
    return False


def protected_path(path: Path, cwd: Path, active_cwds: list[Path]) -> tuple[bool, str | None]:
    relationship = cwd_relationship(path, cwd)
    if relationship:
        return True, relationship
    for active_cwd in active_cwds:
        active_relationship = related_path_note(path, active_cwd, "tmux pane cwd")
        if active_relationship:
            return True, active_relationship
    parts = set(path.parts)
    protected_hits = sorted(parts & PROTECTED_DIRS)
    if protected_hits:
        if is_allowed_nested_worktree_path(path):
            non_worktree_hits = [hit for hit in protected_hits if hit not in {".claude", ".codex"}]
            if not non_worktree_hits:
                return False, None
            protected_hits = non_worktree_hits
        return True, f"under protected config segment {', '.join(protected_hits)}"
    return False, None


def candidate_action(branch: str | None, dirty: bool | None, upstream_state: str | None) -> tuple[str, str, str | None]:
    note: str | None = None
    if branch in PROTECTED_BRANCHES:
        return "manual-review", "review protected branch before quarantine", "branch is protected"
    if dirty is True:
        return "manual-review", "inspect uncommitted work before quarantine", None
    if dirty is False:
        if upstream_state in {"local-only", "upstream-gone"}:
            note = "branch has no live upstream; branch deletion needs explicit approval"
        return "likely-removable", "candidate for quarantine after approval", note
    return "manual-review", "inspect before quarantine", None


def make_worktree_candidate(path: Path, cwd: Path, active_cwds: list[Path], reason: str) -> Candidate:
    branch = git_branch(path) if is_git_worktree(path) else None
    dirty = git_dirty(path) if is_git_worktree(path) else None
    upstream, upstream_state, ahead, behind = git_upstream_info(path) if is_git_worktree(path) else (None, None, None, None)
    protected, note = protected_path(path, cwd, active_cwds)
    action = "keep"
    classification = "keep"

    if protected:
        action = "do not remove"
    else:
        classification, action, branch_note = candidate_action(branch, dirty, upstream_state)
        if branch_note:
            note = branch_note if not note else f"{note}; {branch_note}"

    return Candidate(
        classification=classification,
        path=str(path),
        reason=reason,
        action=action,
        age_days=age_days(path),
        branch=branch,
        dirty=dirty,
        upstream=upstream,
        upstream_state=upstream_state,
        ahead=ahead,
        behind=behind,
        protected=protected,
        notes=note,
    )


def iter_dirs(root: Path, max_depth: int) -> Iterable[tuple[Path, int]]:
    root = root.expanduser()
    if not root.exists():
        return
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        yield current, depth
        if depth >= max_depth:
            continue
        try:
            children = sorted(current.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for child in reversed(children):
            if not child.is_dir():
                continue
            if child.name in SKIP_DIR_NAMES:
                continue
            # Project-local .claude/.codex may contain worktrees; global config remains protected at action time.
            stack.append((child, depth + 1))


def add_children(path: Path, cwd: Path, active_cwds: list[Path], add) -> None:
    try:
        children = sorted(path.iterdir(), key=lambda p: p.name)
    except OSError:
        children = []
    for child in children:
        if child.is_dir() and (child.name.startswith(LAUNCH_PREFIXES) or is_git_worktree(child)):
            add(make_worktree_candidate(child, cwd, active_cwds, f"child of {path.name} worktree container"))


def scan_root(root: Path, max_depth: int, cwd: Path, active_cwds: list[Path]) -> list[Candidate]:
    candidates: list[Candidate] = []
    seen: set[str] = set()

    def add(candidate: Candidate) -> None:
        key = candidate.path
        if key not in seen:
            candidates.append(candidate)
            seen.add(key)

    for path, depth in iter_dirs(root, max_depth):
        name = path.name
        lowered = name.lower()

        if name.endswith(WORKTREE_CONTAINER_SUFFIXES):
            protected, note = protected_path(path, cwd, active_cwds)
            add(
                Candidate(
                    classification="manual-review" if not protected else "keep",
                    path=str(path),
                    reason="generic worktree container",
                    action="review children; remove container only when empty",
                    age_days=age_days(path),
                    protected=protected,
                    notes=note,
                )
            )
            add_children(path, cwd, active_cwds, add)
            continue

        if name == "worktrees" and (has_marker(path, CLAUDE_WORKTREES_MARKER) or has_marker(path, CODEX_WORKTREES_MARKER)):
            protected, note = protected_path(path, cwd, active_cwds)
            add(
                Candidate(
                    classification="manual-review" if not protected else "keep",
                    path=str(path),
                    reason="Claude/Codex worktree container",
                    action="review children; remove container only when empty",
                    age_days=age_days(path),
                    protected=protected,
                    notes=note,
                )
            )
            add_children(path, cwd, active_cwds, add)
            continue

        if depth > 0 and name.startswith(LAUNCH_PREFIXES) and is_git_worktree(path):
            add(make_worktree_candidate(path, cwd, active_cwds, "launch-like Git worktree"))
            continue

        if any(lowered.startswith(pattern) for pattern in COPY_PATTERNS):
            protected, note = protected_path(path, cwd, active_cwds)
            add(
                Candidate(
                    classification="manual-review" if not protected else "keep",
                    path=str(path),
                    reason="possible copied Codex/OMX folder",
                    action="inspect contents before quarantine",
                    age_days=age_days(path),
                    protected=protected,
                    notes=note,
                )
            )
            continue

        if name in {".omx"}:
            protected, note = protected_path(path, cwd, active_cwds)
            add(
                Candidate(
                    classification="manual-review" if not protected else "keep",
                    path=str(path),
                    reason="OMX runtime state directory",
                    action="prune logs/state only with repo-specific approval",
                    age_days=age_days(path),
                    protected=protected,
                    notes=note,
                )
            )

    return candidates


def render_markdown(candidates: list[Candidate]) -> str:
    if not candidates:
        return "No worktree cleanup candidates found."

    groups: dict[str, list[Candidate]] = {}
    for item in candidates:
        groups.setdefault(item.classification, []).append(item)

    lines = ["# Worktree cleanup inventory", ""]
    for classification in sorted(groups):
        items = groups[classification]
        lines.append(f"## {classification} ({len(items)})")
        lines.append("")
        for item in sorted(items, key=lambda c: c.path):
            dirty = "unknown" if item.dirty is None else ("yes" if item.dirty else "no")
            meta = []
            if item.age_days is not None:
                meta.append(f"age={item.age_days}d")
            if item.branch:
                meta.append(f"branch={item.branch}")
            if item.dirty is not None:
                meta.append(f"dirty={dirty}")
            if item.upstream_state:
                meta.append(f"upstream={item.upstream_state}")
            if item.upstream:
                meta.append(f"tracks={item.upstream}")
            if item.ahead:
                meta.append(f"ahead={item.ahead}")
            if item.behind:
                meta.append(f"behind={item.behind}")
            if item.protected:
                meta.append("protected=yes")
            suffix = f" ({', '.join(meta)})" if meta else ""
            lines.append(f"- `{item.path}`{suffix}")
            lines.append(f"  - reason: {item.reason}")
            lines.append(f"  - action: {item.action}")
            if item.notes:
                lines.append(f"  - notes: {item.notes}")
        lines.append("")
    return "\n".join(lines).rstrip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        action="append",
        default=[],
        help="Root directory to scan. Repeatable. Defaults to current directory.",
    )
    parser.add_argument("--max-depth", type=int, default=5, help="Directory traversal depth per root.")
    parser.add_argument("--format", choices={"markdown", "json"}, default="markdown")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cwd = Path.cwd()
    active_cwds = active_tmux_cwds()
    roots = [Path(r).expanduser() for r in (args.root or ["."])]
    candidates: list[Candidate] = []
    seen: set[str] = set()

    for root in roots:
        for candidate in scan_root(root, args.max_depth, cwd, active_cwds):
            if candidate.path not in seen:
                candidates.append(candidate)
                seen.add(candidate.path)

    if args.format == "json":
        payload = {
            "roots": [str(r) for r in roots],
            "cwd": str(cwd),
            "active_cwds": [str(path) for path in active_cwds],
            "candidate_count": len(candidates),
            "candidates": [asdict(candidate) for candidate in candidates],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(render_markdown(candidates))
    return 0


if __name__ == "__main__":
    sys.exit(main())
