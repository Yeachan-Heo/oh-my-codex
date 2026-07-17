---
name: ecomode
description: Resource-efficient context, stage, fan-out, and model routing modifier
---

# Ecomode Skill

Resource-efficient execution. This is a **MODIFIER**, not a standalone execution mode.

## What Ecomode Does

Ecomode reduces total interaction cost and rework, not merely model price:

- Carry compact context packets containing only the task, owned surfaces, constraints, and current evidence
- Reuse approved artifacts instead of regenerating specs, plans, or repository summaries
- Use minimal fan-out: start with one capable owner and add agents only for independent work or a demonstrated authority need
- Collapse redundant stages when an approved artifact already satisfies their output contract
- Reduce interaction count by batching related checks and handing off grounded evidence once
- Stop and re-localise repeated failures before they create more rework

It also overrides default model selection to prefer cheaper tiers:

| Default Tier | Ecomode Override |
|--------------|------------------|
| THOROUGH | STANDARD, THOROUGH only if essential |
| STANDARD | LOW first, STANDARD if needed |
| LOW | LOW - no change |

## What Ecomode Does NOT Do

- **Persistence**: Use `ralph` for "don't stop until done"
- **Parallel Execution**: Use `ultrawork` for parallel agents
- **Orchestration Policy**: Core ownership and safety rules remain active, but delegation is conditional on independent work or a demonstrated authority need

## Combining Ecomode with Other Modes

Ecomode is a modifier that combines with execution modes:

| Combination | Effect |
|-------------|--------|
| `eco ralph` | Ralph loop with cheaper agents |
| `eco ultrawork` | Independent parallel lanes with compact context packets |
| `eco autopilot` | Adaptive autonomous execution with artifact and stage reuse |

## Ecomode Routing Rules

**ALWAYS prefer lower tiers. Only escalate when task genuinely requires it.**

Model tier is the final routing decision, after reducing context size, stage count, interaction count, and unnecessary fan-out.

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

## Conditional Delegation

When delegation is warranted, Ecomode maintains core ownership rules with cost-optimized routing:

| Delegated action | Route To | Model |
|--------|-------------|-------|
| Code changes | executor | LOW / STANDARD |
| Analysis | architect | LOW |
| Search | explore | LOW |
| Documentation | writer | LOW |

### Background Execution
Long-running commands (install, build, test) run in background. Maximum 20 concurrent.

## Token Savings Tips

1. **Reuse approved artifacts** so phases do not rediscover settled context
2. **Send compact context** rather than full conversation history when a bounded packet is enough
3. **Batch similar checks** to reduce interaction count without hiding distinct failures
4. **Use minimal fan-out** and add a second owner only for an independent lane or fresh authority requirement
5. **Use explore (LOW tier)** for file discovery, not architect
6. **Prefer LOW-tier executor routing** for simple changes - only upgrade if it fails or risk requires it
7. **Avoid THOROUGH-tier agents** unless the task genuinely requires deep reasoning

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
