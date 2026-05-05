#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: scripts/check-drift.sh <change-slug>"
  exit 2
fi

CHANGE_SLUG="$1"
CHANGE_DIR="openspec/changes/${CHANGE_SLUG}"

required_files=(
  "${CHANGE_DIR}/proposal.md"
  "${CHANGE_DIR}/design.md"
  "${CHANGE_DIR}/tasks.md"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "[drift] BLOCK: missing required artifact: $f"
    exit 1
  fi
done

if [[ ! -d "${CHANGE_DIR}/specs" ]]; then
  echo "[drift] BLOCK: missing required artifact directory: ${CHANGE_DIR}/specs"
  exit 1
fi

NFR_FOUND=0
while IFS= read -r spec_file; do
  [[ -f "$spec_file" ]] || continue
  if grep -Eq "<NFR>|##[[:space:]]+NFR" "$spec_file"; then
    NFR_FOUND=1
    break
  fi
done < <(find "${CHANGE_DIR}/specs" -type f -name "*.md")

if [[ "$NFR_FOUND" -eq 0 ]]; then
  echo "[drift] BLOCK: no NFR marker found in ${CHANGE_DIR}/specs"
  exit 1
fi

CODE_CHANGED=0
SPEC_CHANGED=0

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if [[ "$file" == openspec/changes/"$CHANGE_SLUG"/* ]]; then
    SPEC_CHANGED=1
  else
    CODE_CHANGED=1
  fi
done < <(
  if [[ -n "$(git status --porcelain)" ]]; then
    git diff --name-only HEAD
    git ls-files --others --exclude-standard
  elif git rev-parse --verify origin/main >/dev/null 2>&1; then
    git diff --name-only "origin/main...HEAD" 2>/dev/null || true
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    git diff --name-only HEAD~1...HEAD 2>/dev/null || true
  else
    git ls-files
  fi
)

if [[ "$CODE_CHANGED" -eq 1 && "$SPEC_CHANGED" -eq 0 ]]; then
  echo "[drift] BLOCK: code changed but OpenSpec artifacts not updated for ${CHANGE_SLUG}"
  exit 1
fi

echo "[drift] PASS: basic artifact consistency check passed (${CHANGE_SLUG})"

