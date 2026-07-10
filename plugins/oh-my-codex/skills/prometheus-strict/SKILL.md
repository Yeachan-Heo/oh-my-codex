---
name: prometheus-strict
description: "[OMX] Clean-room interview-driven planner: Metis clarifies, Momus challenges, Oracle synthesizes, then hands off to $ultragoal/$team."
argument-hint: "<goal or problem statement>"
---

# Prometheus Strict

Clean-room OMX planning workflow inspired by the high-level OMO Prometheus concept only. This skill does not copy implementation, prompts, wording, control flow, or runtime code from OMO. It reimplements the idea under this repository's MIT-licensed skill conventions.

Credit: Inspired by OMO Prometheus (`code-yeongyu/oh-my-openagent`), reimplemented from concept under MIT.

<Purpose>
Prometheus Strict creates a rigorous plan before execution when ambiguity is still risky. It separates three planning voices: Metis clarifies requirements, Momus challenges assumptions and validation gaps, and Oracle synthesizes the handoff-ready OMX-native plan.

The output is a planning-only artifact for `$ultragoal` and, when independent lanes are justified, `$team`. When a durable artifact is useful, store or request the final plan under `.omx/plans/prometheus-strict/`.
</Purpose>

<Use_When>
- The task is important enough that a shallow plan could produce wrong work.
- Requirements are partially known but acceptance criteria, boundaries, risks, or validation are incomplete.
- The user wants a strict interview before execution.
- A future `$ultragoal` story needs durable scope, tests, and handoff sequencing.
- A team split may be needed, but the lanes are not yet safe to assign.
</Use_When>

<Do_Not_Use_When>
- The user asks for immediate implementation of a clear, low-risk change; use the normal executor path.
- The task is only a repository lookup or explanation; use `explore`/`analyze` as appropriate.
- The user needs adversarial execution QA after code changes; use `$ultraqa`.
- The user wants hook behavior, Sisyphus behavior, or a `start-work` port. Those are explicit non-goals.
</Do_Not_Use_When>

<Why_This_Exists>
OMX already has `$plan`, `$ralplan`, and `$deep-interview`. Prometheus Strict exists for a narrower case: an explicit clean-room strict-planning lane with named clarification, critique, and synthesis roles, plus a durable `.omx/plans/prometheus-strict/` handoff contract. It is not a replacement for execution workflows.
</Why_This_Exists>

<Execution_Policy>
- Stay planning-only. Do not edit source code during this skill unless the user starts a separate execution workflow afterward.
- Preserve clean-room boundaries. Do not copy or imitate OMO wording, source, prompts, runtime behavior, or control flow.
- Keep non-goals visible: No hook implementation. No Sisyphus/start-work port. No automatic external-production actions.
- Ask high-leverage questions as a batched round when the answers materially change scope, safety, or validation. Reserve one-at-a-time questioning only for dependent question chains where the next question depends on the previous answer.
- If a safe assumption is available, state it and continue.
- Use repository reads when needed to make paths, tests, and handoff commands concrete.
- During Metis planning, run pre-question research fan-out for every non-trivial intent unless the task is trivial, the cited spec is self-contained, or cached evidence already covers the same surface; use `explore` for repo facts and the exact cheap `gpt-5.6-terra` `researcher` lane for external docs / OSS references before asking the user. Prometheus Strict may fan out up to `2 explore + 4 researcher` agents per round so breadth comes from more citation-focused mini researchers while Metis/Momus/Oracle keep stronger judgment roles.
- Recommend `$team` only when Oracle identifies independent, bounded, verifiable lanes.

### Structured Question Surface

Every Metis/Momus/Oracle question to the user MUST go through the surface-appropriate structured question path. Plain prose questioning is the last fallback, not the default.

