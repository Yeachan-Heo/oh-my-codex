# Agent Tiers

This file defines practical tier guidance for OMX agent routing.

## Mental Model

OMX now separates three concepts:

- `role`: what the agent is responsible for (`executor`, `planner`, `architect`)
- `tier`: how much reasoning/cost to spend (`LOW`, `STANDARD`, `THOROUGH`)
- `posture`: how the role behaves (`frontier-orchestrator`, `deep-worker`, `fast-lane`)
- `exactModel`: optional role pin that bypasses tier defaults when a role needs a
  specific model contract.

Use role to choose responsibility, tier to choose depth, and posture to choose operating style.

Model routing: Each role belongs to a modelClass (`frontier`, `standard`, `fast`) which determines its default model tier. Built-in defaults are all `gpt-6-astra` across tiers; role reasoning defaults and explicit overrides remain unchanged.

**Native Codex subagents** inherit the Codex `config.toml` model except:
- Pinned roles (`planner`, `architect`, `researcher`) use exact `gpt-6-astra` with built-in providers
- Per-agent `agentModels` overrides are respected

**Environment variables** (`OMX_DEFAULT_FRONTIER_MODEL`, `OMX_DEFAULT_STANDARD_MODEL`, `OMX_DEFAULT_SPARK_MODEL`) do NOT set the native TOML `model` field or change native subagent runtime model selection. They configure Team worker fallback selection and mode resolution, and may be reflected in generated `resolved_model` or AGENTS.md model-table metadata.

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
  - **Native subagent model selection:** Ralplan keeps `planner` and `architect` in this posture. With **built-in providers**, `planner` uses exact `gpt-6-astra` (medium reasoning) and `architect` uses exact `gpt-6-astra` (xhigh reasoning). With **custom providers**, these roles inherit the provider's model at runtime. The `critic` consensus gate stays on the frontier lane.

- `deep-worker`:
  - Best for implementation-heavy roles that should carry work to completion.
  - Prioritizes direct execution, minimal diffs, and strict verification.
  - Typical roles: `executor`, `debugger`, `test-engineer`, `build-fixer`.

- `fast-lane`:
  - Best for triage, search, and narrow synthesis.
  - Model selection: Uses the spark/low-complexity tier (default `gpt-6-astra` like other lanes). Configure `OMX_DEFAULT_SPARK_MODEL` (for Team workers) or `agentModels.explore`/etc. (for native agents) to use a cheaper model.
  - Prioritizes quick routing, concise search, and escalation over deep autonomous work.
  - Typical roles: `explore`, `writer`, and lightweight research/search specialists.
