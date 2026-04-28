import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  contextPackIndexPath,
  describeContextPackBasisResolutionIssues,
  findMissingContextPackRoles,
  inspectContextPackBasis,
  inspectContextPackGeneratedIndex,
  parseContextPackPathInfo,
  REQUIRED_CONTEXT_PACK_ROLES,
  materializeContextPackRefs,
  readContextPackDocument,
  validateContextPackManifest,
  type ContextPackBasisState,
  type ContextPackExecutionRef,
  type ContextPackRole,
} from './context-packs.js';
import {
  advanceMarkdownFenceState,
  collectMarkdownVisibleMatches,
  getMarkdownScanState,
  isIndentedMarkdownCodeLine,
  type MarkdownFenceState,
} from './markdown-structure.js';
import { normalizePlanningRepoRelativePath, resolveDeclaredContextPackPath } from './path-utils.js';
import {
  comparePlanningArtifactPaths,
  parsePlanningArtifactFileName,
  planningArtifactSlug,
  selectMatchingTestSpecsForPrd,
  selectLatestPlanningArtifactPath,
} from './artifact-names.js';
import { omxPlansDir } from '../utils/paths.js';

const PRD_PATTERN = /^prd-.*\.md$/i;
const TEST_SPEC_PATTERN = /^test-?spec-.*\.md$/i;
const DEEP_INTERVIEW_SPEC_PATTERN = /^deep-interview-.*\.md$/i;
const CONTEXT_PACK_PATTERN = /^context-.*\.json$/i;
const CONTEXT_PACK_OUTCOME_HEADING_PATTERN = /^#{1,6}\s+Context Pack Outcome\s*$/i;
const CONTEXT_PACK_OUTCOME_DECLARATION_PREFIX_PATTERN = /^[*-]\s*pack\s*:/i;
const CONTEXT_PACK_OUTCOME_LINE_PATTERN = /^[*-]\s*pack\s*:\s*(?<action>created|refreshed|revalidated)\s+(?:`(?<quotedPath>[^`]+\.json)`|(?<barePath>\S+\.json))\s*$/i;
export type ContextPackAction = 'created' | 'refreshed' | 'revalidated';

export interface ContextPackRef {
  path: string;
  action: ContextPackAction;
}

export type ContextPackStatus = 'missing-baseline' | 'ready' | 'plan-only' | 'incomplete' | 'invalid';
export type ContextPackBaselineState = 'missing-prd' | 'missing-test-spec' | 'present';
export type ContextPackOutcomeState = 'absent' | 'malformed' | 'ambiguous' | 'single' | 'single-other';
export type ContextPackPackState = 'missing' | 'unreadable' | 'schema-invalid' | 'valid';
export type ContextPackRoleCoverageState = 'missing-required-roles' | 'covered';
export type ContextPackIndexState = 'missing' | 'invalid' | 'fresh';

export function isApprovedExecutionFollowupReadyStatus(status: ContextPackStatus): boolean {
  return status === 'ready' || status === 'plan-only';
}

export function isApprovedExecutionContextReadyStatus(status: ContextPackStatus): boolean {
  return status === 'ready';
}

export interface PlanningArtifacts {
  plansDir: string;
  specsDir: string;
  contextDir: string;
  prdPaths: string[];
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPackPaths: string[];
}

export interface ApprovedPlanContext {
  sourcePath: string;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
  contextRefs: ContextPackExecutionRef[];
  contextRefIssues: string[];
}

export interface ApprovedExecutionLaunchHint extends ApprovedPlanContext {
  mode: 'team' | 'ralph';
  command: string;
  task: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
}

export type ApprovedExecutionLaunchHintOutcome =
  | { status: 'absent' }
  | { status: 'ambiguous' }
  | { status: 'resolved'; hint: ApprovedExecutionLaunchHint };

export interface LatestPlanningArtifactSelection {
  prdPath: string | null;
  canonicalPrdPath: string | null;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
}

interface PlanningArtifactPrdIdentity {
  canonicalPath: string;
  persistedPath: string;
}

interface ApprovedExecutionLaunchHintReadOptions {
  materializeContextRefs?: boolean;
  prdPath?: string;
  task?: string;
  command?: string;
}

interface ContextPackResolution {
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
}

interface ContextPackOutcomeInspection {
  outcomeState: ContextPackOutcomeState;
  contextPack: ContextPackRef | null;
  declaredPackPath: string | null;
  issues: string[];
}

export interface ContextPackHandoffStatusSnapshot {
  packPath: string;
  indexPath: string;
  slug: string | null;
  prdPath: string | null;
  testSpecPaths: string[];
  declaredPackPath: string | null;
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  indexState: ContextPackIndexState;
  handoffState: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  issues: string[];
}

export interface TeamDagArtifactResolution {
  source: 'json-sidecar' | 'markdown-handoff' | 'none';
  prdPath: string | null;
  planSlug: string | null;
  artifactPath?: string;
  content?: string;
  warnings: string[];
}

function matchesTeamDagSidecarSlug(fileName: string, slug: string): boolean {
  const prefix = `team-dag-${slug}`;
  return (fileName === `${prefix}.json` || fileName.startsWith(`${prefix}-`)) && fileName.endsWith('.json');
}

function readMatchingPaths(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  try {
    return readdirSync(dir)
      .filter((file) => pattern.test(file))
      .sort((a, b) => a.localeCompare(b))
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

export function readPlanningArtifacts(cwd: string): PlanningArtifacts {
  const plansDir = omxPlansDir(cwd);
  const specsDir = join(cwd, '.omx', 'specs');
  const contextDir = join(cwd, '.omx', 'context');

  return {
    plansDir,
    specsDir,
    contextDir,
    prdPaths: readMatchingPaths(plansDir, PRD_PATTERN),
    testSpecPaths: readMatchingPaths(plansDir, TEST_SPEC_PATTERN),
    deepInterviewSpecPaths: readMatchingPaths(specsDir, DEEP_INTERVIEW_SPEC_PATTERN)
      .filter((path) => parsePlanningArtifactFileName(path)?.kind === 'deep-interview')
      .sort(comparePlanningArtifactPaths),
    contextPackPaths: readMatchingPaths(contextDir, CONTEXT_PACK_PATTERN),
  };
}

function selectPlanningArtifactsForPrdPath(
  artifacts: PlanningArtifacts,
  prdPath: string | null,
): LatestPlanningArtifactSelection {
  const prdIdentity = resolvePlanningArtifactPrdIdentity(artifacts, prdPath);
  const resolvedPrdPath = prdIdentity?.persistedPath ?? null;
  const canonicalPrdPath = prdIdentity?.canonicalPath ?? null;
  const slug = canonicalPrdPath
    ? planningArtifactSlug(canonicalPrdPath, 'prd')
    : null;
  const testSpecSelection = selectMatchingTestSpecsForPrd(canonicalPrdPath, artifacts.testSpecPaths);
  const testSpecPaths = testSpecSelection.paths;
  const deepInterviewSpecPaths = selectDeepInterviewSpecPathsForSlug(artifacts.deepInterviewSpecPaths, slug);
  const contextPackResolution = readContextPackResolution(
    artifacts,
    canonicalPrdPath,
    slug,
  );
  const missingBaseline = !canonicalPrdPath || !existsSync(canonicalPrdPath) || testSpecPaths.length === 0;
  const timestampedTestSpecRequirement = describeTimestampedTestSpecRequirement(testSpecSelection);
  const baselineIssues = testSpecPaths.length === 0 && resolvedPrdPath
    ? [
      'Approved plan is missing a matching test spec.',
      ...(timestampedTestSpecRequirement ? [timestampedTestSpecRequirement] : []),
    ]
    : [];

  return {
    prdPath: resolvedPrdPath,
    canonicalPrdPath,
    testSpecPaths,
    deepInterviewSpecPaths,
    contextPack: contextPackResolution.contextPack,
    contextPackStatus: missingBaseline ? 'missing-baseline' : contextPackResolution.contextPackStatus,
    missingRequiredContextPackRoles: contextPackResolution.missingRequiredContextPackRoles,
    contextPackIssues: missingBaseline
      ? [...baselineIssues, ...contextPackResolution.contextPackIssues]
      : contextPackResolution.contextPackIssues,
  };
}

function resolvePlanningArtifactPrdIdentity(
  artifacts: PlanningArtifacts,
  prdPath: string | null,
): PlanningArtifactPrdIdentity | null {
  if (!prdPath) {
    return null;
  }
  const repoRoot = dirname(dirname(artifacts.plansDir));
  if (isAbsolute(prdPath)) {
    const resolvedPath = resolve(prdPath);
    const matchedArtifact = artifacts.prdPaths.find((candidatePath) => {
      try {
        return realpathSync.native(candidatePath) === realpathSync.native(resolvedPath);
      } catch {
        return resolve(candidatePath) === resolvedPath;
      }
    });
    return matchedArtifact
      ? { canonicalPath: matchedArtifact, persistedPath: resolvedPath }
      : null;
  }

  const normalizedPath = normalizePlanningRepoRelativePath(prdPath);
  const matchedArtifact = artifacts.prdPaths.find(
    (candidatePath) => {
      const repoRelativePath = normalizePlanningRepoRelativePath(relative(repoRoot, candidatePath));
      const plansRelativePath = normalizePlanningRepoRelativePath(relative(artifacts.plansDir, candidatePath));
      return normalizedPath === repoRelativePath || normalizedPath === plansRelativePath;
    },
  );
  return matchedArtifact
    ? { canonicalPath: matchedArtifact, persistedPath: matchedArtifact }
    : null;
}

function resolvePlanningArtifactSelection(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): LatestPlanningArtifactSelection {
  return selectPlanningArtifactsForPrdPath(
    artifacts,
    prdPath ?? selectLatestPlanningArtifactPath(artifacts.prdPaths),
  );
}

export function hasApprovedPlanBaseline(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): boolean {
  const selection = resolvePlanningArtifactSelection(artifacts, prdPath);
  if (!selection.prdPath || !existsSync(selection.prdPath)) {
    return false;
  }
  return selection.testSpecPaths.length > 0;
}

export function isPlanningComplete(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): boolean {
  if (!hasApprovedPlanBaseline(artifacts, prdPath)) {
    return false;
  }
  const selection = resolvePlanningArtifactSelection(artifacts, prdPath);
  return isApprovedExecutionFollowupReadyStatus(selection.contextPackStatus);
}

export function hasRequiredContextPacks(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): boolean {
  const selection = resolvePlanningArtifactSelection(artifacts, prdPath);
  return selection.contextPackStatus === 'ready';
}

function decodeQuotedValue(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized) as string;
  } catch {
    if (
      (normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1);
    }
    return null;
  }
}

function describeTimestampedTestSpecRequirement(
  selection: ReturnType<typeof selectMatchingTestSpecsForPrd>,
): string | null {
  if (!selection.requiredTimestampedFileName) {
    return null;
  }
  return `Approved timestamped plan requires test spec \`${selection.requiredTimestampedFileName}\`.`;
}

