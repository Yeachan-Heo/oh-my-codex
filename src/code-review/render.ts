import { isAbsolute, posix, win32 } from 'node:path';
import {
  REVIEW_LIMITS,
  type DiagnosticSummary,
  type FinalLaneRecord,
  type FinalReviewArtifact,
  type FinalVerdict,
  type ReviewBatch,
  type ReviewRecord,
  type ScopeFile,
  type ScopeManifest,
  type ScopeSelector,
} from './contract.js';
import { sanitizeForPersistence, validateReviewFinding } from './redaction.js';

export class FinalArtifactValidationError extends Error {
  readonly code = 'PERSISTENCE_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'FinalArtifactValidationError';
  }
}

function invalid(message: string): never {
  throw new FinalArtifactValidationError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) invalid(`${name} must be an object`);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${name} contains an unknown field`);
  return value;
}

function boundedString(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || [...value].length > maximum) {
    invalid(`${name} must be a bounded string`);
  }
  if (value.includes('\0')) invalid(`${name} contains a NUL byte`);
  return value;
}

function uuid(value: unknown, name: string): string {
  const parsed = boundedString(value, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed)) {
    invalid(`${name} must be a cryptographic UUID`);
  }
  return parsed.toLowerCase();
}

function enumeration<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`${name} has an invalid enum value`);
  return value as T;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${name} must be an integer`);
  return value as number;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') invalid(`${name} must be boolean`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  const parsed = boundedString(value, name, 64);
  if (!Number.isFinite(Date.parse(parsed))) invalid(`${name} must be an ISO timestamp`);
  return parsed;
}

function relativePath(value: unknown, name: string, allowDot = false): string {
  const parsed = boundedString(value, name, REVIEW_LIMITS.path);
  if (/[\r\n]/u.test(parsed) || isAbsolute(parsed) || win32.isAbsolute(parsed)) {
    invalid(`${name} must be repository-relative`);
  }
  const normalized = posix.normalize(parsed.replaceAll('\\', '/'));
  if ((!allowDot && normalized === '.') || normalized === '..' || normalized.startsWith('../')) {
    invalid(`${name} escapes the repository root`);
  }
  return normalized;
}

function hash(value: unknown, name: string): string {
  const parsed = boundedString(value, name, 64);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) invalid(`${name} must be a lower-case SHA-256 digest`);
  return parsed;
}

function optionalString(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, name, maximum);
}

function validateSelector(value: unknown): ScopeSelector {
  const selector = object(value, 'scope selector', ['requested_base', 'explicit_paths']);
  if (!Array.isArray(selector.explicit_paths) || selector.explicit_paths.length > REVIEW_LIMITS.findingsPerReview) {
    invalid('scope selector explicit_paths must be a bounded array');
  }
  const requestedBase = optionalString(selector.requested_base, 'requested_base', REVIEW_LIMITS.path);
  return {
    ...(requestedBase === undefined ? {} : { requested_base: requestedBase }),
    explicit_paths: selector.explicit_paths.map((path) => relativePath(path, 'explicit path', true)),
  };
}

function validateScopeFile(value: unknown): ScopeFile {
  const file = object(value, 'scope file', [
    'path', 'previous_path', 'change', 'sources', 'binary', 'additions', 'deletions',
  ]);
  if (!Array.isArray(file.sources) || file.sources.length === 0 || file.sources.length > 4) {
    invalid('scope file sources must be non-empty and bounded');
  }
  const sources = file.sources.map((source) => enumeration(
    source,
    'scope file source',
    ['BASE', 'INDEX', 'WORKTREE', 'UNTRACKED'] as const,
  ));
  if (new Set(sources).size !== sources.length) invalid('scope file sources must be unique');
  const previousPath = file.previous_path === undefined
    ? undefined
    : relativePath(file.previous_path, 'previous path');
  const additions = file.additions === undefined ? undefined : integer(file.additions, 'additions');
  const deletions = file.deletions === undefined ? undefined : integer(file.deletions, 'deletions');
  return {
    path: relativePath(file.path, 'scope file path'),
    ...(previousPath === undefined ? {} : { previous_path: previousPath }),
    change: enumeration(file.change, 'scope file change', [
      'ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED', 'UNMERGED', 'SUBMODULE', 'SYMLINK',
    ] as const),
    sources,
    binary: boolean(file.binary, 'scope file binary'),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
  };
}

