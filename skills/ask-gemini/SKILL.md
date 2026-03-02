---
name: ask-gemini
description: Ask Gemini directly via MCP
---

# Ask Gemini

Use Gemini as a direct external advisor for brainstorming, design feedback, and second opinions.

## Usage

```bash
/ask-gemini <question or task>
```

## Routing

### Preferred: MCP Direct
Before first MCP tool use, call `ToolSearch("mcp")` to discover deferred MCP tools.
Use `mcp__g__ask_gemini` with the user's request.

### Fallback
If Gemini MCP is unavailable, explain that Gemini MCP is not configured and continue with `mcp__x__ask_codex`.

Task: {{ARGUMENTS}}