function selectDeepInterviewSpecPathsForSlug(
  deepInterviewSpecPaths: readonly string[],
  slug: string | null,
): string[] {
  if (!slug) return [];
  return deepInterviewSpecPaths
    .filter((path) => planningArtifactSlug(path, 'deep-interview') === slug)
    .sort(comparePlanningArtifactPaths);
}

function orderedPrdPathsNewestFirst(paths: readonly string[]): string[] {
  return [...paths].sort(comparePlanningArtifactPaths).reverse();
}

function selectLatestPrdPathForSlug(paths: readonly string[], slug: string): string | null {
  return selectLatestPlanningArtifactPath(
    paths.filter((path) => planningArtifactSlug(path, 'prd') === slug),
  );
}

function extractContextPackOutcomeSections(content: string): string[][] {
  const lines = content.split(/\r?\n/);
  const sections: string[][] = [];
  let activeFence: MarkdownFenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (getMarkdownScanState(activeFence, line) !== 'normal' || !CONTEXT_PACK_OUTCOME_HEADING_PATTERN.test(trimmed)) {
      activeFence = advanceMarkdownFenceState(activeFence, line);
      continue;
    }
    activeFence = advanceMarkdownFenceState(activeFence, line);

    const section: string[] = [];
    for (let sectionIndex = index + 1; sectionIndex < lines.length; sectionIndex += 1) {
      const sectionLine = lines[sectionIndex]!;
      const sectionTrimmed = sectionLine.trim();
      if (
        isIndentedMarkdownCodeLine(sectionLine)
        || /^#{1,6}\s+\S/.test(sectionTrimmed)
        || (sectionTrimmed !== '' && !/^[*-]\s+/.test(sectionTrimmed))
      ) {
        break;
      }
      section.push(sectionLine);
    }
    sections.push(section);
  }

  return sections;
}

