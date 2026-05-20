---
name: prometheus-strict
description: "[OMX] Clean-room interview-driven planner: Metis clarifies, Momus challenges, Oracle synthesizes, then hands off to $ultragoal/$team."
argument-hint: "<goal or problem statement>"
---

# Prometheus Strict

Clean-room OMX planning workflow inspired by the high-level OMO Prometheus concept only. This skill does not copy implementation, prompts, wording, control flow, or runtime code from OMO. It reimplements the idea under this repository's MIT-licensed skill conventions.

Credit: Inspired by OMO Prometheus (`code-yeongyu/oh-my-openagent`), reimplemented from concept under MIT.

## Purpose

Use Prometheus Strict when the user needs a rigorous plan before execution and ambiguity is still risky. The workflow separates three planning voices:

1. **Metis** — interviews for hidden requirements, constraints, non-goals, and acceptance criteria.
2. **Momus** — attacks assumptions, scope creep, missing tests, and execution risks.
3. **Oracle** — synthesizes the clarified requirements and critique into an executable OMX-native plan.

The output is a handoff-ready plan for `$ultragoal` and, when parallel execution is warranted, `$team`. When a durable artifact is useful, write or request the plan under `.omx/plans/prometheus-strict/` using the output contract below. Prometheus Strict is a planning skill, not an implementation runtime.

## Use When

- The task is important enough that a shallow plan could produce wrong work.
- Requirements are partially known but acceptance criteria, boundaries, risks, or validation are incomplete.
- The user wants a strict interview before execution.
- A future `$ultragoal` story needs durable scope, tests, and handoff sequencing.
- A team split may be needed, but the lanes are not yet safe to assign.

## Do Not Use When

- The user asks for immediate implementation of a clear, low-risk change; use the normal executor path.
- The task is only a repository lookup or explanation; use `explore`/`analyze` as appropriate.
- The user needs adversarial execution QA after code changes; use `$ultraqa`.
- The user wants hook behavior, Sisyphus behavior, or a `start-work` port. Those are explicit non-goals.

## Non-Goals and Boundaries

- No hook implementation.
- No Sisyphus/start-work port.
- No automatic external-production actions.
- No direct code edits during the planning interview unless a separate execution workflow is explicitly started afterward.
- No copying from OMO sources; only the concept-level credit above is allowed.

## Required Inputs

- A user goal or problem statement.
- Any known constraints, deadline, target branch, risk tolerance, and validation expectations if already available.
- Repository context may be gathered read-only when needed to make the plan concrete.

If the user supplies too little information, Metis asks exactly one high-leverage question at a time until the plan can be safely drafted.

## Workflow

### 1. Intake and Safety Bounds

Restate the target result, known constraints, expected deliverables, validation expectations, and stop condition. Identify whether this is a planning-only turn or whether the user has also requested downstream execution.

If the prompt contains destructive, credential-gated, external-production, or materially scope-changing decisions, hold those decisions for explicit user confirmation. Otherwise, continue automatically through the planning loop.

### 2. Metis Interview

Use `prometheus-strict-metis` as the interview voice. When native subagents are available, invoke the dedicated agent; otherwise run the same role in-context without editing files.

Metis must discover:

- success criteria and measurable acceptance tests;
- hard constraints and explicit non-goals;
- current evidence versus assumptions;
- required artifacts and delivery path, including whether `.omx/plans/prometheus-strict/` should be created;
- likely owners/lanes if parallel work is needed;
- missing decisions that materially change scope or risk.

Ask one question per round when the answer is necessary. If the missing detail can be safely assumed, state the assumption and continue.

### 3. Momus Challenge

Use `prometheus-strict-momus` as the adversarial critique voice. When native subagents are available, invoke the dedicated agent; otherwise run the same role in-context without editing files.

Momus must challenge:

- underspecified acceptance criteria;
- hidden destructive or irreversible steps;
- overbroad scope and unnecessary dependencies;
- missing regression, lint, typecheck, build, or e2e evidence;
- ownership conflicts between worker lanes;
- handoff risks that would make `$ultragoal` or `$team` ambiguous.

Momus does not rewrite the plan alone. It produces objections and required fixes.

### 4. Oracle Synthesis

Use `prometheus-strict-oracle` as the synthesis voice. When native subagents are available, invoke the dedicated agent; otherwise run the same role in-context without editing files.

Oracle turns Metis + Momus outputs into a concise execution artifact:

- final objective;
- scope and non-goals;
- deliverables;
- assumptions accepted;
- implementation lanes, including which files or surfaces each lane owns;
- verification matrix;
- rollback/escalation conditions;
- recommended handoff command: `$ultragoal` for durable execution and `$team` only when parallel lanes are justified;
- artifact path: `.omx/plans/prometheus-strict/<slug>.md` when a durable plan file is warranted.

### 5. Handoff

Prometheus Strict stops with a plan unless the user explicitly invokes or authorizes the next workflow. Prefer this sequence:

```text
$ultragoal "<Oracle plan summary>"
$team <N>:executor "execute the approved Ultragoal story in parallel lanes"  # only when warranted
```

Do not start implementation from this skill by default.

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

Escalate instead of planning when:

- a necessary answer cannot be inferred safely;
- the next step is destructive, irreversible, credential-gated, or external-production;
- required repository context is unavailable;
- the user asks for behavior outside the non-goals.

When blocked, report the exact missing decision and the smallest safe question that would unblock planning.

## Task

{{ARGUMENTS}}
