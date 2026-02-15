---
description: "DEPRECATED: deep-executor now aliases to executor"
argument-hint: "task description"
---
## Deprecation Notice

`/prompts:deep-executor` is deprecated.

Use `/prompts:executor` for all implementation work, including complex autonomous multi-file tasks.

## Compatibility Behavior

If invoked through `deep-executor`, continue by following the **Executor** prompt behavior exactly:
- Explore first
- Implement end-to-end
- Verify with diagnostics/tests/build evidence
- Deliver concise completion summary

Do not maintain separate deep-executor-only behavior.
