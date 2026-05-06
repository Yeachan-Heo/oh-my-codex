---
name: ask
description: Ask a local external advisor CLI (Claude or Gemini) and capture a reusable artifact
---

# Ask (Local Advisor CLI)

Use a locally installed external advisor CLI for focused questions, reviews, brainstorming, or second opinions. This skill replaces the separate `ask-claude` and `ask-gemini` skills.

## Usage

```bash
$ask claude <question or task>
$ask gemini <question or task>
omx ask claude "<question or task>"
omx ask gemini "<question or task>"
```

## Backend selection

- Use `claude` when the user asks for Claude, Anthropic, or the previous `$ask-claude` behavior.
- Use `gemini` when the user asks for Gemini or the previous `$ask-gemini` behavior.
- If no backend is specified, choose the installed backend that best matches the user request; if neither is clearly available, explain that a local CLI is required.

## Local CLI commands

Claude:

```bash
omx ask claude "{{ARGUMENTS}}"
claude -p "{{ARGUMENTS}}"
```

Gemini:

```bash
omx ask gemini "{{ARGUMENTS}}"
gemini -p "{{ARGUMENTS}}"
```

If needed, adapt to the user's installed CLI variant while keeping local execution as the default path. Do not silently switch to an MCP or remote provider when the local binary is missing.

## Artifact requirement

After local execution, save a markdown artifact to:

```text
.omx/artifacts/ask-<backend>-<slug>-<timestamp>.md
```

Minimum artifact sections:
1. Original user task
2. Backend and final prompt sent to the CLI
3. Raw CLI output
4. Concise summary
5. Action items / next steps

Task: {{ARGUMENTS}}
