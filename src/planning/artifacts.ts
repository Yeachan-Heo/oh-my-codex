import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  comparePlanningArtifactPaths,
  parsePlanningArtifactFileName,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
  selectMatchingTestSpecsForPrd,
} from './artifact-names.js';
import { omxPlansDir } from '../utils/paths.js';

const PRD_PATTERN = /^prd-.*\.md$/i;
const TEST_SPEC_PATTERN = /^test-?spec-.*\.md$/i;
const DEEP_INTERVIEW_SPEC_PATTERN = /^deep-interview-.*\.md$/i;
const CONTEXT_PACK_OUTCOME_HEADING_PATTERN = /^#{1,6}\s+Context Pack Outcome\s*$/i;
const CONTEXT_PACK_OUTCOME_DECLARATION_PATTERN = /^[*-]\s*pack\s*:/i;
const CONTEXT_PACK_OUTCOME_LINE_PATTERN = /^[*-]\s*pack\s*:\s*(?:(?:created|refreshed|revalidated)\s+)?(?:`(?<quotedPath>[^`]+\.json)`|(?<barePath>\S+\.json))\s*$/i;
const CONTEXT_PACK_PATH_PATTERN = /^\.omx\/context\/context-(?<timestamp>\d{8}T\d{6}Z)-(?<slug>.+)\.json$/i;
const SHA1_PATTERN = /^[0-9a-f]{40}$/i;
const APPROVED_REPOSITORY_CONTEXT_MAX_CHARS = 4_000;
const APPROVED_REPOSITORY_CONTEXT_MAX_LINES = 80;
export const REQUIRED_CONTEXT_PACK_ROLES = ['scope', 'build', 'verify'] as const;
export type ContextPackRole = (typeof REQUIRED_CONTEXT_PACK_ROLES)[number];
export type ContextPackStatus = 'missing-baseline' | 'plan-only' | 'ready' | 'incomplete' | 'invalid';
export type ContextPackBaselineState = 'missing-prd' | 'missing-test-spec' | 'present';
export type ContextPackOutcomeState = 'absent' | 'malformed' | 'ambiguous' | 'declared';
export type ContextPackPackState = 'missing' | 'unreadable' | 'invalid' | 'valid';
export type ContextPackRoleCoverageState = 'missing-required-roles' | 'covered';
export type ContextPackBasisState = 'stale' | 'fresh';

export interface ContextPackRef {
  path: string;
}

export interface ContextPackHandoffStatusSnapshot {
  prdPath: string | null;
  testSpecPaths: string[];
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
}

interface ContextPackBasisObject {
  path: string;
  sha1: string;
}

interface ContextPackDocument {
  slug: string;
  basis: {
    prd: ContextPackBasisObject;
    testSpecs: ContextPackBasisObject[];
  };
  entries: Array<{
    path: string;
    roles: ContextPackRole[];
  }>;
}

interface PlanningArtifactSelectionBase {
  prdPath: string | null;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
}

interface ContextPackOutcomeInspection {
  outcomeState: ContextPackOutcomeState;
  contextPack: ContextPackRef | null;
  declaredPackPath: string | null;
  declaredSlug: string | null;
  issues: string[];
}

export interface PlanningArtifacts {
  plansDir: string;
  specsDir: string;
  prdPaths: string[];
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
}

export interface ApprovedRepositoryContextSummary {
  sourcePath: string;
  content: string;
  truncated: boolean;
}

export interface ApprovedPlanContext {
  sourcePath: string;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
  repositoryContextSummary?: ApprovedRepositoryContextSummary;
}

export interface ApprovedExecutionLaunchHint extends ApprovedPlanContext {
  mode: 'team' | 'ralph';
  command: string;
  task: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
}

export interface LatestPlanningArtifactSelection {
  prdPath: string | null;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
}

interface ApprovedExecutionLaunchHintReadOptions {
  prdPath?: string;
  task?: string;
  command?: string;
}

export type ApprovedExecutionLaunchHintOutcome =
  | { status: 'absent' }
  | { status: 'ambiguous' }
  | { status: 'resolved'; hint: ApprovedExecutionLaunchHint };

export interface TeamDagArtifactResolution {
  source: 'json-sidecar' | 'markdown-handoff' | 'none';
  prdPath: string | null;
  planSlug: string | null;
  artifactPath?: string;
  content?: string;
  warnings: string[];
}

function readMatchingPaths(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  try {
    return readdirSync(dir)
      .filter((file) => pattern.test(file))
      .sort(comparePlanningArtifactPaths)
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

export function readPlanningArtifacts(cwd: string): PlanningArtifacts {
  const plansDir = omxPlansDir(cwd);
  const specsDir = join(cwd, '.omx', 'specs');

  return {
    plansDir,
    specsDir,
    prdPaths: readMatchingPaths(plansDir, PRD_PATTERN),
    testSpecPaths: readMatchingPaths(plansDir, TEST_SPEC_PATTERN),
    deepInterviewSpecPaths: readMatchingPaths(specsDir, DEEP_INTERVIEW_SPEC_PATTERN)
      .filter((path) => parsePlanningArtifactFileName(path)?.kind === 'deep-interview'),
  };
}

export function isPlanningComplete(artifacts: PlanningArtifacts): boolean {
  const selection = selectPlanningArtifactsBase(artifacts);
  return Boolean(selection.prdPath) && selection.testSpecPaths.length > 0;
}

export function isApprovedExecutionFollowupReadyStatus(status: ContextPackStatus): boolean {
  return status === 'ready' || status === 'plan-only';
}

export function isApprovedExecutionContextReadyStatus(status: ContextPackStatus): boolean {
  return status === 'ready';
}

export function decodeApprovedExecutionQuotedValue(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    return normalized.slice(1, -1).replace(/\\"/g, '"');
  }
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return normalized.slice(1, -1).replace(/\\'/g, "'");
  }
  return null;
}

function artifactPathSuffix(path: string, prefixPattern: RegExp): string | null {
  const file = basename(path);
  const match = file.match(prefixPattern);
  return match?.groups?.slug ?? null;
}

function selectDeepInterviewSpecPathsForSlug(paths: readonly string[], slug: string | null): string[] {
  if (!slug) return [];
  return paths
    .filter((path) => planningArtifactSlug(path, 'deep-interview') === slug)
    .sort(comparePlanningArtifactPaths);
}

function selectPlanningArtifactsBase(
  artifacts: PlanningArtifacts,
  prdPath?: string,
): PlanningArtifactSelectionBase {
  const selectedPrdPath = prdPath == null
    ? selectLatestPlanningArtifactPath(artifacts.prdPaths)
    : artifacts.prdPaths.includes(prdPath)
      ? prdPath
      : null;
  const slug = selectedPrdPath
    ? planningArtifactSlug(selectedPrdPath, 'prd')
    : null;

  return {
    prdPath: selectedPrdPath,
    testSpecPaths: selectMatchingTestSpecsForPrd(selectedPrdPath, artifacts.testSpecPaths),
    deepInterviewSpecPaths: selectDeepInterviewSpecPathsForSlug(artifacts.deepInterviewSpecPaths, slug),
  };
}

function normalizeRepoRelativePath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^`|`$/g, '').replaceAll('\\', '/');
  if (!trimmed) {
    return null;
  }
  const withoutLeadingDot = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  if (!withoutLeadingDot || withoutLeadingDot.startsWith('/') || /^[A-Za-z]:/.test(withoutLeadingDot)) {
    return null;
  }
  const segments = withoutLeadingDot.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes('..')) {
    return null;
  }
  return segments.join('/');
}

function computeGitBlobSha1(filePath: string): string {
  const buffer = readFileSync(filePath);
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function isMarkdownFenceLine(line: string): boolean {
  return /^(```|~~~)/.test(line.trimStart());
}