- In attached-tmux OMX runtime, use `omx question` as the OMX-owned structured question surface (this is the `AskUserQuestion` equivalent for Prometheus Strict). From attached-tmux Bash/tool paths, prefix the command with `OMX_QUESTION_RETURN_PANE=$TMUX_PANE` (or a concrete `%pane` value) so the leader-pane return target is preserved.
- **Batch independent high-leverage questions into a single `questions[]` array call**: scope, constraints, non-goals, deliverables, safety bounds, and acceptance criteria are normally independent and MUST be batched into one structured form so the user answers them in a single panel. Reserve one-at-a-time only for dependent question chains where the next question depends on the previous answer.
- Wait for the `omx question` JSON answer before checking the clearance rule, asking another round, or handing off; prefer `answers[]` / `answers[i].answer`, and use the legacy top-level `answer` only as a compatibility fallback. After every `answers[]` batch, run at least **two gap-fill passes** before another question or handoff: Pass 1 assimilates user answers into the checklist; Pass 2 re-scans repo context, prior turns, research fan-out evidence, and conservative defaults to absorb non-CRITICAL residual gaps.
- Minimum two emitted question rounds: when Metis emits any user-facing question round, do not hand off after Round 1 unless hostility/`<turn_aborted>` or the round-5 cap forces exit; handoff is allowed only after Round 2 has been emitted and processed. Zero-question complete-checklist handoff remains valid when no questions were emitted.
- Between-round planning must actively use evidence: after Round 1 answers and the two gap-fill passes, refresh or reuse `<research_fan_out>` explore/researcher evidence, re-run spec prefill, and build Round 2 from residual CRITICAL gaps only.
- Outside tmux, use the native structured input tool when one is available.
- When neither structured surface can render (non-tmux Codex CLI, piped runs, CI), list the round's independent questions as a numbered prose block (`Q1: ... Q2: ... Q3: ...`) and wait for all answers in one user turn; do not split into separate round-trips.
- Multiple interview rounds ARE expected when clearance is not yet reached; each round is one batched form (or its prose fallback), never split across forms.

### Checklist Clearance

The interview is governed by deterministic checklist clearance, not by subjective "feels enough" judgement. Exit the Metis interview loop when the 6-item checklist is fully YES: objective / scope IN+OUT / acceptance / test strategy / handoff target / no outstanding CRITICAL. Each item is evaluated with the tri-state defined in `<Turn_Termination_Rules>`.

Cap interview rounds at **5** to prevent runaway. If checklist clearance is not reached by round 5, hand the remaining UNKNOWN items to Oracle as explicitly carried-forward `<unresolved_blocker>` entries.

**Hostility / non-answer exit**: if the user's responses for a round contain refusal signals (1-2 character non-answers, dismissive `알아서` / "you decide" / "whatever" patterns, profanity-laden responses, or a `<turn_aborted>` on the prior turn), the round invalidates the answers — it does NOT advance any checklist item to YES, exits the interview loop immediately, and routes the unresolved gaps either to `<silent_absorption>` (for dismissive delegation) or back to the user via `hostility_exit` (for anger / aborted turns). See `prometheus-strict-metis` `<hostility_detection>` for the full pattern list and routing rules.
</Execution_Policy>

<Turn_Termination_Rules>
Every Prometheus Strict turn ends with EXACTLY ONE of the following terminations. Bare summaries and "I think we're done" are forbidden.

The 6-item checklist is: objective / scope IN+OUT / acceptance / test strategy / handoff target / no outstanding CRITICAL. A checklist item is YES when it is USER_ANSWERED ∪ ABSORBED_WITH_CITATION ∪ INFERRED_FROM_SPEC. Only UNKNOWN (no answer, no citation, no spec inference) counts as NO.

- (a) `omx question` batch: use when at least one CRITICAL question survives `<gap_triage>` and `<self_review>`. The batch is the round; the turn waits for `answers[]` before continuing.
- (b) explicit handoff: use when the 6-item checklist is fully YES. Hand off Metis → Momus after clearance, Momus → Oracle after critique, and Oracle → user or `<unresolved_blocker>` carry-forward after Pass 2 synthesis.
- (c) stop-blocker: use when hostility/`<turn_aborted>` is detected via `<hostility_detection>` with subtype `hostility_exit`, or when the next action is destructive, credential-gated, external-production, and cannot be defaulted safely.

Edge cases:
1. Zero-questions-but-complete-checklist → option (b) explicit handoff. Do not emit an empty `omx question` form.
2. Round-5-cap with incomplete checklist → option (a) emit one more question batch with surviving UNKNOWN items annotated, OR option (b) handoff with UNKNOWN items carried forward to Oracle as `<unresolved_blocker>` entries.
3. Hostility/`<turn_aborted>` → option (c) for anger, profanity, or aborted-turn via `hostility_exit`; option (b) for dismissive-delegation (`알아서` / "you decide") with absorbed gaps annotated.
</Turn_Termination_Rules>

<Steps>
### 1. Intake and Safety Bounds

Restate the target result, known constraints, deliverables, validation expectations, and stop condition. Identify whether this turn is planning-only or whether the user also requested downstream execution.

