---
name: analyze
description: "Run deep investigation of architecture, bugs, performance issues, or dependencies and return structured findings with file:line evidence. Use when a user says 'analyze', 'investigate', 'why does', 'what's causing', or needs root cause analysis before making changes. Routes to architect agent or Codex MCP for thorough cross-file reasoning."
---

# Analyze — Evidence-Driven Investigation

Use this skill for ambiguous, causal, evidence-heavy questions where the goal is to explain **why** an observed result happened, not to jump directly into fixing or rewriting code.

## Good entry cases

Use `$analyze` when the problem is:

- ambiguous or causal
- evidence-heavy
- best answered by exploring competing explanations
- requires reading multiple files and reasoning across them

Examples:
- runtime bugs and regressions
- performance / latency / resource behavior
- architecture / premortem / postmortem analysis
- config / routing / orchestration behavior explanation
- dependency analysis or impact assessment
- "given this output, trace back the likely causes"

## Do not use when

- User wants code changes made — use `$ralph` or executor instead
- User wants a full plan with acceptance criteria — use `$plan` instead
- User wants a quick file lookup — use explore agent instead
- User asks a simple factual question answerable from one file — just read and answer

## Workflow posture

- Default to concise, evidence-dense progress and completion reporting unless the user or risk level requires more detail.
- Treat newer user task updates as local overrides for the active workflow branch while preserving earlier non-conflicting instructions.
- If the user says `continue`, resume from the highest-value unresolved hypothesis, gap, or discriminating probe instead of restarting the investigation.

## Core investigation contract

Always preserve these distinctions:

1. **Observation** — what was actually observed
2. **Hypotheses** — competing explanations
3. **Evidence For** — what supports each explanation
4. **Evidence Against / Gaps** — what contradicts it or is still missing
5. **Current Best Explanation** — the leading explanation right now
6. **Critical Unknown** — the missing fact keeping the top explanations apart
7. **Discriminating Probe** — the highest-value next step to collapse uncertainty

Do **not** collapse into:
- a generic fix-it coding loop
- a generic debugger summary
- a raw dump of output
- fake certainty when evidence is incomplete

## Evidence strength hierarchy

Treat evidence as ranked, not flat. From strongest to weakest:

1. **Controlled reproductions / direct experiments / uniquely discriminating artifacts**
2. **Primary source artifacts with tight provenance** (trace events, logs, metrics, configs, git history, file:line behavior)
3. **Multiple independent sources converging on the same explanation**
4. **Single-source code-path or behavioral inference**
5. **Weak circumstantial clues** (timing, naming, stack order, resemblance to prior bugs)
6. **Intuition / analogy / speculation**

Explicitly down-rank hypotheses that depend mostly on lower tiers when stronger contradictory evidence exists.

## Strong falsification rules

Every serious investigation must try to falsify its own favorite explanation.

For each top hypothesis:
- collect evidence **for** it
- collect evidence **against** it
- state what distinctive prediction it makes
- state what observation would be hard to reconcile with it
- identify the cheapest probe that would discriminate it from the next-best alternative

Down-rank a hypothesis when:
- direct evidence contradicts it
- it survives only by adding new unverified assumptions
- it makes no distinctive prediction compared with rivals
- a stronger alternative explains the same facts with fewer assumptions

## Team-mode orchestration (when using $team)

For complex investigations, use `$team` to run parallel tracer lanes:

1. Restate the observed result or "why" question precisely
2. Generate multiple deliberately different candidate hypotheses
3. Spawn **3 tracer lanes** via `$team`
4. Assign one lane per hypothesis
5. Each lane gathers evidence **for** and **against** its hypothesis
6. Run a **rebuttal round** between the leading hypothesis and the strongest alternative
7. Merge findings into a ranked synthesis

### Default hypothesis lanes

Unless the problem strongly suggests a better partition:

1. **Code-path / implementation cause**
2. **Config / environment / orchestration cause**
3. **Measurement / artifact / assumption mismatch cause**

### Worker contract

Each worker must:
- own exactly one hypothesis lane
- gather evidence **for** and **against** the lane
- rank evidence strength
- call out missing evidence and failed predictions
- name the **critical unknown** for the lane
- recommend the best **discriminating probe**
- avoid collapsing into implementation

### Cross-check lenses

After the initial evidence pass, pressure-test with these lenses when relevant:

- **Systems lens** — queues, retries, backpressure, feedback loops, upstream/downstream dependencies
- **Premortem lens** — assume the current best explanation is wrong; what failure mode would embarrass the trace later?
- **Science lens** — controls, confounders, measurement bias, falsifiable predictions

## Execution steps

1. **Identify the analysis type**: Architecture, bug investigation, performance, or dependency analysis
2. **Gather relevant context**: Read or identify the key files involved
3. **Generate hypotheses**: At least 2-3 competing explanations
4. **Route to analyzer**:
   - For simple cases: investigate directly with file reads and reasoning
   - For complex cases: use `$team` with tracer lanes
   - Use `ask_codex` with `agent_role: "architect"` when available
5. **Falsify**: Try to break your own best hypothesis
6. **Return structured findings**: Present with evidence, file references, and actionable recommendations

## Output format

### Observed Result
[What happened]

### Ranked Hypotheses
| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | ... | High / Medium / Low | Strong / Moderate / Weak | ... |

### Evidence Summary by Hypothesis
- Hypothesis 1: ...
- Hypothesis 2: ...

### Evidence Against / Missing Evidence
- Hypothesis 1: ...
- Hypothesis 2: ...

### Most Likely Explanation
[Current best explanation with file:line references]

### Critical Unknown
[Single missing fact keeping uncertainty open]

### Recommended Next Step
[Single best action — either a discriminating probe or a fix recommendation]

## Quality bar

Good analysis output is:
- evidence-backed with file:line references
- concise but rigorous
- skeptical of premature certainty
- explicit about missing evidence
- practical about the next action
- explicit about why weaker explanations were down-ranked

Task: {{ARGUMENTS}}
