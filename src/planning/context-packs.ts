import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  comparePlanningArtifactPaths,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
  selectMatchingTestSpecsForPrd,
} from './artifact-names.js';
import {
  findMissingRequiredContextPackRoles,
  inspectContextPackOutcome,
  readContextPackDocument,
  resolveContextPackHandoffState,
  validateContextPackBasis,
  type ContextPackBaselineState,
  type ContextPackBasisState,
  type ContextPackOutcomeState,
  type ContextPackPackState,
  type ContextPackRole,
  type ContextPackRoleCoverageState,
  type ContextPackStatus,
} from './context-pack-status.js';
import {
  isCanonicalContextPackPath,
  normalizePlanningRepoRelativePath,
} from './path-utils.js';
import { omxPlansDir } from '../utils/paths.js';

const PRD_PATTERN = /^prd-.*\.md$/i;
const TEST_SPEC_PATTERN = /^test-?spec-.*\.md$/i;
const CONTEXT_PACK_FILE_PATTERN = /^context-(?<timestamp>\d{8}T\d{6}Z)-(?<slug>[^/]+)\.json$/i;

export type ContextPackInspectOutcomeState = ContextPackOutcomeState | 'other-pack';

export interface ContextPackReadStatusSnapshot {
  packPath: string;
  slug: string | null;
  prdPath: string | null;
  declaredPackPath: string | null;
  testSpecPaths: string[];
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackInspectOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  handoffState: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  issues: string[];
}

interface ApprovedPlanBasisResolution {
  prdPath: string | null;
  testSpecPaths: string[];
  baselineState: ContextPackBaselineState;
  issues: string[];
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

function parseContextPackSlug(packPath: string): string | null {
  if (!isCanonicalContextPackPath(packPath)) {
    return null;
  }
  const match = basename(packPath).match(CONTEXT_PACK_FILE_PATTERN);
  if (!match?.groups?.slug) {
    return null;
  }
  return match.groups.slug;
}

function resolveApprovedPlanBasisForSlug(
  repoRoot: string,
  slug: string,
): ApprovedPlanBasisResolution {
  const plansDir = omxPlansDir(repoRoot);
  const prdPaths = readMatchingPaths(plansDir, PRD_PATTERN)
    .filter((path) => planningArtifactSlug(path, 'prd') === slug);
  const prdPath = selectLatestPlanningArtifactPath(prdPaths);
  if (!prdPath) {
    return {
      prdPath: null,
      testSpecPaths: [],
      baselineState: 'missing-prd',
      issues: [`Could not resolve approved plan for slug ${slug}.`],
    };
  }

  const testSpecPaths = selectMatchingTestSpecsForPrd(
    prdPath,
    readMatchingPaths(plansDir, TEST_SPEC_PATTERN),
  );
  if (testSpecPaths.length === 0) {
    return {
      prdPath,
      testSpecPaths,
      baselineState: 'missing-test-spec',
      issues: ['Approved plan is missing a matching test spec.'],
    };
  }

  return {
    prdPath,
    testSpecPaths,
    baselineState: 'present',
    issues: [],
  };
}

export function resolveContextPackRepoRoot(packPath: string, fallbackCwd: string): string {
  const resolvedPackPath = isAbsolute(packPath) ? resolve(packPath) : resolve(fallbackCwd, packPath);
  if (!parseContextPackSlug(resolvedPackPath)) {
    return resolve(fallbackCwd);
  }
  const contextDir = dirname(resolvedPackPath);
  const omxDir = dirname(contextDir);
  if (basename(contextDir) !== 'context' || basename(omxDir) !== '.omx') {
    return resolve(fallbackCwd);
  }
  return dirname(omxDir);
}

export function readContextPackHandoffStatus(
  repoRoot: string,
  packPath: string,
): ContextPackReadStatusSnapshot {
  const absolutePackPath = isAbsolute(packPath) ? resolve(packPath) : resolve(repoRoot, packPath);
  const slug = parseContextPackSlug(absolutePackPath);
  const basisResolution = slug
    ? resolveApprovedPlanBasisForSlug(repoRoot, slug)
    : {
      prdPath: null,
      testSpecPaths: [],
      baselineState: 'missing-prd' as const,
      issues: ['Context pack path must follow context-<timestamp>-<slug>.json naming.'],
    };
  const targetPackPath =
    normalizePlanningRepoRelativePath(relative(repoRoot, absolutePackPath));

  let outcomeState: ContextPackInspectOutcomeState = 'absent';
  let declaredPackPath: string | null = null;
  const issues = [...basisResolution.issues];

  if (basisResolution.prdPath && existsSync(basisResolution.prdPath)) {
    try {
      const prdContent = readFileSync(basisResolution.prdPath, 'utf-8');
      const outcome = inspectContextPackOutcome(repoRoot, prdContent);
      declaredPackPath = outcome.declaredPackPath;
      issues.push(...outcome.issues);
      outcomeState = outcome.outcomeState;
      if (
        outcome.outcomeState === 'declared'
        && declaredPackPath
        && targetPackPath
        && declaredPackPath !== targetPackPath
      ) {
        outcomeState = 'other-pack';
        issues.push(`Approved plan declares different context pack: ${declaredPackPath}.`);
      }
    } catch {
      outcomeState = 'malformed';
      issues.push('Approved plan could not be read while resolving context pack status.');
    }
  }

  let packState: ContextPackPackState = 'missing';
  let roleCoverage: ContextPackRoleCoverageState = 'unknown';
  let basisState: ContextPackBasisState = 'stale';
  let missingRequiredContextPackRoles: ContextPackRole[] = [];

  if (!existsSync(absolutePackPath)) {
    packState = 'missing';
    issues.push(`Declared context pack file is missing: ${targetPackPath ?? absolutePackPath}.`);
  } else {
    const loadedPack = readContextPackDocument(absolutePackPath);
    packState = loadedPack.packState;
    issues.push(...loadedPack.issues);
    if (loadedPack.document) {
      missingRequiredContextPackRoles =
        findMissingRequiredContextPackRoles(loadedPack.document);
      roleCoverage =
        missingRequiredContextPackRoles.length === 0
          ? 'covered'
          : 'missing-required-roles';
      if (basisResolution.baselineState === 'present' && basisResolution.prdPath) {
        const basisIssues = validateContextPackBasis(
          repoRoot,
          basisResolution.prdPath,
          basisResolution.testSpecPaths,
          loadedPack.document,
        );
        if (basisIssues.length === 0) {
          basisState = 'fresh';
        } else {
          issues.push(...basisIssues);
        }
      }
    }
  }

  const normalizedOutcomeState: ContextPackOutcomeState =
    outcomeState === 'other-pack' ? 'malformed' : outcomeState;

  return {
    packPath: absolutePackPath,
    slug,
    prdPath: basisResolution.prdPath,
    declaredPackPath,
    testSpecPaths: basisResolution.testSpecPaths,
    baselineState: basisResolution.baselineState,
    outcomeState,
    packState,
    roleCoverage,
    basisState,
    handoffState: resolveContextPackHandoffState({
      baselineState: basisResolution.baselineState,
      outcomeState: normalizedOutcomeState,
      packState,
      roleCoverage,
      basisState,
    }),
    missingRequiredContextPackRoles,
    issues,
  };
}