function isIndentedMarkdownCodeLine(line: string): boolean {
  return /^(?: {4,}|\t)/.test(line);
}

function extractContextPackOutcomeSections(content: string): string[][] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sections: string[][] = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isMarkdownFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || isIndentedMarkdownCodeLine(line)) {
      continue;
    }
    if (!CONTEXT_PACK_OUTCOME_HEADING_PATTERN.test(line.trim())) {
      continue;
    }

    const section: string[] = [];
    for (let sectionIndex = index + 1; sectionIndex < lines.length; sectionIndex += 1) {
      const sectionLine = lines[sectionIndex]!;
      const trimmed = sectionLine.trim();
      if (
        isMarkdownFenceLine(sectionLine)
        || isIndentedMarkdownCodeLine(sectionLine)
        || /^#{1,6}\s+\S/.test(trimmed)
        || (trimmed !== '' && !/^[*-]\s+/.test(trimmed))
      ) {
        break;
      }
      section.push(sectionLine);
    }
    sections.push(section);
  }

  return sections;
}

function resolveDeclaredContextPackPath(
  repoRoot: string,
  rawPath: string,
): { normalizedPath: string; resolvedPath: string; slug: string } | null {
  const normalizedPath = normalizeRepoRelativePath(rawPath);
  if (!normalizedPath) {
    return null;
  }
  const pathMatch = normalizedPath.match(CONTEXT_PACK_PATH_PATTERN);
  if (!pathMatch?.groups?.slug) {
    return null;
  }
  const resolvedPath = resolve(repoRoot, normalizedPath);
  const roundTripPath = normalizeRepoRelativePath(relative(repoRoot, resolvedPath));
  if (!roundTripPath || roundTripPath !== normalizedPath) {
    return null;
  }
  return {
    normalizedPath,
    resolvedPath,
    slug: pathMatch.groups.slug,
  };
}