function validateContextPackFile(packPath: string, expectedSlug: string, repoRoot: string): string[] {
  return validateContextPackManifest({
    packPath,
    expectedSlug,
    repoRoot,
    requireFreshBasis: true,
  });
}

export function resolveContextPackHandoffState(input: {
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  indexState: ContextPackIndexState;
}): ContextPackStatus {
  if (input.baselineState !== 'present') {
    return 'missing-baseline';
  }
  if (input.outcomeState === 'absent') {
    return 'plan-only';
  }
  if (
    input.outcomeState === 'malformed'
    || input.outcomeState === 'ambiguous'
    || input.outcomeState === 'single-other'
  ) {
    return 'invalid';
  }
  if (input.packState === 'missing') {
    return 'incomplete';
  }
  if (input.packState === 'unreadable' || input.packState === 'schema-invalid') {
    return 'invalid';
  }
  if (input.basisState !== 'fresh') {
    return 'invalid';
  }
  if (input.indexState === 'invalid') {
    return 'invalid';
  }
  if (input.roleCoverage === 'missing-required-roles') {
    return 'incomplete';
  }
  if (input.indexState === 'missing') {
    return 'incomplete';
  }
  return 'ready';
}

function resolveDeclaredContextPackReadiness(
  ref: ContextPackRef,
  missingRequiredContextPackRoles: ContextPackRole[],
  missingCoverageIssues: string[],
  generatedIndexInspection: ReturnType<typeof inspectContextPackGeneratedIndex>,
): ContextPackResolution {
  const contextPackIssues = [...missingCoverageIssues, ...generatedIndexInspection.issues];
  const contextPackStatus = resolveContextPackHandoffState({
    baselineState: 'present',
    outcomeState: 'single',
    packState: 'valid',
    roleCoverage: missingRequiredContextPackRoles.length > 0 ? 'missing-required-roles' : 'covered',
    basisState: 'fresh',
    indexState: generatedIndexInspection.status === 'ready' ? 'fresh' : generatedIndexInspection.status,
  });
  return {
    contextPack: ref,
    contextPackStatus,
    missingRequiredContextPackRoles,
    contextPackIssues,
  };
}

function resolveApprovedExecutionRefs(
  repoRoot: string,
  prdPath: string,
  contextPack: ContextPackRef | null,
): { refs: ContextPackExecutionRef[]; issues: string[] } {
  if (!contextPack) {
    return { refs: [], issues: [] };
  }
  const slug = planningArtifactSlug(prdPath, 'prd');
  return materializeContextPackRefs({
    packPath: contextPack.path,
    expectedSlug: slug ?? '',
    repoRoot,
    requireFreshBasis: true,
    roles: REQUIRED_CONTEXT_PACK_ROLES,
  });
}

