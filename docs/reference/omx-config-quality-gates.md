# Custom Quality Gates Configuration

## Overview

OMX supports configurable custom quality gates for workflow stages via the `.omx-config.json` configuration file. Quality gates allow you to invoke specialized skills at specific workflow stages to perform additional checks, validations, or reviews.

Each gate runs as a separate native subagent at its owning workflow's stage and uses the same verdict format. Gates can be configured in blocking mode (default) to feed non-approving verdicts into the revision loop, or advisory mode to record verdicts without independently blocking progression. Availability handling differs between skill guidance and the current Ralplan runtime; see [Verdict and Behavior](#verdict-and-behavior). Optionally, you can override the subagent model for individual gates.

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
  - **Blocking**: `iterate` or `reject` feeds into the revision loop like Critic; see [Verdict and Behavior](#verdict-and-behavior) for unavailable-gate handling
  - **Advisory**: Verdict recorded without blocking; used for informational/risk assessment gates
- `model` (optional): Override the subagent model for this gate only (e.g., `"claude-opus"`, `"claude-sonnet"`)

## Stage Keys

Quality gate stage keys map directly to documented workflow/skill names:

| Stage Key | Workflow/Skill | Stage Step | Description |
| --- | --- | --- | --- |
| `deep-interview` | $deep-interview | final-spec | Requirements gathering and specification phase; gates execute after specification is complete and before handoff |
| `ralplan` | $ralplan | Architect→Critic review | Consensus planning phase; gates execute after Critic review and feed into the revise loop within the iteration cap. Lightweight $plan modes do not run this stage. |
| `code-review` | $code-review | review stage | Code review and approval; gates execute after the built-in independent reviews |

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
- **Runs as a separate native subagent** at the owning workflow's documented stage: after the final specification for Deep Interview, after Critic review for Ralplan, and after the built-in independent reviews for Code Review. Custom gates supplement required reviewers.
- **Returns reviewer verdicts**: `approve`, `iterate`, or `reject` (same format as Critic). Ralplan records `unavailable` when its executor cannot provide a valid native review.
- **Unavailable reviews** are distinct from approving evidence; their effect on progression depends on the owning guidance or runtime described below.
- **Blocking gates** with `iterate` or `reject` enter the owning workflow's revise loop where supported.
- **Advisory gates** record non-approving or unavailable results without independently blocking progression.

The quality-gate listing/configuration surface discovers and normalizes configuration. It does not run reviewers or enforce stage completion. Skill instructions and executable behavior currently differ for unavailable Ralplan gates:

| Surface | Unavailable blocking gate |
| --- | --- |
| [Deep Interview](../../skills/deep-interview/SKILL.md) and [Code Review](../../skills/code-review/SKILL.md) skill guidance | Requires blocking evidence to approve; unavailable evidence prevents readiness or handoff. |
| [Ralplan skill guidance](../../skills/ralplan/SKILL.md) | Also requires fail-closed handling before handoff. |
| [Current Ralplan runtime](../../src/ralplan/runtime.ts) | Records `unavailable` and skips it, including in blocking mode. Consensus can complete when the other consensus requirements pass. |

Ralplan catches missing/failed executors or invalid native-review results as `unavailable`, then marks its configured gate-review loop complete. Its [quality-gate verdict tests](../../src/ralplan/__tests__/runtime.test.ts) explicitly expect an unavailable blocking gate not to block consensus. Blocking `iterate` or `reject` results still enter the revise loop within the iteration cap; advisory results and skipped unavailable results do not independently require another iteration.

**Known guidance/runtime mismatch:** the current Ralplan runtime does not enforce its skill's fail-closed requirement for unavailable gates. A completed consensus receipt alone does not prove that every configured blocking gate returned approving evidence. A fail-closed runtime policy needs maintainer confirmation and corresponding runtime/test changes.

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
