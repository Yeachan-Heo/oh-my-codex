import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { planningArtifactSlug } from './artifact-names.js';

const CONTEXT_PACK_OUTCOME_HEADING_PATTERN =
  /^#{1,6}\s+Context Pack Outcome\s*$/i;
const CONTEXT_PACK_OUTCOME_DECLARATION_PATTERN = /^[*-]\s*pack\s*:/i;
const CONTEXT_PACK_OUTCOME_LINE_PATTERN =
  /^[*-]\s*pack\s*:\s*(?:(?:created|refreshed|revalidated)\s+)?(?:`(?<quotedPath>[^`]+\.json)`|(?<barePath>\S+\.json))\s*$/i;
const CONTEXT_PACK_PATH_PATTERN =
  /^\.omx\/context\/context-(?<timestamp>\d{8}T\d{6}Z)-(?<slug>[^/]+)\.json$/i;
const SHA1_PATTERN = /^[0-9a-f]{40}$/i;

export const REQUIRED_CONTEXT_PACK_ROLES = ['scope', 'build', 'verify'] as const;

export type ContextPackRole = (typeof REQUIRED_CONTEXT_PACK_ROLES)[number];
export type ContextPackStatus =
  'missing-baseline' | 'plan-only' | 'ready' | 'incomplete' | 'invalid';
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

export interface ContextPackArtifactReadModel {
  plansDir: string;
}

export interface ContextPackBaselineSelection {
  prdPath: string | null;
  testSpecPaths: string[];
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

interface ContextPackOutcomeInspection {
  outcomeState: ContextPackOutcomeState;
  contextPack: ContextPackRef | null;
  declaredPackPath: string | null;
  declaredSlug: string | null;
  issues: string[];
}

export function isApprovedExecutionFollowupReadyStatus(
  status: ContextPackStatus,
): boolean {
  return status === 'ready' || status === 'plan-only';
}

export function isApprovedExecutionContextReadyStatus(
  status: ContextPackStatus,
): boolean {
  return status === 'ready';
}

function normalizeRepoRelativePath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^`|`$/g, '').replaceAll('\\', '/');
  if (!trimmed) {
    return null;
  }
  const withoutLeadingDot = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  if (
    !withoutLeadingDot
    || withoutLeadingDot.startsWith('/')
    || /^[A-Za-z]:/.test(withoutLeadingDot)
  ) {
    return null;
  }
  const segments = withoutLeadingDot
    .split('/')
    .filter((segment) => segment.length > 0);
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

function inspectContextPackOutcome(
  repoRoot: string,
  content: string,
): ContextPackOutcomeInspection {
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
      issues.push(
        'Context Pack Outcome must point to .omx/context/context-<timestamp>-<slug>.json.',
      );
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
      issues: issues.length > 0
        ? issues
        : ['Context Pack Outcome may declare only one pack.'],
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

  const slug =
    typeof documentRecord.slug === 'string' ? documentRecord.slug.trim() : '';
  if (!slug) {
    issues.push('Declared context pack must declare a non-empty slug.');
  }

  const basisRecord = documentRecord.basis;
  if (!basisRecord || typeof basisRecord !== 'object' || Array.isArray(basisRecord)) {
    issues.push('Declared context pack must declare basis PRD and test-spec hashes.');
  }
  const prdBasisRecord =
    !basisRecord || typeof basisRecord !== 'object' || Array.isArray(basisRecord)
      ? null
      : (basisRecord as Record<string, unknown>).prd;
  const testSpecsBasisRecord =
    !basisRecord || typeof basisRecord !== 'object' || Array.isArray(basisRecord)
      ? null
      : (basisRecord as Record<string, unknown>).testSpecs;

  const normalizeBasisObject = (
    value: unknown,
    label: string,
  ): ContextPackBasisObject | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`Declared context pack ${label} basis must be an object.`);
      return null;
    }
    const record = value as Record<string, unknown>;
    const path =
      typeof record.path === 'string' ? normalizeRepoRelativePath(record.path) : null;
    if (!path) {
      issues.push(`Declared context pack ${label} basis path must be repo-relative.`);
    }
    const sha1 =
      typeof record.sha1 === 'string' && SHA1_PATTERN.test(record.sha1.trim())
        ? record.sha1.trim().toLowerCase()
        : null;
    if (!sha1) {
      issues.push(
        `Declared context pack ${label} basis sha1 must be a 40-character hex string.`,
      );
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
      const path =
        typeof record.path === 'string' ? normalizeRepoRelativePath(record.path) : null;
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
          issues.push(
            `Declared context pack entry role "${normalizedRole}" is not supported.`,
          );
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

  if (
    issues.length > 0
    || !prdBasis
    || testSpecBasis.length === 0
    || entries.length === 0
    || !slug
  ) {
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

function findMissingRequiredContextPackRoles(
  document: ContextPackDocument,
): ContextPackRole[] {
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
    issues.push(
      `Declared context pack slug ${document.slug} does not match approved plan slug ${expectedSlug}.`,
    );
  }

  const expectedPrdRelativePath = normalizeRepoRelativePath(relative(repoRoot, prdPath));
  if (!expectedPrdRelativePath) {
    issues.push('Approved plan path could not be normalized for context pack validation.');
  } else if (document.basis.prd.path !== expectedPrdRelativePath) {
    issues.push(
      `Declared context pack basis prd path ${document.basis.prd.path} does not match ${expectedPrdRelativePath}.`,
    );
  } else if (document.basis.prd.sha1 !== computeGitBlobSha1(prdPath)) {
    issues.push(
      `Declared context pack basis prd hash for ${document.basis.prd.path} does not match the current approved PRD.`,
    );
  }

  const expectedTestSpecMap = new Map(testSpecPaths.flatMap((testSpecPath) => {
    const normalizedPath = normalizeRepoRelativePath(relative(repoRoot, testSpecPath));
    return normalizedPath
      ? [[normalizedPath, computeGitBlobSha1(testSpecPath)]]
      : [];
  }));
  const storedTestSpecMap = new Map(
    document.basis.testSpecs.map((testSpec) => [testSpec.path, testSpec.sha1]),
  );

  for (const [expectedPath, expectedSha1] of expectedTestSpecMap.entries()) {
    const storedSha1 = storedTestSpecMap.get(expectedPath);
    if (!storedSha1) {
      issues.push(`Declared context pack basis is missing test-spec ${expectedPath}.`);
      continue;
    }
    if (storedSha1 !== expectedSha1) {
      issues.push(
        `Declared context pack basis test-spec hash for ${expectedPath} does not match the current approved test spec.`,
      );
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

export function resolveContextPackHandoffStatus(
  artifacts: ContextPackArtifactReadModel,
  selection: ContextPackBaselineSelection,
): ContextPackHandoffStatusSnapshot {
  const prdPath = selection.prdPath;
  const repoRoot = dirname(dirname(artifacts.plansDir));
  const baselineState: ContextPackBaselineState =
    !prdPath || !existsSync(prdPath)
      ? 'missing-prd'
      : selection.testSpecPaths.length === 0
        ? 'missing-test-spec'
        : 'present';
  const contextPackIssues: string[] =
    selection.testSpecPaths.length === 0 && prdPath
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
        contextPackIssues.push(
          `Declared context pack slug ${outcome.declaredSlug} does not match approved plan slug ${expectedSlug}.`,
        );
      }

      if (outcome.outcomeState === 'declared' && contextPack) {
        if (!existsSync(contextPack.path)) {
          packState = 'missing';
          contextPackIssues.push(
            `Declared context pack file is missing: ${outcome.declaredPackPath ?? contextPack.path}.`,
          );
        } else {
          const packDocument = readContextPackDocument(contextPack.path);
          packState = packDocument.packState;
          contextPackIssues.push(...packDocument.issues);
          if (packDocument.document) {
            missingRequiredContextPackRoles =
              findMissingRequiredContextPackRoles(packDocument.document);
            roleCoverage =
              missingRequiredContextPackRoles.length === 0
                ? 'covered'
                : 'missing-required-roles';
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
      contextPackIssues.push(
        'Approved plan could not be read while resolving context pack status.',
      );
    }
  }

  if (declarationMismatch) {
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
