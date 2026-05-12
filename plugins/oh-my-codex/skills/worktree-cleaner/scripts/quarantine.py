#!/usr/bin/env python3
"""Move explicitly approved cleanup paths into a dated quarantine folder.

Dry-run by default. Requires --apply to move anything. Accept only explicit paths;
this script performs no discovery and intentionally does not expand globs.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

PROTECTED_SEGMENTS = {".ssh", ".aws", ".gnupg", ".config", ".codex", ".claude"}
ALLOWED_NESTED_MARKERS = ((".claude", "worktrees"), (".codex", "worktrees"))


def resolve(path: str) -> Path:
    return Path(path).expanduser().resolve()


def relation_to_cwd(path: Path, cwd: Path) -> str | None:
    if path == cwd:
        return "is current working directory"
    if path in cwd.parents:
        return "contains current working directory"
    return None


def marker_child_depth(path: Path, marker: tuple[str, str]) -> int | None:
    parts = path.parts
    for idx in range(len(parts) - 1):
        if parts[idx] == marker[0] and parts[idx + 1] == marker[1]:
            return len(parts) - (idx + 2)
    return None


def allowed_nested_worktree_child(path: Path) -> bool:
    # Allow only children under project-local .claude/.codex/worktrees, not the config dir itself.
    return any((depth := marker_child_depth(path, marker)) is not None and depth >= 1 for marker in ALLOWED_NESTED_MARKERS)


def refusal_reason(path: Path, cwd: Path) -> str | None:
    relation = relation_to_cwd(path, cwd)
    if relation:
        return relation
    if not path.exists():
        return "does not exist"
    protected = sorted(set(path.parts) & PROTECTED_SEGMENTS)
    if protected:
        if allowed_nested_worktree_child(path):
            non_worktree_hits = [hit for hit in protected if hit not in {".claude", ".codex"}]
            if not non_worktree_hits:
                return None
            protected = non_worktree_hits
        return f"contains protected path segment: {', '.join(protected)}"
    return None


def unique_destination(quarantine_dir: Path, source: Path) -> Path:
    target = quarantine_dir / source.name
    if not target.exists():
        return target
    index = 1
    while True:
        candidate = quarantine_dir / f"{source.name}.{index}"
        if not candidate.exists():
            return candidate
        index += 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="Explicit paths approved for quarantine")
    parser.add_argument("--apply", action="store_true", help="Actually move paths. Without this, dry-run only.")
    parser.add_argument(
        "--quarantine-dir",
        default=f"~/.Trash/worktree-cleanup-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
        help="Destination directory. Defaults to a dated folder under ~/.Trash.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cwd = Path.cwd().resolve()
    quarantine_dir = resolve(args.quarantine_dir)
    sources = [resolve(path) for path in args.paths]

    refused: list[tuple[Path, str]] = []
    allowed: list[Path] = []
    for source in sources:
        reason = refusal_reason(source, cwd)
        if reason:
            refused.append((source, reason))
        else:
            allowed.append(source)

    print(f"quarantine_dir: {quarantine_dir}")
    print(f"mode: {'apply' if args.apply else 'dry-run'}")

    if refused:
        print("\nrefused:")
        for path, reason in refused:
            print(f"- {path} ({reason})")

    if allowed:
        print("\nallowed:")
        for source in allowed:
            print(f"- {source} -> {unique_destination(quarantine_dir, source)}")

    if refused:
        print("\nNo files moved because at least one path was refused.")
        return 2

    if not args.apply:
        print("\nDry-run only. Re-run with --apply after reviewing the exact paths.")
        return 0

    quarantine_dir.mkdir(parents=True, exist_ok=True)
    for source in allowed:
        target = unique_destination(quarantine_dir, source)
        shutil.move(str(source), str(target))
    print("\nMoved approved paths to quarantine.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
