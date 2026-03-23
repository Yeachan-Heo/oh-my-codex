---
name: ecomode
description: "Token-efficient model routing modifier that downgrades agent tiers to save costs. Use when you want to reduce token spend on a task — say 'eco', 'ecomode', or 'budget mode' to activate. Combines with ralph, ultrawork, and autopilot (e.g. 'eco ralph fix the tests')."
---

# Ecomode Skill

Token-efficient model routing. This is a **MODIFIER**, not a standalone execution mode.

## What Ecomode Does

Overrides default model selection to prefer cheaper tiers:

| Default Tier | Ecomode Override |
|--------------|------------------|
| THOROUGH | STANDARD, THOROUGH only if essential |
| STANDARD | LOW first, STANDARD if needed |
| LOW | LOW - no change |

## What Ecomode Does NOT Do

- **Persistence**: Use `ralph` for "don't stop until done"
- **Parallel Execution**: Use `ultrawork` for parallel agents
- **Delegation Enforcement**: Always active via core orchestration

## Combining Ecomode with Other Modes

Ecomode is a modifier that combines with execution modes:

| Combination | Effect |
|-------------|--------|
| `eco ralph` | Ralph loop with cheaper agents |
| `eco ultrawork` | Parallel execution with cheaper agents |
| `eco autopilot` | Full autonomous with cost optimization |

## Ecomode Routing Rules

**ALWAYS prefer lower tiers. Only escalate when task genuinely requires it.**

| Decision | Rule |
|----------|------|
| DEFAULT | Start with LOW tier for most tasks |
| UPGRADE | Escalate to STANDARD when LOW tier fails or task requires multi-file reasoning |
| AVOID | THOROUGH tier - only for planning/critique if essential |

## Agent Selection in Ecomode

**FIRST ACTION:** Before delegating any work, read the agent reference file:
```
Read file: docs/shared/agent-tiers.md
```
This provides the complete agent tier matrix, MCP tool assignments, and selection guidance.

**Ecomode preference order:**

```
// PREFERRED - Use for most tasks
delegate(role="executor", tier="LOW", task="...")
delegate(role="explore", tier="LOW", task="...")
delegate(role="architect", tier="LOW", task="...")

// FALLBACK - Only if LOW fails
delegate(role="executor", tier="STANDARD", task="...")
delegate(role="architect", tier="STANDARD", task="...")

// AVOID - Only for planning/critique if essential
delegate(role="planner", tier="THOROUGH", task="...")
```

## Delegation Enforcement

Ecomode maintains all delegation rules from core protocol with cost-optimized routing:

| Action | Delegate To | Model |
|--------|-------------|-------|
| Code changes | executor | LOW / STANDARD |
| Analysis | architect | LOW |
| Search | explore | LOW |
| Documentation | writer | LOW |

### Background Execution
Long-running commands (install, build, test) run in background. Maximum 20 concurrent.

## Token Savings Tips

1. **Batch similar tasks** to one agent instead of spawning many
2. **Use explore (LOW tier)** for file discovery, not architect
3. **Prefer LOW-tier executor routing** for simple changes - only upgrade if it fails
4. **Use writer (LOW tier)** for all documentation tasks
5. **Avoid THOROUGH-tier agents** unless the task genuinely requires deep reasoning

## Disabling Ecomode

Ecomode can be completely disabled via config. When disabled, all ecomode keywords are ignored.

Set in `~/.codex/.omx-config.json`:
```json
{
  "ecomode": {
    "enabled": false
  }
}
```

## State Management

Use `omx_state` MCP tools for ecomode lifecycle state.

- **On activation**:
  `state_write({mode: "ecomode", active: true})`
- **On deactivation/completion**:
  `state_write({mode: "ecomode", active: false})`
- **On cancellation/cleanup**:
  run `$cancel` (which should call `state_clear(mode="ecomode")`)
