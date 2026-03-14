import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

export interface ApprovedExecutionLaunchHint {
  mode: 'team' | 'ralph';
  command: string;
  task: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
  sourcePath: string;
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

function readApprovedPlanText(cwd: string): { path: string; content: string } | null {
  const artifacts = readPlanningArtifacts(cwd);
  if (!isPlanningComplete(artifacts)) return null;

  const latestPrdPath = artifacts.prdPaths.at(-1);
  if (!latestPrdPath || !existsSync(latestPrdPath)) return null;

  try {
    return {
      path: latestPrdPath,
      content: readFileSync(latestPrdPath, 'utf-8'),
    };
  } catch {
    return null;
  }
}

export function readApprovedExecutionLaunchHint(
  cwd: string,
  mode: 'team' | 'ralph',
): ApprovedExecutionLaunchHint | null {
  const planText = readApprovedPlanText(cwd);
  if (!planText) return null;

  if (mode === 'team') {
    const teamPattern = /(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
    const matches = [...planText.content.matchAll(teamPattern)];
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
      sourcePath: planText.path,
    };
  }

  const ralphPattern = /(?<command>(?:omx\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
  const matches = [...planText.content.matchAll(ralphPattern)];
  const last = matches.at(-1);
  if (!last?.groups) return null;
  const task = decodeQuotedValue(last.groups.task);
  if (!task) return null;
  return {
    mode,
    command: last.groups.command,
    task,
    sourcePath: planText.path,
  };
}
