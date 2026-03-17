import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ralphthonDir } from './prd.js';

const PROCESSED_MARKER_LIMIT = 200;
const CAPTURE_TEXT_LIMIT = 24_000;

export const RALPHTHON_RUNTIME_SCHEMA_VERSION = 1;

export const ralphthonRuntimeStateSchema = z.object({
  schemaVersion: z.literal(RALPHTHON_RUNTIME_SCHEMA_VERSION).default(RALPHTHON_RUNTIME_SCHEMA_VERSION),
  leaderTarget: z.string().trim().default(''),
  lastCaptureHash: z.string().trim().min(1).optional(),
  lastCaptureText: z.string().optional(),
  lastOutputChangeAt: z.string().trim().min(1).optional(),
  lastPollAt: z.string().trim().min(1).optional(),
  lastInjectionAt: z.string().trim().min(1).optional(),
  lastInjectedTaskId: z.string().trim().min(1).optional(),
  activeTaskId: z.string().trim().min(1).optional(),
  processedMarkers: z.array(z.string().trim().min(1)).default([]),
  subagentSessionId: z.string().trim().min(1).optional(),
  leaderThreadId: z.string().trim().min(1).optional(),
  subagentThreadIds: z.array(z.string().trim().min(1)).default([]),
  activeSubagentThreadIds: z.array(z.string().trim().min(1)).default([]),
  subagentLastObservedAt: z.string().trim().min(1).optional(),
  subagentWaitReason: z.string().trim().min(1).optional(),
});

export type RalphthonRuntimeState = z.infer<typeof ralphthonRuntimeStateSchema>;

export function canonicalRalphthonRuntimePath(cwd: string): string {
  return join(ralphthonDir(cwd), 'runtime.json');
}

export function createRalphthonRuntimeState(leaderTarget: string): RalphthonRuntimeState {
  return {
    schemaVersion: RALPHTHON_RUNTIME_SCHEMA_VERSION,
    leaderTarget: leaderTarget.trim(),
    processedMarkers: [],
    subagentThreadIds: [],
    activeSubagentThreadIds: [],
  };
}

function trimCaptureText(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(-CAPTURE_TEXT_LIMIT);
}

export function parseRalphthonRuntimeState(input: unknown): RalphthonRuntimeState {
  const parsed = ralphthonRuntimeStateSchema.parse(input);
  return {
    ...parsed,
    lastCaptureText: trimCaptureText(parsed.lastCaptureText),
    processedMarkers: parsed.processedMarkers.slice(-PROCESSED_MARKER_LIMIT),
    subagentThreadIds: parsed.subagentThreadIds.slice(-PROCESSED_MARKER_LIMIT),
    activeSubagentThreadIds: parsed.activeSubagentThreadIds.slice(-PROCESSED_MARKER_LIMIT),
  };
}

export async function readRalphthonRuntimeState(cwd: string): Promise<RalphthonRuntimeState | null> {
  const path = canonicalRalphthonRuntimePath(cwd);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  return parseRalphthonRuntimeState(JSON.parse(raw));
}

export async function writeRalphthonRuntimeState(cwd: string, state: RalphthonRuntimeState): Promise<string> {
  const normalized = parseRalphthonRuntimeState(state);
  const path = canonicalRalphthonRuntimePath(cwd);
  await mkdir(ralphthonDir(cwd), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return path;
}

export function hashPaneCapture(capture: string): string {
  return createHash('sha1').update(capture).digest('hex');
}

export function rememberProcessedMarker(state: RalphthonRuntimeState, marker: string): RalphthonRuntimeState {
  const processedMarkers = [...state.processedMarkers, marker].slice(-PROCESSED_MARKER_LIMIT);
  return {
    ...state,
    processedMarkers,
  };
}

export function diffPaneCapture(previousCapture: string | undefined, currentCapture: string): string {
  const previous = previousCapture || '';
  if (!previous) return currentCapture;
  if (!currentCapture) return '';
  if (previous === currentCapture) return '';
  if (currentCapture.startsWith(previous)) return currentCapture.slice(previous.length);

  const maxOverlap = Math.min(previous.length, currentCapture.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === currentCapture.slice(0, overlap)) {
      return currentCapture.slice(overlap);
    }
  }

  return currentCapture;
}

export function withPersistedCapture(runtime: RalphthonRuntimeState, capture: string): RalphthonRuntimeState {
  return {
    ...runtime,
    lastCaptureHash: hashPaneCapture(capture),
    lastCaptureText: trimCaptureText(capture),
  };
}