function validateScope(value: unknown): ScopeManifest {
  const scope = object(value, 'scope', [
    'selector', 'status', 'base_ref', 'base_sha', 'head_sha', 'scope_hash', 'files', 'changed_lines', 'reasons',
  ]);
  if (!Array.isArray(scope.files) || scope.files.length > REVIEW_LIMITS.findingsPerReview) {
    invalid('scope files must be a bounded array');
  }
  if (!Array.isArray(scope.reasons) || scope.reasons.length > REVIEW_LIMITS.findingsPerReview) {
    invalid('scope reasons must be a bounded array');
  }
  const baseRef = optionalString(scope.base_ref, 'base_ref', REVIEW_LIMITS.path);
  const baseSha = optionalString(scope.base_sha, 'base_sha', 64);
  const headSha = optionalString(scope.head_sha, 'head_sha', 64);
  for (const [name, sha] of [['base_sha', baseSha], ['head_sha', headSha]] as const) {
    if (sha !== undefined && !/^[0-9a-f]{40,64}$/u.test(sha)) invalid(`${name} is invalid`);
  }
  return {
    selector: validateSelector(scope.selector),
    status: enumeration(scope.status, 'scope status', ['FULL_SCOPE', 'PARTIAL_SCOPE'] as const),
    ...(baseRef === undefined ? {} : { base_ref: baseRef }),
    ...(baseSha === undefined ? {} : { base_sha: baseSha }),
    ...(headSha === undefined ? {} : { head_sha: headSha }),
    scope_hash: hash(scope.scope_hash, 'scope_hash'),
    files: scope.files.map(validateScopeFile),
    changed_lines: integer(scope.changed_lines, 'changed_lines'),
    reasons: scope.reasons.map((reason) => boundedString(reason, 'scope reason', REVIEW_LIMITS.reason, true)),
  };
}

function validateBatch(value: unknown): ReviewBatch {
  const batch = object(value, 'review batch', [
    'batch_id', 'module_root', 'files', 'changed_lines', 'oversized_single_file',
  ]);
  if (!Array.isArray(batch.files) || batch.files.length > REVIEW_LIMITS.findingsPerReview) {
    invalid('batch files must be a bounded array');
  }
  return {
    batch_id: boundedString(batch.batch_id, 'batch_id', 160),
    module_root: relativePath(batch.module_root, 'module_root', true),
    files: batch.files.map((path) => relativePath(path, 'batch file')),
    changed_lines: integer(batch.changed_lines, 'batch changed_lines'),
    oversized_single_file: boolean(batch.oversized_single_file, 'oversized_single_file'),
  };
}

function validateFinalLane(value: unknown): FinalLaneRecord {
  const lane = object(value, 'final lane', [
    'lane_id', 'role', 'batch_id', 'scope_hash', 'status', 'attempt', 'recommendation',
    'architectural_status', 'findings', 'diagnostic_ids', 'failure_code',
  ]);
  if (!Array.isArray(lane.findings) || lane.findings.length > REVIEW_LIMITS.findingsPerLane) {
    invalid('lane findings exceed the per-lane limit');
  }
  if (!Array.isArray(lane.diagnostic_ids) || lane.diagnostic_ids.length > 256) {
    invalid('lane diagnostic ids must be bounded');
  }
  let findings: FinalLaneRecord['findings'];
  try {
    findings = lane.findings.map(validateReviewFinding);
  } catch {
    invalid('lane finding is invalid');
  }
  const recommendation = lane.recommendation === undefined
    ? undefined
    : enumeration(lane.recommendation, 'recommendation', ['APPROVE', 'COMMENT', 'REQUEST CHANGES'] as const);
  const architecturalStatus = lane.architectural_status === undefined
    ? undefined
    : enumeration(lane.architectural_status, 'architectural_status', ['CLEAR', 'WATCH', 'BLOCK'] as const);
  const failureCode = optionalString(lane.failure_code, 'failure_code', 160);
  return {
    lane_id: boundedString(lane.lane_id, 'lane_id', 160),
    role: enumeration(lane.role, 'lane role', ['code-reviewer', 'architect'] as const),
    batch_id: boundedString(lane.batch_id, 'lane batch_id', 160),
    scope_hash: hash(lane.scope_hash, 'lane scope_hash'),
    status: enumeration(lane.status, 'lane status', ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'TIMED_OUT', 'INVALID'] as const),
    attempt: integer(lane.attempt, 'lane attempt', 1),
    ...(recommendation === undefined ? {} : { recommendation }),
    ...(architecturalStatus === undefined ? {} : { architectural_status: architecturalStatus }),
    findings,
    diagnostic_ids: lane.diagnostic_ids.map((id) => boundedString(id, 'diagnostic id', 160)),
    ...(failureCode === undefined ? {} : { failure_code: failureCode }),
  };
}

