# Quality Gates Integration Report
## PR #3956 - Custom Quality Gates Implementation

### Executive Summary
Successfully integrated configurable quality gates into ralplan consensus planning, deep-interview specification stage, and code-review workflow. Gates can be configured per-stage in `.omx-config.json` with advisory (warning) or blocking (must-pass) enforcement modes.

### Integration Points & Call Sites

#### 1. CLI Command (`omx quality-gates list --stage <s>`)
**File:** `src/bin/quality-gates-cli.ts`
**Export:** `qualityGatesCommand(argv: string[], codexHomeOverride?: string): string` (Line 69)
**Call Sites:**
- Line 115: `getGatesForStage(options.stage, codexHomeOverride)`
- Line 116: `getAdvisoryGatesForStage(options.stage, codexHomeOverride)`
- Line 117: `getBlockingGatesForStage(options.stage, codexHomeOverride)`

**Dispatcher Integration:** `src/cli/index.ts:5279`
- Calls `qualityGatesCommand(args.slice(1))`
- Parses JSON response
- Sets `process.exitCode = 1` on error response

#### 2. Ralplan Runtime Integration
**Files:** `src/ralplan/runtime.ts`, `src/ralplan/runtime-contract.ts`, `src/quality-gates/plan-stage-wiring.ts`

**Runtime Call Sites:**
- `src/ralplan/runtime.ts:10` - Import `getPlanStageGates`
- `src/ralplan/runtime.ts:500` - Get configured plan-stage gates: `getPlanStageGates(cwd)`
- `src/ralplan/runtime.ts:503-504` - Invoke quality gate subagent: `executor.qualityGateReview({gate, draft, architectReview, criticReview, ...ctx})`

**Contract Additions:**
- `src/ralplan/runtime-contract.ts:52` - `RalplanQualityGateResult` interface for gate results
- `src/ralplan/runtime-contract.ts:68` - `qualityGateResults` field in `RalplanConsensusGate`
- `src/ralplan/runtime-contract.ts:78` - `gateResults` field in `RalplanConsensusIterationContext`
- `src/ralplan/runtime-contract.ts:89-94` - Optional `qualityGateReview()` method in `RalplanConsensusExecutor`

**Gate Wiring:**
- `src/quality-gates/plan-stage-wiring.ts:41` - `getPlanStageGates(cwd?: string)` returns plan-stage gates
- `src/quality-gates/plan-stage-wiring.ts:42` - Calls `getGatesForStage('plan', cwd)`

#### 3. Interview Stage Integration
**File:** `src/quality-gates/interview-stage-wiring.ts`
**Call Sites:**
- Line 38: `getInterviewStageGates()` → `getGatesForStage('interview')`
- Line 45: `getInterviewAdvisoryGates()` → `getAdvisoryGatesForStage('interview')`
- Line 52: `getInterviewBlockingGates()` → `getBlockingGatesForStage('interview')`

#### 4. Code Review Stage Integration
**File:** `src/quality-gates/code-review-stage-wiring.ts`
**Call Sites:**
- Line 44: `getCodeReviewGates()` → `getGatesForStage('codeReview')`
- Line 51: `getCodeReviewAdvisoryGates()` → `getAdvisoryGatesForStage('codeReview')`
- Line 58: `getCodeReviewBlockingGates()` → `getBlockingGatesForStage('codeReview')`

#### 5. Core Config API
**File:** `src/config/quality-gates.ts`
**Core Functions Consumed:**
- `getGatesForStage(stage, codexHomeOverride)` - Get all gates for a stage
- `getAdvisoryGatesForStage(stage, codexHomeOverride)` - Get advisory-mode gates only
- `getBlockingGatesForStage(stage, codexHomeOverride)` - Get blocking-mode gates only
- `readQualityGatesConfig(codexHomeOverride)` - Read from `.omx-config.json`
- `readValidatedQualityGates(stage, codexHomeOverride)` - Validate and return gates for stage

### Workflow Behavior

#### Plan Stage (Ralplan)
1. Planner creates draft and summary
2. Architect reviews (sequential, not parallel)
3. Critic reviews (sequential, after Architect)
4. **Custom quality gates executed** (after Critic approval):
   - Spawn each configured gate as native subagent
   - Advisory gates: recorded in receipt, do not block handoff
   - Blocking gates: must approve, failures trigger revision loop (max 5 iterations)
5. On gate approval + Critic approval → execution handoff

#### Interview Stage (Deep-Interview)
- After final-spec crystallization
- Spawn configured interview gates alongside standard readiness checks
- Advisory gates: recorded as residual risks
- Blocking gates: must approve before handoff; require spec refinement on failure

#### Code Review Stage
- After built-in code-reviewer and architect reviews
- Spawn configured code-review gates
- Advisory gates: recorded without blocking approval
- Blocking gates: force REQUEST CHANGES and prevent merge-ready status

### Configuration Example

```json
{
  "qualityGates": {
    "plan": [
      {
        "skill": "design-audit",
        "mode": "advisory"
      },
      {
        "skill": "security-audit",
        "mode": "blocking",
        "model": "claude-opus"
      }
    ],
    "interview": [
      {
        "skill": "requirements-validator",
        "mode": "blocking"
      }
    ],
    "codeReview": [
      {
        "skill": "performance-reviewer",
        "mode": "advisory"
      }
    ]
  }
}
```

### Files Changed

#### Core Integration
- `src/bin/quality-gates-cli.ts` (NEW) - CLI command implementation
- `src/cli/index.ts` - Added quality-gates command dispatcher
- `src/ralplan/runtime.ts` - Gate invocation loop after Critic
- `src/ralplan/runtime-contract.ts` - Gate result types and executor method
- `src/quality-gates/plan-stage-wiring.ts` - Added `cwd` parameter to `getPlanStageGates()`

#### Documentation
- `skills/ralplan/SKILL.md` - Added plan-stage gate documentation
- `skills/plan/SKILL.md` - Added consensus section with gate routing
- `skills/deep-interview/SKILL.md` - Added interview-stage gate documentation
- `skills/code-review/SKILL.md` - Added code-review gate documentation
- Plugin mirror equivalents synced: `plugins/oh-my-codex/skills/*/SKILL.md`

#### Tests
- `src/quality-gates/__tests__/integration.test.ts` (NEW) - Integration tests for CLI and ralplan

### Verification Checklist

- [x] CLI module returns pure JSON (no console I/O)
- [x] Dispatcher handles JSON parsing and exit codes
- [x] Ralplan runtime invokes gates after Critic approval
- [x] Blocking gates trigger revision loop (max 5 iterations)
- [x] Advisory gates recorded without blocking
- [x] TypeScript compilation successful
- [x] Existing ralplan runtime tests pass
- [x] Quality gates integration tests pass
- [x] Skill documentation updated (4 skills)
- [x] Plugin mirror synced

### Known Issues / Future Work

1. **Capabilities Lock**: Skill surface changes may require lock file regeneration in CI
2. **Native Executor Requirement**: `executor.qualityGateReview()` is optional but required for gate invocation (native subagent launch handled by executor host)
3. **Model Override Scope**: Custom gate model overrides apply only to that gate's subagent execution

### Testing Notes

- CLI smoke tests: Pass (Node 22 strip-types)
- Ralplan runtime tests: 15 tests pass
- Quality gates integration tests: Pass
- Full test suite: Pending CI verification
