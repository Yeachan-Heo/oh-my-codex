import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import type { AutoresearchMissionContract } from './contracts.js';
import { executeExplorePrompt, type ExecuteExplorePromptResult } from '../cli/explore.js';

export interface AutoresearchSparkPrepassSnapshot {
  enabled: boolean;
  status: 'pending' | 'available' | 'fallback';
  note: string;
  updated_at: string;
  packet_characters: number;
  // Sidecar extensions (present when --spark-sidecar is active)
  sidecar_enabled?: boolean;
  last_refresh_iteration?: number;
  refresh_count?: number;
  last_refresh_reason?: string;
}

export const SPARK_SIDECAR_NOOP_TRIGGER = 2;
export const SPARK_SIDECAR_COOLDOWN_ITERATIONS = 3;

export interface ReadAutoresearchSparkPrepassResult {
  snapshot: AutoresearchSparkPrepassSnapshot | null;
  packet: string | null;
}

export interface RunAutoresearchSparkPrepassOptions {
  cwd: string;
  iteration: number;
  lastKeptCommit: string;
  previousIterationOutcome?: string | null;
  recentLedgerSummary?: readonly unknown[];
  env?: NodeJS.ProcessEnv;
  statusFile?: string | null;
  packetFile?: string | null;
}

interface RunAutoresearchSparkPrepassDependencies {
  now?: () => string;
  executeExplore?: typeof executeExplorePrompt;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimPreview(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n...`;
}

export function trimAutoresearchSparkFactPacket(value: string, maxChars = 3200): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n...`;
}

export function buildAutoresearchSparkPrepassPrompt(
  contract: AutoresearchMissionContract,
  context: Pick<
    RunAutoresearchSparkPrepassOptions,
    'iteration' | 'lastKeptCommit' | 'previousIterationOutcome' | 'recentLedgerSummary'
  >,
): string {
  return [
    'You are a bounded OMX autoresearch Spark discovery sidecar.',
    'Goal: produce a compact read-only fact packet for the next main Codex experiment turn.',
    'Stay strictly read-only: no edits, no patches, no commits, no candidate ownership, no supervisor decisions.',
    'Prefer cheap discovery: relevant files, key symbol/path matches, short evidence snippets, and the next files worth opening.',
    'Return markdown with exactly these headings and short bullet lists:',
    '## Likely relevant files',
    '## Key matches',
    '## Evidence snippets',
    '## Next files to inspect',
    'Keep the total response under 12 bullets and under 900 words.',
    '',
    'Current iteration context:',
    '```json',
    JSON.stringify({
      iteration: context.iteration,
      last_kept_commit: context.lastKeptCommit,
      previous_iteration_outcome: context.previousIterationOutcome ?? 'none yet',
      recent_ledger_summary: context.recentLedgerSummary ?? [],
    }, null, 2),
    '```',
    '',
    'Mission excerpt:',
    '```md',
    trimPreview(contract.missionContent, 1000),
    '```',
    '',
    'Sandbox excerpt:',
    '```md',
    trimPreview(contract.sandbox.body || contract.sandboxContent, 1000),
    '```',
  ].join('\n');
}

export async function writeAutoresearchSparkPrepassSnapshot(
  statusFile: string,
  packetFile: string,
  snapshot: AutoresearchSparkPrepassSnapshot,
  packet: string | null,
): Promise<void> {
  await writeFile(statusFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  await writeFile(packetFile, packet ? `${packet.trim()}\n` : '', 'utf-8');
}

export async function readAutoresearchSparkPrepassSnapshot(
  statusFile: string | null | undefined,
  packetFile: string | null | undefined,
): Promise<ReadAutoresearchSparkPrepassResult> {
  if (!statusFile || !packetFile || !existsSync(statusFile)) {
    return { snapshot: null, packet: null };
  }

  const snapshot = JSON.parse(await readFile(statusFile, 'utf-8')) as AutoresearchSparkPrepassSnapshot;
  const packet = existsSync(packetFile)
    ? trimAutoresearchSparkFactPacket(await readFile(packetFile, 'utf-8'))
    : '';
  return {
    snapshot,
    packet: packet || null,
  };
}

export async function initializeAutoresearchSparkPrepassSnapshot(
  enabled: boolean,
  statusFile: string | null | undefined,
  packetFile: string | null | undefined,
  now: () => string = nowIso,
  sidecarEnabled = false,
): Promise<void> {
  if (!enabled || !statusFile || !packetFile) return;
  await writeAutoresearchSparkPrepassSnapshot(
    statusFile,
    packetFile,
    {
      enabled: true,
      status: 'pending',
      note: 'Spark prepass will run before the next experiment turn.',
      updated_at: now(),
      packet_characters: 0,
      ...(sidecarEnabled ? {
        sidecar_enabled: true,
        last_refresh_iteration: 0,
        refresh_count: 0,
        last_refresh_reason: 'initial',
      } : {}),
    },
    null,
  );
}

export function shouldSparkSidecarRefresh(
  snapshot: AutoresearchSparkPrepassSnapshot | null,
  trailingNoops: number,
  currentIteration: number,
): boolean {
  if (!snapshot?.sidecar_enabled) return false;
  if (trailingNoops < SPARK_SIDECAR_NOOP_TRIGGER) return false;
  const lastRefresh = snapshot.last_refresh_iteration ?? 0;
  if (currentIteration - lastRefresh < SPARK_SIDECAR_COOLDOWN_ITERATIONS) return false;
  return true;
}

export function buildSidecarRefreshSnapshot(
  baseSnapshot: AutoresearchSparkPrepassSnapshot,
  iteration: number,
  reason: string,
): Pick<AutoresearchSparkPrepassSnapshot, 'sidecar_enabled' | 'last_refresh_iteration' | 'refresh_count' | 'last_refresh_reason'> {
  return {
    sidecar_enabled: true,
    last_refresh_iteration: iteration,
    refresh_count: (baseSnapshot.refresh_count ?? 0) + 1,
    last_refresh_reason: reason,
  };
}

function mergeSidecarSnapshotMetadata(
  snapshot: AutoresearchSparkPrepassSnapshot,
  previousSnapshot: AutoresearchSparkPrepassSnapshot | null,
): AutoresearchSparkPrepassSnapshot {
  if (!previousSnapshot?.sidecar_enabled) return snapshot;
  return {
    ...snapshot,
    sidecar_enabled: true,
    last_refresh_iteration: previousSnapshot.last_refresh_iteration ?? 0,
    refresh_count: previousSnapshot.refresh_count ?? 0,
    last_refresh_reason: previousSnapshot.last_refresh_reason ?? 'initial',
  };
}

function formatFailureNote(message: string): string {
  return `Spark prepass unavailable; proceeding with the normal Codex experiment turn (${message}).`;
}

function renderExploreFailure(result: ExecuteExplorePromptResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr) return stderr;
  if (stdout) return stdout;
  return `explore backend exited with status ${result.exitCode}`;
}

export async function runAutoresearchSparkPrepass(
  contract: AutoresearchMissionContract,
  options: RunAutoresearchSparkPrepassOptions,
  deps: RunAutoresearchSparkPrepassDependencies = {},
): Promise<ReadAutoresearchSparkPrepassResult> {
  const now = deps.now ?? nowIso;
  const executeExplore = deps.executeExplore ?? executeExplorePrompt;
  const env = options.env ?? process.env;
  const previousSnapshot = options.statusFile && options.packetFile
    ? (await readAutoresearchSparkPrepassSnapshot(options.statusFile, options.packetFile)).snapshot
    : null;

  try {
    const prompt = buildAutoresearchSparkPrepassPrompt(contract, options);
    const result = await executeExplore(prompt, options.cwd, env);
    if (result.exitCode !== 0) {
      throw new Error(renderExploreFailure(result));
    }

    const packet = trimAutoresearchSparkFactPacket(result.stdout || '');
    if (!packet) {
      throw new Error('explore backend returned an empty fact packet');
    }

    const snapshot = mergeSidecarSnapshotMetadata({
      enabled: true,
      status: 'available',
      note: `Spark prepass fact packet captured from the explore ${result.backend} backend.`,
      updated_at: now(),
      packet_characters: packet.length,
    }, previousSnapshot);

    if (options.statusFile && options.packetFile) {
      await writeAutoresearchSparkPrepassSnapshot(options.statusFile, options.packetFile, snapshot, packet);
    }
    return { snapshot, packet };
  } catch (error) {
    const snapshot = mergeSidecarSnapshotMetadata({
      enabled: true,
      status: 'fallback',
      note: formatFailureNote(error instanceof Error ? error.message : String(error)),
      updated_at: now(),
      packet_characters: 0,
    }, previousSnapshot);
    if (options.statusFile && options.packetFile) {
      await writeAutoresearchSparkPrepassSnapshot(options.statusFile, options.packetFile, snapshot, null);
    }
    return { snapshot, packet: null };
  }
}
