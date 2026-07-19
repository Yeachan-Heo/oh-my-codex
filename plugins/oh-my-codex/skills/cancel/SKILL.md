---
name: cancel
description: Cancel any active OMX mode (autopilot, ralph, ultrawork, ecomode, ultraqa, swarm, ultrapilot, pipeline, team)
---

# Cancel Skill

Intelligent cancellation that detects and cancels the active OMX mode.

**The cancel skill is the standard way to complete and exit any OMX mode.**
When the stop hook detects work is complete, it instructs the LLM to invoke
this skill for proper state cleanup. If cancel fails or is interrupted,
retry with `--force` flag, or wait for the 2-hour staleness timeout as
a last resort.

## What It Does

Automatically detects which mode is active and cancels it:
- **Autopilot**: Stops workflow, preserves progress for resume
- **Ralph**: Stops persistence loop, clears linked ultrawork if applicable
- **Ultrawork**: Stops parallel execution (standalone or linked)
- **Ecomode**: Stops token-efficient parallel execution (standalone or linked to ralph)
- **UltraQA**: Stops QA cycling workflow
- **Swarm**: Stops coordinated agent swarm, releases claimed tasks
- **Ultrapilot**: Stops parallel autopilot workers
- **Pipeline**: Stops sequential agent pipeline
- **Team**: Sends shutdown inbox to all workers, waits for exit, kills tmux session, and clears team state

## Usage

```
/cancel
```

Or say: "cancelomc", "stopomc"

## Auto-Detection

`/cancel` follows the session-aware state contract:
- By default the command inspects the current session via `state_list_active` and `state_get_status`, navigating `.omx/state/sessions/{sessionId}/…` to discover which mode is active.
- When a session id is provided or already known, that session-scoped path is authoritative. Legacy files in `.omx/state/*.json` are consulted only as a compatibility fallback if the session id is missing or empty.
- Swarm is a shared SQLite/marker mode (`.omx/state/swarm.db` / `.omx/state/swarm-active.marker`) and is not session-scoped.
- The default cleanup flow calls `state_clear` with the session id to remove only the matching session files; modes stay bound to their originating session.

## Normative Ralph cancellation post-conditions (MUST)

For Ralph-targeted cancellation (standalone or linked), completion is defined by post-conditions:

1. Target Ralph state is terminalized, not silently removed:
   - `active=false`
   - `current_phase='cancelled'`
   - `completed_at` is set (ISO timestamp)
2. If Ralph is linked to Ultrawork or Ecomode in the same scope, that linked mode is also terminalized/non-active.
4. Cancellation MUST remain scope-safe: no mutation of unrelated sessions.

See: `docs/contracts/ralph-cancel-contract.md`.

Active modes are still cancelled in dependency order:
1. Autopilot (includes linked ultragoal/ultraqa/ecomode cleanup plus explicit legacy Ralph cleanup)
2. Ralph (cleans its linked ultrawork or ecomode)
3. Ultrawork (standalone)
4. Ecomode (standalone)
5. UltraQA (standalone)
6. Swarm (standalone)
7. Ultrapilot (standalone)
8. Pipeline (standalone)
9. Team (tmux-based)
10. Plan Consensus (standalone)

## Normative Ralph post-conditions (MUST)

When cancellation targets Ralph state in a scope, completion requires all of the following:

1. Ralph state is terminal in that same scope: `active=false`, `current_phase='cancelled'` (or linked terminal phase), and `completed_at` is set.
2. Linked Ultrawork/Ecomode in the same scope is also terminal/non-active.
4. Unrelated sessions are untouched.

## Exact-scope force compatibility

`--force` is a compatibility flag for the same proven current scope as bare cancellation. It does not widen cancellation to other sessions, legacy roots, Team runtimes, or workspace artifacts. Its only additional behavior is exact-session native-stop cleanup after the same ownership checks.

`--all` is intentionally unsupported. Workspace-wide destructive cancellation requires a separately reviewed command and authority contract. Unknown flags and mixed flag combinations fail before mutation.

```text
/cancel
/cancel --force
```

### Argument contract

- no arguments: cancel only the provably current session/root scope;
- `--force`: same scope, plus exact-session native-stop cleanup;
- `--all`: reject without mutation;
- unknown or multiple flags: reject without mutation.

### State discovery

Cancellation derives writable targets from the already-proven writable scope. Compatibility discovery may inform status, but never grants write authority. Unrelated session, legacy-root, Team, and run-dir state remains untouched unless it is independently proven as the exact cancellation target.

### 3B. Smart Cancellation (default)

#### If Team Active (tmux-based)

Teams are detected by checking for config files in `.omx/state/team/`:

```bash
# Check for active teams
ls .omx/state/team/*/config.json 2>/dev/null
```

**Two-pass cancellation protocol:**

