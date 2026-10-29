# Custom Quality Gates Configuration

## Overview

OMX supports configurable custom quality gates for workflow stages (interview, plan, code-review) via the `.omx-config.json` configuration file. Quality gates allow you to invoke specialized skills at specific workflow stages to perform additional checks, validations, or reviews.

Each gate spawns as a native subagent with the named skill, enabling real integration with OMX's skill system.

## Configuration Schema

Quality gates are configured in the `.omx-config.json` file under the `qualityGates` section, organized by stage:

```json
{
  "qualityGates": {
    "interview": [
      {
        "skill": "$deep-interview",
        "mode": "advisory",
        "model": "gpt-6-astra"
      }
    ],
    "plan": [
      {
        "skill": "$code-review",
        "mode": "blocking"
      }
    ],
    "codeReview": [
      {
        "skill": "$analyze",
        "mode": "advisory"
      }
    ]
  }
}
```

## Gate Properties

### Required Properties

| Property | Type | Description |
| --- | --- | --- |
| `skill` | string | Skill name to invoke for this gate (e.g., `$deep-interview`, `$code-review`, `$analyze`). Must be a valid, non-sunset skill name. Optionally prefixed with `$`. |
| `mode` | string | Gate enforcement mode: `advisory` (warning/recommendation) or `blocking` (must pass to proceed). |

### Optional Properties

| Property | Type | Description |
| --- | --- | --- |
| `model` | string | Model override for this gate's skill execution (e.g., `gpt-6-astra`). If omitted, uses configured defaults. |

## Gate Modes

### Advisory Gates

Advisory gates provide recommendations and findings without blocking workflow progression. They:
- Record verdicts in the stage receipt
- Inform stakeholders of findings
- Allow iteration to continue even if findings exist

### Blocking Gates

Blocking gates must pass or be resolved before proceeding. They:
- Record verdicts in the stage receipt
- Feed into the revise loop within the iteration cap
- Halt progression until resolved (or iteration cap exceeded)

## Workflow Stages

| Stage | Skill Integration | Description |
| --- | --- | --- |
| `interview` | $deep-interview final-spec stage | Requirements gathering and specification phase |
| `plan` | $plan/$ralplan Architect→Critic review | Planning and design phase |
| `codeReview` | $code-review stage | Code review and approval |

Each gate spawns as a subagent during its stage, running the specified skill alongside standard reviewers.

## Reserved and Sunset Skill Names

The following skill names are reserved for built-in OMX systems:
- `deep-interview` — built-in interview skill
- `code-review` — built-in review skill
- `verification` — built-in test verification
- `ai-slop-cleaner` — built-in quality verification

Sunset skills from the removed skills list (e.g., `ask-claude`, `deepsearch`, `ralph`, `ecomode`) cannot be used and will be rejected with validation errors.

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

## Missing Skill Handling

If a configured skill cannot be found:
- A visible warning is emitted
- The gate receipt records `gate_unavailable`
- The workflow continues (advisory gates) or offers remediation options (blocking gates)

## Validation

Quality gate configurations are validated when:
1. The `.omx-config.json` file is read
2. Gates are queried for a specific stage
3. Gate-related operations are executed

Validation checks:
- ✓ Skill name is valid kebab-case format
- ✓ Skill is not reserved
- ✓ Skill is not sunset/deprecated
- ✓ Mode is `advisory` or `blocking`
- ✓ Optional model is a non-empty string

Invalid gates are skipped with error reporting. Use `omx doctor` to diagnose configuration issues.

## Wiring Details

### Interview Stage (final-spec)

Gates configured for `interview` are invoked during the `$deep-interview` skill's final-spec stage, after specification is complete and before handoff. Each gate:
- Receives the final spec context
- Spawns as a subagent with the configured skill
- Records advisory findings or blocking verdicts in the stage receipt

### Plan Stage (Architect→Critic)

Gates configured for `plan` are invoked during `$plan` or `$ralplan` Architect→Critic review stage, after initial planning. Each gate:
- Receives the plan context
- Spawns as a subagent with the configured skill
- Records verdicts in the plan receipt
- Blocking gates feed into the revise loop within the iteration cap

### Code Review Stage

Gates configured for `codeReview` are invoked during the `$code-review` stage alongside standard reviewers. Each gate:
- Spawns as a subagent with the configured skill
- Records findings in the code review receipt
- Blocking verdicts halt approval until resolved

## Examples

### Security Review Gate

```json
{
  "qualityGates": {
    "codeReview": [
      {
        "skill": "$code-review",
        "mode": "blocking"
      }
    ]
  }
}
```

### Multi-Stage Verification

```json
{
  "qualityGates": {
    "interview": [
      {
        "skill": "$analyze",
        "mode": "advisory"
      }
    ],
    "plan": [
      {
        "skill": "$code-review",
        "mode": "blocking"
      }
    ],
    "codeReview": [
      {
        "skill": "$analyze",
        "mode": "advisory"
      }
    ]
  }
}
```

### Custom Model Override

```json
{
  "qualityGates": {
    "plan": [
      {
        "skill": "$analyze",
        "mode": "advisory",
        "model": "gpt-6-astra"
      }
    ]
  }
}
```

## See Also

- [.omx-config.json Reference](./omx-config-schema-routing.md)
- [Skills Reference](../skills/)
- [Quality Gate System Architecture](../architecture/quality-gates.md)
