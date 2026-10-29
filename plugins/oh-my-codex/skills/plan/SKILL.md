---
name: plan
description: Lightweight planning with optional interview
---

<Purpose>
Plan creates concise, actionable work plans. Auto-detects interview vs direct, supports `--interview` for Socratic clarification and `--review` for evaluation.
</Purpose>

<Use_When>
- Planning before implementation — "plan this", "let's plan"
- Requirements are vague and need scoping — use `--interview`
- Reviewing an existing plan — `--review`
</Use_When>

<Do_Not_Use_When>
- Want direct execution — execute the scoped task directly; use `ultragoal` only for durable goals or `team` for coordinated parallel work
- Simple focused fix with obvious scope — skip planning
</Do_Not_Use_When>

<Execution_Policy>
- Auto-detect interview vs direct; `--interview` forces Socratic mode, `--direct` skips it
- Ask one question at a time; gather codebase facts first
- `omx explore` is deprecated. Use normal repository inspection for codebase facts; `omx sparkshell` only for explicit shell-native evidence
- Plans must be evidence-backed: 80%+ claims cite file/line, 90%+ criteria testable
- Right-size steps to scope; save to `.omx/plans/`
</Execution_Policy>

<Steps>

### Mode Selection
| Mode | Trigger | Behavior |
|------|---------|----------|
| Interview | `--interview` or broad request | Socratic requirements gathering |
| Direct | `--direct` or detailed request | Generate plan immediately |
| Review | `--review` | Critic evaluation of existing plan |

### Interview (`--interview`)
1. Classify request; ask one focused question via `omx question`
2. Gather codebase facts first, then ask informed follow-ups
3. Build on answers; consult Analyst for hidden requirements
4. Create plan when user signals readiness

### Direct
1. Quick analysis (optional Analyst)
2. Generate plan immediately
3. Optional Critic review if requested

### Review (`--review`)
1. Read plan from `.omx/plans/`
2. Evaluate via Critic; verdict APPROVED/REVISE/REJECT
3. If author == reviewer, hand off to `$code-review`

### Output
Every plan includes: Requirements Summary, Acceptance Criteria (testable), Implementation Steps (with file refs, adaptive count), Risks/Mitigations, Verification. Saved to `.omx/plans/`.

Outcome-first framing: apply outcome-first framing, concise visible updates for multi-step planning. Local overrides for the active workflow branch apply via newer user task updates. If the user says `continue`, continue the current branch instead of restarting.

</Steps>

<Tool_Usage>
- `omx explore` is deprecated. Use normal repository inspection; `omx sparkshell` only for explicit shell-native evidence
- Use `omx question` for interview questions; plain text only as fallback
- Use `ask_codex` with `planner`/`analyst`/`critic` as needed
</Tool_Usage>

<Escalation_And_Stop_Conditions>
- Stop interviewing when requirements are clear — do not over-interview
- Escalate on irreconcilable trade-offs requiring business decision
- "just do it" / "skip planning" → hand off to `$ultragoal`
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Acceptance criteria testable (90%+ concrete)
- [ ] Claims cite file/line (80%+)
- [ ] Risks have mitigations, no vague terms
- [ ] Plan saved to `.omx/plans/`
</Final_Checklist>

<Advanced>
## Question Classification
| Type | Examples | Action |
|------|----------|--------|
| Codebase Fact | "Where is X?" | Explore first, do not ask |
| User Preference | "Priority?" | Ask via `omx question` |
| Scope Decision | "Include Y?" | Ask user |

## Review Quality Criteria
| Criterion | Standard |
|-----------|----------|
| Clarity | 80%+ claims cite file/line |
| Testability | 90%+ criteria concrete |
| Verification | File refs exist |
</Advanced>
