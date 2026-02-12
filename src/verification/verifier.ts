/**
 * Verification Protocol for oh-my-codex
 *
 * Evidence-backed verification of task completion.
 * Sizing: small (haiku), standard (sonnet), large (opus)
 */

export interface VerificationResult {
  passed: boolean;
  evidence: VerificationEvidence[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface VerificationEvidence {
  type: 'test' | 'typecheck' | 'lint' | 'build' | 'manual' | 'runtime';
  passed: boolean;
  command?: string;
  output?: string;
  details?: string;
}

/**
 * Generate verification instructions for a given task size
 */
export function getVerificationInstructions(
  taskSize: 'small' | 'standard' | 'large',
  taskDescription: string
): string {
  const baseInstructions = `
## Verification Protocol

Verify the following task is complete: ${taskDescription}

### Required Evidence:
`;

  switch (taskSize) {
    case 'small':
      return baseInstructions + `
1. Run type checker on modified files (if TypeScript/typed language)
2. Run tests related to the change
3. Confirm the change works as described

Report: PASS/FAIL with evidence for each check.
`;

    case 'standard':
      return baseInstructions + `
1. Run full type check (tsc --noEmit or equivalent)
2. Run test suite (focus on changed areas)
3. Run linter on modified files
4. Verify the feature/fix works end-to-end
5. Check for regressions in related functionality

Report: PASS/FAIL with command output for each check.
`;

    case 'large':
      return baseInstructions + `
1. Run full type check across the project
2. Run complete test suite
3. Run linter across modified files
4. Security review of changes (OWASP top 10)
5. Performance impact assessment
6. API compatibility check (if applicable)
7. End-to-end verification of all affected features
8. Regression testing of adjacent functionality

Report: PASS/FAIL with detailed evidence for each check.
Include confidence level (high/medium/low) with justification.
`;
  }
}

/**
 * Determine task size from file count and line changes
 */
export function determineTaskSize(
  fileCount: number,
  lineChanges: number
): 'small' | 'standard' | 'large' {
  if (fileCount <= 3 && lineChanges < 100) return 'small';
  if (fileCount <= 15 && lineChanges < 500) return 'standard';
  return 'large';
}

/**
 * Generate the verification fix-loop instructions
 */
export function getFixLoopInstructions(maxRetries: number = 3): string {
  return `
## Fix-Verify Loop

If verification fails:
1. Identify the root cause of each failure
2. Fix the issue (prefer minimal changes)
3. Re-run verification
4. Repeat up to ${maxRetries} times
5. If still failing after ${maxRetries} attempts, escalate with:
   - What was attempted
   - What failed and why
   - Recommended next steps
`;
}