function inspectContextPackOutcome(repoRoot: string, content: string): ContextPackOutcomeInspection {
  const outcomeSections = extractContextPackOutcomeSections(content);
  if (outcomeSections.length === 0) {
    return {
      outcomeState: 'absent',
      contextPack: null,
      declaredPackPath: null,
      declaredSlug: null,
      issues: [],
    };
  }
  if (outcomeSections.length > 1) {
    return {
      outcomeState: 'ambiguous',
      contextPack: null,
      declaredPackPath: null,
      declaredSlug: null,
      issues: ['Approved plan contains multiple Context Pack Outcome sections.'],
    };
  }

  let declarationCount = 0;
  let resolvedPackPath: string | null = null;
  let resolvedSlug: string | null = null;
  let resolvedPack: ContextPackRef | null = null;
  const issues: string[] = [];

  for (const line of outcomeSections[0]!) {
    const trimmed = line.trim();
    if (!trimmed || !CONTEXT_PACK_OUTCOME_DECLARATION_PATTERN.test(trimmed)) {
      continue;
    }
    declarationCount += 1;
    const lineMatch = trimmed.match(CONTEXT_PACK_OUTCOME_LINE_PATTERN);
    if (!lineMatch?.groups) {
      issues.push(`Invalid Context Pack Outcome line: ${trimmed}`);
      continue;
    }
    const resolvedPath = resolveDeclaredContextPackPath(
      repoRoot,
      lineMatch.groups.quotedPath ?? lineMatch.groups.barePath,
    );
    if (!resolvedPath) {
      issues.push('Context Pack Outcome must point to .omx/context/context-<timestamp>-<slug>.json.');
      continue;
    }
    if (declarationCount > 1) {
      issues.push('Context Pack Outcome may declare only one pack.');
      continue;
    }
    resolvedPackPath = resolvedPath.normalizedPath;
    resolvedSlug = resolvedPath.slug;
    resolvedPack = { path: resolvedPath.resolvedPath };
  }

  if (declarationCount === 0) {
    return {
      outcomeState: 'malformed',
      contextPack: null,
      declaredPackPath: null,
      declaredSlug: null,
      issues: ['Context Pack Outcome must declare exactly one pack.'],
    };
  }
  if (declarationCount > 1) {
    return {
      outcomeState: 'ambiguous',
      contextPack: resolvedPack,
      declaredPackPath: resolvedPackPath,
      declaredSlug: resolvedSlug,
      issues: issues.length > 0 ? issues : ['Context Pack Outcome may declare only one pack.'],
    };
  }
  if (issues.length > 0 || !resolvedPack || !resolvedPackPath || !resolvedSlug) {
    return {
      outcomeState: 'malformed',
      contextPack: resolvedPack,
      declaredPackPath: resolvedPackPath,
      declaredSlug: resolvedSlug,
      issues,
    };
  }
  return {
    outcomeState: 'declared',
    contextPack: resolvedPack,
    declaredPackPath: resolvedPackPath,
    declaredSlug: resolvedSlug,
    issues: [],
  };
}

