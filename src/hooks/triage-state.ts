/**
 * Triage State
 *
 * Session-scoped state helper for prompt-routing triage.
 * Independent of workflow mode state (ralph-state.json, skill-active-state.json, etc.).
 *
 * File location:
 *   With session id : .omx/state/sessions/<session_id>/prompt-routing-state.json
 *   Without session id: .omx/state/prompt-routing-state.json
 *
 * Rules:
 *   - Write ONLY for HEAVY/LIGHT decisions (never for PASS).
 *   - Keyword routing must not write triage state (caller's responsibility).
 *   - Missing or malformed file returns null from readTriageState, never throws.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { SESSION_ID_PATTERN, getStateDir } from '../mcp/state-paths.js';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface TriageStateFile {
  version: 1;
  last_triage: {
    lane: "HEAVY" | "LIGHT";
    destination: "autopilot" | "explore" | "executor" | "designer";
    reason: string;
    /** sha256 of the normalized prompt, prefixed with "sha256:" */
    prompt_signature: string;
    /** Best-effort turn marker; ISO timestamp or monotonic counter */
    turn_id: string;
    /** ISO timestamp */
    created_at: string;
  } | null;
  suppress_followup: boolean;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const STATE_FILENAME = 'prompt-routing-state.json';

function resolveStatePath(workingDirectory?: string, sessionId?: string | null): string | null {
  if (typeof sessionId === 'string' && !SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  // getStateDir returns .omx/state/sessions/<sessionId>/ when sessionId is provided,
  // or .omx/state/ as the root fallback — exactly the paths we need.
  const stateDir = getStateDir(workingDirectory ?? undefined, sessionId ?? undefined);
  return join(stateDir, STATE_FILENAME);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ReadTriageStateArgs {
  sessionId?: string | null;
  cwd?: string;
}

export function readTriageState(args: ReadTriageStateArgs): TriageStateFile | null {
  try {
    const filePath = resolveStatePath(args.cwd, args.sessionId);
    if (!filePath) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isTriageStateFile(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface WriteTriageStateArgs extends ReadTriageStateArgs {
  state: TriageStateFile;
}

export function writeTriageState(args: WriteTriageStateArgs): void {
  try {
    const filePath = resolveStatePath(args.cwd, args.sessionId);
    if (!filePath) return;
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    const content = JSON.stringify(args.state, null, 2);

    // Atomic-ish write: write to temp file, then rename.
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch {
    // Swallow filesystem errors — a broken state file must never break the hook.
  }
}

// ---------------------------------------------------------------------------
// Prompt signature
// ---------------------------------------------------------------------------

/**
 * Returns a sha256 hex digest of the normalized prompt, prefixed with "sha256:".
 */
export function promptSignature(normalizedPrompt: string): string {
  return 'sha256:' + createHash('sha256').update(normalizedPrompt, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Suppression logic
// ---------------------------------------------------------------------------

export interface ShouldSuppressArgs {
  previous: TriageStateFile | null;
  /** Normalized prompt: trim + lowercase */
  currentPrompt: string;
  /** Keyword routing always bypasses suppression */
  currentHasKeyword: boolean;
}

/** Clarifying tokens that indicate a short follow-up reply */
const CLARIFYING_STARTERS: readonly string[] = [
  'yes',
  'no',
  'yeah',
  'nope',
  'ok',
  'okay',
  'the ',
  'that',
  'those',
  'it',
];

/**
 * Returns true when the current prompt should suppress triage re-injection
 * because it looks like a short follow-up to a prior HEAVY/LIGHT triage turn.
 *
 * Suppression conditions (all must hold):
 *   1. A prior triage exists (previous?.last_triage != null).
 *   2. previous.suppress_followup === true.
 *   3. currentHasKeyword === false (keywords always bypass triage).
 *   4. The current prompt looks like a clarifying reply and starts with a
 *      known clarifying token. Short length alone is not enough.
 */
export function shouldSuppressFollowup(args: ShouldSuppressArgs): boolean {
  if (args.currentHasKeyword) return false;
  if (!args.previous?.last_triage) return false;
  if (!args.previous.suppress_followup) return false;

  const prompt = args.currentPrompt; // already normalized (trim + lowercase)
  for (const token of CLARIFYING_STARTERS) {
    if (prompt.startsWith(token)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Runtime type guard
// ---------------------------------------------------------------------------

function isTriageStateFile(value: unknown): value is TriageStateFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;

  if (v['version'] !== 1) return false;
  if (typeof v['suppress_followup'] !== 'boolean') return false;

  if (v['last_triage'] === null) return true;

  if (typeof v['last_triage'] !== 'object' || v['last_triage'] === null) return false;
  const lt = v['last_triage'] as Record<string, unknown>;

  return (
    (lt['lane'] === 'HEAVY' || lt['lane'] === 'LIGHT') &&
    (lt['destination'] === 'autopilot' ||
      lt['destination'] === 'explore' ||
      lt['destination'] === 'executor' ||
      lt['destination'] === 'designer') &&
    typeof lt['reason'] === 'string' &&
    typeof lt['prompt_signature'] === 'string' &&
    typeof lt['turn_id'] === 'string' &&
    typeof lt['created_at'] === 'string'
  );
}