If the prompt contains destructive, credential-gated, external-production, or materially scope-changing decisions, hold those decisions for explicit user confirmation. Otherwise, continue through the planning loop.

### 2. Metis Interview (Iterative, Checklist Clearance)

Use `prometheus-strict-metis` as the interview voice. When native subagents are available, invoke the dedicated agent; otherwise run the same role in-context without editing files.

Metis discovers success criteria, non-goals, evidence versus assumptions, required artifacts, likely execution lanes, and missing decisions. Before the first user-facing question batch, Metis must actively fan out repo/external research per intent: `explore` maps local surfaces and exact `gpt-5.6-terra` `researcher` lanes gather official/upstream or OSS-reference evidence. Research-heavy intents use more cheap researchers rather than downgrading Metis/Momus/Oracle judgment.

Run the interview as a bounded loop:

1. Identify every currently-UNKNOWN checklist item and every CRITICAL question whose answers would materially change scope, safety, or validation.
2. Batch the round's independent questions into a single Structured Question Surface call (`questions[]` array, or numbered prose fallback outside tmux).
3. Collect the structured `answers[]`, then run **Gap-fill Pass 1 — answer assimilation**: update evidence vs. assumption and mark checklist items YES only when USER_ANSWERED, ABSORBED_WITH_CITATION, or INFERRED_FROM_SPEC.
4. Run **Gap-fill Pass 2 — residual adversarial scan**: re-check every remaining UNKNOWN against repo context, prior turns, research fan-out evidence, framework/industry defaults, and conservative reversible defaults; absorb non-CRITICAL gaps with citations/assumptions and leave only CRITICAL blockers.
5. Run **between-round planning** after Round 1: refresh or reuse `<research_fan_out>` explore/researcher evidence, re-run spec prefill, and prepare Round 2 from residual CRITICAL gaps only.
6. Evaluate the 6-item checklist (`<Turn_Termination_Rules>` tri-state) only after BOTH gap-fill passes and the minimum two emitted question rounds gate; exit when ALL YES and either no questions were emitted or Round 2 has been emitted and processed.
7. If checklist clearance is not reached, or only Round 1 has been processed, return to step 1 with the next round. Cap at 5 rounds; on cap, carry remaining UNKNOWN items forward to Oracle as explicit `<unresolved_blocker>` entries.

### 3. Momus Challenge (Bounded Retry)

Use `prometheus-strict-momus` as the adversarial critique voice. When native subagents are available, invoke the dedicated agent; otherwise run the same role in-context without editing files.

Momus challenges underspecified acceptance criteria, unsafe assumptions, hidden destructive steps, overbroad scope, missing verification, ownership conflicts, and `$ultragoal`/`$team` handoff ambiguity.

**Bounded retry contract**: after Oracle synthesizes in §4, re-invoke Momus on the synthesized plan to verify that Oracle's resolutions did not introduce new risks (scope addition without matching verification, lane split that creates dependency cycles, safety reinforcement that contradicts stop conditions). Repeat the Momus → Oracle re-synthesis cycle up to **3 times total**. If blocking objections remain after the 3rd cycle, mark them as carried-forward in the final plan and proceed to §5.

### 4. Oracle Synthesis (Two-Pass: Synthesis + Self-Verification)

Use `prometheus-strict-oracle` as the synthesis voice. When native subagents are available, invoke the dedicated agent; otherwise run the same role in-context without editing files.

**Pass 1 — Synthesis.** Oracle produces the final objective, scope and non-goals, accepted assumptions, resolved critique, sequenced steps or lanes, verification matrix, rollback/escalation conditions, and recommended OMX handoff.

**Pass 2 — Self-Verification (machine-checkable acceptance contract).** Oracle re-reads its own Pass 1 output and asserts:

- Every claim in the verification matrix has an explicit evidence source (test/build/lint/e2e/doc).
- Every step lists its owner / lane / executor; no shared-file conflicts between parallel lanes.
- Stop, rollback, and acceptance criteria are mutually consistent (no acceptance criterion is satisfied by a state that also triggers rollback).
- No destructive, credential-gated, or external-production step is unauthorized.
- The handoff command is concrete (callable verbatim) and points at an existing workflow (`$ultragoal`, `$team`, or `none`).
- Clean-room credit is preserved.

