# Docs: global install path alignment and doctor guidance cleanup

## Summary

This change set aligns the written guidance in `oh-my-codex` with the current runtime layout used by modern OMX installs.

## What changed

### 1. Global install paths now consistently point at `.codex/*`

The affected docs now describe the active install layout as:

- prompts: `~/.codex/prompts/`
- skills: `~/.codex/skills/`
- native agents: `~/.codex/agents/`
- config: `~/.codex/config.toml`
- AGENTS: `~/.codex/AGENTS.md`

Project-local equivalents likewise point at `./.codex/*`.

This removes stale references to older `.omx/agents` locations in user-facing setup guidance.

### 2. `doctor` skill guidance now matches the current CLI

The `doctor` skill previously described outdated legacy/plugin cleanup flows and could mislead operators into treating active `.codex` locations as legacy content.

It now uses the modern guidance model:

- run `omx doctor` first
- use `omx doctor --team` only for team/swarm runtime diagnostics
- prefer `omx setup --force` for managed artifact drift
- treat `.codex/skills` and `.codex/agents` as active install targets, not legacy paths

### 3. Regression coverage was added

A dedicated documentation-path test now checks that:

- core setup docs reference `.codex/agents`
- setup/doctor skills do not label live `.codex` installs as legacy
- stale `.omx/agents` references are caught early

## Why this matters

Without this cleanup, operators can end up in an inconsistent state where:

- docs point to stale locations
- the runtime uses different paths than the written guidance
- the `doctor` workflow suggests cleanup actions against active managed directories

The result is confusion during installation, debugging, or migration.

## Validation used for this change

- `npm run lint`
- `npm run build`
- `node --test dist/cli/__tests__/documentation-paths.test.js dist/cli/__tests__/setup-scope.test.js dist/config/__tests__/generator-notify.test.js dist/hooks/__tests__/prompt-guidance-contract.test.js dist/hooks/__tests__/prompt-guidance-wave-two.test.js dist/hooks/__tests__/prompt-guidance-catalog.test.js`

## Operator impact

No runtime behavior is intentionally changed by this doc cleanup.

The goal is to ensure that:

- generated guidance
- repo documentation
- doctor/setup skill instructions
- regression tests

all describe the same current OMX installation model.
