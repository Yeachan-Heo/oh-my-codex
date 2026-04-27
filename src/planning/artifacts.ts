import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { omxPlansDir } from '../utils/paths.js';

const PRD_PATTERN = /^prd-.*\.md$/i;
const TEST_SPEC_PATTERN = /^test-?spec-.*\.md$/i;
const DEEP_INTERVIEW_SPEC_PATTERN = /^deep-interview-.*\.md$/i;

export interface PlanningArtifacts {
  plansDir: string;
  specsDir: string;
  prdPaths: string[];
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
}

export interface ApprovedPlanContext {
  sourcePath: string;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
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
}

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
      .sort((a, b) => a.localeCompare(b))
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
    deepInterviewSpecPaths: readMatchingPaths(specsDir, DEEP_INTERVIEW_SPEC_PATTERN),
  };
}

export function isPlanningComplete(artifacts: PlanningArtifacts): boolean {
  return artifacts.prdPaths.length > 0 && artifacts.testSpecPaths.length > 0;
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

function artifactSlug(path: string, prefixPattern: RegExp): string | null {
  const file = basename(path);
  const match = file.match(prefixPattern);
  return match?.groups?.slug ?? null;
}

function filterArtifactsForSlug(paths: readonly string[], prefixPattern: RegExp, slug: string | null): string[] {
  if (!slug) return [];
  return paths.filter((path) => artifactSlug(path, prefixPattern) === slug);
}

function readApprovedPlanText(cwd: string): { content: string; context: ApprovedPlanContext } | null {
  const artifacts = readPlanningArtifacts(cwd);
  if (!isPlanningComplete(artifacts)) return null;

  const selection = selectLatestPlanningArtifacts(artifacts);
  const latestPrdPath = selection.prdPath;
  if (!latestPrdPath || selection.testSpecPaths.length === 0 || !existsSync(latestPrdPath)) return null;

  try {
    return {
      content: readFileSync(latestPrdPath, 'utf-8'),
      context: {
        sourcePath: latestPrdPath,
        testSpecPaths: selection.testSpecPaths,
        deepInterviewSpecPaths: selection.deepInterviewSpecPaths,
      },
    };
  } catch {
    return null;
  }
}

export function selectLatestPlanningArtifacts(
  artifacts: PlanningArtifacts,
): LatestPlanningArtifactSelection {
  const latestPrdPath = artifacts.prdPaths.at(-1) ?? null;
  const slug = latestPrdPath
    ? artifactSlug(latestPrdPath, /^prd-(?<slug>.*)\.md$/i)
    : null;

  return {
    prdPath: latestPrdPath,
    testSpecPaths: filterArtifactsForSlug(
      artifacts.testSpecPaths,
      /^test-?spec-(?<slug>.*)\.md$/i,
      slug,
    ),
    deepInterviewSpecPaths: filterArtifactsForSlug(
      artifacts.deepInterviewSpecPaths,
      /^deep-interview-(?<slug>.*)\.md$/i,
      slug,
    ),
  };
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
  if (!isPlanningComplete(artifacts)) {
    return { source: 'none', prdPath: null, planSlug: null, warnings: ['planning_incomplete'] };
  }

  const selection = selectLatestPlanningArtifacts(artifacts);
  const prdPath = selection.prdPath;
  const planSlug = prdPath ? artifactSlug(prdPath, /^prd-(?<slug>.*)\.md$/i) : null;
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

export function readApprovedExecutionLaunchHint(
  cwd: string,
  mode: 'team' | 'ralph',
): ApprovedExecutionLaunchHint | null {
  const approvedPlan = readApprovedPlanText(cwd);
  if (!approvedPlan) return null;

  if (mode === 'team') {
    const teamPattern = /(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
    const matches = [...approvedPlan.content.matchAll(teamPattern)];
    const last = matches.at(-1);
    if (!last?.groups) return null;
    const task = decodeQuotedValue(last.groups.task);
    if (!task) return null;
    return {
      mode,
      command: last.groups.command,
      task,
      workerCount: Number.parseInt(last.groups.count, 10),
      agentType: last.groups.role || undefined,
      linkedRalph: Boolean(last.groups.ralph?.trim()),
      ...approvedPlan.context,
    };
  }

  const ralphPattern = /(?<command>(?:omx\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
  const matches = [...approvedPlan.content.matchAll(ralphPattern)];
  const last = matches.at(-1);
  if (!last?.groups) return null;
  const task = decodeQuotedValue(last.groups.task);
  if (!task) return null;
  return {
    mode,
    command: last.groups.command,
    task,
    ...approvedPlan.context,
  };
}