type FinalDiagnostic = Omit<DiagnosticSummary, 'thread_id'>;

function validateDiagnostic(value: unknown): FinalDiagnostic {
  const diagnostic = object(value, 'diagnostic', [
    'diagnostic_id', 'capability', 'applicability', 'execution', 'outcome', 'tool_name',
    'program', 'args', 'event_ref', 'source_ref', 'summary',
  ]);
  if (diagnostic.args !== undefined && (!Array.isArray(diagnostic.args) || diagnostic.args.length > 128)) {
    invalid('diagnostic args must be bounded');
  }
  const toolName = optionalString(diagnostic.tool_name, 'tool_name', 160);
  const program = optionalString(diagnostic.program, 'program', REVIEW_LIMITS.path);
  const sourceRef = optionalString(diagnostic.source_ref, 'source_ref', REVIEW_LIMITS.path);
  const args = diagnostic.args === undefined
    ? undefined
    : diagnostic.args.map((arg) => boundedString(arg, 'diagnostic arg', REVIEW_LIMITS.path, true));
  const summary = boundedString(diagnostic.summary, 'diagnostic summary', REVIEW_LIMITS.diagnostic, true);
  if (Buffer.byteLength(summary, 'utf8') > REVIEW_LIMITS.diagnostic) invalid('diagnostic summary exceeds two KiB');
  return {
    diagnostic_id: boundedString(diagnostic.diagnostic_id, 'diagnostic_id', 160),
    capability: enumeration(diagnostic.capability, 'diagnostic capability', ['LSP', 'AST', 'COMPILER', 'LINT', 'RG_FALLBACK'] as const),
    applicability: enumeration(diagnostic.applicability, 'diagnostic applicability', ['APPLICABLE', 'NOT_APPLICABLE'] as const),
    execution: enumeration(diagnostic.execution, 'diagnostic execution', ['NATIVE', 'ACCEPTED_EQUIVALENT', 'FALLBACK', 'UNAVAILABLE', 'SKIPPED'] as const),
    outcome: enumeration(diagnostic.outcome, 'diagnostic outcome', ['PASS', 'FAIL', 'TIMED_OUT', 'MALFORMED', 'NOT_RUN'] as const),
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(program === undefined ? {} : { program }),
    ...(args === undefined ? {} : { args }),
    event_ref: boundedString(diagnostic.event_ref, 'event_ref', REVIEW_LIMITS.path),
    ...(sourceRef === undefined ? {} : { source_ref: sourceRef }),
    summary,
  };
}

function validateVerdict(value: unknown): FinalVerdict {
  const verdict = object(value, 'verdict', [
    'recommendation', 'architectural_status', 'scope_status', 'evidence_status', 'rule_id', 'reasons', 'clean',
  ]);
  if (!Array.isArray(verdict.reasons) || verdict.reasons.length > REVIEW_LIMITS.findingsPerReview) {
    invalid('verdict reasons must be a bounded array');
  }
  return {
    recommendation: enumeration(verdict.recommendation, 'verdict recommendation', ['APPROVE', 'COMMENT', 'REQUEST CHANGES'] as const),
    architectural_status: enumeration(verdict.architectural_status, 'verdict architectural status', ['CLEAR', 'WATCH', 'BLOCK'] as const),
    scope_status: enumeration(verdict.scope_status, 'verdict scope status', ['FULL_SCOPE', 'PARTIAL_SCOPE'] as const),
    evidence_status: enumeration(verdict.evidence_status, 'verdict evidence status', ['FULL_EVIDENCE', 'DEGRADED_EVIDENCE'] as const),
    rule_id: boundedString(verdict.rule_id, 'verdict rule_id', 160),
    reasons: verdict.reasons.map((reason) => boundedString(reason, 'verdict reason', REVIEW_LIMITS.reason, true)),
    clean: boolean(verdict.clean, 'verdict clean'),
  };
}

