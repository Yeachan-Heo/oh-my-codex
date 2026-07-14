import { isAbsolute, posix, win32 } from 'node:path';
import { redactAuthSecrets } from '../auth/redact.js';
import {
  REVIEW_LIMITS,
  type DiagnosticSubmission,
  type DiagnosticSummary,
  type ReviewFinding,
} from './contract.js';

const PROVIDER_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/giu;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu;
const GENERIC_SECRET_PATTERN = /\b([A-Za-z0-9_.-]*(?:api[-_]?key|password|passwd|client[-_]?secret|private[-_]?key|github[-_]?token|secret|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\r\n]+)/giu;
const AUTHORIZATION_HEADER_PATTERN = /\bauthorization\s*:\s*[^\r\n]+/giu;
const JSON_DOUBLE_QUOTED_SECRET_PATTERN = /"([^"\\]*(?:api[-_]?key|password|passwd|client[-_]?secret|private[-_]?key|github[-_]?token|secret|credential|authorization|auth)[^"\\]*)"(\s*:\s*)"(?:\\.|[^"\\])*"/giu;
const JSON_SINGLE_QUOTED_SECRET_PATTERN = /'([^'\\]*(?:api[-_]?key|password|passwd|client[-_]?secret|private[-_]?key|github[-_]?token|secret|credential|authorization|auth)[^'\\]*)'(\s*:\s*)'(?:\\.|[^'\\])*'/giu;
const HOME_PATH_PATTERN = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)(?=\/)/gu;
const WINDOWS_HOME_PATH_PATTERN = /\b[A-Za-z]:\\Users\\[^\\\s]+(?=\\)/gu;
const SENSITIVE_KEY_PARTS = ['token', 'apikey', 'credential', 'password', 'passwd', 'secret', 'auth'] as const;
const RAW_CONTEXT_KEY_PARTS = ['source', 'diff', 'model', 'context', 'prompt', 'tool', 'output', 'env', 'environment'] as const;
const PEM_PRIVATE_KEY_LABELS = ['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'PRIVATE KEY'] as const;

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

function redactPemPrivateKeyBlocks(value: string): string {
  let cursor = 0;
  let redacted = '';
  while (cursor < value.length) {
    let blockStart = -1;
    let label: typeof PEM_PRIVATE_KEY_LABELS[number] | undefined;
    for (const candidate of PEM_PRIVATE_KEY_LABELS) {
      const index = value.indexOf(`-----BEGIN ${candidate}-----`, cursor);
      if (index >= 0 && (blockStart < 0 || index < blockStart)) {
        blockStart = index;
        label = candidate;
      }
    }
    if (blockStart < 0 || label === undefined) {
      redacted += value.slice(cursor);
      break;
    }
    const endMarker = `-----END ${label}-----`;
    const blockEnd = value.indexOf(endMarker, blockStart + label.length);
    if (blockEnd < 0) {
      redacted += value.slice(cursor);
      break;
    }
    redacted += `${value.slice(cursor, blockStart)}[REDACTED]`;
    cursor = blockEnd + endMarker.length;
  }
  return redacted;
}

export function redactReviewText(
  value: unknown,
  options: { repositoryRoot?: string } = {},
): string {
  let text = redactPemPrivateKeyBlocks(redactAuthSecrets(value));
  text = text.replace(JSON_DOUBLE_QUOTED_SECRET_PATTERN, '"$1"$2"[REDACTED]"');
  text = text.replace(JSON_SINGLE_QUOTED_SECRET_PATTERN, "'$1'$2'[REDACTED]'");
  text = text.replace(AUTHORIZATION_HEADER_PATTERN, 'Authorization: [REDACTED]');
  text = text.replace(PROVIDER_TOKEN_PATTERN, '[REDACTED]');
  text = text.replace(AWS_ACCESS_KEY_ID_PATTERN, '[REDACTED]');
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
  if (typeof finding.severity !== 'string'
    || !(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).includes(finding.severity as ReviewFinding['severity'])) {
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

export function validateReviewReason(value: unknown): string {
  const reason = boundedReviewString(value, 'reason', REVIEW_LIMITS.reason, { allowEmpty: true });
  if (reason.includes('\0')) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'reason contains a NUL byte');
  }
  return reason;
}

type ReviewDiagnostic = DiagnosticSummary | DiagnosticSubmission;

function validateDiagnosticObject(
  value: unknown,
  options: { includeThreadId: boolean },
): ReviewDiagnostic {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'diagnostic must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'diagnostic must be plain JSON');
  }
  const diagnostic = value as Record<string, unknown>;
  const required = [
    'diagnostic_id', 'capability', 'applicability', 'execution', 'outcome',
    ...(options.includeThreadId ? ['thread_id'] : []),
    'event_ref', 'summary',
  ];
  const optional = ['tool_name', 'program', 'args', 'source_ref'];
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(diagnostic).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(diagnostic, key))) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'diagnostic has missing or unknown fields');
  }

  const enumeration = <T extends string>(
    item: unknown,
    field: string,
    allowedValues: readonly T[],
  ): T => {
    if (typeof item !== 'string' || !allowedValues.includes(item as T)) {
      throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', `${field} is invalid`);
    }
    return item as T;
  };
  const string = (item: unknown, field: string, maximum: number, allowEmpty = false): string => {
    const validated = boundedReviewString(item, field, maximum, { allowEmpty });
    if (validated.includes('\0')) {
      throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', `${field} contains a NUL byte`);
    }
    return validated;
  };
  const optionalString = (item: unknown, field: string, maximum: number): string | undefined => (
    item === undefined ? undefined : string(item, field, maximum)
  );
  if (diagnostic.args !== undefined
    && (!Array.isArray(diagnostic.args) || diagnostic.args.length > 128)) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'diagnostic args must be bounded');
  }

  const summary = string(diagnostic.summary, 'diagnostic summary', REVIEW_LIMITS.diagnostic, true);
  if (Buffer.byteLength(summary, 'utf8') > REVIEW_LIMITS.diagnostic) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'diagnostic summary exceeds two KiB');
  }
  const threadId = options.includeThreadId
    ? string(diagnostic.thread_id, 'diagnostic thread_id', 160)
    : undefined;
  const toolName = optionalString(diagnostic.tool_name, 'diagnostic tool_name', 160);
  const program = optionalString(diagnostic.program, 'diagnostic program', REVIEW_LIMITS.path);
  const sourceRef = optionalString(diagnostic.source_ref, 'diagnostic source_ref', REVIEW_LIMITS.path);
  const args = diagnostic.args === undefined
    ? undefined
    : diagnostic.args.map((arg) => string(arg, 'diagnostic arg', REVIEW_LIMITS.path, true));
  return {
    diagnostic_id: string(diagnostic.diagnostic_id, 'diagnostic_id', 160),
    capability: enumeration(
      diagnostic.capability,
      'diagnostic capability',
      ['LSP', 'AST', 'COMPILER', 'LINT', 'RG_FALLBACK'] as const,
    ),
    applicability: enumeration(
      diagnostic.applicability,
      'diagnostic applicability',
      ['APPLICABLE', 'NOT_APPLICABLE'] as const,
    ),
    execution: enumeration(
      diagnostic.execution,
      'diagnostic execution',
      ['NATIVE', 'ACCEPTED_EQUIVALENT', 'FALLBACK', 'UNAVAILABLE', 'SKIPPED'] as const,
    ),
    outcome: enumeration(
      diagnostic.outcome,
      'diagnostic outcome',
      ['PASS', 'FAIL', 'TIMED_OUT', 'MALFORMED', 'NOT_RUN'] as const,
    ),
    ...(threadId === undefined ? {} : { thread_id: threadId }),
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(program === undefined ? {} : { program }),
    ...(args === undefined ? {} : { args }),
    event_ref: string(diagnostic.event_ref, 'diagnostic event_ref', REVIEW_LIMITS.path),
    ...(sourceRef === undefined ? {} : { source_ref: sourceRef }),
    summary,
  } as ReviewDiagnostic;
}

export function validateReviewDiagnostics(
  value: unknown,
  options: { includeThreadId: true },
): DiagnosticSummary[];
export function validateReviewDiagnostics(
  value: unknown,
  options: { includeThreadId: false },
): DiagnosticSubmission[];
export function validateReviewDiagnostics(
  value: unknown,
  options: { includeThreadId: boolean },
): ReviewDiagnostic[] {
  if (!Array.isArray(value)) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'diagnostics must be an array');
  }
  const diagnostics = value.map((diagnostic) => validateDiagnosticObject(diagnostic, options));
  if (Buffer.byteLength(JSON.stringify(diagnostics), 'utf8') > REVIEW_LIMITS.diagnosticsTotalBytes) {
    throw new ReviewDataValidationError('LANE_EVIDENCE_INVALID', 'diagnostics exceed sixteen KiB');
  }
  return diagnostics;
}

function sanitizeValue(
  value: unknown,
  options: { repositoryRoot?: string },
  seen: Set<object>,
): unknown {
  if (typeof value === 'string') {
    return redactReviewText(value, options);
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
