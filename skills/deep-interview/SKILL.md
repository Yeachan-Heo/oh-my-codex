---
name: deep-interview
description: Structured requirement interviews with depth control and transcript output
---

<Purpose>
Deep Interview runs a structured requirements interview before planning or implementation. It clarifies goals, scope, constraints, and success criteria so downstream work is grounded in explicit requirements.
</Purpose>

<Trigger_Keywords>
- "interview"
- "deep interview"
- "gather requirements"
</Trigger_Keywords>

<Use_When>
- Requirements are ambiguous or underspecified
- Stakeholders need alignment before PRD/planning
- You need explicit constraints, priorities, and validation criteria
</Use_When>

<Depth_Levels>
- **Quick**: 3-5 focused questions for rapid clarification (default for pre-PRD checks)
- **Standard**: 6-10 questions covering full planning inputs
- **Deep**: 12+ questions with scenario probing, edge cases, and risk exploration
</Depth_Levels>

<Workflow_Stages>
1. **Context gathering**: establish current system/task context and known facts
2. **Goal clarification**: define desired outcomes and success signals
3. **Scope**: identify in-scope/out-of-scope boundaries
4. **Constraints**: capture technical, timeline, compliance, and resource limits
5. **Validation**: confirm acceptance criteria, risks, and open questions
</Workflow_Stages>

<Cross_Platform_Tool_Abstraction>
Interactive question collection varies by runtime:
- **Codex CLI**: use `request_user_input` for structured multiple-choice questions
- **Claude Code**: use `AskUserQuestion` for equivalent structured prompts

When writing or maintaining this skill, preserve behavior parity across tools:
- Ask equivalent questions in the same stage order
- Keep option semantics aligned (recommended/default choices first)
- Record responses in a normalized transcript format regardless of tool
</Cross_Platform_Tool_Abstraction>

<Execution_Policy>
- Pick depth level from user intent (`--quick`, `--standard`, `--deep`)
- If no flag is provided, default to **Standard**
- Keep questions atomic and non-leading
- Summarize assumptions explicitly before closing
</Execution_Policy>

<Output_Contract>
After interview completion, write transcript/summary to:

`.omx/interviews/{slug}-{timestamp}.md`

Where:
- `slug` = short task slug (kebab-case)
- `timestamp` = UTC timestamp (e.g., `20260303T071500Z`)

Output must include:
- Interview metadata (date, depth, participants/context)
- Stage-by-stage Q&A summary
- Confirmed requirements
- Open questions / risks
- Recommended next step (e.g., proceed to PRD)
</Output_Contract>

Task: {{ARGUMENTS}}
