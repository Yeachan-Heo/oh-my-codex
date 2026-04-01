---
name: ask-qwen
description: Ask Qwen via local CLI and capture a reusable artifact
---

# Ask Qwen (Local CLI)

Use the locally installed Qwen CLI as a direct external advisor for brainstorming, design feedback, and second opinions.

## Usage

```bash
/ask-qwen <question or task>
```

## Routing

### Preferred: Local CLI execution
Run Qwen through the canonical OMX CLI command path (no MCP routing):

```bash
omx ask qwen "{{ARGUMENTS}}"
```

Exact non-interactive Qwen CLI command from `qwen --help`:

```bash
qwen -p "{{ARGUMENTS}}"
# equivalent: qwen --prompt "{{ARGUMENTS}}"
```

If needed, adapt to the user's installed Qwen CLI variant while keeping local execution as the default path.

Legacy compatibility entrypoints (`./scripts/ask-qwen.sh`, `npm run ask:qwen -- ...`) are transitional wrappers.

### Missing binary behavior
If `qwen` is not found, do **not** switch to MCP.
Instead:
1. Explain that local Qwen CLI is required for this skill.
2. Ask the user to install/configure Qwen CLI.
3. Provide a quick verification command:

```bash
qwen --version
```

## Artifact requirement
After local execution, save a markdown artifact to:

```text
.omx/artifacts/qwen-<slug>-<timestamp>.md
```

Minimum artifact sections:
1. Original user task
2. Final prompt sent to Qwen CLI
3. Qwen output (raw)
4. Concise summary
5. Action items / next steps

Task: {{ARGUMENTS}}
