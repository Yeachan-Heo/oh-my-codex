---
name: enterprise
description: Bounded enterprise orchestration for high-signal, controlled Phase 1 delivery
argument-hint: "<task description>"
---

# Enterprise Skill

`$enterprise` is a **separate orchestration surface** for enterprise-grade work. It is **not** a replacement for `$team`, and it must not silently alter existing flat-team behavior.

Use it when the user wants a more explicit organizational model with tighter control over ownership, reporting, and shutdown behavior.

## Core Philosophy

Enterprise mode optimizes for:

- **chairman-style orchestration**, not generic worker fanout
- **clear ownership** of each execution scope
- **summary-first reporting** upward through the hierarchy
- **bounded hierarchy and budgets** instead of open-ended recursion
- **predictable kill/shutdown paths** instead of orphaned agents

When users ask for `$enterprise`, they are choosing a more controlled orchestration posture rather than a noisier `$team` session.

## Phase 1 Boundary

Phase 1 is intentionally bounded.

### Hierarchy
- **chairman** — global routing and organizational decisions
- **division leads** — own major scopes and local decomposition
- **subordinates** — narrow local operators owned by a division lead

### Required constraints
- depth cap: `chairman -> division lead -> subordinate`
- no silent fallback that changes normal `$team` semantics
- no raw subordinate-to-chairman transcript spam by default
- no unconstrained write-capable subordinate chaos
- every subordinate must have a clear owner and cleanup path

## When To Use

Use `$enterprise` when the request explicitly asks for enterprise orchestration, enterprise mode, chairman-style execution, or a bounded hierarchical workflow.

Good fits:
- large multi-stage delivery with several independent scopes
- work that benefits from clear division ownership and summary rollups
- requests where separation from standard `$team` behavior matters
- situations where shutdown control and bounded scope are first-class concerns

## When Not To Use

Do **not** use this skill when:
- the word “enterprise” is incidental (pricing, docs, marketing, sales tiers)
- the user really wants standard `$team` behavior
- the task is a simple direct implementation that does not need orchestration

## Operating Rules

1. Confirm the request is truly asking for enterprise orchestration.
2. Keep scope tight and Phase 1 bounded.
3. Prefer explicit acceptance criteria and named touchpoints.
4. Reuse lower-level team infrastructure only when it does **not** collapse the product boundary.
5. Verify outcomes with concrete evidence before claiming completion.
6. If the task is underspecified, route toward planning clarity before heavy execution.

## Summary

`$enterprise` exists to provide a distinct, controlled orchestration surface for enterprise-oriented execution while keeping existing `$team` behavior stable.
