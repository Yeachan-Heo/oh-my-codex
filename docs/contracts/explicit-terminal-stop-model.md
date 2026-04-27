# Explicit Terminal Stop Model Contract

Status: approved migration contract for runtime, hooks, MCP state, and prompt/documentation surfaces.

## Purpose

This document locks the canonical terminal stop vocabulary for active OMX workflows.
It exists so runtime code, native/fallback Stop handlers, MCP state, and user-facing handoff guidance all describe the same end-of-turn semantics.

## Canonical terminal lifecycle outcomes

These are the only canonical user-facing terminal lifecycle outcomes for the explicit stop model:

| Outcome | Meaning | Continuation rule | User-facing expectation |
| --- | --- | --- | --- |
| `finished` | The workflow completed successfully. | Do not auto-continue. | Report completion evidence and resulting artifacts. |
| `blocked` | Progress cannot continue because a non-user prerequisite is missing. | Do not auto-continue until the blocker changes. | Report the blocker, why it matters, and the required handoff. |
| `failed` | The workflow or verification failed. | Do not auto-continue until the failure is addressed. | Report failure evidence, impact, and recommended recovery. |
| `userinterlude` | The user intentionally interrupted or paused the run. | Do not auto-continue unless the user explicitly restarts it. | Report that the stop was user-originated, not model-originated. |
| `askuserQuestion` | OMX must ask the user a blocking question before safe progress can continue. | Do not auto-continue until the question is answered. | Ask one concrete blocking question and record the question metadata. |

`askuserQuestion` and `userinterlude` are intentionally distinct:

- `askuserQuestion` is model-originated and should normally be backed by `omx question` or equivalent machine-readable question metadata.
- `userinterlude` is user-originated interruption/stop intent.

## Legacy compatibility rules

Legacy values may still appear in persisted state during migration, but they are compatibility inputs, not the public canonical vocabulary.

| Legacy value | Canonical interpretation |
| --- | --- |
| `finish`, `complete`, `completed`, `done` | normalize to `finished` |
| `blocked_on_user` | compatibility-only user-wait signal; map to `askuserQuestion` when question metadata proves OMX asked a blocking question, otherwise map to `userinterlude`/user-wait compatibility according to the surrounding context |
| `cancelled`, `canceled`, `abort`, `aborted` | internal legacy/admin stop compatibility only; do **not** present as a canonical user-facing lifecycle outcome |

### `cancelled` policy

`cancelled` remains valid for legacy administrative state, teardown, or backward-compatible reads.
It is **not** a canonical user-facing terminal lifecycle outcome in the explicit stop model.
Docs, prompts, and runtime summaries should prefer one of:

- `finished`
- `blocked`
- `failed`
- `userinterlude`
- `askuserQuestion`

## State / MCP precedence

Terminal lifecycle metadata should be interpreted in this order:

1. a dedicated canonical lifecycle field such as `lifecycle_outcome`
2. legacy `run_outcome` compatibility data
3. fallback inference from `current_phase`, question metadata, and other persisted context

Notes:

- `current_phase` and lifecycle outcome are related but not identical. A workflow can keep legacy phase names while still exposing canonical lifecycle metadata.
- If both canonical lifecycle metadata and legacy `run_outcome` are present, the canonical lifecycle field wins.
- `run_outcome` should be treated as a compatibility read/write surface during migration, not as the long-term public contract.

## Stop / watcher interpretation rules

Stop readers, native hooks, and fallback watchers should prefer explicit lifecycle metadata over assistant prose heuristics.
During migration they should:

- honor canonical `finished`, `blocked`, `failed`, `userinterlude`, and `askuserQuestion` metadata first
- keep honoring legacy `blocked_on_user` as a suppress-continuation compatibility signal
- avoid treating optional assistant prose as the semantic owner of lifecycle state
- keep `cancelled` internal legacy-only when translating to user-facing lifecycle summaries

## Active workflow terminal handoff contract

When an active workflow produces a terminal user-facing message, the handoff should be explicit and structured.
The terminal summary should include:

1. **Outcome** — one explicit lifecycle label
2. **Evidence** — concrete verification output, failure evidence, or the missing dependency/question
3. **Artifacts / state** — changed files, saved artifacts, or recorded question identifiers when relevant
4. **Handoff** — the exact next owner or required answer, without optional permission-seeking phrasing

### Forbidden terminal pattern

Do **not** end active workflow terminal handoffs with optional follow-up softeners such as:

- `If you want, I can ...`
- `If you'd like, I can ...`
- `Would you like me to continue?`

Those phrases make the lifecycle state ambiguous. The terminal outcome should already explain whether the run finished, failed, blocked, entered user interlude, or is waiting on a required user question.

## Non-goals

This contract does **not** require every legacy internal phase name to be renamed immediately.
It does require every migrated surface to expose and prefer the canonical terminal lifecycle concepts above.
