/**
 * Quality Gates Module
 * 
 * Central export for quality gates configuration.
 */

// Re-export configuration types and functions
export {
  type QualityGateStage,
  type QualityGatesConfig,
  validateSkillName,
  readQualityGatesConfig,
  getGatesForStage,
  validateAllQualityGates,
} from '../config/quality-gates.js';
