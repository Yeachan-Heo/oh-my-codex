import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  comparePlanningArtifactPaths,
  parsePlanningArtifactFileName,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
  selectMatchingTestSpecsForPrd,
} from './artifact-names.js';
import {
  isApprovedExecutionFollowupReadyStatus,
  resolveContextPackHandoffStatus,
  type ContextPackHandoffStatusSnapshot,
  type ContextPackRef,
  type ContextPackRole,
  type ContextPackRoleRefs,
  type ContextPackStatus,
} from './context-pack-status.js';
import { collectMarkdownVisibleMatches } from './markdown-structure.js';

const PRD_PATTERN = /^prd-.*\.md$/i;
const TEST_SPEC_PATTERN = /^test-?spec-.*\.md$/i;
const DEEP_INTERVIEW_SPEC_PATTERN = /^deep-interview-.*\.md$/i;
const APPROVED_REPOSITORY_CONTEXT_MAX_CHARS = 4_000;
const APPROVED_REPOSITORY_CONTEXT_MAX_LINES = 80;

export {
  REQUIRED_CONTEXT_PACK_ROLES,
  isApprovedExecutionContextReadyStatus,
  isApprovedExecutionFollowupReadyStatus,
  resolveContextPackHandoffState,
} from './context-pack-status.js';
export type {
  ContextPackHandoffStatusSnapshot,
  ContextPackBaselineState,
  ContextPackBasisState,
  ContextPackDeclarationState,
  ContextPackOutcomeState,
  ContextPackPackState,
  ContextPackRef,
  ContextPackRole,
  ContextPackRoleRefs,
  ContextPackRoleCoverageState,
  ContextPackStatus,
} from './context-pack-status.js';

interface PlanningArtifactSelectionBase {
  prdPath: string | null;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
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
  contextPackRoleRefs: ContextPackRoleRefs | null;
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
  contextPackRoleRefs: ContextPackRoleRefs | null;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
}

interface ApprovedExecutionLaunchHintReadOptions {
  prdPath?: string;
  task?: string;
  command?: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
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
  const plansDir = join(cwd, '.omx', 'plans');
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
  const requestedPrdPath = prdPath == null
    ? null
    : resolveRequestedPrdPath(artifacts, prdPath);
  const selectedPrdPath = prdPath == null
    ? selectLatestPlanningArtifactPath(artifacts.prdPaths)
    : requestedPrdPath;
  const slug = selectedPrdPath
    ? planningArtifactSlug(selectedPrdPath, 'prd')
    : null;

  return {
    prdPath: selectedPrdPath,
    testSpecPaths: selectMatchingTestSpecsForPrd(selectedPrdPath, artifacts.testSpecPaths),
    deepInterviewSpecPaths: selectDeepInterviewSpecPathsForSlug(artifacts.deepInterviewSpecPaths, slug),
  };
}

function resolveRequestedPrdPath(
  artifacts: PlanningArtifacts,
  rawPrdPath: string,
): string | null {
  const requested = rawPrdPath.trim();
  if (!requested) {
    return null;
  }
  if (artifacts.prdPaths.includes(requested)) {
    return requested;
  }

  const repoRoot = dirname(dirname(artifacts.plansDir));
  const canonicalByResolvedPath = new Map(
    artifacts.prdPaths.map((artifactPath) => [resolve(artifactPath), artifactPath]),
  );
  const candidatePaths = isAbsolute(requested)
    ? [resolve(requested)]
    : [
      resolveRelativePathWithinRoot(repoRoot, requested, repoRoot),
      resolveRelativePathWithinRoot(artifacts.plansDir, requested, repoRoot),
    ];

  for (const candidatePath of candidatePaths) {
    if (!candidatePath) {
      continue;
    }
    const canonical = canonicalByResolvedPath.get(candidatePath);
    if (canonical) {
      return canonical;
    }
  }
  return null;
}

function resolveRelativePathWithinRoot(
  baseDir: string,
  rawPath: string,
  rootDir: string,
): string | null {
  const resolvedRootDir = resolve(rootDir);
  let currentDir = resolve(baseDir);

  for (const segment of rawPath.split(/[\\/]+/)) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (currentDir === resolvedRootDir) {
        return null;
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        return null;
      }
      currentDir = parentDir;
      continue;
    }
    currentDir = join(currentDir, segment);
  }

  return resolve(currentDir);
}

