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
  - Ralplan keeps `planner` and `architect` in this posture; `planner`
    uses exact `gpt-5.5` with medium reasoning, `architect` uses exact
    `gpt-5.5` with xhigh reasoning, and the `critic` consensus gate stays
    on the frontier lane.

- `deep-worker`:
  - Best for implementation-heavy roles that should carry work to completion.
  - Prioritizes direct execution, minimal diffs, and strict verification.
  - Typical roles: `executor`, `debugger`, `test-engineer`, `build-fixer`.

- `fast-lane`:
  - Best for cheap/fast models used for triage, search, and narrow synthesis.
  - Prioritizes quick routing, concise search, and escalation over deep autonomous work.
  - Typical roles: `explore`, `writer`, and lightweight research/search specialists.