function readContextPackDocument(packPath: string): {
  packState: ContextPackPackState;
  document: ContextPackDocument | null;
  issues: string[];
} {
  let rawContent = '';
  try {
    rawContent = readFileSync(packPath, 'utf-8');
  } catch {
    return {
      packState: 'unreadable',
      document: null,
      issues: ['Declared context pack could not be read.'],
    };
  }

  let rawDocument: unknown;
  try {
    rawDocument = JSON.parse(rawContent);
  } catch {
    return {
      packState: 'invalid',
      document: null,
      issues: ['Declared context pack contains invalid JSON.'],
    };
  }
  if (!rawDocument || typeof rawDocument !== 'object' || Array.isArray(rawDocument)) {
    return {
      packState: 'invalid',
      document: null,
      issues: ['Declared context pack must be a JSON object.'],
    };
  }

  const documentRecord = rawDocument as Record<string, unknown>;
  const issues: string[] = [];

  const slug = typeof documentRecord.slug === 'string' ? documentRecord.slug.trim() : '';
  if (!slug) {
    issues.push('Declared context pack must declare a non-empty slug.');
  }

  const basisRecord = documentRecord.basis;
  if (!basisRecord || typeof basisRecord !== 'object' || Array.isArray(basisRecord)) {
    issues.push('Declared context pack must declare basis PRD and test-spec hashes.');
  }
  const prdBasisRecord = !basisRecord || typeof basisRecord !== 'object' || Array.isArray(basisRecord)
    ? null
    : (basisRecord as Record<string, unknown>).prd;
  const testSpecsBasisRecord = !basisRecord || typeof basisRecord !== 'object' || Array.isArray(basisRecord)
    ? null
    : (basisRecord as Record<string, unknown>).testSpecs;

  const normalizeBasisObject = (value: unknown, label: string): ContextPackBasisObject | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`Declared context pack ${label} basis must be an object.`);
      return null;
    }
    const record = value as Record<string, unknown>;
    const path = typeof record.path === 'string' ? normalizeRepoRelativePath(record.path) : null;
    if (!path) {
      issues.push(`Declared context pack ${label} basis path must be repo-relative.`);
    }
    const sha1 = typeof record.sha1 === 'string' && SHA1_PATTERN.test(record.sha1.trim())
      ? record.sha1.trim().toLowerCase()
      : null;
    if (!sha1) {
      issues.push(`Declared context pack ${label} basis sha1 must be a 40-character hex string.`);
    }
    return path && sha1 ? { path, sha1 } : null;
  };

  const prdBasis = normalizeBasisObject(prdBasisRecord, 'prd');
  const testSpecBasis = Array.isArray(testSpecsBasisRecord)
    ? testSpecsBasisRecord
      .map((value, index) => normalizeBasisObject(value, `test-spec[${index}]`))
      .filter((value): value is ContextPackBasisObject => value !== null)
    : [];
  if (!Array.isArray(testSpecsBasisRecord) || testSpecBasis.length === 0) {
    issues.push('Declared context pack must declare at least one test-spec basis entry.');
  }

  const rawEntries = documentRecord.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    issues.push('Declared context pack must declare at least one entry.');
  }
  const entries = Array.isArray(rawEntries)
    ? rawEntries.flatMap((rawEntry) => {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        issues.push('Declared context pack entries must be objects.');
        return [];
      }
      const record = rawEntry as Record<string, unknown>;
      const path = typeof record.path === 'string' ? normalizeRepoRelativePath(record.path) : null;
      if (!path) {
        issues.push('Declared context pack entries must provide a repo-relative path.');
      }
      if (!Array.isArray(record.roles) || record.roles.length === 0) {
        issues.push('Declared context pack entries must declare at least one role.');
        return [];
      }
      const roles = [...new Set(record.roles.flatMap((role) => {
        if (typeof role !== 'string') {
          issues.push('Declared context pack entry roles must be strings.');
          return [];
        }
        const normalizedRole = role.trim();
        if (!REQUIRED_CONTEXT_PACK_ROLES.includes(normalizedRole as ContextPackRole)) {
          issues.push(`Declared context pack entry role "${normalizedRole}" is not supported.`);
          return [];
        }
        return [normalizedRole as ContextPackRole];
      }))];
      if (!path || roles.length === 0) {
        return [];
      }
      return [{ path, roles }];
    })
    : [];

  if (issues.length > 0 || !prdBasis || testSpecBasis.length === 0 || entries.length === 0 || !slug) {
    return {
      packState: 'invalid',
      document: null,
      issues,
    };
  }

  return {
    packState: 'valid',
    document: {
      slug,
      basis: {
        prd: prdBasis,
        testSpecs: testSpecBasis,
      },
      entries,
    },
    issues: [],
  };
}

