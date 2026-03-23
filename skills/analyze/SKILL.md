---
name: analyze
description: "Run deep investigation of architecture, bugs, performance issues, or dependencies and return structured findings with file:line evidence. Use when a user says 'analyze', 'investigate', 'why does', 'what's causing', or needs root cause analysis before making changes. Routes to architect agent or Codex MCP for thorough cross-file reasoning."
---

<Purpose>
Analyze performs deep investigation of architecture, bugs, performance issues, and dependencies. It routes to the architect agent or Codex MCP for thorough analysis and returns structured findings with evidence.
</Purpose>

<Use_When>
- User says "analyze", "investigate", "debug", "why does", or "what's causing"
- User needs to understand a system's architecture or behavior before making changes
- User wants root cause analysis of a bug or performance issue
- User needs dependency analysis or impact assessment for a proposed change
- A complex question requires reading multiple files and reasoning across them
</Use_When>

<Do_Not_Use_When>
- User wants code changes made -- use executor agents or `ralph` instead
- User wants a full plan with acceptance criteria -- use `plan` skill instead
- User wants a quick file lookup or symbol search -- use `explore` agent instead
- User asks a simple factual question that can be answered from one file -- just read and answer directly
</Do_Not_Use_When>

<Why_This_Exists>
Deep investigation requires a different approach than quick lookups or code changes. Analysis tasks need broad context gathering, cross-file reasoning, and structured findings. Routing these to the architect agent or Codex ensures the right level of depth without the overhead of a full planning or execution workflow.
</Why_This_Exists>

<Execution_Policy>
- Prefer Codex MCP for analysis when available (faster, lower cost)
- Fall back to architect agent when Codex is unavailable
- Always provide context files to the analysis tool for grounded reasoning
- Return structured findings, not just raw observations
- Default to concise, evidence-dense progress and completion reporting unless the user or risk level requires more detail
- Treat newer user task updates as local overrides for the active workflow branch while preserving earlier non-conflicting constraints
- If correctness depends on additional inspection, retrieval, execution, or verification, keep using the relevant tools until the analysis is grounded
- Continue through clear, low-risk, reversible next steps automatically; ask only when the next step is materially branching, destructive, or preference-dependent
</Execution_Policy>

<Steps>
1. **Identify the analysis type**: Architecture, bug investigation, performance, or dependency analysis
2. **Gather relevant context**: Read or identify the key files involved
3. **Route to analyzer**:
   - Preferred: `ask_codex` with `agent_role: "architect"` and relevant `context_files`
   - Fallback: delegate to the `architect` role at THOROUGH tier with the analysis request
4. **Return structured findings**: Present the analysis with evidence, file references, and actionable recommendations
</Steps>

<Tool_Usage>
- Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools
- Use `ask_codex` with `agent_role: "architect"` as the preferred analysis route
- Pass `context_files` with all relevant source files for grounded analysis
- Use the `architect` role as fallback when ToolSearch finds no MCP tools or Codex is unavailable
- For broad analysis, use `explore` agent first to identify relevant files before routing to architect
</Tool_Usage>


## Scenario Examples

**Good:** The user says `continue` after the workflow already has a clear next step. Continue the current branch of work instead of restarting or re-asking the same question.

**Good:** The user changes only the output shape or downstream delivery step (for example `make a PR`). Preserve earlier non-conflicting workflow constraints and apply the update locally.

**Bad:** The user says `continue`, and the workflow restarts discovery or stops before the missing verification/evidence is gathered.

<Examples>
<Good>
User: "analyze why the WebSocket connections drop after 30 seconds"
Action: Gather WebSocket-related files, route to architect with context, return root cause analysis with specific file:line references and a recommended fix.
Why good: Clear investigation target, structured output with evidence.
</Good>

<Good>
User: "investigate the dependency chain from src/api/routes.ts"
Action: Use explore agent to map the import graph, then route to architect for impact analysis.
Why good: Uses explore for fact-gathering, architect for reasoning.
</Good>

<Bad>
User: "analyze the auth module"
Action: Returning "The auth module handles authentication."
Why bad: Shallow summary without investigation. Should examine the module's structure, patterns, potential issues, and provide specific findings with file references.
</Bad>

<Bad>
User: "fix the bug in the parser"
Action: Running analysis skill.
Why bad: This is a fix request, not an analysis request. Route to executor or ralph instead.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- If analysis reveals the issue requires code changes, report findings and recommend using `ralph` or executor for the fix
- If the analysis scope is too broad ("analyze everything"), ask the user to narrow the focus
- If Codex is unavailable and the architect agent also fails, report what context was gathered and suggest manual investigation paths
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Analysis addresses the specific question or investigation target
- [ ] Findings reference specific files and line numbers where applicable
- [ ] Root causes are identified (not just symptoms) for bug investigations
- [ ] Actionable recommendations are provided
- [ ] Analysis distinguishes between confirmed facts and hypotheses
</Final_Checklist>

Task: {{ARGUMENTS}}