**Pass 1: Graceful Shutdown**
```
For each team found in .omx/state/team/:
  1. Read config.json to get team_name and workers list
  2. For each worker:
     a. Write shutdown inbox to .omx/state/team/{name}/workers/{worker}/inbox.md
     b. Send short trigger via tmux send-keys
     c. Wait up to 15 seconds for worker tmux pane to exit
     d. If still alive: mark as unresponsive
```

**Pass 2: Force Kill**
```
After graceful pass:
  1. For each remaining alive worker:
     a. Send C-c via tmux send-keys
     b. Wait 2 seconds
     c. Kill the tmux window if still alive
  2. Destroy the tmux session: tmux kill-session -t omx-team-{name}
```

**Cleanup:**
```
  1. Strip AGENTS.md team worker overlay (<!-- OMX:TEAM:WORKER:START/END -->)
  2. Remove team state directory: rm -rf .omx/state/team/{name}/
  3. Clear team mode state: state_clear(mode="team")
  4. Emit structured cancel report
```

**Structured Cancel Report:**
```
Team "{team_name}" cancelled:
  - Workers signaled: N
  - Graceful exits: M
  - Force killed: K
  - tmux session destroyed: yes/no
  - State cleaned up: yes/no
```

**Implementation note:** The cancel skill is executed by the LLM, not as a bash script. When you detect an active team:
1. Check `.omx/state/team/*/config.json` for active teams
2. For each worker in config.workers, write shutdown inbox and send trigger
3. Wait briefly for workers to exit (15s timeout)
4. Force kill remaining workers via tmux
5. Destroy tmux session: `tmux kill-session -t omx-team-{name}`
6. Strip AGENTS.md overlay
7. Remove state: `rm -rf .omx/state/team/{name}/`
8. `state_clear(mode="team")`
9. Report structured summary to user

#### If Autopilot Active

Call `cancelAutopilot()` from `src/hooks/autopilot/cancel.ts:27-78`:

```bash
# Autopilot handles its own cleanup + ralph + ultraqa
# Just mark autopilot as inactive (preserves state for resume)
if [[ -f .omx/state/autopilot-state.json ]]; then
  # Clean up ralph if active
  if [[ -f .omx/state/ralph-state.json ]]; then
    RALPH_STATE=$(cat .omx/state/ralph-state.json)
    LINKED_UW=$(echo "$RALPH_STATE" | jq -r '.linked_ultrawork // false')

    # Clean linked ultrawork first
    if [[ "$LINKED_UW" == "true" ]] && [[ -f .omx/state/ultrawork-state.json ]]; then
      rm -f .omx/state/ultrawork-state.json
      echo "Cleaned up: ultrawork (linked to ralph)"
    fi

    # Clean ralph
    rm -f .omx/state/ralph-state.json
    rm -f .omx/state/ralph-verification.json
    echo "Cleaned up: ralph"
  fi

  # Clean up ultraqa if active
  if [[ -f .omx/state/ultraqa-state.json ]]; then
    rm -f .omx/state/ultraqa-state.json
    echo "Cleaned up: ultraqa"
  fi

  # Mark autopilot inactive but preserve state
  CURRENT_STATE=$(cat .omx/state/autopilot-state.json)
  CURRENT_PHASE=$(echo "$CURRENT_STATE" | jq -r '.phase // "unknown"')
  echo "$CURRENT_STATE" | jq '.active = false' > .omx/state/autopilot-state.json

  echo "Autopilot cancelled at phase: $CURRENT_PHASE. Progress preserved for resume."
  echo "Run /autopilot to resume."
fi
```

#### If Ralph Active (but not Autopilot)

Call `clearRalphState()` + `clearLinkedUltraworkState()` from `src/hooks/ralph-loop/index.ts:147-182`:

```bash
if [[ -f .omx/state/ralph-state.json ]]; then
  # Check if ultrawork is linked
  RALPH_STATE=$(cat .omx/state/ralph-state.json)
  LINKED_UW=$(echo "$RALPH_STATE" | jq -r '.linked_ultrawork // false')

  # Clean linked ultrawork first
  if [[ "$LINKED_UW" == "true" ]] && [[ -f .omx/state/ultrawork-state.json ]]; then
    UW_STATE=$(cat .omx/state/ultrawork-state.json)
    UW_LINKED=$(echo "$UW_STATE" | jq -r '.linked_to_ralph // false')

    # Only clear if it was linked to ralph
    if [[ "$UW_LINKED" == "true" ]]; then
      rm -f .omx/state/ultrawork-state.json
      echo "Cleaned up: ultrawork (linked to ralph)"
    fi
  fi

  # Clean ralph state
  rm -f .omx/state/ralph-state.json
  rm -f .omx/state/ralph-plan-state.json
  rm -f .omx/state/ralph-verification.json

  echo "Ralph cancelled. Persistent mode deactivated."
fi
```