export function validateFinalReviewArtifact(value: unknown): FinalReviewArtifact {
  const artifact = object(value, 'final review artifact', [
    'schema_version', 'review_id', 'revision', 'status', 'current_attempt', 'scope', 'review_flags',
    'batches', 'lanes', 'diagnostics', 'verdict', 'created_at', 'updated_at', 'finalized_at', 'supersedes_review_id',
  ]);
  if (artifact.schema_version !== 1) invalid('final review schema version is invalid');
  if (!Array.isArray(artifact.review_flags)
    || artifact.review_flags.some((flag) => flag !== 'BATCHED_REVIEW')
    || new Set(artifact.review_flags).size !== artifact.review_flags.length) {
    invalid('review_flags is invalid');
  }
  if (!Array.isArray(artifact.batches) || !Array.isArray(artifact.lanes) || !Array.isArray(artifact.diagnostics)) {
    invalid('final review collections are invalid');
  }
  const scope = artifact.scope === undefined ? undefined : validateScope(artifact.scope);
  const batches = artifact.batches.map(validateBatch);
  const lanes = artifact.lanes.map(validateFinalLane);
  if (lanes.reduce((total, lane) => total + lane.findings.length, 0) > REVIEW_LIMITS.findingsPerReview) {
    invalid('final review findings exceed the review limit');
  }
  const diagnostics = artifact.diagnostics.map(validateDiagnostic);
  if (Buffer.byteLength(JSON.stringify(diagnostics), 'utf8') > REVIEW_LIMITS.diagnosticsTotalBytes) {
    invalid('final review diagnostics exceed sixteen KiB');
  }
  const verdict = validateVerdict(artifact.verdict);
  if (scope && verdict.scope_status !== scope.status) invalid('verdict scope status contradicts the manifest');

  const batchIds = new Set(batches.map((batch) => batch.batch_id));
  if (batchIds.size !== batches.length) invalid('review batch ids must be unique');
  const laneIds = new Set(lanes.map((lane) => lane.lane_id));
  if (laneIds.size !== lanes.length) invalid('final lane ids must be unique');
  const diagnosticIds = new Set(diagnostics.map((diagnostic) => diagnostic.diagnostic_id));
  if (diagnosticIds.size !== diagnostics.length) invalid('diagnostic ids must be unique');

  if (lanes.length > 0 && scope === undefined) invalid('final lanes require a frozen scope');
  const scopeFiles = new Set(scope?.files.map((file) => file.path) ?? []);
  const batchFiles = new Map(batches.map((batch) => [batch.batch_id, new Set(batch.files)]));
  for (const batch of batches) {
    if (new Set(batch.files).size !== batch.files.length) invalid('batch files must be unique');
    if (scope && batch.files.some((path) => !scopeFiles.has(path))) invalid('batch contains a file outside the frozen scope');
  }
  for (const lane of lanes) {
    if (scope && lane.scope_hash !== scope.scope_hash) invalid('lane scope hash contradicts the frozen scope');
    if (lane.role === 'architect') {
      if (lane.batch_id !== 'global') invalid('architect lane must use the global batch');
      if (lane.recommendation !== undefined || lane.architectural_status === undefined) {
        invalid('architect lane has fields for the wrong role');
      }
      if (lane.diagnostic_ids.length !== 0) invalid('architect lane must not reference diagnostics');
      if (lane.findings.some((finding) => !scopeFiles.has(finding.file))) {
        invalid('architect finding is outside the frozen scope');
      }
    } else {
      if (!batchIds.has(lane.batch_id)) invalid('reviewer lane references an unknown batch');
      if (lane.recommendation === undefined || lane.architectural_status !== undefined) {
        invalid('reviewer lane has fields for the wrong role');
      }
      const files = batchFiles.get(lane.batch_id)!;
      if (lane.findings.some((finding) => !scopeFiles.has(finding.file) || !files.has(finding.file))) {
        invalid('reviewer finding is outside its frozen batch');
      }
    }
    if (new Set(lane.diagnostic_ids).size !== lane.diagnostic_ids.length) {
      invalid('lane diagnostic references must be unique');
    }
    if (lane.diagnostic_ids.some((id) => !diagnosticIds.has(id))) {
      invalid('lane references an unknown diagnostic');
    }
  }
  const supersedesReviewId = artifact.supersedes_review_id === undefined
    ? undefined
    : uuid(artifact.supersedes_review_id, 'supersedes_review_id');
  return {
    schema_version: 1,
    review_id: uuid(artifact.review_id, 'review_id'),
    revision: integer(artifact.revision, 'revision', 1),
    status: enumeration(artifact.status, 'final status', ['FINALIZED', 'BLOCKED'] as const),
    current_attempt: integer(artifact.current_attempt, 'current_attempt', 1),
    ...(scope === undefined ? {} : { scope }),
    review_flags: artifact.review_flags as 'BATCHED_REVIEW'[],
    batches,
    lanes,
    diagnostics,
    verdict,
    created_at: timestamp(artifact.created_at, 'created_at'),
    updated_at: timestamp(artifact.updated_at, 'updated_at'),
    finalized_at: timestamp(artifact.finalized_at, 'finalized_at'),
    ...(supersedesReviewId === undefined ? {} : { supersedes_review_id: supersedesReviewId }),
  };
}