function selectPlanningArtifacts(
  artifacts: PlanningArtifacts,
  prdPath?: string,
): LatestPlanningArtifactSelection {
  const selection = selectPlanningArtifactsBase(artifacts, prdPath);
  const handoffStatus = resolveContextPackHandoffStatus(artifacts, selection);
  const contextPackRoleRefs =
    handoffStatus.contextPackStatus === 'ready'
      ? handoffStatus.contextPackRoleRefs
      : null;
  return {
    ...selection,
    contextPack: handoffStatus.contextPack,
    contextPackStatus: handoffStatus.contextPackStatus,
    contextPackRoleRefs,
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
  allowMissingBaseline = false,
  artifacts: PlanningArtifacts = readPlanningArtifacts(cwd),
): { content: string; context: ApprovedPlanContext } | null {
  const selection = selectPlanningArtifacts(artifacts, options.prdPath);
  const latestPrdPath = selection.prdPath;
  if (!latestPrdPath || (!allowMissingBaseline && selection.testSpecPaths.length === 0) || !existsSync(latestPrdPath)) {
    return null;
  }

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
        contextPackRoleRefs: selection.contextPackRoleRefs,
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

type LaunchHintMatchFilter = (match: RegExpMatchArray, task: string) => boolean;

const TEAM_LAUNCH_HINT_PATTERN_SOURCE =
  String.raw`(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))`;
const RALPH_LAUNCH_HINT_PATTERN_SOURCE =
  String.raw`(?<command>(?:omx\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))`;

function launchHintPattern(mode: 'team' | 'ralph'): RegExp {
  return mode === 'team'
    ? new RegExp(TEAM_LAUNCH_HINT_PATTERN_SOURCE, 'gi')
    : new RegExp(RALPH_LAUNCH_HINT_PATTERN_SOURCE, 'gi');
}

function launchHintExactPattern(mode: 'team' | 'ralph'): RegExp {
  return mode === 'team'
    ? new RegExp(`^${TEAM_LAUNCH_HINT_PATTERN_SOURCE}$`, 'i')
    : new RegExp(`^${RALPH_LAUNCH_HINT_PATTERN_SOURCE}$`, 'i');
}

function normalizeLaunchHintCommandFromMatch(
  mode: 'team' | 'ralph',
  match: RegExpMatchArray | null | undefined,
): string | null {
  const groups = match?.groups;
  const rawCommand = groups?.command?.trim();
  const taskToken = groups?.task?.trim();
  if (!groups || !rawCommand || !taskToken) {
    return null;
  }

  if (mode === 'team') {
    const countToken = groups.count?.trim();
    if (!countToken) {
      return null;
    }
    const roleToken = groups.role?.trim();
    const prefix = /^\$team\b/i.test(rawCommand) ? '$team' : 'omx team';
    const countWithRole = roleToken ? `${countToken}:${roleToken}` : countToken;
    const parts = [prefix];
    if (groups.ralph?.trim()) {
      parts.push('ralph');
    }
    parts.push(countWithRole, taskToken);
    return parts.join(' ');
  }

  const prefix = /^\$ralph\b/i.test(rawCommand) ? '$ralph' : 'omx ralph';
  return `${prefix} ${taskToken}`;
}

function normalizeLaunchHintCommand(
  mode: 'team' | 'ralph',
  command: string | undefined,
): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = trimmed.match(launchHintExactPattern(mode));
  return normalizeLaunchHintCommandFromMatch(mode, parsed) ?? trimmed;
}

function collectLaunchHintMatches(
  content: string,
  mode: 'team' | 'ralph',
): RegExpMatchArray[] {
  return collectMarkdownVisibleMatches(content, launchHintPattern(mode));
}

function selectLaunchHintMatch(
  mode: 'team' | 'ralph',
  matches: RegExpMatchArray[],
  normalizedTask?: string,
  normalizedCommand?: string,
  matchFilter?: LaunchHintMatchFilter,
): LaunchHintSelection {
  const exactCommand = normalizeLaunchHintCommand(mode, normalizedCommand);
  if (normalizedCommand) {
    const exactMatches = matches.flatMap((match) => {
      const command = normalizeLaunchHintCommandFromMatch(mode, match);
      if (!command || command !== exactCommand) {
        return [];
      }
      const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
      if (!task) {
        return [];
      }
      return [{ match, task }];
    });
    if (exactMatches.length === 0) return { status: 'no-match' };
    if (exactMatches.length > 1) return { status: 'ambiguous' };
    return { status: 'unique', ...exactMatches[0]! };
  }

  if (!normalizedTask) {
    const decodedMatches = matches.flatMap((match) => {
      const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
      if (!task) {
        return [];
      }
      if (matchFilter && !matchFilter(match, task)) {
        return [];
      }
      return [{ match, task }];
    });
    if (decodedMatches.length === 0) return { status: 'no-match' };
    if (decodedMatches.length > 1) return { status: 'ambiguous' };
    return { status: 'unique', ...decodedMatches[0]! };
  }

  const exactMatches = matches.flatMap((match) => {
    const task = match.groups?.task ? decodeApprovedExecutionQuotedValue(match.groups.task) : null;
    if (!task || task.trim() !== normalizedTask) {
      return [];
    }
    if (matchFilter && !matchFilter(match, task)) {
      return [];
    }
    return [{ match, task }];
  });
  if (exactMatches.length === 0) return { status: 'no-match' };
  if (exactMatches.length > 1) return { status: 'ambiguous' };
  return { status: 'unique', ...exactMatches[0]! };
}

function hasRequestedTeamLaunchSignature(
  options: ApprovedExecutionLaunchHintReadOptions,
): boolean {
  return options.workerCount != null
    || options.agentType != null
    || options.linkedRalph != null;
}

function matchesRequestedTeamLaunchSignature(
  match: RegExpMatchArray,
  options: ApprovedExecutionLaunchHintReadOptions,
): boolean {
  const groups = match.groups;
  if (!groups) {
    return false;
  }

  if (options.workerCount != null) {
    const workerCount = Number.parseInt(groups.count ?? '', 10);
    if (!Number.isFinite(workerCount) || workerCount !== options.workerCount) {
      return false;
    }
  }

  if (options.agentType != null) {
    const requestedAgentType = options.agentType.trim();
    const actualAgentType = groups.role?.trim() || '';
    if (actualAgentType !== requestedAgentType) {
      return false;
    }
  }

  if (options.linkedRalph != null) {
    if (Boolean(groups.ralph?.trim()) !== options.linkedRalph) {
      return false;
    }
  }

  return true;
}

function buildRequestedTeamLaunchSignatureMatchFilter(
  options: ApprovedExecutionLaunchHintReadOptions,
): LaunchHintMatchFilter | undefined {
  if (options.command || !hasRequestedTeamLaunchSignature(options)) {
    return undefined;
  }
  return (match: RegExpMatchArray, _task: string) => matchesRequestedTeamLaunchSignature(match, options);
}

function sameTeamLaunchSignatureMatch(
  anchorHint: ApprovedExecutionLaunchHint,
  match: RegExpMatchArray,
): boolean {
  const groups = match.groups;
  if (!groups) {
    return false;
  }

  const workerCount = Number.parseInt(groups.count ?? '', 10);
  if (!Number.isFinite(workerCount) || workerCount !== anchorHint.workerCount) {
    return false;
  }

  const actualAgentType = groups.role?.trim();
  const expectedAgentType = anchorHint.agentType?.trim();
  if ((actualAgentType || undefined) !== (expectedAgentType || undefined)) {
    return false;
  }

  return Boolean(groups.ralph?.trim()) === Boolean(anchorHint.linkedRalph);
}

function orderedPrdPathsNewestFirst(prdPaths: readonly string[]): string[] {
  return [...prdPaths].sort(comparePlanningArtifactPaths).reverse();
}

function readApprovedExecutionLaunchHintOutcomeForPrdPath(
  cwd: string,
  mode: 'team' | 'ralph',
  prdPath: string,
  options: ApprovedExecutionLaunchHintReadOptions = {},
  matchFilter?: LaunchHintMatchFilter,
  artifacts: PlanningArtifacts = readPlanningArtifacts(cwd),
): ApprovedExecutionLaunchHintOutcome {
  const approvedPlan = readApprovedPlanText(cwd, { ...options, prdPath }, true, artifacts);
  if (!approvedPlan) {
    return { status: 'absent' };
  }
  const selected = selectLaunchHintMatch(
    mode,
    collectLaunchHintMatches(approvedPlan.content, mode),
    options.task?.trim(),
    options.command?.trim(),
    matchFilter,
  );
  if (selected.status === 'ambiguous') {
    return { status: 'ambiguous' };
  }
  if (selected.status !== 'unique' || !selected.match.groups) {
    return { status: 'absent' };
  }

  if (mode === 'team') {
    const workerCount = Number.parseInt(selected.match.groups.count, 10);
    if (!Number.isFinite(workerCount)) {
      return { status: 'absent' };
    }
    return {
      status: 'resolved',
      hint: {
        mode,
        command: normalizeLaunchHintCommandFromMatch(mode, selected.match) ?? selected.match.groups.command,
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
      command: normalizeLaunchHintCommandFromMatch(mode, selected.match) ?? selected.match.groups.command,
      task: selected.task,
      ...approvedPlan.context,
    },
  };
}

type SameLineageFallback =
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'resolved'; hint: ApprovedExecutionLaunchHint };

function resolveOlderReusableSameLineageHint(
  cwd: string,
  mode: 'team' | 'ralph',
  artifacts: PlanningArtifacts,
  latestPrdPath: string,
  anchorHint: ApprovedExecutionLaunchHint,
): SameLineageFallback {
  const orderedPrdPaths = [...artifacts.prdPaths].sort(comparePlanningArtifactPaths);
  const latestIndex = orderedPrdPaths.lastIndexOf(latestPrdPath);
  if (latestIndex <= 0) {
    return { status: 'none' };
  }

  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const prdPath = orderedPrdPaths[index]!;
    const outcome = readApprovedExecutionLaunchHintOutcomeForPrdPath(
      cwd,
      mode,
      prdPath,
      { task: anchorHint.task },
      mode === 'team'
        ? (match: RegExpMatchArray, _task: string) => sameTeamLaunchSignatureMatch(anchorHint, match)
        : undefined,
      artifacts,
    );
    if (outcome.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (outcome.status !== 'resolved') {
      continue;
    }
    if (isApprovedExecutionFollowupReadyStatus(outcome.hint.contextPackStatus)) {
      return { status: 'resolved', hint: outcome.hint };
    }
  }

  return { status: 'none' };
}

export function readApprovedExecutionLaunchHintOutcome(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHintOutcome {
  const artifacts = readPlanningArtifacts(cwd);
  if (options.prdPath) {
    return readApprovedExecutionLaunchHintOutcomeForPrdPath(
      cwd,
      mode,
      options.prdPath,
      options,
      mode === 'team' ? buildRequestedTeamLaunchSignatureMatchFilter(options) : undefined,
      artifacts,
    );
  }

  const normalizedTask = options.task?.trim();
  const normalizedCommand = options.command?.trim();
  if (!normalizedTask && !normalizedCommand) {
    const latestPrdPath = selectLatestPlanningArtifactPath(artifacts.prdPaths);
    if (!latestPrdPath) {
      return { status: 'absent' };
    }

    const latestOutcome = readApprovedExecutionLaunchHintOutcomeForPrdPath(
      cwd,
      mode,
      latestPrdPath,
      options,
      mode === 'team' ? buildRequestedTeamLaunchSignatureMatchFilter(options) : undefined,
      artifacts,
    );
    if (latestOutcome.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (latestOutcome.status !== 'resolved') {
      return { status: 'absent' };
    }
    if (isApprovedExecutionFollowupReadyStatus(latestOutcome.hint.contextPackStatus)) {
      return latestOutcome;
    }

    const fallback = resolveOlderReusableSameLineageHint(
      cwd,
      mode,
      artifacts,
      latestPrdPath,
      latestOutcome.hint,
    );
    if (fallback.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    return fallback.status === 'resolved'
      ? { status: 'resolved', hint: fallback.hint }
      : latestOutcome;
  }

  let newestNonreadyHint: ApprovedExecutionLaunchHint | null = null;
  let teamLineageAnchorHint: ApprovedExecutionLaunchHint | null = null;
  for (const prdPath of orderedPrdPathsNewestFirst(artifacts.prdPaths)) {
    const teamLineageAnchor = teamLineageAnchorHint;
    const requestedTeamMatchFilter = mode === 'team'
      ? buildRequestedTeamLaunchSignatureMatchFilter(options)
      : undefined;
    const teamLineageMatchFilter = requestedTeamMatchFilter ?? (
      mode === 'team'
      && normalizedTask
      && !normalizedCommand
      && teamLineageAnchor
        ? (match: RegExpMatchArray, _task: string) => sameTeamLaunchSignatureMatch(teamLineageAnchor, match)
        : undefined
    );
    const outcome = readApprovedExecutionLaunchHintOutcomeForPrdPath(
      cwd,
      mode,
      prdPath,
      options,
      teamLineageMatchFilter,
      artifacts,
    );
    if (outcome.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (outcome.status !== 'resolved') {
      continue;
    }
    if (mode === 'team' && normalizedTask && !normalizedCommand) {
      teamLineageAnchorHint ??= outcome.hint;
    }
    if (isApprovedExecutionFollowupReadyStatus(outcome.hint.contextPackStatus)) {
      return outcome;
    }
    newestNonreadyHint ??= outcome.hint;
  }

  return newestNonreadyHint
    ? { status: 'resolved', hint: newestNonreadyHint }
    : { status: 'absent' };
}

export function readApprovedExecutionLaunchHint(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHint | null {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, options);
  if (outcome.status !== 'resolved' || outcome.hint.contextPackStatus === 'missing-baseline') {
    return null;
  }
  return outcome.hint;
}