function findMissingRequiredContextPackRoles(document: ContextPackDocument): ContextPackRole[] {
  const presentRoles = new Set(document.entries.flatMap((entry) => entry.roles));
  return REQUIRED_CONTEXT_PACK_ROLES.filter((role) => !presentRoles.has(role));
}

function validateContextPackBasis(
  repoRoot: string,
  prdPath: string,
  testSpecPaths: readonly string[],
  document: ContextPackDocument,
): string[] {
  const issues: string[] = [];
  const expectedSlug = planningArtifactSlug(prdPath, 'prd');
  if (!expectedSlug) {
    issues.push('Approved plan slug could not be resolved for context pack validation.');
  } else if (document.slug !== expectedSlug) {
    issues.push(`Declared context pack slug ${document.slug} does not match approved plan slug ${expectedSlug}.`);
  }

  const expectedPrdRelativePath = normalizeRepoRelativePath(relative(repoRoot, prdPath));
  if (!expectedPrdRelativePath) {
    issues.push('Approved plan path could not be normalized for context pack validation.');
  } else if (document.basis.prd.path !== expectedPrdRelativePath) {
    issues.push(`Declared context pack basis prd path ${document.basis.prd.path} does not match ${expectedPrdRelativePath}.`);
  } else if (document.basis.prd.sha1 !== computeGitBlobSha1(prdPath)) {
    issues.push(`Declared context pack basis prd hash for ${document.basis.prd.path} does not match the current approved PRD.`);
  }

  const expectedTestSpecMap = new Map(testSpecPaths.flatMap((testSpecPath) => {
    const normalizedPath = normalizeRepoRelativePath(relative(repoRoot, testSpecPath));
    return normalizedPath
      ? [[normalizedPath, computeGitBlobSha1(testSpecPath)]]
      : [];
  }));
  const storedTestSpecMap = new Map(document.basis.testSpecs.map((testSpec) => [testSpec.path, testSpec.sha1]));

  for (const [expectedPath, expectedSha1] of expectedTestSpecMap.entries()) {
    const storedSha1 = storedTestSpecMap.get(expectedPath);
    if (!storedSha1) {
      issues.push(`Declared context pack basis is missing test-spec ${expectedPath}.`);
      continue;
    }
    if (storedSha1 !== expectedSha1) {
      issues.push(`Declared context pack basis test-spec hash for ${expectedPath} does not match the current approved test spec.`);
    }
  }
  for (const storedPath of storedTestSpecMap.keys()) {
    if (!expectedTestSpecMap.has(storedPath)) {
      issues.push(`Declared context pack basis includes unexpected test-spec ${storedPath}.`);
    }
  }

  return issues;
}

export function resolveContextPackHandoffState(input: {
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
}): ContextPackStatus {
  if (input.baselineState !== 'present') {
    return 'missing-baseline';
  }
  if (input.outcomeState === 'absent') {
    return 'plan-only';
  }
  if (input.outcomeState === 'malformed' || input.outcomeState === 'ambiguous') {
    return 'invalid';
  }
  if (input.packState === 'missing') {
    return 'incomplete';
  }
  if (input.packState === 'unreadable' || input.packState === 'invalid') {
    return 'invalid';
  }
  if (input.basisState !== 'fresh') {
    return 'invalid';
  }
  if (input.roleCoverage !== 'covered') {
    return 'incomplete';
  }
  return 'ready';
}

