# Custom Quality Gates Configuration

## Overview

OMX supports configurable custom quality gates for workflow stages (interview, plan, code-review) via the `.omx-config.json` configuration file. Custom quality gates allow you to enforce additional checks and requirements at specific points in the workflow.

## Configuration Schema

Quality gates are configured in the `.omx-config.json` file under the `qualityGates` section:

```json
{
  "qualityGates": {
    "gates": [
      {
        "name": "my-custom-gate",
        "label": "My Custom Quality Gate",
        "level": "advisory",
        "stages": ["interview", "plan"],
        "description": "Verifies custom requirements",
        "skill": "my-custom-skill"
      }
    ]
  }
}
```

## Gate Properties

### Required Properties

| Property | Type | Description |
| --- | --- | --- |
| `name` | string | Unique gate identifier in kebab-case (e.g., `my-gate`, `custom-check-v2`). Must be lowercase alphanumeric with hyphens. Cannot be a reserved or sunset name. |
| `label` | string | Human-readable label for the gate (e.g., `"My Custom Quality Gate"`). |
| `level` | string | Gate enforcement level: `advisory` (warning/recommendation) or `blocking` (must pass to proceed). |
| `stages` | string[] | Array of workflow stages where this gate applies. Valid values: `interview`, `plan`, `codeReview`. Must be non-empty. |

### Optional Properties

| Property | Type | Description |
| --- | --- | --- |
| `description` | string | Detailed description of what this gate verifies. |
| `skill` | string | Associated OMX skill name that can help resolve gate failures. |

## Gate Levels

### Advisory Gates
Advisory gates provide recommendations and warnings but do not block workflow progression. They are useful for:
- Suggesting best practices
- Highlighting potential issues for review
- Informing stakeholders of quality metrics

### Blocking Gates
Blocking gates must be satisfied before proceeding. They are enforced for:
- Critical requirements
- Compliance and safety checks
- Mandatory verification steps

## Workflow Stages

| Stage | Description |
| --- | --- |
| `interview` | Initial requirements and specification gathering |
| `plan` | Planning and design phase |
| `codeReview` | Code review and approval stage |

A gate can apply to multiple stages. For example, a gate can be configured to check both interview and plan stages.

## Reserved Gate Names

The following gate names are reserved for built-in OMX quality gates and cannot be customized:

- `ai-slop-cleaner` — AI content quality verification
- `verification` — Test and verification checks
- `code-review` — Code review approval
- `architecture-invariant-gate` — Architecture/domain invariant verification

Attempting to define custom gates with reserved names will result in a validation error.

## Sunset/Deprecated Gate Names

The following gate names are deprecated and no longer supported:

- `legacy-review` — Replaced by code-review
- `deprecated-lint` — Use verification instead
- `obsolete-test` — Use verification instead

Attempting to use sunset names will result in a validation error.

## Gate Name Format

Custom gate names must follow kebab-case convention:
- Only lowercase letters, digits, and hyphens
- Must start with a letter or digit
- Must end with a letter or digit
- Examples: `my-gate`, `custom-check-v2`, `compliance-check`

Invalid formats (rejected):
- `MyGate` (contains uppercase)
- `my_gate` (contains underscore)
- `my.gate` (contains period)
- `-my-gate` (starts with hyphen)
- `my-gate-` (ends with hyphen)

## Configuration Examples

### Single Advisory Gate

```json
{
  "qualityGates": {
    "gates": [
      {
        "name": "performance-check",
        "label": "Performance Benchmark",
        "level": "advisory",
        "stages": ["interview"],
        "description": "Validates performance assumptions are documented"
      }
    ]
  }
}
```

### Blocking Gate for Multiple Stages

```json
{
  "qualityGates": {
    "gates": [
      {
        "name": "security-scan",
        "label": "Security Vulnerability Scan",
        "level": "blocking",
        "stages": ["plan", "codeReview"],
        "description": "Ensures no known vulnerabilities in dependencies",
        "skill": "security-audit"
      }
    ]
  }
}
```

### Multiple Gates

```json
{
  "qualityGates": {
    "gates": [
      {
        "name": "accessibility-audit",
        "label": "Accessibility Compliance",
        "level": "advisory",
        "stages": ["codeReview"],
        "skill": "a11y-audit"
      },
      {
        "name": "documentation-check",
        "label": "Documentation Coverage",
        "level": "blocking",
        "stages": ["interview", "plan"],
        "description": "Verifies API documentation is complete"
      },
      {
        "name": "test-coverage",
        "label": "Test Coverage Threshold",
        "level": "blocking",
        "stages": ["codeReview"],
        "skill": "coverage-analyzer"
      }
    ]
  }
}
```

## Validation

Quality gate configurations are validated when:
1. The `.omx-config.json` file is read
2. Gates are queried for a specific stage
3. Gate-related operations are executed

Validation checks:
- ✓ Gate name is valid kebab-case format
- ✓ Gate name is not reserved
- ✓ Gate name is not sunset/deprecated
- ✓ All required properties are present
- ✓ Level is `advisory` or `blocking`
- ✓ Stages array is non-empty
- ✓ Each stage is valid (`interview`, `plan`, or `codeReview`)
- ✓ Optional skill property is a non-empty string if provided

Invalid gates are skipped with error reporting. Use `omx doctor` to diagnose configuration issues.

## Implementation Status

This feature supports:
- ✓ Reading custom quality gates from configuration
- ✓ Validation of gate definitions
- ✓ Stage-based gate filtering
- ✓ Advisory and blocking levels
- ✓ Optional skill references

## See Also

- [.omx-config.json Reference](./omx-config-schema-routing.md)
- [Quality Gate System Architecture](../architecture/quality-gates.md)
