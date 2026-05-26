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
$ask antigravity <question or task>
omx ask claude "<question or task>"
omx ask gemini "<question or task>"
omx ask antigravity "<question or task>"
```

## Backend selection

- Use `claude` when the user asks for Claude, Anthropic, or the previous `$ask-claude` behavior.
- Use `gemini` when the user asks for Gemini or the previous `$ask-gemini` behavior.
- Use `antigravity` when the user asks for Antigravity/agy review through ACPX + agy-acp.
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

Antigravity:
```bash
omx ask antigravity "{{ARGUMENTS}}"
OMX_ANTIGRAVITY_MODEL_TIER=low omx ask antigravity "{{ARGUMENTS}}"
OMX_ANTIGRAVITY_MODEL_TIER=medium omx ask antigravity "{{ARGUMENTS}}"
OMX_ANTIGRAVITY_MODEL_TIER=high omx ask antigravity "{{ARGUMENTS}}"
OMX_ANTIGRAVITY_MODEL=low omx ask antigravity "{{ARGUMENTS}}"
OMX_ANTIGRAVITY_MODEL='gemini-3.5-flash (high)' omx ask antigravity "{{ARGUMENTS}}"
```

Antigravity model note: `agy` 1.0.2 has no documented hard `--model` CLI flag. `omx ask antigravity` defaults to requested model setting `gemini-3.5-flash (medium)`, infers `low|medium|high` model tier from task wording, and accepts `OMX_ANTIGRAVITY_MODEL`, `OMX_ANTIGRAVITY_MODEL_TIER`, `OMX_ANTIGRAVITY_MODEL_SETTING`, or `OMX_ANTIGRAVITY_PROFILE` as routing hints. Low/medium/high is treated as the model setting, not a separate effort knob. If a future `agy` adds hard model flags, pass them via `AGY_EXTRA_ARGS`. Antigravity defaults to long-running review timeouts (`AGY_TIMEOUT_SECONDS=900`, `OMX_ANTIGRAVITY_ACPX_TIMEOUT_SECONDS=960`) to avoid killing full frontend audits early; override these env vars for shorter or longer lanes.


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
