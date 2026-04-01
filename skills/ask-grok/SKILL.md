---
name: ask-grok
description: Ask Grok via local CLI and capture a reusable artifact
---

# Ask Grok (Local CLI)

Use the locally installed Grok CLI as a direct external advisor for brainstorming, design feedback, and second opinions.

## Usage

```bash
/ask-grok <question or task>
```

## Routing

### Preferred: Local CLI execution
Run Grok through the canonical OMX CLI command path (no MCP routing):

```bash
omx ask grok "{{ARGUMENTS}}"
```

Exact non-interactive Grok CLI command from `grok --help`:

```bash
grok -p "{{ARGUMENTS}}"
# equivalent: grok --prompt "{{ARGUMENTS}}"
```

If needed, adapt to the user's installed Grok CLI variant while keeping local execution as the default path.

### Missing binary behavior
If `grok` is not found, do **not** switch to MCP.
Instead:
1. Explain that local Grok CLI is required for this skill.
2. Ask the user to install/configure Grok CLI.
3. Provide a quick verification command:

```bash
grok --version
```

## Artifact requirement
After local execution, save a markdown artifact to:

```text
.omx/artifacts/grok-<slug>-<timestamp>.md
```

Minimum artifact sections:
1. Original user task
2. Final prompt sent to Grok CLI
3. Grok output (raw)
4. Concise summary
5. Action items / next steps

Task: {{ARGUMENTS}}
