import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  comparePlanningArtifactPaths,
  parsePlanningArtifactFileName,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
  selectMatchingTestSpecsForPrd,
} from './artifact-names.js';
import {
  resolveContextPackHandoffStatus,
  type ContextPackHandoffStatusSnapshot,
  type ContextPackRef,
  type ContextPackRole,
  type ContextPackStatus,
} from './context-pack-status.js';
import { omxPlansDir } from '../utils/paths.js';

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
  ContextPackOutcomeState,
  ContextPackPackState,
  ContextPackRef,
  ContextPackRole,
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
  allowMissingBaseline = false,
): { content: string; context: ApprovedPlanContext } | null {
  const artifacts = readPlanningArtifacts(cwd);
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
  const approvedPlan = readApprovedPlanText(cwd, options, true);
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
  if (outcome.status !== 'resolved' || outcome.hint.contextPackStatus === 'missing-baseline') {
    return null;
  }
  return outcome.hint;
}
