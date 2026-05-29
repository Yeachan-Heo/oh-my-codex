import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  appendGoalWorkflowLedger,
  readGoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import type { GoalHarnessWorkerRole } from './policy.js';
import {
  GoalHarnessRuntimeError,
  recordGoalHarnessTrajectory,
  type GoalHarnessTrajectory,
  type GoalHarnessTrajectoryStatus,
  type GoalHarnessRuntimeState,
} from './runtime.js';

const GOAL_HARNESS_WORKFLOW = 'goal-harness';

export type GoalHarnessWorkerResultStatus = 'pass' | 'issues' | 'blocked';

export interface ParsedGoalHarnessWorkerResult {
  resultPath: string;
  slug?: string;
  planId?: string;
  role: GoalHarnessWorkerRole;
  workerStatus: GoalHarnessWorkerResultStatus;
  trajectoryStatus: GoalHarnessTrajectoryStatus;
  summary: string;
  evidence: string[];
  risk?: string;
  score?: number;
  noveltyScore?: number;
  boundaryConfirmed: boolean;
}

export interface ImportGoalHarnessWorkerResultOptions {
  slug: string;
  resultPath: string;
  id?: string;
  status?: GoalHarnessTrajectoryStatus;
  now?: Date;
}

export interface ImportGoalHarnessWorkerResultResult {
  parsed: ParsedGoalHarnessWorkerResult;
  runtime: GoalHarnessRuntimeState;
  trajectory: GoalHarnessTrajectory;
}

function trimValue(value: string | undefined): string {
  return value?.replace(/\r/g, '').trim() ?? '';
}

function stripBullet(value: string): string {
  return value.replace(/^\s*[-*]\s*/, '').trim();
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || /^<[^>]+>$/.test(trimmed) || /\bpass\|issues\|blocked\b/i.test(trimmed) || /\b0-100\b/i.test(trimmed);
}

function compactSection(value: string): string {
  return value
    .split('\n')
    .map((line) => stripBullet(line))
    .filter((line) => !isPlaceholder(line))
    .join('\n')
    .trim();
}

function parseMetadata(raw: string): Record<string, string> {
  const firstHeading = raw.search(/^##\s+/m);
  const head = firstHeading >= 0 ? raw.slice(0, firstHeading) : raw;
  const metadata: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const match = line.match(/^\s*[-*]\s*([a-z_]+):\s*(.+?)\s*$/i);
    if (match) metadata[match[1].toLowerCase()] = match[2].trim();
  }
  return metadata;
}

function parseSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  const heading = /^##\s+(.+?)\s*$/gm;
  const matches = [...raw.matchAll(heading)];
  for (const [index, match] of matches.entries()) {
    const title = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? raw.length;
    sections.set(title, raw.slice(start, end).trim());
  }
  return sections;
}

function parseRole(raw: string): GoalHarnessWorkerRole {
  const value = raw.trim();
  if (
    value === 'researcher'
    || value === 'implementer'
    || value === 'tester'
    || value === 'critic'
    || value === 'architect'
    || value === 'replanner'
  ) return value;
  throw new GoalHarnessRuntimeError('Worker result is missing a valid role.');
}

function parseWorkerStatus(raw: string): GoalHarnessWorkerResultStatus {
  const value = raw.trim().toLowerCase();
  if (value === 'pass' || value === 'issues' || value === 'blocked') return value;
  throw new GoalHarnessRuntimeError('Worker result status must be pass, issues, or blocked.');
}

function parseOptionalScore(raw: string, label: string): number | undefined {
  const value = raw.trim();
  if (!value || isPlaceholder(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new GoalHarnessRuntimeError(`Worker result ${label} must be a finite number between 0 and 100.`);
  }
  return Math.round(parsed * 100) / 100;
}

function boundaryConfirmed(raw: string): boolean {
  return /did not call create_goal/i.test(raw)
    && /did not call update_goal/i.test(raw)
    && /did not mark the whole mission complete/i.test(raw);
}

function evidenceFromSections(sections: Map<string, string>, summary: string): string[] {
  const evidence = compactSection(sections.get('evidence') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const commands = compactSection(sections.get('commands') ?? '');
  if (commands) evidence.push(`Commands:\n${commands}`);
  if (evidence.length === 0 && summary) evidence.push(summary);
  return evidence;
}

export function parseGoalHarnessWorkerResultMarkdown(raw: string, resultPath: string): ParsedGoalHarnessWorkerResult {
  const metadata = parseMetadata(raw);
  const sections = parseSections(raw);
  const role = parseRole(trimValue(metadata.role));
  const workerStatus = parseWorkerStatus(trimValue(metadata.status));
  const summary = compactSection(sections.get('candidate trajectory') ?? '') || compactSection(sections.get('summary') ?? '');
  if (!summary) throw new GoalHarnessRuntimeError('Worker result must include a non-placeholder Summary or Candidate Trajectory.');
  const evidence = evidenceFromSections(sections, summary);
  if (evidence.length === 0) throw new GoalHarnessRuntimeError('Worker result must include concrete evidence.');
  const confirmed = boundaryConfirmed(sections.get('goal boundary confirmation') ?? raw);
  if (!confirmed) {
    throw new GoalHarnessRuntimeError('Worker result must confirm it did not call create_goal, update_goal, or mark the mission complete.');
  }
  const risk = compactSection(sections.get('risks or blockers') ?? '') || undefined;
  return {
    resultPath,
    slug: trimValue(metadata.slug) || undefined,
    planId: trimValue(metadata.plan_id) || undefined,
    role,
    workerStatus,
    trajectoryStatus: workerStatus === 'blocked' ? 'blocked' : 'candidate',
    summary,
    evidence,
    risk,
    score: parseOptionalScore(trimValue(metadata.score), 'score'),
    noveltyScore: parseOptionalScore(trimValue(metadata.novelty_score), 'novelty_score'),
    boundaryConfirmed: confirmed,
  };
}

export async function importGoalHarnessWorkerResult(
  cwd: string,
  options: ImportGoalHarnessWorkerResultOptions,
): Promise<ImportGoalHarnessWorkerResultResult> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const resultPath = resolve(cwd, options.resultPath);
  const raw = await readFile(resultPath, 'utf-8');
  const parsed = parseGoalHarnessWorkerResultMarkdown(raw, options.resultPath);
  if (parsed.slug && parsed.slug !== run.slug) {
    throw new GoalHarnessRuntimeError(`Worker result slug mismatch: expected ${run.slug}, got ${parsed.slug}.`);
  }
  const recorded = await recordGoalHarnessTrajectory(cwd, {
    slug: run.slug,
    id: options.id,
    source: 'worker',
    role: parsed.role,
    summary: parsed.summary,
    evidence: parsed.evidence,
    risk: parsed.risk,
    score: parsed.score,
    noveltyScore: parsed.noveltyScore,
    status: options.status ?? parsed.trajectoryStatus,
    now: options.now,
  });
  await appendGoalWorkflowLedger(cwd, run, {
    ts: options.now?.toISOString() ?? new Date().toISOString(),
    event: 'team_result_imported',
    status: run.status,
    message: `Goal harness worker result imported: ${recorded.trajectory.id}`,
    evidence: parsed.evidence.join('\n'),
    metadata: {
      resultPath: options.resultPath,
      planId: parsed.planId,
      role: parsed.role,
      workerStatus: parsed.workerStatus,
      trajectoryId: recorded.trajectory.id,
    },
  });
  return { parsed, ...recorded };
}