function resolveContextPackHandoffStatus(
  artifacts: PlanningArtifacts,
  selection: PlanningArtifactSelectionBase,
): ContextPackHandoffStatusSnapshot {
  const prdPath = selection.prdPath;
  const repoRoot = dirname(dirname(artifacts.plansDir));
  const baselineState: ContextPackBaselineState = !prdPath || !existsSync(prdPath)
    ? 'missing-prd'
    : selection.testSpecPaths.length === 0
      ? 'missing-test-spec'
      : 'present';
  const contextPackIssues: string[] = selection.testSpecPaths.length === 0 && prdPath
    ? ['Approved plan is missing a matching test spec.']
    : [];

  let contextPack: ContextPackRef | null = null;
  let outcomeState: ContextPackOutcomeState = 'absent';
  let packState: ContextPackPackState = 'missing';
  let roleCoverage: ContextPackRoleCoverageState = 'missing-required-roles';
  let basisState: ContextPackBasisState = 'stale';
  let missingRequiredContextPackRoles: ContextPackRole[] = [];
  let declarationMismatch = false;

  if (prdPath && existsSync(prdPath)) {
    try {
      const outcome = inspectContextPackOutcome(repoRoot, readFileSync(prdPath, 'utf-8'));
      outcomeState = outcome.outcomeState;
      contextPack = outcome.contextPack;
      contextPackIssues.push(...outcome.issues);

      const expectedSlug = planningArtifactSlug(prdPath, 'prd');
      if (
        contextPack
        && outcome.declaredSlug
        && expectedSlug
        && outcome.declaredSlug !== expectedSlug
      ) {
        declarationMismatch = true;
        contextPackIssues.push(`Declared context pack slug ${outcome.declaredSlug} does not match approved plan slug ${expectedSlug}.`);
      }

      if (outcome.outcomeState === 'declared' && contextPack) {
        if (!existsSync(contextPack.path)) {
          packState = 'missing';
          contextPackIssues.push(`Declared context pack file is missing: ${outcome.declaredPackPath ?? contextPack.path}.`);
        } else {
          const packDocument = readContextPackDocument(contextPack.path);
          packState = packDocument.packState;
          contextPackIssues.push(...packDocument.issues);
          if (packDocument.document) {
            missingRequiredContextPackRoles = findMissingRequiredContextPackRoles(packDocument.document);
            roleCoverage = missingRequiredContextPackRoles.length === 0 ? 'covered' : 'missing-required-roles';
            if (baselineState === 'present') {
              const basisIssues = validateContextPackBasis(
                repoRoot,
                prdPath,
                selection.testSpecPaths,
                packDocument.document,
              );
              if (basisIssues.length === 0) {
                basisState = 'fresh';
              } else {
                contextPackIssues.push(...basisIssues);
              }
            }
          }
        }
      }
    } catch {
      outcomeState = 'malformed';
      contextPackIssues.push('Approved plan could not be read while resolving context pack status.');
    }
  }
  if (declarationMismatch && packState === 'valid') {
    packState = 'invalid';
  }

  return {
    prdPath,
    testSpecPaths: selection.testSpecPaths,
    contextPack,
    contextPackStatus: resolveContextPackHandoffState({
      baselineState,
      outcomeState,
      packState,
      roleCoverage,
      basisState,
    }),
    baselineState,
    outcomeState,
    packState,
    roleCoverage,
    basisState,
    missingRequiredContextPackRoles,
    contextPackIssues,
  };
}

function selectPlanningArtifacts(
  artifacts: PlanningArtifacts,
  prdPath?: string,
): LatestPlanningArtifactSelection {
  const selection = selectPlanningArtifactsBase(artifacts, prdPath);
  const handoffStatus = resolveContextPackHandoffStatus(artifacts, selection);
  return {
    ...selection,
    contextPack: handoffStatus.contextPack,
    contextPackStatus: handoffStatus.contextPackStatus,
    missingRequiredContextPackRoles: handoffStatus.missingRequiredContextPackRoles,
    contextPackIssues: handoffStatus.contextPackIssues,
  };
}

function boundedRepositoryContextSummary(sourcePath: string, content: string): ApprovedRepositoryContextSummary | null {
  const normalizedLines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  const trimmed = normalizedLines.join('\n').trim();
  if (!trimmed) return null;

  const limitedLines = normalizedLines.slice(0, APPROVED_REPOSITORY_CONTEXT_MAX_LINES);
  const lineTruncated = normalizedLines.length > limitedLines.length;
  let limited = limitedLines.join('\n').trim();
  let charTruncated = false;
  if (limited.length > APPROVED_REPOSITORY_CONTEXT_MAX_CHARS) {
    limited = limited.slice(0, APPROVED_REPOSITORY_CONTEXT_MAX_CHARS).trimEnd();
    charTruncated = true;
  }
  return { sourcePath, content: limited, truncated: lineTruncated || charTruncated };
}

