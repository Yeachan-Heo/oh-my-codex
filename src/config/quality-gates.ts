/**
 * Custom Quality Gates Configuration
 *
 * Supports configurable custom quality gates for interview, plan, and code-review stages
 * via .omx-config.json qualityGates property.
 * 
 * Schema:
 * {
 *   "qualityGates": {
 *     "interview": [{"skill": "...", "mode": "advisory|blocking", "model": "..." }],
 *     "plan": [...],
 *     "codeReview": [...]
 *   }
 * }
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { codexHome } from '../utils/paths.js';
import { REMOVED_SKILLS } from '../hooks/sunset-stub.js';

/**
 * Quality gate enforcement mode
 */
export type QualityGateMode = 'advisory' | 'blocking';

/**
 * Workflow stage where quality gates apply
 */
export type QualityGateStage = 'interview' | 'plan' | 'codeReview';

/**
 * Quality gate definition
 */
export interface QualityGate {
  /** Skill name to invoke for this gate (e.g., "deep-interview", "code-review") */
  skill: string;
  /** Gate enforcement mode: advisory (warning) or blocking (must pass) */
  mode: QualityGateMode;
  /** Optional model override for this gate */
  model?: string;
}

/**
 * Quality gates configuration from .omx-config.json
 * Maps stage names to arrays of quality gates
 */
export interface QualityGatesConfig {
  /** Quality gates for the interview/spec stage */
  interview?: QualityGate[];
  /** Quality gates for the plan/design stage */
  plan?: QualityGate[];
  /** Quality gates for the code-review stage */
  codeReview?: QualityGate[];
}

/**
 * Reserved skill names that cannot be customized
 * These are built-in skills managed by OMX
 */
const RESERVED_SKILL_NAMES = new Set([
  'ai-slop-cleaner',
  'verification',
  'code-review',
  'deep-interview',
]);

/**
 * Sunset/deprecated skill names from sunset-stub.ts
 * These skills are no longer supported and should not be used
 */
function getSunsetSkillNames(): Set<string> {
  return new Set(Object.keys(REMOVED_SKILLS).map(k => k.toLowerCase()));
}

/**
 * Validate skill name: must be kebab-case, not reserved, not sunset
 */
export function validateSkillName(skill: string): { valid: boolean; error?: string } {
  if (!skill || typeof skill !== 'string') {
    return { valid: false, error: 'Skill name must be a non-empty string' };
  }

  // Check kebab-case format (including leading $ for skill references)
  const normalized = skill.startsWith('$') ? skill.slice(1) : skill;
  if (!normalized || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    return { valid: false, error: 'Skill name must be kebab-case (lowercase with hyphens), optionally prefixed with $' };
  }

  // Check reserved names
  if (RESERVED_SKILL_NAMES.has(normalized)) {
    return { valid: false, error: `Skill "${skill}" is reserved for built-in gates` };
  }

  // Check sunset names
  const sunsetNames = getSunsetSkillNames();
  if (sunsetNames.has(normalized.toLowerCase())) {
    return { valid: false, error: `Skill "${skill}" is deprecated and no longer supported` };
  }

  return { valid: true };
}

/**
 * Validate quality gate
 */
export function validateQualityGate(gate: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!gate || typeof gate !== 'object') {
    errors.push('Quality gate must be an object');
    return { valid: false, errors };
  }

  const g = gate as Record<string, unknown>;

  // Validate skill
  if (!g.skill || typeof g.skill !== 'string') {
    errors.push('Gate must have a non-empty "skill" property (string)');
  } else {
    const skillResult = validateSkillName(g.skill);
    if (!skillResult.valid) {
      errors.push(`Invalid skill: ${skillResult.error}`);
    }
  }

  // Validate mode
  if (!g.mode || (g.mode !== 'advisory' && g.mode !== 'blocking')) {
    errors.push('Gate must have "mode" property with value "advisory" or "blocking"');
  }

  // Validate optional model
  if (g.model !== undefined) {
    if (!g.model || typeof g.model !== 'string') {
      errors.push('Optional "model" property must be a non-empty string');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Read quality gates configuration from .omx-config.json
 */
export function readQualityGatesConfig(codexHomeOverride?: string): QualityGatesConfig | null {
  const configPath = join(codexHomeOverride || codexHome(), '.omx-config.json');
  if (!existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const qualityGates = raw.qualityGates;
    if (!qualityGates || typeof qualityGates !== 'object' || Array.isArray(qualityGates)) {
      return null;
    }

    return qualityGates as QualityGatesConfig;
  } catch {
    return null;
  }
}

/**
 * Read and validate quality gates from configuration for a specific stage
 */
export function readValidatedQualityGates(stage: QualityGateStage, codexHomeOverride?: string): {
  gates: QualityGate[];
  errors: Array<{ gateIndex: number; errors: string[] }>;
} {
  const config = readQualityGatesConfig(codexHomeOverride);
  const gates: QualityGate[] = [];
  const errors: Array<{ gateIndex: number; errors: string[] }> = [];

  const stageGates = config?.[stage];
  if (!stageGates || !Array.isArray(stageGates)) {
    return { gates, errors };
  }

  for (let i = 0; i < stageGates.length; i++) {
    const result = validateQualityGate(stageGates[i]);
    if (result.valid) {
      gates.push(stageGates[i] as QualityGate);
    } else {
      errors.push({ gateIndex: i, errors: result.errors });
    }
  }

  return { gates, errors };
}

/**
 * Get quality gates for a specific stage
 */
export function getGatesForStage(stage: QualityGateStage, codexHomeOverride?: string): QualityGate[] {
  const { gates } = readValidatedQualityGates(stage, codexHomeOverride);
  return gates;
}

/**
 * Get advisory gates for a specific stage
 */
export function getAdvisoryGatesForStage(stage: QualityGateStage, codexHomeOverride?: string): QualityGate[] {
  return getGatesForStage(stage, codexHomeOverride).filter((gate) => gate.mode === 'advisory');
}

/**
 * Get blocking gates for a specific stage
 */
export function getBlockingGatesForStage(stage: QualityGateStage, codexHomeOverride?: string): QualityGate[] {
  return getGatesForStage(stage, codexHomeOverride).filter((gate) => gate.mode === 'blocking');
}

/**
 * Validate all gates in the configuration file
 */
export function validateAllQualityGates(codexHomeOverride?: string): {
  gates: QualityGate[];
  errors: Array<{ stage: QualityGateStage; gateIndex: number; errors: string[] }>;
} {
  const gates: QualityGate[] = [];
  const errors: Array<{ stage: QualityGateStage; gateIndex: number; errors: string[] }> = [];

  const stages: QualityGateStage[] = ['interview', 'plan', 'codeReview'];
  for (const stage of stages) {
    const { gates: stageGates, errors: stageErrors } = readValidatedQualityGates(stage, codexHomeOverride);
    gates.push(...stageGates);
    for (const err of stageErrors) {
      errors.push({ stage, gateIndex: err.gateIndex, errors: err.errors });
    }
  }

  return { gates, errors };
}
