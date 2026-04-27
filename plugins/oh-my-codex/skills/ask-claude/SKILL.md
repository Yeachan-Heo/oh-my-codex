---
name: ask-claude
description: Ask Claude via local CLI and capture a reusable artifact
---

# Ask Claude (Local CLI)

Use the locally installed Claude CLI as a direct external advisor for focused questions, reviews, or second opinions.

## Usage

```bash
/ask-claude <question or task>
```

## Routing

### Preferred: Local CLI execution
Run Claude through the canonical OMX CLI command path (no MCP routing):

```bash
omx ask claude "{{ARGUMENTS}}"
```

Exact non-interactive Claude CLI command from `claude --help`:

```bash
claude -p "{{ARGUMENTS}}"
# equivalent: claude --print "{{ARGUMENTS}}"
```

If needed, adapt to the user's installed Claude CLI variant while keeping local execution as the default path.

Legacy compatibility entrypoints (`./scripts/ask-claude.sh`, `npm run ask:claude -- ...`) are transitional wrappers.

### Missing binary behavior
If `claude` is not found, do **not** switch to MCP.
Instead:
1. Explain that local Claude CLI is required for this skill.
2. Ask the user to install/configure Claude CLI.
3. Provide a quick verification command:

```bash
claude --version
```

## Artifact requirement
After local execution, save a markdown artifact to:

```text
.omx/artifacts/claude-<slug>-<timestamp>.md
```

Minimum artifact sections:
1. Original user task
2. Final prompt sent to Claude CLI
3. Claude output (raw)
4. Concise summary
5. Action items / next steps

Task: {{ARGUMENTS}}
