/**
 * Pre-Execution Gate for oh-my-codex
 *
 * Enforces ralplan-first workflow: vague requests get redirected to planning,
 * and execution skills are blocked unless PRD Scope + Test Spec artifacts exist.
 *
 * In OMX, enforcement is split:
 *   1. AGENTS.md instructions (soft gate) — model is told to self-redirect vague prompts
 *   2. Artifact validation (hard gate) — called by notify-hook / team orchestrator
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface ExecutionArtifactValidation {
  ok: boolean;
  planPath: string | null;
  missing: string[];
  message: string;
}

const EXECUTION_SKILLS = new Set([
  'ralph',
  'autopilot',
  'team',
  'ultrawork',
  'pipeline',
  'ultrapilot',
  'swarm',
  'ecomode',
]);

export function isExecutionSkill(skillName: string | null | undefined): boolean {
  if (!skillName) return false;
  const normalized = skillName.replace(/^\$/, '').toLowerCase();
  return EXECUTION_SKILLS.has(normalized);
}

function getLatestPlanPath(root: string): string | null {
  const plansDir = join(root, '.omx', 'plans');
  if (!existsSync(plansDir)) return null;

  const candidates = readdirSync(plansDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const path = join(plansDir, name);
      const mtime = statSync(path).mtimeMs;
      return { path, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return candidates[0]?.path ?? null;
}

export function validateExecutionArtifacts(root: string): ExecutionArtifactValidation {
  const planPath = getLatestPlanPath(root);
  if (!planPath) {
    return {
      ok: false,
      planPath: null,
      missing: ['plan file in .omx/plans/*.md', '## PRD Scope section', '## Test Spec section'],
      message:
        '[PRE-EXECUTION GATE] Execution blocked. No approved plan artifacts found. Run $ralplan first and produce PRD Scope + Test Spec.',
    };
  }

  const content = readFileSync(planPath, 'utf-8');
  const missing: string[] = [];

  if (!/^##\s+PRD\s+Scope\b/im.test(content)) {
    missing.push('## PRD Scope section');
  }

  if (!/^##\s+Test\s+Spec(?:ification)?\b/im.test(content)) {
    missing.push('## Test Spec section');
  }

  if (missing.length > 0) {
    return {
      ok: false,
      planPath,
      missing,
      message:
        `[PRE-EXECUTION GATE] Execution blocked. Missing required artifacts in ${planPath}: ${missing.join(', ')}. ` +
        'Update the plan via $ralplan before execution handoff.',
    };
  }

  return {
    ok: true,
    planPath,
    missing: [],
    message: `[PRE-EXECUTION GATE] Artifacts verified: ${planPath}`,
  };
}

/**
 * Generate the AGENTS.md section that instructs the model to enforce the gate.
 * This is the "soft" gate — the model self-enforces based on instructions.
 */
export function generatePreExecutionGateSection(): string {
  return `
<pre_execution_gate>
## Pre-Execution Gate (MANDATORY)

Before activating ANY execution skill ($ralph, $autopilot, $team, $ultrawork, $ecomode),
you MUST verify that planning artifacts exist:

1. **Vague request check**: If the user's request is underspecified (fewer than 7 words,
   no file/module/API references, no concrete scope), REDIRECT to \`$ralplan\` first.
   Do NOT start execution. Say: "This request needs planning first. Starting ralplan..."

2. **Artifact check**: Before invoking any execution skill, verify that the latest
   plan file in \`.omx/plans/*.md\` contains BOTH:
   - \`## PRD Scope\` — explicit in-scope / out-of-scope boundaries
   - \`## Test Spec\` — unit/integration/e2e strategy

   If either is missing, say: "Missing required plan artifacts. Run $ralplan first."

3. **Exceptions**: Direct \`$cancel\`, \`$analyze\`, \`$deepsearch\`, \`$plan\`, \`$ralplan\`
   do NOT require artifacts. Only execution/implementation modes are gated.

Good prompt (execution-ready):
  "Implement OAuth callback in src/auth/callback.ts with unit + integration tests"

Bad prompt (needs ralplan first):
  "fix it" / "make this better" / "do the thing"
</pre_execution_gate>
`;
}
