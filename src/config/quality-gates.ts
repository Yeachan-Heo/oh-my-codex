/**
 * Custom Quality Gates Configuration (Minimal)
 *
 * Supports configurable custom quality gates for workflow stages via .omx-config.json qualityGates property.
 * 
 * Schema:
 * {
 *   "qualityGates": {
 *     "deep-interview": ["skill-name" | {skill, mode?, model?}, ...],
 *     "ralplan": ["skill-name" | {skill, mode?, model?}, ...],
 *     "code-review": ["skill-name" | {skill, mode?, model?}, ...]
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
 * Gate entry: either a skill name string or a gate configuration object
 */
export type QualityGateEntry = string | QualityGateObject;

/**
 * Gate configuration object
 */
export interface QualityGateObject {
  /** Skill name (kebab-case) */
  skill: string;
  /** Gate mode: 'blocking' (default) or 'advisory' */
  mode?: 'blocking' | 'advisory';
  /** Optional subagent model override */
  model?: string;
}

/**
 * Normalized gate entry (internal representation)
 */
export type NormalizedGate = {
  skill: string;
  mode: 'blocking' | 'advisory';
  model?: string;
};

/**
 * Quality gates configuration from .omx-config.json
 * Maps stage names to arrays of gate entries (strings or objects)
 */
export interface QualityGatesConfig {
  /** Quality gates for the deep-interview final-spec stage */
  'deep-interview'?: QualityGateEntry[];
  /** Quality gates for the ralplan Architect→Critic review stage */
  'ralplan'?: QualityGateEntry[];
  /** Quality gates for the code-review stage */
  'code-review'?: QualityGateEntry[];
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
 * Normalize a gate entry (string or object) to the standard internal representation
 */
export function normalizeGateEntry(entry: unknown): NormalizedGate | null {
  let skill: string;
  let mode: 'blocking' | 'advisory' = 'blocking';
  let model: string | undefined;

  if (typeof entry === 'string') {
    skill = entry;
  } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = entry as Record<string, unknown>;
    if (!obj.skill || typeof obj.skill !== 'string') {
      return null;
    }
    skill = obj.skill;
    if (obj.mode && typeof obj.mode === 'string') {
      if (!['blocking', 'advisory'].includes(obj.mode)) {
        return null; // Invalid mode
      }
      mode = obj.mode as 'blocking' | 'advisory';
    }
    if (obj.model && typeof obj.model === 'string') {
      model = obj.model;
    }
  } else {
    return null; // Invalid entry format
  }

  // Validate skill name
  const validation = validateSkillName(skill);
  if (!validation.valid) {
    return null;
  }

  // Return object without model field if it's undefined
  const result: NormalizedGate = { skill, mode };
  if (model !== undefined) {
    result.model = model;
  }
  return result;
}

/**
 * Read quality gates configuration from .omx-config.json
 * Reads from both project ./.omx-config.json (if cwd provided) and $CODEX_HOME/.omx-config.json
 * Project config takes precedence over CODEX_HOME config for the same stage
 */
export function readQualityGatesConfig(codexHomeOverride?: string, cwd?: string): QualityGatesConfig | null {
  const result: QualityGatesConfig = {};
  let hasConfig = false;

  // Read CODEX_HOME config first (lower precedence)
  const codexHomePath = join(codexHomeOverride || codexHome(), '.omx-config.json');
  if (existsSync(codexHomePath)) {
    try {
      const raw = JSON.parse(readFileSync(codexHomePath, 'utf-8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const qualityGates = raw.qualityGates;
        if (qualityGates && typeof qualityGates === 'object' && !Array.isArray(qualityGates)) {
          const codexHomeGates = qualityGates as QualityGatesConfig;
          for (const [stage, gates] of Object.entries(codexHomeGates)) {
            if (gates) {
              result[stage as QualityGateStage] = gates;
              hasConfig = true;
            }
          }
        }
      }
    } catch {
      // Silently ignore parse errors in CODEX_HOME config
    }
  }

  // Read project config (higher precedence - overwrites CODEX_HOME)
  if (cwd) {
    const projectConfigPath = join(cwd, '.omx-config.json');
    if (existsSync(projectConfigPath)) {
      try {
        const raw = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const qualityGates = raw.qualityGates;
          if (qualityGates && typeof qualityGates === 'object' && !Array.isArray(qualityGates)) {
            const projectGates = qualityGates as QualityGatesConfig;
            for (const [stage, gates] of Object.entries(projectGates)) {
              if (gates) {
                result[stage as QualityGateStage] = gates;
                hasConfig = true;
              }
            }
          }
        }
      } catch {
        // Silently ignore parse errors in project config
      }
    }
  }

  return hasConfig ? result : null;
}

/**
 * Get normalized quality gates for a specific stage
 * Returns array of validated and normalized gate entries
 * Reads from both project and CODEX_HOME config with project taking precedence
 */
export function getGatesForStage(stage: QualityGateStage, codexHomeOverride?: string, cwd?: string): NormalizedGate[] {
  const config = readQualityGatesConfig(codexHomeOverride, cwd);
  const stageGates = config?.[stage];
  
  if (!stageGates || !Array.isArray(stageGates)) {
    return [];
  }

  // Normalize and filter to valid entries
  return stageGates
    .map(entry => normalizeGateEntry(entry))
    .filter((gate): gate is NormalizedGate => gate !== null);
}

/**
 * Validate all gates in the configuration file
 * Returns validated gates and list of validation errors
 * Reads from both project and CODEX_HOME config with project taking precedence
 */
export function validateAllQualityGates(codexHomeOverride?: string, cwd?: string): {
  gates: NormalizedGate[];
  errors: Array<{ stage: QualityGateStage; skillIndex: number; entry: string; error: string }>;
} {
  const gates: NormalizedGate[] = [];
  const errors: Array<{ stage: QualityGateStage; skillIndex: number; entry: string; error: string }> = [];

  const config = readQualityGatesConfig(codexHomeOverride, cwd);
  if (!config) {
    return { gates, errors };
  }

  const stages: QualityGateStage[] = ['deep-interview', 'ralplan', 'code-review'];
  for (const stage of stages) {
    const stageGates = config[stage];
    if (!stageGates || !Array.isArray(stageGates)) continue;

    for (let i = 0; i < stageGates.length; i++) {
      const entry = stageGates[i];
      const entryStr = typeof entry === 'string' ? entry : JSON.stringify(entry);
      
      const normalized = normalizeGateEntry(entry);
      if (normalized) {
        gates.push(normalized);
      } else {
        let error = 'Invalid gate entry';
        
        if (typeof entry === 'string') {
          error = validateSkillName(entry).error || 'Invalid skill';
        } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const obj = entry as unknown as Record<string, unknown>;
          if (!obj || !obj.skill) {
            error = 'Gate object must have a "skill" property';
          } else if (typeof obj.skill !== 'string') {
            error = 'Gate skill must be a string';
          } else if (obj.mode && !['blocking', 'advisory'].includes(obj.mode as string)) {
            error = `Invalid mode: ${obj.mode}; must be 'blocking' or 'advisory'`;
          } else {
            error = validateSkillName(obj.skill).error || 'Invalid skill';
          }
        } else {
          error = 'Gate entry must be a string or object with {skill, mode?, model?}';
        }
        
        errors.push({
          stage,
          skillIndex: i,
          entry: entryStr,
          error,
        });
      }
    }
  }

  return { gates, errors };
}
