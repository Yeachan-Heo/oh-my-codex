import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const PASSING_VALUES = new Set(['pass', 'passed', 'approve', 'approved', 'complete', 'completed', 'ok', 'success', 'succeeded']);

export interface RalphCompletionAuditResult {
  complete: boolean;
  reason: string;
  source: 'state' | 'artifact' | 'missing';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasPassingVerdict(value: Record<string, unknown>): boolean {
  if (value.passed === true || value.approved === true || value.complete === true) return true;
  for (const key of ['status', 'verdict', 'result', 'outcome']) {
    const candidate = safeString(value[key]).toLowerCase();
    if (PASSING_VALUES.has(candidate)) return true;
  }
  return false;
}

function hasSubstantiveValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value === true;
}

function readAuditArtifact(cwd: string, rawPath: unknown): Record<string, unknown> | null {
  const auditPath = safeString(rawPath);
  if (!auditPath) return null;
  const resolvedPath = isAbsolute(auditPath) ? auditPath : join(cwd, auditPath);
  if (!existsSync(resolvedPath)) return null;
  try {
    const content = readFileSync(resolvedPath, 'utf-8').trim();
    if (!content) return null;
    if (!resolvedPath.endsWith('.json')) {
      return { passed: true, checklist: content, verification_evidence: content };
    }
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function selectAuditCandidate(state: Record<string, unknown>, cwd: string): { audit: Record<string, unknown> | null; source: 'state' | 'artifact' | 'missing' } {
  for (const key of ['completion_audit', 'completionAudit', 'completion_audit_evidence', 'completionAuditEvidence']) {
    if (isRecord(state[key])) return { audit: state[key], source: 'state' };
  }

  for (const key of ['completion_audit_path', 'completionAuditPath', 'completion_audit_evidence_path', 'completionAuditEvidencePath']) {
    const artifact = readAuditArtifact(cwd, state[key]);
    if (artifact) return { audit: artifact, source: 'artifact' };
  }

  return { audit: null, source: 'missing' };
}

export function evaluateRalphCompletionAuditEvidence(
  state: Record<string, unknown>,
  cwd: string,
): RalphCompletionAuditResult {
  const { audit, source } = selectAuditCandidate(state, cwd);
  if (!audit) {
    return { complete: false, reason: 'missing_completion_audit', source };
  }

  if (!hasPassingVerdict(audit)) {
    return { complete: false, reason: 'completion_audit_not_passing', source };
  }

  const checklist = audit.prompt_to_artifact_checklist
    ?? audit.promptToArtifactChecklist
    ?? audit.checklist
    ?? audit.requirements_checklist
    ?? audit.requirementsChecklist;
  if (!hasSubstantiveValue(checklist)) {
    return { complete: false, reason: 'missing_completion_checklist', source };
  }

  const evidence = audit.verification_evidence
    ?? audit.verificationEvidence
    ?? audit.evidence
    ?? audit.validation_evidence
    ?? audit.validationEvidence
    ?? audit.commands
    ?? audit.tests;
  if (!hasSubstantiveValue(evidence)) {
    return { complete: false, reason: 'missing_verification_evidence', source };
  }

  return { complete: true, reason: 'completion_audit_passed', source };
}

export function isRalphCompletePhase(value: unknown): boolean {
  const phase = safeString(value).toLowerCase();
  return phase === 'complete' || phase === 'completed';
}
