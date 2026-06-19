---
name: ecomode
description: Ecomode deprecated shim
---

# Ecomode deprecated

Hard-deprecated. Do not invoke or route this skill. Use `$ultrawork` directly for maintained high-throughput execution workflows.

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

Ecomode is deprecated, so do not add a repository-doc read prerequisite before delegation. If legacy ecomode routing needs to be interpreted, use this self-contained mapping:

- LOW intensity: prefer `agent_type="explore"` for search, `writer` for documentation, or a tightly scoped `executor` lane with `reasoning_effort="low"`.
- STANDARD intensity: use `agent_type="executor"`, `debugger`, or `test-engineer` with `reasoning_effort="medium"` when LOW is insufficient.
- THOROUGH intensity: use `agent_type="architect"`, `critic`, or high-impact `executor` with `reasoning_effort="xhigh"` only when essential.

**Ecomode preference order:**

```
// PREFERRED - Use for most tasks
use /prompts:executor for this scoped task
use /prompts:explore for this scoped task
use /prompts:architect for this scoped task

// FALLBACK - Only if LOW fails
use /prompts:executor for this scoped task
use /prompts:architect for this scoped task

// AVOID - Only for planning/critique if essential
use /prompts:planner for this scoped task
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

Use the CLI-first state surface (`omx state ... --json`) for ecomode lifecycle state. If explicit MCP compatibility tools are already available, equivalent `omx_state` calls are optional compatibility, not the default.

- **On activation**:
  `omx state write --input '{"mode":"ecomode","active":true}' --json`
- **On deactivation/completion**:
  `omx state write --input '{"mode":"ecomode","active":false}' --json`
- **On cancellation/cleanup**:
  run `$cancel` (which should call `omx state clear --input '{"mode":"ecomode"}' --json`)