function readContextPackOutcomeDeclaration(
  repoRoot: string,
  line: string,
): {
    isDeclaration: boolean;
    declaredPath: string | null;
    ref: ContextPackRef | null;
    issue: string | null;
  } {
  if (!CONTEXT_PACK_OUTCOME_DECLARATION_PREFIX_PATTERN.test(line)) {
    return {
      isDeclaration: false,
      declaredPath: null,
      ref: null,
      issue: null,
    };
  }

  const lineMatch = line.match(CONTEXT_PACK_OUTCOME_LINE_PATTERN);
  if (!lineMatch?.groups) {
    return {
      isDeclaration: true,
      declaredPath: null,
      ref: null,
      issue: `Invalid Context Pack Outcome line: ${line}`,
    };
  }

  const resolvedPath = resolveDeclaredContextPackPath(
    repoRoot,
    lineMatch.groups.quotedPath ?? lineMatch.groups.barePath,
  );
  if (!resolvedPath) {
    return {
      isDeclaration: true,
      declaredPath: null,
      ref: null,
      issue: 'Context Pack Outcome must point to .omx/context/context-<timestamp>-<slug>.json.',
    };
  }

  return {
    isDeclaration: true,
    declaredPath: resolvedPath.normalizedPath,
    ref: {
      path: resolvedPath.resolvedPath,
      action: lineMatch.groups.action.toLowerCase() as ContextPackAction,
    },
    issue: null,
  };
}

function inspectContextPackOutcome(repoRoot: string, content: string): ContextPackOutcomeInspection {
  const outcomeSections = extractContextPackOutcomeSections(content);
  let ref: ContextPackRef | null = null;
  let declaredPackPath: string | null = null;
  const issues: string[] = [];
  let hasDuplicatePackDeclaration = false;

  if (outcomeSections.length === 0) {
    return {
      outcomeState: 'absent',
      contextPack: null,
      declaredPackPath: null,
      issues: [],
    };
  }
  if (outcomeSections.length > 1) {
    return {
      outcomeState: 'ambiguous',
      contextPack: null,
      declaredPackPath: null,
      issues: ['Approved plan contains multiple Context Pack Outcome sections.'],
    };
  }

  for (const line of outcomeSections[0]!) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const declaration = readContextPackOutcomeDeclaration(repoRoot, trimmed);
    if (!declaration.isDeclaration) {
      continue;
    }
    if (declaration.issue) {
      issues.push(declaration.issue);
      continue;
    }
    if (ref) {
      issues.push('Context Pack Outcome may declare only one pack.');
      hasDuplicatePackDeclaration = true;
      continue;
    }
    declaredPackPath = declaration.declaredPath;
    ref = declaration.ref;
  }

  if (issues.length > 0) {
    return {
      outcomeState: hasDuplicatePackDeclaration ? 'ambiguous' : 'malformed',
      contextPack: ref,
      declaredPackPath,
      issues,
    };
  }

  if (!ref) {
    return {
      outcomeState: 'malformed',
      contextPack: null,
      declaredPackPath: null,
      issues: ['Context Pack Outcome must declare exactly one pack.'],
    };
  }

  return {
    outcomeState: 'single',
    contextPack: ref,
    declaredPackPath,
    issues: [],
  };
}

