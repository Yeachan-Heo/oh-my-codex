/**
 * Custom Quality Gates Configuration (Minimal)
 *
 * Supports configurable custom quality gates for workflow stages via .omx-config.json qualityGates property.
 * 
 * Schema:
 * {
 *   "qualityGates": {
 *     "deep-interview": ["skill-name", ...],
 *     "ralplan": ["skill-name", ...],
 *     "code-review": ["skill-name", ...]
 *   }
 * }
 *
 * Gates are native subagents that run alongside standard reviewers.
 * Missing skills produce visible warnings and are skipped.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { codexHome } from '../utils/paths.js';
import { REMOVED_SKILLS } from '../hooks/sunset-stub.js';

/**
 * Workflow stage where quality gates apply
 * - 'deep-interview': deep-interview final-spec stage
 * - 'ralplan': ralplan Architect→Critic review (consensus mode, also used by $plan)
 * - 'code-review': code-review stage
 */
export type QualityGateStage = 'deep-interview' | 'ralplan' | 'code-review';

/**
 * Quality gates configuration from .omx-config.json
 * Maps stage names to arrays of skill names (strings)
 */
export interface QualityGatesConfig {
  /** Quality gates for the deep-interview final-spec stage */
  'deep-interview'?: string[];
  /** Quality gates for the ralplan Architect→Critic review stage */
  'ralplan'?: string[];
  /** Quality gates for the code-review stage */
  'code-review'?: string[];
}

/**
 * Reserved skill names that cannot be used as gates
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
 * Get quality gates for a specific stage
 * Returns array of validated skill names
 */
export function getGatesForStage(stage: QualityGateStage, codexHomeOverride?: string): string[] {
  const config = readQualityGatesConfig(codexHomeOverride);
  const stageGates = config?.[stage];
  
  if (!stageGates || !Array.isArray(stageGates)) {
    return [];
  }

  // Filter to valid skill names
  return stageGates.filter((skill): skill is string => {
    return typeof skill === 'string' && validateSkillName(skill).valid;
  });
}

/**
 * Validate all gates in the configuration file
 * Returns validated gates and list of validation errors
 */
export function validateAllQualityGates(codexHomeOverride?: string): {
  gates: string[];
  errors: Array<{ stage: QualityGateStage; skillIndex: number; skill: string; error: string }>;
} {
  const gates: string[] = [];
  const errors: Array<{ stage: QualityGateStage; skillIndex: number; skill: string; error: string }> = [];

  const config = readQualityGatesConfig(codexHomeOverride);
  if (!config) {
    return { gates, errors };
  }

  const stages: QualityGateStage[] = ['deep-interview', 'ralplan', 'code-review'];
  for (const stage of stages) {
    const stageGates = config[stage];
    if (!stageGates || !Array.isArray(stageGates)) continue;

    for (let i = 0; i < stageGates.length; i++) {
      const skill = stageGates[i];
      if (typeof skill !== 'string') {
        errors.push({
          stage,
          skillIndex: i,
          skill: String(skill),
          error: 'Gate entry must be a string (skill name)',
        });
        continue;
      }

      const validation = validateSkillName(skill);
      if (validation.valid) {
        gates.push(skill);
      } else {
        errors.push({
          stage,
          skillIndex: i,
          skill,
          error: validation.error || 'Invalid skill',
        });
      }
    }
  }

  return { gates, errors };
}
