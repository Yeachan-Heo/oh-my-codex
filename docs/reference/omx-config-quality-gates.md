# Custom Quality Gates Configuration

## Overview

OMX supports configurable custom quality gates for workflow stages via the `.omx-config.json` configuration file. Quality gates allow you to invoke specialized skills at specific workflow stages to perform additional checks, validations, or reviews.

Each gate spawns as a native subagent alongside standard reviewers and uses the same verdict format.

## Configuration Schema

Quality gates are configured in the `.omx-config.json` file under the `qualityGates` section, organized by stage:

```json
{
  "qualityGates": {
    "deep-interview": ["skill-name1", "skill-name2"],
    "ralplan": ["skill-name"],
    "code-review": ["skill-name1", "skill-name2"]
  }
}
```

Gate entries are plain skill-name strings. Each gate runs as a native subagent during its stage.

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

The iteration cap applies to blocking gate verdicts just as it does to Critic feedback.

## Examples

### Single-Stage Gate

```json
{
  "qualityGates": {
    "code-review": ["my-security-check"]
  }
}
```

### Multi-Stage Verification

```json
{
  "qualityGates": {
    "deep-interview": ["my-spec-validator"],
    "ralplan": ["my-design-reviewer"],
    "code-review": ["my-security-check", "my-style-check"]
  }
}
```

## Validation

Quality gate configurations are validated when gates are queried for a specific stage. Validation checks:
- ✓ Skill name is valid kebab-case format
- ✓ Skill is not reserved
- ✓ Skill is not sunset/deprecated
- ✓ Gate entry is a non-empty string

Invalid gates are silently filtered out. Use `omx doctor` to diagnose configuration issues.

## CLI

List configured gates for a specific stage:

```bash
omx quality-gates list --stage deep-interview|ralplan|code-review
```

Returns JSON with the list of skill names for that stage.

## See Also

- [.omx-config.json Reference](./omx-config-schema-routing.md)
- [Skills Reference](../skills/)
