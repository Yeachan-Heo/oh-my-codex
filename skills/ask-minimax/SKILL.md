---
name: ask-minimax
description: Ask MiniMax M2.7 via OpenAI-compatible API and capture a reusable artifact
---

# Ask MiniMax (API)

Use the MiniMax API as a direct external advisor for focused questions, reviews, or second opinions.
Unlike Claude and Gemini providers, MiniMax requires no local CLI binary — it calls the MiniMax
OpenAI-compatible HTTP API directly.

## Usage

```bash
/ask-minimax <question or task>
```

## Requirements

Set the `MINIMAX_API_KEY` environment variable before invoking:

```bash
export MINIMAX_API_KEY=your_api_key_here
```

Optional environment overrides:

| Variable | Default | Description |
|---|---|---|
| `MINIMAX_API_KEY` | *(required)* | MiniMax API key |
| `MINIMAX_BASE_URL` | `https://api.minimax.io/v1` | API base URL |
| `MINIMAX_MODEL` | `MiniMax-M2.7` | Model name |

## Routing

### Preferred: OMX CLI execution

Run MiniMax through the canonical OMX CLI command path:

```bash
omx ask minimax "{{ARGUMENTS}}"
```

This calls the MiniMax `/v1/chat/completions` endpoint directly via `fetch` (no CLI binary needed).

### Missing API key behavior

If `MINIMAX_API_KEY` is not set, do **not** fall back to another provider.
Instead:
1. Explain that `MINIMAX_API_KEY` is required for this skill.
2. Ask the user to set the environment variable.
3. Provide a quick verification command:

```bash
omx ask minimax "hello" # should work once MINIMAX_API_KEY is set
```

## Artifact requirement

After execution, an artifact is saved to:

```text
.omx/artifacts/minimax-<slug>-<timestamp>.md
```

Minimum artifact sections:
1. Original user task
2. Final prompt sent to MiniMax API
3. MiniMax output (raw)
4. Concise summary
5. Action items / next steps

Task: {{ARGUMENTS}}
