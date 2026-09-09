# Ordinary requests do not need an execution workflow

The default task path is understand → execute → verify → report. The keyword
registry no longer interprets `build me` or `I want a` as Autopilot requests, and a
bare `autopilot` name or a question about Autopilot or Ultragoal mode is not activation.

Use an explicit `$autopilot` / `$ultragoal` invocation or a supported command-style
request such as `run autopilot`, `start autopilot`, or `use autopilot`. Explicit
Autopilot retains its staged Deep Interview → Ralplan → Ultragoal contract.

The native prompt hook does not add generic “newest input is an execution handoff”
or “same-thread follow-up” coaching. The shared AGENTS operating guidance already
owns following the latest request. Actual workflow transition instructions remain;
this cleanup does not bypass authority, session ownership, stop, or cancellation
checks, and ordinary follow-ups still continue an already-active workflow.

## Regression corpus

```sh
npm run build
node --test dist/hooks/__tests__/ordinary-task-routing.test.js
```

The fixed corpus tests the real classifier and native UserPromptSubmit dispatcher,
including absence/presence of workflow state, not just generated text. It covers
ordinary work, bare names, quoted mentions, workflow questions, follow-ups, explicit
invocations, and command-style requests. Existing keyword/native-hook suites own
active-resume, marked-question, ownership and cancellation regression coverage.

This is deterministic routing verification, not evidence of model-quality gains,
end-to-end completion rate, or production latency. Source-size deltas can be measured
with the existing prompt inventory and the companion complexity-inventory PR.
