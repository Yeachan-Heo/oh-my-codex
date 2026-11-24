# Agent Tiers

This file defines practical work-tier and model-tier guidance for OMX agent routing.

## Mental Model

OMX separates these concepts:

- `role`: what the agent is responsible for (`executor`, `planner`, `architect`)
- task `tier`: how much work depth to use (`LOW`, `STANDARD`, `THOROUGH`)
- model tier: which model default the role uses (`frontier`, `standard`, `spark`)
- `posture`: how the role behaves (`frontier-orchestrator`, `deep-worker`, `fast-lane`)

Use role to choose responsibility, task tier to choose depth, model tier to select the model default, and posture to choose operating style.

## Model Tiers

Per-role model precedence is `.omx-config.json` `agentModels[role]` > tier env var > built-in tier default. `agentModels` is empty by default. The root `config.toml` model is for the main/leader session only; setup seeds it to `gpt-6.2-sol`, and it does not affect agent tiers.

| Model tier | Environment variable | Built-in default | Roles |
| --- | --- | --- | --- |
| Frontier | `OMX_DEFAULT_FRONTIER_MODEL` | `gpt-6.2-astra` | `planner`, `architect`, `critic` |
| Standard | `OMX_DEFAULT_STANDARD_MODEL` | `gpt-6.2-sol` | Every other non-spark role |
| Spark | `OMX_DEFAULT_SPARK_MODEL` | `gpt-6-luna` | `explore`, `style-reviewer`, `vision` |

Standard never inherits the frontier model; spark never inherits the main/leader model. Team worker fallback uses the same precedence, and a known role's tier/override model wins over the inherited leader model. A distinct `OMX_TEAM_WORKER_LAUNCH_ARGS --model` wins first.

## Tiers

- `LOW`:
  Fast lookups and narrow checks.
  Use for simple exploration, style checks, and lightweight doc edits.
  Typical roles: `explore`, `style-reviewer`, `writer`.

- `STANDARD`:
  Default tier for implementation, debugging, and normal verification.
  Typical roles: `executor`, `debugger`, `test-engineer`, `quality-reviewer`.

- `THOROUGH`:
  Use for architectural, security-sensitive, or high-impact multi-file work.
  Typical roles: `architect`, `critic`, `security-reviewer`, `executor`.
  Note: `deep-executor` is deprecated; route implementation to `executor`.

## Selection Rules

1. Start at `STANDARD` for most code changes.
2. Use `LOW` only when the task is bounded and non-invasive.
3. Escalate to `THOROUGH` for:
   - security/auth/trust-boundary changes
   - architectural decisions with system-wide impact
   - large refactors across many files
4. For Ralph completion checks, use at least `STANDARD` architect verification.

## Posture Guidance

- `frontier-orchestrator`:
  - Best for steerable frontier models and leader-style roles.
  - Prioritizes intent classification, delegation, verification, and architectural judgment.
  - Typical roles: `planner`, `analyst`, `architect`, `critic`, `code-reviewer`.
  - Ralplan keeps `planner` and `architect` in this posture; model selection follows each role's model tier, and reasoning effort remains role-specific.

- `deep-worker`:
  - Best for implementation-heavy roles that should carry work to completion.
  - Prioritizes complete, maintainable repairs within scope; correctness and clarity ahead of patch minimization. Includes strict verification.
  - Typical roles: `executor`, `debugger`, `test-engineer`, `build-fixer`.

- `fast-lane`:
  - Best for cheap/fast models used for triage, search, and narrow synthesis.
  - Prioritizes quick routing, concise search, and escalation over deep autonomous work.
  - Typical roles: `explore`, `writer`, and lightweight research/search specialists.
