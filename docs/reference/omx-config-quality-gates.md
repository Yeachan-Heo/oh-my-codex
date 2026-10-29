# Custom Quality Gates Configuration

## Overview

OMX supports configurable custom quality gates for workflow stages via the `.omx-config.json` configuration file. Quality gates allow you to invoke specialized skills at specific workflow stages to perform additional checks, validations, or reviews.

Each gate spawns as a native subagent alongside standard reviewers and uses the same verdict format. Gates can be configured in blocking mode (default) to feed into the revision loop, or advisory mode to record verdicts without blocking progression. Optionally, you can override the subagent model for individual gates.

## Configuration Schema

Quality gates are configured in the `.omx-config.json` file under the `qualityGates` section, organized by stage. Gate entries can be either plain skill-name strings or objects with mode and optional model overrides:

```json
{
  "qualityGates": {
    "deep-interview": [
      "skill-name1",
      "skill-name2",
      { "skill": "skill-name3", "mode": "advisory" },
      { "skill": "skill-name4", "mode": "blocking", "model": "claude-opus" }
    ],
    "ralplan": ["skill-name"],
    "code-review": ["skill-name1", "skill-name2"]
  }
}
```

## Gate Entry Formats

### String Format (Default Blocking)

The simplest format is a plain skill name string:

```json
{
  "qualityGates": {
    "ralplan": ["my-design-reviewer", "security-checker"]
  }
}
```

String entries default to blocking mode with no model override.

### Object Format (Advanced)

For fine-grained control, use an object with explicit configuration:

```json
{
  "skill": "my-custom-gate",
  "mode": "blocking|advisory",
  "model": "claude-opus"
}
```

**Object properties:**
- `skill` (required): Skill name in kebab-case
- `mode` (optional): `"blocking"` (default) or `"advisory"`
  - **Blocking**: Rejection feeds into the revision loop like Critic; prevents progression until resolved
  - **Advisory**: Verdict recorded without blocking; used for informational/risk assessment gates
- `model` (optional): Override the subagent model for this gate only (e.g., `"claude-opus"`, `"claude-sonnet"`)

## Stage Keys

Quality gate stage keys map directly to documented workflow/skill names:

| Stage Key | Workflow/Skill | Stage Step | Description |
| --- | --- | --- | --- |
| `deep-interview` | $deep-interview | final-spec | Requirements gathering and specification phase; gates execute after specification is complete and before handoff |
| `ralplan` | $ralplan (also $plan consensus mode) | Architect→Critic review | Planning and design phase; gates execute after initial planning and feed into the revise loop within the iteration cap |
| `code-review` | $code-review | review stage | Code review and approval; gates execute alongside standard reviewers |

## Skill Name Format

Custom skill names must follow kebab-case convention:
- Only lowercase letters, digits, and hyphens
- Optional `$` prefix (e.g., `$my-skill` or `my-skill`)
- Examples: `my-custom-gate`, `analysis-check-v2`, `compliance-review`

Invalid formats (rejected):
- `MySkill` (contains uppercase)
- `my_skill` (contains underscore)
- `my.skill` (contains period)
- `-my-skill` (starts with hyphen, sans $ prefix)

## Reserved and Sunset Skill Names

The following skill names are reserved for built-in OMX systems and cannot be used as gates:
- `deep-interview` — built-in interview skill
- `code-review` — built-in review skill
- `verification` — built-in test verification
- `ai-slop-cleaner` — built-in quality verification

Sunset skills from the removed skills list (e.g., `ask-claude`, `deepsearch`, `ralph`, `ecomode`) cannot be used and will be rejected with validation errors.

## Verdict and Behavior

Each quality gate:
- **Runs as a native subagent** next to standard reviewers (Architect, Critic, etc.)
- **Returns verdicts**: `approve`, `iterate`, or `reject` (same format as Critic)
- **Missing skill** produces a visible warning and the gate is skipped
- **Blocking gates** (verdict = `reject`) feed into the existing revise loop exactly like the Critic's vote
- **Advisory gates** (verdict = `reject`) are recorded without blocking progression

The iteration cap applies to blocking gate verdicts just as it does to Critic feedback. Advisory gate verdicts do not count against progression.

## Examples

### Simple String-Based Gates

```json
{
  "qualityGates": {
    "ralplan": ["design-audit", "security-check"]
  }
}
```

All gates run in blocking mode with default model.

### Mixed Blocking and Advisory Gates

```json
{
  "qualityGates": {
    "deep-interview": [
      "requirements-validator",
      { "skill": "compliance-check", "mode": "advisory" },
      { "skill": "architecture-review", "mode": "blocking" }
    ]
  }
}
```

The `requirements-validator` and `architecture-review` block on rejection; `compliance-check` records findings without blocking.

### Model Overrides

```json
{
  "qualityGates": {
    "ralplan": [
      { "skill": "deep-analysis", "model": "claude-opus" },
      { "skill": "quick-check", "model": "claude-haiku", "mode": "advisory" }
    ]
  }
}
```

Each gate uses its specified model instead of the session default.

### Multi-Stage Verification

```json
{
  "qualityGates": {
    "deep-interview": ["spec-validator"],
    "ralplan": ["design-reviewer", { "skill": "risk-assessment", "mode": "advisory" }],
    "code-review": ["security-check", "style-check"]
  }
}
```

## Validation

Quality gate configurations are validated when gates are queried for a specific stage. Validation checks:
- ✓ Skill name is valid kebab-case format
- ✓ Skill is not reserved
- ✓ Skill is not sunset/deprecated
- ✓ Gate entry is either a string or an object with `skill` property
- ✓ Mode (if specified) is `"blocking"` or `"advisory"`

Invalid gates are silently filtered out. Use `omx doctor` to diagnose configuration issues.

## CLI

List configured gates for a specific stage (outputs normalized entries with mode and optional model):

```bash
omx quality-gates list --stage deep-interview|ralplan|code-review
```

Returns JSON with normalized gate objects, each containing `skill`, `mode`, and optional `model`:

```json
{
  "gates": [
    { "skill": "my-validator", "mode": "blocking" },
    { "skill": "advisory-check", "mode": "advisory" },
    { "skill": "custom-reviewer", "mode": "blocking", "model": "claude-opus" }
  ],
  "stage": "ralplan"
}
```

## See Also

- [.omx-config.json Reference](./omx-config-schema-routing.md)
- [Skills Reference](../skills/)