#### If Ultrawork Active (standalone, not linked)

Call `deactivateUltrawork()` from `src/hooks/ultrawork/index.ts:150-173`:

```bash
if [[ -f .omx/state/ultrawork-state.json ]]; then
  # Check if linked to ralph
  UW_STATE=$(cat .omx/state/ultrawork-state.json)
  LINKED=$(echo "$UW_STATE" | jq -r '.linked_to_ralph // false')

  if [[ "$LINKED" == "true" ]]; then
    echo "Ultrawork is linked to Ralph. Use /cancel to cancel both."
    exit 1
  fi

  # Remove local state
  rm -f .omx/state/ultrawork-state.json

  echo "Ultrawork cancelled. Parallel execution mode deactivated."
fi
```

#### If UltraQA Active (standalone)

Call `clearUltraQAState()` from `src/hooks/ultraqa/index.ts:107-120`:

```bash
if [[ -f .omx/state/ultraqa-state.json ]]; then
  rm -f .omx/state/ultraqa-state.json
  echo "UltraQA cancelled. QA cycling workflow stopped."
fi
```

#### No Active Modes

```bash
echo "No active OMX modes detected."
echo ""
echo "Checked for:"
echo "  - Autopilot (.omx/state/autopilot-state.json)"
echo "  - Ralph (.omx/state/ralph-state.json)"
echo "  - Ultrawork (.omx/state/ultrawork-state.json)"
echo "  - UltraQA (.omx/state/ultraqa-state.json)"
echo ""
echo "Use --force for exact-session native-stop cleanup without widening scope."

```

## Implementation Notes

The cancel skill runs as follows:
1. Parse arguments strictly. Bare cancellation and a single `--force` are accepted; `--all`, unknown flags, and multiple flags fail before mutation.
2. Resolve one writable scope and treat compatibility discovery as read-only.
3. Cancel only active state files whose exact scope, ownership fields, and frozen file identity are proven.
4. With `--force`, remove only the selected session's native-stop entry after the same proof and revalidation.
5. Leave unrelated sessions, legacy compatibility roots, Team artifacts, and tmux sessions untouched.

Mode-specific subsections below describe same-scope dependency ordering only.
## Messages Reference

| Mode | Success Message |
|------|-----------------|
| Autopilot | "Autopilot cancelled at phase: {phase}. Progress preserved for resume." |
| Ralph | "Ralph cancelled. Persistent mode deactivated." |
| Ultrawork | "Ultrawork cancelled. Parallel execution mode deactivated." |
| Ecomode | "Ecomode cancelled. Token-efficient execution mode deactivated." |
| UltraQA | "UltraQA cancelled. QA cycling workflow stopped." |
| Swarm | "Swarm cancelled. Coordinated agents stopped." |
| Ultrapilot | "Ultrapilot cancelled. Parallel autopilot workers stopped." |
| Pipeline | "Pipeline cancelled. Sequential agent chain stopped." |
| Team | "Team cancelled. Teammates shut down and cleaned up." |
| Plan Consensus | "Plan Consensus cancelled. Planning session ended." |
| Force | "All OMX modes cleared. You are free to start fresh." |
| None | "No active OMX modes detected." |

## What Gets Preserved

| Mode | State Preserved | Resume Command |
|------|-----------------|----------------|
| Autopilot | Yes (phase, files, spec, plan, verdicts) | `/autopilot` |
| Ralph | No | N/A |
| Ultrawork | No | N/A |
| UltraQA | No | N/A |
| Swarm | No | N/A |
| Ultrapilot | No | N/A |
| Pipeline | No | N/A |
| Plan Consensus | Yes (plan file path preserved) | N/A |

## Notes

- **Dependency-aware**: Autopilot cancellation cleans up Ultragoal/UltraQA state and any explicit legacy Ralph state
- **Link-aware**: Ralph cancellation cleans up linked Ultrawork or Ecomode
- **Safe**: Only clears linked Ultrawork, preserves standalone Ultrawork
- **Local-only**: Clears state files in `.omx/state/` directory
- **Resume-friendly**: Autopilot state is preserved for seamless resume
- **Team-aware**: Team cancellation is permitted only when the selected state carries exact same-scope Team authority; unrelated Team artifacts and tmux sessions remain untouched.

## Tmux Team Cleanup

Cancellation MUST NOT enumerate or kill every `omx-team-*` session and MUST NOT recursively delete `.omx/state/team/`. Team shutdown requires the exact frozen Team root, internal name, session, leader pane, and runtime identity selected by the authorized state transition. When that proof is unavailable or changes, cancellation fails closed without signals, pane actions, overlay edits, or Team-state deletion.

`--force` does not widen Team scope. It only enables exact-session native-stop cleanup after the same authority checks.