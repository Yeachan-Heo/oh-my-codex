---
name: ask-claude
description: Ask Claude directly via MCP
---

# Ask Claude

Use Claude as a direct external advisor for focused questions, reviews, or second opinions.

## Usage

```bash
/ask-claude <question or task>
```

## Routing

### Preferred: MCP Direct
Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools.
Use `mcp__c__ask_claude` with the user's request.

### Fallback
If Claude MCP is unavailable, explain that Claude MCP is not configured and continue with `mcp__x__ask_codex`.

Task: {{ARGUMENTS}}
