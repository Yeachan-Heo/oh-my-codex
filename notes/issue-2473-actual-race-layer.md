# Issue #2473 work-stream (a): actual race layer is upstream of OMX

**Status: BLOCKED on scope-of-ownership. Wrote this note instead of patching a layer I cannot verify, per the guardrail in the work-stream prompt.**

## TL;DR

The prompt for work-stream (a) directs me to patch `wait_agent` so that, before declaring a
timeout, it reconciles against the OMX notify-fallback / rollout `task_complete` records.

`wait_agent` does **not exist** as a symbol anywhere in the oh-my-codex codebase. It is a
Codex CLI native-subagent runtime tool, owned upstream in `codex-rs`, not here. OMX is the
event **consumer** for that runtime — it cannot patch the `wait_agent` deadline logic.

Per the work-stream (a) guardrail:

> If you find that `wait_agent` already has SOME reconciliation logic and the race is in a
> different layer, STOP and write `notes/issue-2473-actual-race-layer.md` describing what you
> found. Do not patch a layer you didn't verify.

My finding is one step stronger than that guardrail's literal text: `wait_agent` doesn't have
reconciliation logic in OMX at all because the function itself is not in OMX. Stopping and
escalating rather than fabricating an OMX-side function named `wait_agent` (which would be
dead code from the moment it landed, since no OMX caller would invoke it).

## Evidence — exhaustive search

Searched the entire worktree (excluding `node_modules`, `dist`, `target`, `.git`, and the
harness's own `.omc` cache which contains this session's branch name as a string):

```bash
grep -rln "wait_agent\|close_agent" \
  --include="*.ts" --include="*.js" --include="*.rs" \
  --include="*.md" --include="*.toml" --include="*.json" \
  --include="*.sh" .
```

Hits: **zero in source.** The only filesystem match is
`.omc/state/hud-stdin-cache.json`, which contains this Claude Code session's own metadata
(session name `"Fix wait_agent reconciliation race (#2473)"` and worktree branch
`fix+issue-2473-wait-agent-reconcile`) — not source code.

Cross-checks that also returned zero:

