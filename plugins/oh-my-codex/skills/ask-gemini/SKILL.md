---
name: ask-gemini
description: Ask Gemini via local CLI and capture a reusable artifact
---

# Ask Gemini (Local CLI)

Use the locally installed Gemini CLI as a direct external advisor for brainstorming, design feedback, and second opinions.

## Usage

```bash
/ask-gemini <question or task>
```

## Routing

### Preferred: Local CLI execution
Run Gemini through the canonical OMX CLI command path (no MCP routing):

```bash
omx ask gemini "{{ARGUMENTS}}"
```

Exact non-interactive Gemini CLI command from `gemini --help`:

```bash
gemini -p "{{ARGUMENTS}}"
# equivalent: gemini --prompt "{{ARGUMENTS}}"
```

If needed, adapt to the user's installed Gemini CLI variant while keeping local execution as the default path.

Legacy compatibility entrypoints (`./scripts/ask-gemini.sh`, `npm run ask:gemini -- ...`) are transitional wrappers.

### Missing binary behavior
If `gemini` is not found, do **not** switch to MCP.
Instead:
1. Explain that local Gemini CLI is required for this skill.
2. Ask the user to install/configure Gemini CLI.
3. Provide a quick verification command:

```bash
gemini --version
```

## Artifact requirement
After local execution, save a markdown artifact to:

```text
.omx/artifacts/gemini-<slug>-<timestamp>.md
```

Minimum artifact sections:
1. Original user task
2. Final prompt sent to Gemini CLI
3. Gemini output (raw)
4. Concise summary
5. Action items / next steps

Task: {{ARGUMENTS}}