function extractApprovedRepositoryContextSection(sourcePath: string, content: string): ApprovedRepositoryContextSummary | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+Approved Repository Context Summary\s*$/i.test(line.trim()));
  if (headingIndex < 0) return null;
  const headingLevel = lines[headingIndex].match(/^(#+)/)?.[1].length ?? 1;
  const body: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= headingLevel) break;
    body.push(lines[index]);
  }
  return boundedRepositoryContextSummary(sourcePath, body.join('\n'));
}

function readApprovedRepositoryContextSummary(
  artifacts: PlanningArtifacts,
  prdPath: string,
  planSlug: string | null,
  prdContent: string,
): ApprovedRepositoryContextSummary | null {
  if (!planSlug) return extractApprovedRepositoryContextSection(prdPath, prdContent);
  const sidecarPath = join(artifacts.plansDir, `repo-context-${planSlug}.md`);
  if (existsSync(sidecarPath)) {
    try {
      const sidecar = boundedRepositoryContextSummary(sidecarPath, readFileSync(sidecarPath, 'utf-8'));
      if (sidecar) return sidecar;
    } catch {
      // Fall through to an inline approved PRD section when the inspectable sidecar is unreadable.
    }
  }
  return extractApprovedRepositoryContextSection(prdPath, prdContent);
}