- `grep -rn "agent_thread_limit\|agent-thread-limit" .` (the "agent thread limit reached"
  error message kjsolo quoted is also not from OMX — it's from the upstream Codex runtime).
- `grep -rn "spawn_agent\|spawnAgent\|await_agent\|agent_wait" .`
- `git log --all --grep="wait_agent\|wait-agent\|waitAgent"` — no commits ever introduced
  or removed a `wait_agent` symbol on any branch.

## What IS in OMX (the consumer surface)

OMX participates in the native-subagent flow only as an event consumer / synthesizer:

1. **`src/scripts/codex-native-hook.ts`** — receives notify-hook events from Codex CLI
   (`agent-turn-complete`, etc.) and records subagent turns via
   `recordSubagentTurnForSession` (`src/subagents/tracker.ts`).
2. **`src/scripts/notify-fallback-watcher.ts`** — long-running watcher that tails Codex
   rollout JSONL files. When it sees an `event_msg` with `payload.type === 'task_complete'`,
   it synthesizes an `agent-turn-complete` notify-hook payload with
   `input-messages: ['[notify-fallback] synthesized from rollout task_complete']` and
   re-invokes the notify hook in a child process
   (`src/scripts/notify-fallback-watcher.ts:1640-1680`).
3. **`src/subagents/tracker.ts`** — durable per-session record of subagent threads
   (`thread_id`, `first_seen_at`, `last_seen_at`, `turn_count`, `mode`). This is the only
   OMX-owned record that even *could* serve as the "task-complete / notify-fallback record"
   the prompt wants `wait_agent` to read.
4. **`src/ralplan/runtime.ts`** — the `RalplanConsensusExecutor` interface
   (`draft / architectReview / criticReview`) is an **injected interface**. The actual
   implementation that does the subagent-spawn-and-wait lives in the LLM prompt /
   slash-command surface, not in OMX TypeScript code. `runRalplanConsensus` just `await`s
   the injected executor methods — it doesn't wait on a subagent itself and has no deadline
   logic.
5. **`src/team/worker-bootstrap.ts:664`** — the prompt text emitted to leader/worker agents
   literally says "spawn up to N Codex native subagents using model M, **wait for them**" —
   confirming the wait is a prompt-level instruction to use a *Codex-side* native tool. OMX
   never owns the timer.

The notify-fallback synthesis cited in the issue body (`[notify-fallback] synthesized from
rollout task_complete`) is exactly the
`buildNotifyPayload` path at `src/scripts/notify-fallback-watcher.ts:1640`. The race kjsolo
observed is real, and the OMX-side artifact (the synthesized event) is real, but the timer
that decides "timed out" is on the **Codex / executor caller** side, not in OMX.

## Why the prompt's plan can't land as written

The prompt's IMPLEMENTATION PLAN step 3 says:

> On timeout-decision evaluation, BEFORE returning timeout, read the most-recent
> task-complete / notify-fallback records for the target sub-agent.

There is no OMX function that owns "timeout-decision evaluation" for a subagent wait. The
deadline is enforced wherever the executor implementation lives (Codex CLI native tool, or
the LLM prompt that simulates `wait_agent` semantically). Adding an OMX helper named
`waitAgentReconcile(...)` would be dead code — nothing in OMX calls a deadline-aware
subagent wait, and the upstream Codex CLI cannot import OMX TypeScript at the timeout site.

The prompt's `IMPLEMENTATION PLAN` also says:

> Use whatever bounded-read helper already exists; do not introduce a new full-scan.

There is no such bounded-read helper for "is sub-agent X done?" today. The closest is
`readSubagentSessionSummary` (`src/subagents/tracker.ts`), which returns
`{ activeSubagentThreadIds, allThreadIds, ... }` — i.e. liveness inference based on a
`last_seen_at` window, not a "completed/not-completed" boolean keyed on a specific
sub-agent id with a captured result payload. So even the helper the prompt assumes already
exists doesn't exist yet — building it is itself a scope expansion.

## What the actual fix would have to look like

Either of these would be defensible, but **both** exceed the work-stream (a) scope as
written:

**Option α — upstream fix in `codex-rs`.** Add a reconciliation step to the
Codex-native `wait_agent` tool (Rust side) that, before declaring timeout, checks the
rollout file for a `task_complete` event matching the target sub-agent. This is the
correct layer because it owns the timer. OMX would not need any change. Out-of-repo for
this PR.

**Option β — OMX-side reconciliation API + prompt rewiring.** Add an OMX helper
(`omx subagent reconcile <thread_id> [--since=<ts>]`) that reads the same task-complete
records the notify-fallback-watcher reads, and returns a structured "completed | pending"
verdict with the captured `last_agent_message`. Then rewrite the leader/worker prompt
guidance (`src/team/worker-bootstrap.ts:664`, `prompts/*.md`, ralplan executor harness) to
call this helper before treating a subagent wait as timed out. This touches at minimum:
- new CLI subcommand (`src/cli/`)
- prompt rewrites across `prompts/` and `src/team/worker-bootstrap.ts`
- new `subagents/tracker.ts` API for keyed reconciliation
- new tests

Option β is a multi-surface PR (CLI + prompt rewrites + tracker API) that goes well
beyond the prompt's stated scope ("Surface to touch: wait_agent driver implementation
file(s); the notify-fallback / task-complete record reader; regression test").

## What I did NOT do, and why

- Did **not** invent an OMX function named `wait_agent` to satisfy the prompt's "surface to
  touch" expectation. Per the prompt's GUARDRAILS section, default-to-stop on
  scope/identification ambiguity rather than fabricate.
- Did **not** patch `notify-fallback-watcher.ts` to add a reconciliation API, because that
  would only be useful with Option β's accompanying prompt + caller rewrites — and those
  rewrites overlap with `$ralplan` driver code that the prompt's ABSOLUTELY OUT OF SCOPE
  list excludes ("`$ralplan` driver / `$ralph` driver").
- Did **not** add a regression test, because there is no OMX function under test for
  work-stream (a) as scoped. (A future test would cover whichever helper Option β
  introduces.)
- Did **not** touch `close_agent` / thread-limit (work-stream b) or `omx doctor` /
  `mode_not_allowed` surfacing (work-stream c), per the prompt's scope fence.

## Recommended owner routing

1. Confirm whether the intended fix layer is Codex CLI (Option α) — if so, this issue
   needs an upstream PR to `codex-rs`, not OMX.
2. If the intended fix is OMX-side (Option β), the work-stream (a) prompt needs a scope
   expansion to cover the new CLI subcommand + prompt rewrites, since just adding a
   reconciliation helper in isolation is dead code.
3. The notify-fallback record format **does** carry per-thread ids (`thread-id`, `turn-id`
   in the synthesized payload at `notify-fallback-watcher.ts:1640`), so the
   `notes/issue-2473-id-missing.md` guardrail does not apply — id-by-thread is available
   either way.

## Inputs I read

- `gh issue view 2473 --repo Yeachan-Heo/oh-my-codex` (body + all 3 comments)
- `src/ralplan/runtime.ts`, `src/ralplan/__tests__/runtime.test.ts`
- `src/scripts/notify-fallback-watcher.ts` (especially the `buildNotifyPayload` /
  `processLine` path at ~1620–1700)
- `src/scripts/codex-native-hook.ts` (top + subagent-tracking imports)
- `src/subagents/tracker.ts`
- `src/team/worker-bootstrap.ts` (subagent delegation contract block at ~640–680)
- Exhaustive grep of all `*.ts/*.rs/*.md/*.toml/*.json/*.sh` outside vendored/dist trees
- `git log --all --grep="wait_agent|wait-agent|waitAgent|2473|close_agent"`