function readContextPackResolution(
  artifacts: PlanningArtifacts,
  prdPath: string | null,
  slug: string | null,
): ContextPackResolution {
  if (!prdPath || !existsSync(prdPath)) {
    return {
      contextPack: null,
      contextPackStatus: 'plan-only',
      missingRequiredContextPackRoles: [],
      contextPackIssues: [],
    };
  }

  const repoRoot = dirname(dirname(artifacts.plansDir));

  try {
    const content = readFileSync(prdPath, 'utf-8');
    const outcome = inspectContextPackOutcome(repoRoot, content);

    if (outcome.outcomeState === 'absent') {
      return {
        contextPack: null,
        contextPackStatus: 'plan-only',
        missingRequiredContextPackRoles: [],
        contextPackIssues: [],
      };
    }
    if (outcome.outcomeState === 'ambiguous') {
      return {
        contextPack: null,
        contextPackStatus: 'invalid',
        missingRequiredContextPackRoles: [...REQUIRED_CONTEXT_PACK_ROLES],
        contextPackIssues: outcome.issues,
      };
    }
    if (outcome.outcomeState === 'malformed') {
      return {
        contextPack: outcome.contextPack,
        contextPackStatus: 'invalid',
        missingRequiredContextPackRoles: outcome.contextPack ? [...REQUIRED_CONTEXT_PACK_ROLES] : [],
        contextPackIssues: outcome.issues,
      };
    }

    const ref = outcome.contextPack;
    if (!ref) {
      return {
        contextPack: null,
        contextPackStatus: 'invalid',
        missingRequiredContextPackRoles: [...REQUIRED_CONTEXT_PACK_ROLES],
        contextPackIssues: ['Context Pack Outcome must declare exactly one pack.'],
      };
    }

    if (!existsSync(ref.path)) {
      return {
        contextPack: ref,
        contextPackStatus: 'incomplete',
        missingRequiredContextPackRoles: [...REQUIRED_CONTEXT_PACK_ROLES],
        contextPackIssues: [`Declared context pack file is missing: ${outcome.declaredPackPath ?? ref.path}.`],
      };
    }

    const validationIssues = validateContextPackFile(ref.path, slug ?? '', repoRoot);
    const document = readContextPackDocument(ref.path);
    const missingRequiredContextPackRoles = document
      ? findMissingContextPackRoles(document, REQUIRED_CONTEXT_PACK_ROLES)
      : [...REQUIRED_CONTEXT_PACK_ROLES];
    if (validationIssues.length > 0) {
      return {
        contextPack: ref,
        contextPackStatus: 'invalid',
        missingRequiredContextPackRoles,
        contextPackIssues: validationIssues,
      };
    }

    if (!document) {
      return {
        contextPack: ref,
        contextPackStatus: 'invalid',
        missingRequiredContextPackRoles: [...REQUIRED_CONTEXT_PACK_ROLES],
        contextPackIssues: ['Declared context pack could not be read after validation.'],
      };
    }

    const missingCoverageIssues = missingRequiredContextPackRoles.length > 0
      ? [`Declared context pack is missing required roles: ${missingRequiredContextPackRoles.join(', ')}.`]
      : [];
    return resolveDeclaredContextPackReadiness(
      ref,
      missingRequiredContextPackRoles,
      missingCoverageIssues,
      inspectContextPackGeneratedIndex(ref.path, document),
    );
  } catch {
    return {
      contextPack: null,
      contextPackStatus: 'invalid',
      missingRequiredContextPackRoles: [],
      contextPackIssues: ['Approved plan could not be read while resolving context packs.'],
    };
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function classifyGeneratedIndexState(
  inspection: ReturnType<typeof inspectContextPackGeneratedIndex>,
): ContextPackIndexState {
  return inspection.status === 'ready' ? 'fresh' : inspection.status;
}

export function readContextPackHandoffStatus(repoRoot: string, packPath: string): ContextPackHandoffStatusSnapshot {
  const artifacts = readPlanningArtifacts(repoRoot);
  const indexPath = contextPackIndexPath(packPath);
  const pathInfo = parseContextPackPathInfo(packPath);
  const issues: string[] = [];
  let slug: string | null = pathInfo?.slugHint ?? null;
  let packState: ContextPackPackState = 'missing';
  let roleCoverage: ContextPackRoleCoverageState = 'missing-required-roles';
  let basisState: ContextPackBasisState = 'absent';
  let indexState: ContextPackIndexState = 'missing';
  let missingRequiredContextPackRoles: ContextPackRole[] = [...REQUIRED_CONTEXT_PACK_ROLES];
  const documentExists = existsSync(packPath);
  const document = documentExists ? readContextPackDocument(packPath) : null;

  if (!documentExists) {
    issues.push(`Context pack not found: ${packPath}`);
  } else {
    try {
      readFileSync(packPath, 'utf-8');
      if (!document) {
        packState = 'schema-invalid';
        issues.push(`Could not read context pack: ${packPath}`);
      } else {
        slug = document.slug;
        const manifestIssues = validateContextPackManifest({
          packPath,
          expectedSlug: slug,
          repoRoot,
        });
        if (manifestIssues.length > 0) {
          packState = 'schema-invalid';
          issues.push(...manifestIssues);
        } else {
          packState = 'valid';
        }

        missingRequiredContextPackRoles = findMissingContextPackRoles(document, REQUIRED_CONTEXT_PACK_ROLES);
        roleCoverage = missingRequiredContextPackRoles.length > 0 ? 'missing-required-roles' : 'covered';
        if (missingRequiredContextPackRoles.length > 0) {
          issues.push(`Declared context pack is missing required roles: ${missingRequiredContextPackRoles.join(', ')}.`);
        }

        const basisInspection = inspectContextPackBasis(document, packPath, repoRoot, slug);
        basisState = basisInspection.status;
        issues.push(...basisInspection.issues);

        const indexInspection = inspectContextPackGeneratedIndex(packPath, document);
        indexState = classifyGeneratedIndexState(indexInspection);
        issues.push(...indexInspection.issues);
      }
    } catch {
      packState = 'unreadable';
      issues.push(`Context pack could not be read: ${packPath}`);
    }
  }

  const prdPath = slug ? selectLatestPrdPathForSlug(artifacts.prdPaths, slug) : null;
  const selection = selectPlanningArtifactsForPrdPath(artifacts, prdPath);
  const baselineState: ContextPackBaselineState = !selection.canonicalPrdPath || !existsSync(selection.canonicalPrdPath)
    ? 'missing-prd'
    : selection.testSpecPaths.length === 0
      ? 'missing-test-spec'
      : 'present';
  if (baselineState === 'missing-prd') {
    issues.push(slug ? `Approved PRD is missing for slug ${slug}.` : 'Could not infer a context-pack slug for approved PRD lookup.');
  } else if (baselineState === 'missing-test-spec') {
    issues.push(`Approved plan is missing a matching test spec for slug ${slug}.`);
    if (slug) {
      for (const issue of describeContextPackBasisResolutionIssues(repoRoot, slug)) {
        if (!issues.includes(issue)) {
          issues.push(issue);
        }
      }
    }
  }

  let outcomeState: ContextPackOutcomeState = 'absent';
  let declaredPackPath: string | null = null;
  if (selection.canonicalPrdPath && existsSync(selection.canonicalPrdPath)) {
    try {
      const outcome = inspectContextPackOutcome(repoRoot, readFileSync(selection.canonicalPrdPath, 'utf-8'));
      outcomeState = outcome.outcomeState;
      declaredPackPath = outcome.declaredPackPath;
      issues.push(...outcome.issues);
      if (outcome.outcomeState === 'single' && outcome.contextPack && !sameResolvedPath(outcome.contextPack.path, packPath)) {
        outcomeState = 'single-other';
        issues.push(`Context Pack Outcome declares ${declaredPackPath ?? outcome.contextPack.path}, not ${packPath}.`);
      }
    } catch {
      outcomeState = 'malformed';
      issues.push(`Approved PRD could not be read for slug ${slug}.`);
    }
  }

  const handoffState = resolveContextPackHandoffState({
    baselineState,
    outcomeState,
    packState,
    roleCoverage,
    basisState,
    indexState,
  });

  return {
    packPath,
    indexPath,
    slug,
    prdPath: selection.prdPath,
    testSpecPaths: selection.testSpecPaths,
    declaredPackPath,
    baselineState,
    outcomeState,
    packState,
    roleCoverage,
    basisState,
    indexState,
    handoffState,
    missingRequiredContextPackRoles,
    issues: [...new Set(issues)],
  };
}

function readApprovedPlanText(
  cwd: string,
  options: ApprovedExecutionLaunchHintReadOptions = {},
): { content: string; context: ApprovedPlanContext } | null {
  const artifacts = readPlanningArtifacts(cwd);
  const selection = resolvePlanningArtifactSelection(artifacts, options.prdPath);
  const latestPrdPath = selection.prdPath;
  const canonicalPrdPath = selection.canonicalPrdPath ?? latestPrdPath;
  if (!latestPrdPath || !existsSync(latestPrdPath)) return null;

  try {
    const repoRoot = dirname(dirname(artifacts.plansDir));
    const shouldMaterializeContextRefs = options.materializeContextRefs === true;
    const refResolution = shouldMaterializeContextRefs && selection.contextPackStatus === 'ready' && canonicalPrdPath
      ? resolveApprovedExecutionRefs(repoRoot, canonicalPrdPath, selection.contextPack)
      : { refs: [], issues: [] };
    const contextPackIssues = [...selection.contextPackIssues];
    const contextRefIssues = [...refResolution.issues];
    const contextPackStatus = shouldMaterializeContextRefs && contextRefIssues.length > 0
      ? 'invalid'
      : selection.contextPackStatus;
    if (shouldMaterializeContextRefs && contextRefIssues.length > 0) {
      contextPackIssues.push(...contextRefIssues);
    }
    return {
      content: readFileSync(latestPrdPath, 'utf-8'),
      context: {
        sourcePath: latestPrdPath,
        testSpecPaths: selection.testSpecPaths,
        deepInterviewSpecPaths: selection.deepInterviewSpecPaths,
        contextPack: selection.contextPack,
        contextPackStatus,
        missingRequiredContextPackRoles: selection.missingRequiredContextPackRoles,
        contextPackIssues,
        contextRefs: refResolution.refs,
        contextRefIssues,
      },
    };
  } catch {
    return null;
  }
}

export function selectLatestPlanningArtifacts(
  artifacts: PlanningArtifacts,
): LatestPlanningArtifactSelection {
  return resolvePlanningArtifactSelection(artifacts);
}

export function readLatestPlanningArtifacts(cwd: string): LatestPlanningArtifactSelection {
  return selectLatestPlanningArtifacts(readPlanningArtifacts(cwd));
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
  const selection = selectLatestPlanningArtifacts(artifacts);
  const prdPath = selection.prdPath;
  const planSlug = prdPath ? planningArtifactSlug(prdPath, 'prd') : null;
  if (!prdPath || !planSlug) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_prd_slug'] };
  }
  if (selection.testSpecPaths.length === 0) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_matching_test_spec'] };
  }
  if (!isApprovedExecutionFollowupReadyStatus(selection.contextPackStatus)) {
    return { source: 'none', prdPath, planSlug, warnings: [`context_pack_not_followup_ready:${selection.contextPackStatus}`] };
  }

  const sidecarPaths = readMatchingPaths(
    artifacts.plansDir,
    new RegExp(`^team-dag-${planSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-.+)?\\.json$`, 'i'),
  ).filter((path) => matchesTeamDagSidecarSlug(basename(path), planSlug));
  if (sidecarPaths.length > 0) {
    const sidecarPath = sidecarPaths.at(-1)!;
    try {
      return {
        source: 'json-sidecar',
        prdPath,
        planSlug,
        artifactPath: sidecarPath,
        content: readFileSync(sidecarPath, 'utf-8'),
        warnings: sidecarPaths.length > 1 ? ['multiple_matches'] : [],
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

type SameTaskLineageFallback =
  | { status: 'resolved'; hint: ApprovedExecutionLaunchHint }
  | { status: 'ambiguous' }
  | { status: 'none' };

function sameTeamLaunchSignature(
  anchor: ApprovedExecutionLaunchHint,
  candidate: ApprovedExecutionLaunchHint,
): boolean {
  return anchor.task.trim() === candidate.task.trim()
    && anchor.workerCount === candidate.workerCount
    && (anchor.agentType ?? null) === (candidate.agentType ?? null)
    && Boolean(anchor.linkedRalph) === Boolean(candidate.linkedRalph);
}

function sameLaunchLineage(
  mode: 'team' | 'ralph',
  anchor: ApprovedExecutionLaunchHint,
  candidate: ApprovedExecutionLaunchHint,
): boolean {
  if (anchor.task.trim() !== candidate.task.trim()) {
    return false;
  }
  return mode === 'team'
    ? sameTeamLaunchSignature(anchor, candidate)
    : true;
}

function sameTeamLaunchSignatureMatch(
  anchor: ApprovedExecutionLaunchHint,
  match: RegExpMatchArray,
  task: string,
): boolean {
  const groups = match.groups;
  if (!groups) {
    return false;
  }
  const workerCount = Number.parseInt(groups.count ?? '', 10);
  if (!Number.isFinite(workerCount)) {
    return false;
  }
  return anchor.task.trim() === task.trim()
    && anchor.workerCount === workerCount
    && (anchor.agentType ?? null) === (groups.role || null)
    && Boolean(anchor.linkedRalph) === Boolean(groups.ralph?.trim());
}

function launchHintPattern(mode: 'team' | 'ralph'): RegExp {
  return mode === 'team'
    ? /(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi
    : /(?<command>(?:omx\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
}

function collectLaunchHintMatches(
  content: string,
  mode: 'team' | 'ralph',
): RegExpMatchArray[] {
  return collectMarkdownVisibleMatches(content, launchHintPattern(mode));
}

function selectLaunchHintMatch(
  matches: RegExpMatchArray[],
  taskGroup: string,
  commandGroup: string,
  normalizedTask?: string,
  normalizedCommand?: string,
  matchFilter?: (match: RegExpMatchArray, task: string) => boolean,
): LaunchHintSelection {
  if (normalizedCommand) {
    const exactMatches = matches.flatMap((match) => {
      const command = match.groups?.[commandGroup]?.trim();
      if (!command || command !== normalizedCommand) {
        return [];
      }
      const rawTask = match.groups?.[taskGroup];
      if (!rawTask) {
        return [];
      }
      const task = decodeQuotedValue(rawTask);
      if (!task) {
        return [];
      }
      if (matchFilter && !matchFilter(match, task)) {
        return [];
      }
      return [{ match, task }];
    });
    if (exactMatches.length === 0) {
      return { status: 'no-match' };
    }
    if (exactMatches.length > 1) {
      return { status: 'ambiguous' };
    }
    return { status: 'unique', ...exactMatches[0]! };
  }

  if (!normalizedTask) {
    const decodedMatches = matches.flatMap((match) => {
      const rawTask = match.groups?.[taskGroup];
      if (!rawTask) {
        return [];
      }
      const task = decodeQuotedValue(rawTask);
      if (!task) {
        return [];
      }
      if (matchFilter && !matchFilter(match, task)) {
        return [];
      }
      return [{ match, task }];
    });
    if (decodedMatches.length === 0) {
      return { status: 'no-match' };
    }
    if (decodedMatches.length > 1) {
      return { status: 'ambiguous' };
    }
    return { status: 'unique', ...decodedMatches[0]! };
  }

  const exactMatches = matches.flatMap((match) => {
    const rawTask = match.groups?.[taskGroup];
    if (!rawTask) {
      return [];
    }
    const task = decodeQuotedValue(rawTask);
    if (!task || task.trim() !== normalizedTask) {
      return [];
    }
    if (matchFilter && !matchFilter(match, task)) {
      return [];
    }
    return [{ match, task }];
  });
  if (exactMatches.length === 0) {
    return { status: 'no-match' };
  }
  if (exactMatches.length > 1) {
    return { status: 'ambiguous' };
  }
  return { status: 'unique', ...exactMatches[0]! };
}

function resolveOlderReusableSameTaskHint(
  cwd: string,
  mode: 'team' | 'ralph',
  artifacts: PlanningArtifacts,
  latestPrdPath: string,
  anchorHint: ApprovedExecutionLaunchHint,
): SameTaskLineageFallback {
  const orderedPrdPaths = [...artifacts.prdPaths].sort(comparePlanningArtifactPaths);
  const latestIndex = orderedPrdPaths.lastIndexOf(latestPrdPath);
  if (latestIndex <= 0) {
    return { status: 'none' };
  }

  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const prdPath = orderedPrdPaths[index]!;
    const approvedPlan = readApprovedPlanText(cwd, { prdPath });
    if (!approvedPlan) {
      continue;
    }

    const matches = collectLaunchHintMatches(approvedPlan.content, mode);
    const selection = selectLaunchHintMatch(
      matches,
      'task',
      'command',
      anchorHint.task,
      undefined,
      mode === 'team'
        ? (match, task) => sameTeamLaunchSignatureMatch(anchorHint, match, task)
        : undefined,
    );
    if (selection.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (selection.status === 'no-match') {
      continue;
    }

    const selectedCommand = selection.match.groups?.command?.trim();
    const approvedHint = readApprovedExecutionLaunchHint(cwd, mode, selectedCommand
      ? {
        command: selectedCommand,
        prdPath,
      }
      : {
        task: selection.task,
        prdPath,
      });
    if (!approvedHint) {
      continue;
    }
    if (!sameLaunchLineage(mode, anchorHint, approvedHint)) {
      continue;
    }
    if (isApprovedExecutionFollowupReadyStatus(approvedHint.contextPackStatus)) {
      return { status: 'resolved', hint: approvedHint };
    }
  }

  return { status: 'none' };
}

export function readApprovedExecutionLaunchHintOutcome(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHintOutcome {
  const normalizedTask = options.task?.trim();
  const normalizedCommand = options.command?.trim();
  if (!normalizedTask && !normalizedCommand && !options.prdPath) {
    const artifacts = readPlanningArtifacts(cwd);
    const latestPrdPath = selectLatestPlanningArtifactPath(artifacts.prdPaths);
    if (!latestPrdPath) {
      return { status: 'absent' };
    }

    const latestApprovedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, {
      ...options,
      prdPath: latestPrdPath,
    });
    if (latestApprovedHintOutcome.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (latestApprovedHintOutcome.status !== 'resolved') {
      return { status: 'absent' };
    }
    const latestApprovedHint = latestApprovedHintOutcome.hint;
    if (isApprovedExecutionFollowupReadyStatus(latestApprovedHint.contextPackStatus)) {
      return { status: 'resolved', hint: latestApprovedHint };
    }
    const sameTaskFallback = resolveOlderReusableSameTaskHint(
      cwd,
      mode,
      artifacts,
      latestPrdPath,
      latestApprovedHint,
    );
    if (sameTaskFallback.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    return sameTaskFallback.status === 'resolved'
      ? { status: 'resolved', hint: sameTaskFallback.hint }
      : { status: 'resolved', hint: latestApprovedHint };
  }

  if ((normalizedTask || normalizedCommand) && !options.prdPath) {
    const artifacts = readPlanningArtifacts(cwd);
    let newestNonReusableHint: ApprovedExecutionLaunchHint | null = null;
    let lineageAnchorHint: ApprovedExecutionLaunchHint | null = null;
    for (const prdPath of orderedPrdPathsNewestFirst(artifacts.prdPaths)) {
      const approvedPlan = readApprovedPlanText(cwd, {
        ...options,
        prdPath,
      });
      if (!approvedPlan) {
        continue;
      }
      const matches = collectLaunchHintMatches(approvedPlan.content, mode);
      const teamLineageFilter = (() => {
        if (!(mode === 'team' && normalizedTask && !normalizedCommand && lineageAnchorHint)) {
          return undefined;
        }
        const anchorHint = lineageAnchorHint;
        return (match: RegExpMatchArray, task: string) => sameTeamLaunchSignatureMatch(anchorHint, match, task);
      })();
      const selection = selectLaunchHintMatch(
        matches,
        'task',
        'command',
        normalizedTask,
        normalizedCommand,
        teamLineageFilter,
      );
      if (selection.status === 'ambiguous') {
        return { status: 'ambiguous' };
      }
      if (selection.status !== 'unique') {
        continue;
      }
      const selectedCommand = selection.match.groups?.command?.trim();
      const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, selectedCommand
        ? {
          ...options,
          prdPath,
          command: selectedCommand,
        }
        : {
          ...options,
          prdPath,
          task: selection.task,
        });
      if (approvedHintOutcome.status !== 'resolved') {
        if (approvedHintOutcome.status === 'ambiguous') {
          return { status: 'ambiguous' };
        }
        continue;
      }
      const approvedHint = approvedHintOutcome.hint;
      if (mode === 'team' && normalizedTask && !normalizedCommand) {
        lineageAnchorHint ??= approvedHint;
      }
      if (isApprovedExecutionFollowupReadyStatus(approvedHint.contextPackStatus)) {
        return { status: 'resolved', hint: approvedHint };
      }
      newestNonReusableHint ??= approvedHint;
    }
    return newestNonReusableHint
      ? { status: 'resolved', hint: newestNonReusableHint }
      : { status: 'absent' };
  }

  const approvedPlan = readApprovedPlanText(cwd, options);
  if (!approvedPlan) return { status: 'absent' };

  if (mode === 'team') {
    const matches = collectLaunchHintMatches(approvedPlan.content, mode);
    const selected = selectLaunchHintMatch(matches, 'task', 'command', normalizedTask, normalizedCommand);
    if (selected.status === 'ambiguous') return { status: 'ambiguous' };
    if (selected.status !== 'unique' || !selected.match.groups) return { status: 'absent' };
    return {
      status: 'resolved',
      hint: {
        mode,
        command: selected.match.groups.command,
        task: selected.task,
        workerCount: Number.parseInt(selected.match.groups.count, 10),
        agentType: selected.match.groups.role || undefined,
        linkedRalph: Boolean(selected.match.groups.ralph?.trim()),
        ...approvedPlan.context,
      },
    };
  }

  const matches = collectLaunchHintMatches(approvedPlan.content, mode);
  const selected = selectLaunchHintMatch(matches, 'task', 'command', normalizedTask, normalizedCommand);
  if (selected.status === 'ambiguous') return { status: 'ambiguous' };
  if (selected.status !== 'unique' || !selected.match.groups) return { status: 'absent' };
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
