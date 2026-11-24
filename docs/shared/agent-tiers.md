# Agent Tiers

This file defines work-depth guidance and model-tier routing for OMX agents.

## Mental Model

OMX separates these concepts:

- `role`: what the agent is responsible for (`executor`, `planner`, `architect`)
- task `tier`: how much work depth to use (`LOW`, `STANDARD`, `THOROUGH`)
- model tier: which model default the role uses (`frontier`, `standard`, `spark`)
- `posture`: how the role behaves (`frontier-orchestrator`, `deep-worker`, `fast-lane`)

Use role to choose responsibility, task tier to choose depth, model tier to select the model default, and posture to choose operating style.

## Model Tiers

Per-role precedence is `.omx-config.json` `agentModels[role]` > the tier environment variable > the built-in tier default. `agentModels` is empty by default. The root `config.toml` model is for the main/leader session only; setup seeds it to `gpt-6.2-sol` and it never affects agent tiers.

| Model tier | Environment variable | Built-in default | Roles |
| --- | --- | --- | --- |
| Frontier | `OMX_DEFAULT_FRONTIER_MODEL` | `gpt-6.2-astra` | `planner`, `architect`, `critic` |
| Standard | `OMX_DEFAULT_STANDARD_MODEL` | `gpt-6.2-sol` | Every other non-spark role, including `researcher`, `analyst`, `security-reviewer`, `test-engineer`, `code-reviewer`, `code-simplifier`, `team-executor`, and `executor` |
| Spark | `OMX_DEFAULT_SPARK_MODEL` | `gpt-6-luna` | `explore`, `style-reviewer`, `vision` |

Standard never inherits the frontier model, and spark never inherits the main/leader model. The spark chain alone may also use the legacy `OMX_SPARK_MODEL` and team low-complexity model keys.

With built-in or implicit providers, native agent TOML writes the resolved tier model for every role. With custom providers, it omits `model` unless `agentModels[role]` is set. A role override still takes precedence in instruction `resolved_model` metadata; otherwise, custom-provider metadata uses the configured root/profile model or is absent if none is configured.

Team worker fallback uses the same `agentModels[role]` > tier environment variable > built-in tier default chain. For a known role, that tier/override model wins over the inherited leader model. A distinct `OMX_TEAM_WORKER_LAUNCH_ARGS --model` wins first.

Reasoning efforts remain unchanged per role. Use `.omx-config.json` `agentReasoning` to override a role's reasoning effort.

## Task Tiers

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

Posture overlays stay within the assigned role and task authority.
Read-only analysis or planning completes with supported conclusions or a plan;
it does not require implementation. Diagnostics, tests, and builds apply when
the assigned result or repository requires them. Native leaf agents report
missing specialist coverage to their leader instead of delegating it.

- `frontier-orchestrator`:
  - Best for steerable frontier models and leader-style roles.
  - Prioritizes intent classification, delegation, verification, and architectural judgment.
  - Typical roles: `planner`, `analyst`, `architect`, `critic`, `code-reviewer`.
  - Model selection follows each role's model tier; posture does not add a model override.

- `deep-worker`:
  - Best for implementation-heavy roles that should carry work to completion.
  - Prioritizes complete, maintainable repairs within scope; correctness and clarity ahead of patch minimization. Includes strict verification.
  - Typical roles: `executor`, `debugger`, `test-engineer`, `build-fixer`.

- `fast-lane`:
  - Best for triage, search, and narrow synthesis.
  - Model selection uses the spark tier: `agentModels[role]`, then `OMX_DEFAULT_SPARK_MODEL`, then built-in `gpt-6-luna`.
  - Prioritizes quick routing, concise search, and escalation over deep autonomous work.
  - Typical roles: `explore`, `writer`, and lightweight research/search specialists.