export function projectFinalReviewArtifact(record: ReviewRecord): FinalReviewArtifact {
  if (!record.verdict || !record.finalized_at || (record.status !== 'FINALIZED' && record.status !== 'BLOCKED')) {
    invalid('review record is not terminal');
  }
  return validateFinalReviewArtifact(sanitizeForPersistence({
    schema_version: 1,
    review_id: record.review_id,
    revision: record.revision,
    status: record.status,
    current_attempt: record.current_attempt,
    ...(record.scope ? { scope: record.scope } : {}),
    review_flags: record.review_flags,
    batches: record.batches,
    lanes: record.lanes.map((lane) => ({
      lane_id: lane.lane_id,
      role: lane.role,
      batch_id: lane.batch_id,
      scope_hash: lane.scope_hash,
      status: lane.status,
      attempt: lane.attempt,
      ...(lane.recommendation ? { recommendation: lane.recommendation } : {}),
      ...(lane.architectural_status ? { architectural_status: lane.architectural_status } : {}),
      findings: lane.findings,
      diagnostic_ids: lane.diagnostic_ids,
      ...(lane.failure_code ? { failure_code: lane.failure_code } : {}),
    })),
    diagnostics: record.diagnostics.map(({ thread_id: _threadId, ...diagnostic }) => diagnostic),
    verdict: record.verdict,
    created_at: record.created_at,
    updated_at: record.updated_at,
    finalized_at: record.finalized_at,
    ...(record.supersedes_review_id ? { supersedes_review_id: record.supersedes_review_id } : {}),
  }));
}

function inline(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

function findingLines(lane: FinalLaneRecord): string[] {
  if (lane.findings.length === 0) return ['No findings.'];
  return lane.findings.flatMap((finding, index) => {
    const range = finding.start_line === undefined
      ? finding.file
      : `${finding.file}:${finding.start_line}${finding.end_line && finding.end_line !== finding.start_line ? `-${finding.end_line}` : ''}`;
    return [
      `#### ${index + 1}. ${inline(finding.title)} (${finding.severity})`,
      '',
      `- Location: \`${inline(range)}\``,
      `- Detail: ${inline(finding.body)}`,
      `- Fix: ${inline(finding.fix)}`,
      ...(finding.evidence ? [`- Evidence: ${inline(finding.evidence)}`] : []),
      '',
    ];
  });
}

export function renderFinalReviewMarkdown(value: unknown): string {
  const artifact = validateFinalReviewArtifact(sanitizeForPersistence(value));
  const scopeHash = artifact.scope?.scope_hash ?? 'REVIEW_NOT_STARTED';
  const lines = [
    '# Code Review',
    '',
    `Review ID: ${artifact.review_id}`,
    `Scope Hash: ${scopeHash}`,
    `Status: **${artifact.status}**`,
    '',
    '## Verdict',
    '',
    `- Recommendation: **${artifact.verdict.recommendation}**`,
    `- Architecture: **${artifact.verdict.architectural_status}**`,
    `- Scope: **${artifact.verdict.scope_status}**`,
    `- Evidence: **${artifact.verdict.evidence_status}**`,
    `- Rule: \`${inline(artifact.verdict.rule_id)}\``,
    `- Clean: **${artifact.verdict.clean ? 'yes' : 'no'}**`,
    '',
    '### Reasons',
    '',
    ...(artifact.verdict.reasons.length > 0
      ? artifact.verdict.reasons.map((reason) => `- ${inline(reason)}`)
      : ['- No additional reasons.']),
    '',
    '## Scope',
    '',
    ...(artifact.scope
      ? [
          `- Files: ${artifact.scope.files.length}`,
          `- Changed lines: ${artifact.scope.changed_lines}`,
          `- Base: ${inline(artifact.scope.base_ref ?? 'local working state')}`,
        ]
      : ['Scope was not frozen.']),
    '',
    '## Lane Results',
    '',
    ...artifact.lanes.flatMap((lane) => [
      `### ${inline(lane.lane_id)} — ${lane.role}`,
      '',
      `- Status: **${lane.status}**`,
      ...(lane.recommendation ? [`- Recommendation: **${lane.recommendation}**`] : []),
      ...(lane.architectural_status ? [`- Architecture: **${lane.architectural_status}**`] : []),
      '',
      ...findingLines(lane),
    ]),
    '## Diagnostics',
    '',
    ...(artifact.diagnostics.length > 0
      ? artifact.diagnostics.map((diagnostic) => (
          `- \`${inline(diagnostic.diagnostic_id)}\` ${diagnostic.capability}: ${diagnostic.outcome} — ${inline(diagnostic.summary)}`
        ))
      : ['No diagnostics were recorded.']),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