function readApprovedPlanText(
  cwd: string,
  options: ApprovedExecutionLaunchHintReadOptions = {},
): { content: string; context: ApprovedPlanContext } | null {
  const artifacts = readPlanningArtifacts(cwd);
  if (!isPlanningComplete(artifacts)) return null;

  const selection = selectPlanningArtifacts(artifacts, options.prdPath);
  const latestPrdPath = selection.prdPath;
  if (!latestPrdPath || selection.testSpecPaths.length === 0 || !existsSync(latestPrdPath)) return null;

  try {
    const content = readFileSync(latestPrdPath, 'utf-8');
    const planSlug = artifactPathSuffix(latestPrdPath, /^prd-(?<slug>.*)\.md$/i);
    const repositoryContextSummary = readApprovedRepositoryContextSummary(artifacts, latestPrdPath, planSlug, content);
    return {
      content,
      context: {
        sourcePath: latestPrdPath,
        testSpecPaths: selection.testSpecPaths,
        deepInterviewSpecPaths: selection.deepInterviewSpecPaths,
        contextPack: selection.contextPack,
        contextPackStatus: selection.contextPackStatus,
        missingRequiredContextPackRoles: selection.missingRequiredContextPackRoles,
        contextPackIssues: selection.contextPackIssues,
        ...(repositoryContextSummary ? { repositoryContextSummary } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function selectLatestPlanningArtifacts(
  artifacts: PlanningArtifacts,
): LatestPlanningArtifactSelection {
  return selectPlanningArtifacts(artifacts);
}

export function readLatestPlanningArtifacts(cwd: string): LatestPlanningArtifactSelection {
  return selectLatestPlanningArtifacts(readPlanningArtifacts(cwd));
}

export function readContextPackHandoffStatus(
  cwd: string,
  prdPath?: string,
): ContextPackHandoffStatusSnapshot {
  const artifacts = readPlanningArtifacts(cwd);
  return resolveContextPackHandoffStatus(artifacts, selectPlanningArtifactsBase(artifacts, prdPath));
}

function extractTeamDagMarkdownHandoff(content: string): string | null {
  const fencePattern = /```(?:json)?\s*\n(?<body>[\s\S]*?)```/gi;
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const headingIndex = content.toLowerCase().indexOf('team dag handoff', searchFrom);
    if (headingIndex < 0) return null;
    fencePattern.lastIndex = headingIndex;
    const match = fencePattern.exec(content);
    if (match?.groups?.body) {
      return match.groups.body.trim();
    }
    searchFrom = headingIndex + 'team dag handoff'.length;
  }
  return null;
}

export function readTeamDagArtifactResolution(cwd: string): TeamDagArtifactResolution {
  const artifacts = readPlanningArtifacts(cwd);
  if (artifacts.prdPaths.length === 0 || artifacts.testSpecPaths.length === 0) {
    return { source: 'none', prdPath: null, planSlug: null, warnings: ['planning_incomplete'] };
  }

  const selection = selectPlanningArtifactsBase(artifacts);
  const prdPath = selection.prdPath;
  const planSlug = prdPath ? artifactPathSuffix(prdPath, /^prd-(?<slug>.*)\.md$/i) : null;
  if (!prdPath || !planSlug) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_prd_slug'] };
  }
  if (selection.testSpecPaths.length === 0) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_matching_test_spec'] };
  }

  const sidecarName = `team-dag-${planSlug}.json`;
  const sidecarPath = join(artifacts.plansDir, sidecarName);
  if (existsSync(sidecarPath)) {
    try {
      return {
        source: 'json-sidecar',
        prdPath,
        planSlug,
        artifactPath: sidecarPath,
        content: readFileSync(sidecarPath, 'utf-8'),
        warnings: [],
      };
    } catch {
      return { source: 'none', prdPath, planSlug, artifactPath: sidecarPath, warnings: ['sidecar_unreadable'] };
    }
  }


  try {
    const prdContent = readFileSync(prdPath, 'utf-8');
    const markdownHandoff = extractTeamDagMarkdownHandoff(prdContent);
    if (markdownHandoff) {
      return { source: 'markdown-handoff', prdPath, planSlug, content: markdownHandoff, warnings: [] };
    }
  } catch {
    return { source: 'none', prdPath, planSlug, warnings: ['prd_unreadable'] };
  }

  return { source: 'none', prdPath, planSlug, warnings: [] };
}

type LaunchHintSelection =
  | { status: 'no-match' }
  | { status: 'ambiguous' }
  | { status: 'unique'; match: RegExpMatchArray; task: string };

function launchHintPattern(mode: 'team' | 'ralph'): RegExp {
  return mode === 'team'
    ? /(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi
    : /(?<command>(?:omx\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
}

function collectLaunchHintMatches(
  content: string,
  mode: 'team' | 'ralph',
): RegExpMatchArray[] {
  return [...content.matchAll(launchHintPattern(mode))];
}

function selectLaunchHintMatch(
  matches: RegExpMatchArray[],
  normalizedTask?: string,
  normalizedCommand?: string,
): LaunchHintSelection {
  if (normalizedCommand) {
    const exactMatches = matches.flatMap((match) => {
      const command = match.groups?.command?.trim();
      if (!command || command !== normalizedCommand) {
        return [];
      }
      const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
      return task ? [{ match, task }] : [];
    });
    if (exactMatches.length === 0) return { status: 'no-match' };
    if (exactMatches.length > 1) return { status: 'ambiguous' };
    return { status: 'unique', ...exactMatches[0]! };
  }

  if (!normalizedTask) {
    const decodedMatches = matches.flatMap((match) => {
      const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
      return task ? [{ match, task }] : [];
    });
    if (decodedMatches.length === 0) return { status: 'no-match' };
    if (decodedMatches.length > 1) return { status: 'ambiguous' };
    return { status: 'unique', ...decodedMatches[0]! };
  }

  const exactMatches = matches.flatMap((match) => {
    const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
    return task && task.trim() === normalizedTask ? [{ match, task }] : [];
  });
  if (exactMatches.length === 0) return { status: 'no-match' };
  if (exactMatches.length > 1) return { status: 'ambiguous' };
  return { status: 'unique', ...exactMatches[0]! };
}

export function readApprovedExecutionLaunchHintOutcome(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHintOutcome {
  const approvedPlan = readApprovedPlanText(cwd, options);
  if (!approvedPlan) return { status: 'absent' };

  const selected = selectLaunchHintMatch(
    collectLaunchHintMatches(approvedPlan.content, mode),
    options.task?.trim(),
    options.command?.trim(),
  );
  if (selected.status === 'ambiguous') return { status: 'ambiguous' };
  if (selected.status !== 'unique' || !selected.match.groups) return { status: 'absent' };

  if (mode === 'team') {
    const workerCount = Number.parseInt(selected.match.groups.count, 10);
    if (!Number.isFinite(workerCount)) {
      return { status: 'absent' };
    }
    return {
      status: 'resolved',
      hint: {
        mode,
        command: selected.match.groups.command,
        task: selected.task,
        workerCount,
        agentType: selected.match.groups.role || undefined,
        linkedRalph: Boolean(selected.match.groups.ralph?.trim()),
        ...approvedPlan.context,
      },
    };
  }

  return {
    status: 'resolved',
    hint: {
      mode,
      command: selected.match.groups.command,
      task: selected.task,
      ...approvedPlan.context,
    },
  };
}

export function readApprovedExecutionLaunchHint(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHint | null {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, options);
  return outcome.status === 'resolved' ? outcome.hint : null;
}
