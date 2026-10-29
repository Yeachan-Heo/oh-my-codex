/**
 * Quality Gates Module
 * 
 * Central export for quality gates configuration and stage wiring.
 */

// Re-export configuration types and functions
export {
  type QualityGateMode,
  type QualityGateStage,
  type QualityGate,
  type QualityGatesConfig,
  validateSkillName,
  validateQualityGate,
  readQualityGatesConfig,
  readValidatedQualityGates,
  getGatesForStage,
  getAdvisoryGatesForStage,
  getBlockingGatesForStage,
  validateAllQualityGates,
} from '../config/quality-gates.js';

// Re-export interview stage wiring
export {
  type InterviewStageGateResult,
  type InterviewStageGateReceipt,
  getInterviewStageGates,
  getInterviewAdvisoryGates,
  getInterviewBlockingGates,
  createEmptyInterviewGateReceipt,
  recordInterviewGateResult,
  canProceedWithInterviewHandoff,
} from './interview-stage-wiring.js';

// Re-export plan stage wiring
export {
  type PlanStageGateResult,
  type PlanStageGateReceipt,
  getPlanStageGates,
  getPlanAdvisoryGates,
  getPlanBlockingGates,
  createEmptyPlanGateReceipt,
  recordPlanGateResult,
  canProceedWithoutRevision,
  markIterationCapExceeded,
} from './plan-stage-wiring.js';

// Re-export code review stage wiring
export {
  type CodeReviewGateResult,
  type CodeReviewStageGateReceipt,
  getCodeReviewGates,
  getCodeReviewAdvisoryGates,
  getCodeReviewBlockingGates,
  createEmptyCodeReviewGateReceipt,
  recordCodeReviewGateResult,
  canApproveCode,
  getCodeReviewGateSummary,
} from './code-review-stage-wiring.js';