If any Pass 2 check fails, Oracle MUST loop back to Pass 1 to repair before emitting the plan. Cap Pass 1 ↔ Pass 2 cycles at **3**; on cycle 3 failure, emit the plan with the failing gates annotated as carried-forward and escalate to the user.

### 5. Post-Plan Gap Check (Metis Re-Invocation)

Before handing off, re-invoke `prometheus-strict-metis` on the finalized Oracle plan with a single charge: identify ambiguities that surfaced **only after** the plan was rendered — for example, new lane assignments that overlap, verification matrix gaps revealed by stop conditions, acceptance criteria that contradict the rollback contract.

If post-plan Metis surfaces any blocking gap, return to §4 Pass 1 with the new question. Otherwise proceed to §6.

### 6. Handoff

Prometheus Strict stops with a plan unless the user explicitly invokes or authorizes the next workflow. Prefer this sequence:

```text
$ultragoal "<Oracle plan summary or .omx/plans/prometheus-strict/<slug>.md>"
$team <N>:executor "execute the approved Ultragoal story in parallel lanes"  # only when warranted
```
</Steps>

<Tool_Usage>
- Use read-only repository inspection to verify referenced files, commands, and existing conventions.
- Treat Metis research fan-out as part of planning, not execution: dispatch `explore` / exact `gpt-5.6-terra` `researcher` evidence-gathering before question generation for non-trivial intents, then re-prefill and ask only surviving CRITICAL gaps.
- Use `prometheus-strict-metis`, `prometheus-strict-momus`, and `prometheus-strict-oracle` sequentially; do not fan out implementation work from this skill.
- Use `$ultragoal` only as the recommended execution handoff after the plan is ready.
- Use `$team` only when parallel lanes are independent and verifiable.
</Tool_Usage>

## State Management

Prometheus Strict does not own a long-running runtime loop. If a durable planning artifact is needed, write the final plan to `.omx/plans/prometheus-strict/<slug>.md`. Draft-only or inline plans may set the artifact path to `N/A - inline plan only`.

Do not create hook state, Sisyphus state, or `start-work` compatibility state for this skill.

<Final_Checklist>
- [ ] Target result is explicit.
- [ ] Scope and non-goals are explicit.
- [ ] Acceptance criteria are measurable.
- [ ] Metis interview loop reached checklist clearance only after the mandatory two gap-fill passes following every `answers[]` batch and, if any question round was emitted, after the minimum two emitted question rounds gate; otherwise the 5-round cap was reached with UNKNOWN items carried forward as `<unresolved_blocker>` entries.
- [ ] Momus objections are resolved or carried forward as explicit blockers, with at most 3 Momus → Oracle re-synthesis cycles consumed.
- [ ] Oracle plan includes a verification matrix.
- [ ] Oracle Pass 2 self-verification completed; every machine-checkable contract item passes or is annotated as carried-forward.
- [ ] Post-plan Metis gap check produced no blocking objections (or all are carried forward).
- [ ] Handoff recommends `$ultragoal` and `$team` only when warranted.
- [ ] Clean-room credit is preserved.
- [ ] No hook implementation or Sisyphus/start-work port was introduced.
</Final_Checklist>

<Advanced>
## Output Contract

If writing a durable plan file, store this markdown at `.omx/plans/prometheus-strict/<slug>.md` and reference that path in the handoff.

```markdown
## Prometheus Strict Plan

### Target Result
- <one-sentence objective>

### Clarified Requirements (Metis)
- <requirement / acceptance criterion>

### Critique Resolved (Momus)
- <risk or objection> -> <resolution>

### Oracle Execution Plan
1. <sequenced step or lane>

### Verification Matrix
| Claim | Required evidence | Owner/lane |
| --- | --- | --- |
| <claim> | <test/build/lint/e2e/doc evidence> | <owner> |

### Artifact
- Durable plan path: `.omx/plans/prometheus-strict/<slug>.md` or `N/A - inline plan only`

### Handoff
- Recommended next workflow: <$ultragoal / $team / direct execution / none>
- Stop condition: <what proves the plan is ready or why it is blocked>

### Clean-Room Credit
Inspired by OMO Prometheus (`code-yeongyu/oh-my-openagent`), reimplemented from concept under MIT.
```

## Failure and Escalation

Escalate instead of planning when a necessary answer cannot be inferred safely, the next step is destructive or credential-gated, required repository context is unavailable, or the user asks for behavior outside the non-goals.
</Advanced>

Original task:
{{PROMPT}}
