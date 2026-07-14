import { isAbsolute, posix, win32 } from 'node:path';
import { redactAuthSecrets } from '../auth/redact.js';
import { REVIEW_LIMITS, type ReviewFinding } from './contract.js';

const PROVIDER_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/giu;
const GENERIC_SECRET_PATTERN = /\b([A-Za-z0-9_.-]*(?:api[-_]?key|password|passwd|client[-_]?secret|private[-_]?key|github[-_]?token|secret|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\r\n]+)/giu;
const AUTHORIZATION_HEADER_PATTERN = /\bauthorization\s*:\s*[^\r\n]+/giu;
const HOME_PATH_PATTERN = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)(?=\/)/gu;
const WINDOWS_HOME_PATH_PATTERN = /\b[A-Za-z]:\\Users\\[^\\\s]+(?=\\)/gu;
const SENSITIVE_KEY_PARTS = ['token', 'apikey', 'credential', 'password', 'passwd', 'secret', 'auth'] as const;
const RAW_CONTEXT_KEY_PARTS = ['source', 'diff', 'model', 'context', 'prompt', 'tool', 'output', 'env', 'environment'] as const;

function isForbiddenPersistenceKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  if (SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))) return true;
  if (normalized === 'prompt' || normalized === 'systemprompt' || normalized === 'tooloutput'
    || normalized === 'env' || normalized === 'environment' || normalized === 'fulldiff'
    || normalized === 'sourcecode' || normalized === 'sourcetext') {
    return true;
  }
  return normalized.startsWith('raw')
    && RAW_CONTEXT_KEY_PARTS.some((part) => normalized.slice(3).includes(part));
}

export class ReviewDataValidationError extends Error {
  readonly code: 'LANE_EVIDENCE_INVALID' | 'PERSISTENCE_FAILED';

  constructor(code: 'LANE_EVIDENCE_INVALID' | 'PERSISTENCE_FAILED', message: string) {
    super(message);
    this.name = 'ReviewDataValidationError';
    this.code = code;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function redactReviewText(
  value: unknown,
  options: { repositoryRoot?: string } = {},
): string {
  let text = redactAuthSecrets(value);
  text = text.replace(AUTHORIZATION_HEADER_PATTERN, 'Authorization: [REDACTED]');
  text = text.replace(PROVIDER_TOKEN_PATTERN, '[REDACTED]');
  text = text.replace(GENERIC_SECRET_PATTERN, (_match, key: string, separator: string) => (
    `${key}${separator.trimEnd()} [REDACTED]`
  ));

  const repositoryRoot = options.repositoryRoot?.replace(/[\\/]+$/u, '');
  if (repositoryRoot) {
    text = text.replace(new RegExp(escapeRegExp(repositoryRoot), 'gu'), '[REPOSITORY_ROOT]');
  }
  return text
    .replace(HOME_PATH_PATTERN, '[HOME]')
    .replace(WINDOWS_HOME_PATH_PATTERN, '[HOME]');
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function boundedReviewString(
  value: unknown,
  field: string,
  maximum: number,
  options: { allowEmpty?: boolean; repositoryRoot?: string } = {},
): string {
  if (typeof value !== 'string') {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', `${field} must be a string`);
  }
  const redacted = redactReviewText(value, options);
  if (!options.allowEmpty && redacted.length === 0) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', `${field} must not be empty`);
  }
  if (unicodeLength(redacted) > maximum) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', `${field} exceeds ${maximum} Unicode characters`);
  }
  return redacted;
}

function validateRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || unicodeLength(value) > REVIEW_LIMITS.path) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'finding file must be a bounded path');
  }
  if (value.includes('\0') || /[\r\n]/u.test(value) || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'finding file must be repository-relative');
  }
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'finding file escapes the repository root');
  }
  return normalized;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'finding contains an unknown field');
  }
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', `${field} must be a positive integer`);
  }
  return value as number;
}

export function validateReviewFinding(value: unknown): ReviewFinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'finding must be an object');
  }
  const finding = value as Record<string, unknown>;
  assertExactKeys(finding, [
    'severity', 'title', 'body', 'file', 'start_line', 'end_line', 'fix', 'evidence',
  ]);
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(String(finding.severity))) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'finding severity is invalid');
  }
  const startLine = optionalPositiveInteger(finding.start_line, 'start_line');
  const endLine = optionalPositiveInteger(finding.end_line, 'end_line');
  if ((endLine !== undefined && startLine === undefined) || (
    startLine !== undefined && endLine !== undefined && endLine < startLine
  )) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'finding line range is invalid');
  }

  let evidence: string | undefined;
  if (finding.evidence !== undefined) {
    evidence = boundedReviewString(finding.evidence, 'evidence', REVIEW_LIMITS.evidence);
    if (evidence.split(/\r?\n/u).length > REVIEW_LIMITS.evidenceLines) {
      throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'evidence exceeds five lines');
    }
  }

  return {
    severity: finding.severity as ReviewFinding['severity'],
    title: boundedReviewString(finding.title, 'title', REVIEW_LIMITS.title),
    body: boundedReviewString(finding.body, 'body', REVIEW_LIMITS.body),
    file: validateRelativePath(finding.file),
    ...(startLine === undefined ? {} : { start_line: startLine }),
    ...(endLine === undefined ? {} : { end_line: endLine }),
    fix: boundedReviewString(finding.fix, 'fix', REVIEW_LIMITS.fix),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function sanitizeValue(
  value: unknown,
  options: { repositoryRoot?: string },
  seen: Set<object>,
): unknown {
  if (typeof value === 'string') {
    const redacted = redactReviewText(value, options);
    if (unicodeLength(redacted) > REVIEW_LIMITS.body) {
      throw new ReviewDataValidationError('PERSISTENCE_FAILED', 'persisted string is unbounded');
    }
    return redacted;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ReviewDataValidationError('PERSISTENCE_FAILED', 'number is not finite');
    return value;
  }
  if (typeof value !== 'object') {
    throw new ReviewDataValidationError('PERSISTENCE_FAILED', 'unsupported persisted value');
  }
  if (seen.has(value)) throw new ReviewDataValidationError('PERSISTENCE_FAILED', 'cyclic persisted value');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, options, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ReviewDataValidationError('PERSISTENCE_FAILED', 'persisted value must be plain JSON');
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isForbiddenPersistenceKey(key)) {
        throw new ReviewDataValidationError('PERSISTENCE_FAILED', `forbidden persistence field: ${key}`);
      }
      output[key] = sanitizeValue(item, options, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeForPersistence<T>(
  value: T,
  options: { repositoryRoot?: string } = {},
): T {
  const sanitized = sanitizeValue(value, options, new Set()) as T;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') > REVIEW_LIMITS.lanePayload) {
    throw new ReviewDataValidationError('PERSISTENCE_FAILED', 'persisted payload exceeds one MiB');
  }
  return sanitized;
}
