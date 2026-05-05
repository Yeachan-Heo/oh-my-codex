#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: scripts/bootstrap-change.sh <change-slug>"
  exit 2
fi

SLUG="$1"
BASE="openspec/changes/${SLUG}"
SPECS_DIR="${BASE}/specs"

if [[ -d "$BASE" ]]; then
  echo "[bootstrap] change already exists: $BASE"
  exit 1
fi

mkdir -p "$SPECS_DIR"

cat > "${BASE}/proposal.md" <<'EOF'
# Proposal

<Change>
  <Goal>Describe business outcome.</Goal>
  <In_Scope>
    - ...
  </In_Scope>
  <Out_Of_Scope>
    - ...
  </Out_Of_Scope>
  <Risk>
    - ...
  </Risk>
  <Rollback>
    - code rollback
    - config rollback
  </Rollback>
</Change>
EOF

cat > "${SPECS_DIR}/spec.md" <<'EOF'
# Specs

## Scenario S1
Given ...
When ...
Then ...

<NFR>
  <Latency p95_ms="100" p99_ms="200" />
  <Idempotency required="true" key="request_id" />
  <Concurrency strategy="optimistic_lock" />
  <Degrade policy="fallback_response" />
</NFR>
EOF

cat > "${BASE}/design.md" <<'EOF'
# Design

## Architecture
- Module boundaries:
- Dependency direction:

## Debate Resolution
- Red finding:
- Blue resolution:
- Final decision:
EOF

cat > "${BASE}/tasks.md" <<'EOF'
# Tasks

- [ ] 1.1 Add/adjust tests
  - verify: <test command>
- [ ] 1.2 Implement minimal change
  - verify: <test command>
- [ ] 1.3 Sync contract/doc
  - verify: <lint/contract command>
- [ ] 1.4 Final verification
  - verify: <full gate command>
EOF

echo "[bootstrap] created change: ${SLUG}"

