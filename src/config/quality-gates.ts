/**
 * Custom Quality Gates Configuration
 *
 * Supports configurable custom quality gates for interview, plan, and code-review stages
 * via .omx-config.json qualityGates property.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { codexHome } from '../utils/paths.js';

/**
 * Quality gate enforcement level
 */
export type QualityGateLevel = 'advisory' | 'blocking';

/**
 * Workflow stage where quality gate applies
 */
export type QualityGateStage = 'interview' | 'plan' | 'codeReview';

/**
 * Custom quality gate definition
 */
export interface CustomQualityGate {
  /** Unique gate identifier (kebab-case) */
  name: string;
  /** Human-readable label */
  label: string;
  /** Gate enforcement level */
  level: QualityGateLevel;
  /** Workflow stages where this gate applies */
  stages: QualityGateStage[];
  /** Optional description of what this gate verifies */
  description?: string;
  /** Optional associated skill name for resolution */
  skill?: string;
}

/**
 * Quality gates configuration from .omx-config.json
 */
export interface QualityGatesConfig {
  /** Array of custom gate definitions */
  gates?: CustomQualityGate[];
}

/**
 * Reserved quality gate names that cannot be customized
 * These are built-in gates managed by OMX
 */
const RESERVED_GATE_NAMES = new Set([
  'ai-slop-cleaner',
  'verification',
  'code-review',
  'architecture-invariant-gate',
]);

/**
 * Sunset/deprecated quality gate names
 * These gates are no longer supported and should not be used
 */
const SUNSET_GATE_NAMES = new Set([
  'legacy-review',
  'deprecated-lint',
  'obsolete-test',
]);

/**
 * Validate gate name: must be kebab-case, not reserved, not sunset
 */
export function validateGateName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Gate name must be a non-empty string' };
  }

  // Check kebab-case format
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return { valid: false, error: 'Gate name must be kebab-case (lowercase with hyphens)' };
  }

  // Check reserved names
  if (RESERVED_GATE_NAMES.has(name)) {
    return { valid: false, error: `Gate name "${name}" is reserved for built-in gates` };
  }

  // Check sunset names
  if (SUNSET_GATE_NAMES.has(name)) {
    return { valid: false, error: `Gate name "${name}" is deprecated and no longer supported` };
  }

  return { valid: true };
}

/**
 * Validate custom quality gate
 */
export function validateCustomGate(gate: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!gate || typeof gate !== 'object') {
    errors.push('Quality gate must be an object');
    return { valid: false, errors };
  }

  const g = gate as Record<string, unknown>;

  // Validate name
  if (!g.name || typeof g.name !== 'string') {
    errors.push('Gate must have a non-empty "name" property (string)');
  } else {
    const nameResult = validateGateName(g.name);
    if (!nameResult.valid) {
      errors.push(`Invalid gate name: ${nameResult.error}`);
    }
  }

  // Validate label
  if (!g.label || typeof g.label !== 'string') {
    errors.push('Gate must have a non-empty "label" property (string)');
  }

  // Validate level
  if (!g.level || (g.level !== 'advisory' && g.level !== 'blocking')) {
    errors.push('Gate must have "level" property with value "advisory" or "blocking"');
  }

  // Validate stages
  if (!Array.isArray(g.stages) || g.stages.length === 0) {
    errors.push('Gate must have "stages" property as non-empty array');
  } else {
    const validStages = new Set(['interview', 'plan', 'codeReview']);
    for (const stage of g.stages) {
      if (!validStages.has(stage as string)) {
        errors.push(`Invalid stage "${stage}". Must be one of: interview, plan, codeReview`);
      }
    }
  }

  // Validate optional skill
  if (g.skill !== undefined) {
    if (!g.skill || typeof g.skill !== 'string') {
      errors.push('Optional "skill" property must be a non-empty string');
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
    if (!qualityGates) return null;

    if (typeof qualityGates !== 'object' || Array.isArray(qualityGates)) {
      return null;
    }

    return qualityGates as QualityGatesConfig;
  } catch {
    return null;
  }
}

/**
 * Read and validate custom quality gates from configuration
 */
export function readValidatedQualityGates(codexHomeOverride?: string): {
  gates: CustomQualityGate[];
  errors: Array<{ gateIndex: number; errors: string[] }>;
} {
  const config = readQualityGatesConfig(codexHomeOverride);
  const gates: CustomQualityGate[] = [];
  const errors: Array<{ gateIndex: number; errors: string[] }> = [];

  if (!config?.gates || !Array.isArray(config.gates)) {
    return { gates, errors };
  }

  for (let i = 0; i < config.gates.length; i++) {
    const result = validateCustomGate(config.gates[i]);
    if (result.valid) {
      gates.push(config.gates[i] as CustomQualityGate);
    } else {
      errors.push({ gateIndex: i, errors: result.errors });
    }
  }

  return { gates, errors };
}

/**
 * Get custom gates for a specific stage
 */
export function getGatesForStage(stage: QualityGateStage, codexHomeOverride?: string): CustomQualityGate[] {
  const { gates } = readValidatedQualityGates(codexHomeOverride);
  return gates.filter((gate) => gate.stages.includes(stage));
}

/**
 * Get advisory gates for a specific stage
 */
export function getAdvisoryGatesForStage(stage: QualityGateStage, codexHomeOverride?: string): CustomQualityGate[] {
  return getGatesForStage(stage, codexHomeOverride).filter((gate) => gate.level === 'advisory');
}

/**
 * Get blocking gates for a specific stage
 */
export function getBlockingGatesForStage(stage: QualityGateStage, codexHomeOverride?: string): CustomQualityGate[] {
  return getGatesForStage(stage, codexHomeOverride).filter((gate) => gate.level === 'blocking');
}
