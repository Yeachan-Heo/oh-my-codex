/**
 * AGENTS.md Runtime Overlay for oh-my-codex
 *
 * Dynamically injects session-specific context into AGENTS.md before Codex
 * launches, then strips it after session ends. Uses marker-bounded sections
 * for idempotent apply/strip cycles.
 *
 * Injected context:
 * - Active mode state (ralph iteration, autopilot phase, etc.)
 * - Priority notepad content
 * - Project memory summary (tech stack, conventions, directives)
 * - Compaction survival instructions
 * - Session metadata
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { omxNotepadPath, omxProjectMemoryPath } from '../utils/paths.js';
import { getBaseStateDir, getStateDir } from '../mcp/state-paths.js';

const START_MARKER = '<!-- OMX:RUNTIME:START -->';
const END_MARKER = '<!-- OMX:RUNTIME:END -->';
const WORKER_START_MARKER = '<!-- OMX:TEAM:WORKER:START -->';
const WORKER_END_MARKER = '<!-- OMX:TEAM:WORKER:END -->';
const MAX_OVERLAY_SIZE = 2000;

// ── Lock helpers ─────────────────────────────────────────────────────────────

function lockPath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'agents-md.lock');
}

async function acquireLock(cwd: string, timeoutMs: number = 5000): Promise<void> {
  const lock = lockPath(cwd);
  // Ensure parent directory exists
  const { dirname } = await import('path');
  await mkdir(dirname(lock), { recursive: true });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lock, { recursive: false });
      // Write owner metadata for stale detection
      const ownerFile = join(lock, 'owner.json');
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return; // Lock acquired
    } catch {
      // Lock exists - check if owner is dead
      try {
        const ownerFile = join(lock, 'owner.json');
        const ownerData = JSON.parse(await readFile(ownerFile, 'utf-8'));
        try { process.kill(ownerData.pid, 0); } catch {
          // Owner PID is dead, safe to reap
          await rm(lock, { recursive: true, force: true }).catch(() => {});
          continue; // Retry acquire immediately
        }
      } catch { /* no owner file or parse error, wait */ }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  // Timeout: do NOT silently proceed - throw so caller knows lock failed
  throw new Error('Failed to acquire AGENTS.md lock within timeout');
}

async function releaseLock(cwd: string): Promise<void> {
  try { await rm(lockPath(cwd), { recursive: true, force: true }); } catch { /* ignore */ }
}

async function withAgentsMdLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  await acquireLock(cwd);
  try {
    return await fn();
  } finally {
    await releaseLock(cwd);
  }
}

// ── Truncation helpers ───────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

type OverlaySection = {
  key: string;
  text: string;
  optional: boolean;
};

function joinSections(sections: OverlaySection[]): string {
  return sections.map(s => s.text).join('\n\n');
}

function capBodyToMax(sections: OverlaySection[], maxBody: number): string {
  // Deterministic overflow policy (lowest priority removed first):
  // 1) Drop optional sections from the end until it fits.
  // 2) If still too large, hard-truncate the final section with ellipsis.
  let current = sections.slice();
  let body = joinSections(current);

  while (body.length > maxBody) {
    const lastOptionalIdx = [...current].reverse().findIndex(s => s.optional);
    if (lastOptionalIdx < 0) break;
    const idx = current.length - 1 - lastOptionalIdx;
    current.splice(idx, 1);
    body = joinSections(current);
  }

  if (body.length > maxBody) {
    if (maxBody <= 3) return '.'.repeat(Math.max(0, maxBody));
    body = body.slice(0, maxBody - 3) + '...';
  }

  return body;
}

// ── Overlay generation ───────────────────────────────────────────────────────

interface OverlayData {
  sessionId: string;
  activeModes: string;
  notepadPriority: string;
  projectMemory: string;
}

async function readActiveModes(cwd: string, sessionId?: string): Promise<string> {
  const { readdir } = await import('fs/promises');
  const scopedDirs = [getBaseStateDir(cwd), ...(sessionId ? [getStateDir(cwd, sessionId)] : [])];
  const modes: string[] = [];

  for (const stateDir of scopedDirs) {
    if (!existsSync(stateDir)) continue;
    const files = await readdir(stateDir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith('-state.json') || f === 'session.json') continue;
      try {
        const data = JSON.parse(await readFile(join(stateDir, f), 'utf-8'));
        if (data.active) {
          const mode = f.replace('-state.json', '');
          const details: string[] = [];
          if (data.iteration !== undefined) details.push(`iteration ${data.iteration}/${data.max_iterations || '?'}`);
          if (data.current_phase) details.push(`phase: ${data.current_phase}`);
          modes.push(`- ${mode}: ${details.join(', ') || 'active'}`);
        }
      } catch { /* skip malformed */ }
    }
  }

  return modes.length > 0 ? modes.join('\n') : '';
}

async function readNotepadPriority(cwd: string): Promise<string> {
  const notePath = omxNotepadPath(cwd);
  if (!existsSync(notePath)) return '';

  try {
    const content = await readFile(notePath, 'utf-8');
    const header = '## PRIORITY';
    const idx = content.indexOf(header);
    if (idx < 0) return '';
    const nextHeader = content.indexOf('\n## ', idx + header.length);
    const section = nextHeader < 0
      ? content.slice(idx + header.length).trim()
      : content.slice(idx + header.length, nextHeader).trim();
    return section || '';
  } catch {
    return '';
  }
}

async function readProjectMemorySummary(cwd: string): Promise<string> {
  const memPath = omxProjectMemoryPath(cwd);
  if (!existsSync(memPath)) return '';

  try {
    const data = JSON.parse(await readFile(memPath, 'utf-8'));
    const parts: string[] = [];
    if (data.techStack) parts.push(`- Stack: ${data.techStack}`);
    if (data.conventions) parts.push(`- Conventions: ${data.conventions}`);
    if (data.build) parts.push(`- Build: ${data.build}`);
    if (data.directives && Array.isArray(data.directives)) {
      const highPriority = data.directives.filter((d: { priority?: string }) => d.priority === 'high');
      for (const d of highPriority.slice(0, 3)) {
        parts.push(`- Directive: ${d.directive}`);
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

function getCompactionInstructions(): string {
  return [
    'Before context compaction, preserve critical state:',
    '1. Write progress checkpoint via state_write MCP tool',
    '2. Save key decisions to notepad via notepad_write_working',
    '3. If context is >80% full, proactively checkpoint state',
  ].join('\n');
}

/**
 * Generate the overlay content to inject into AGENTS.md.
 * Total output is capped at MAX_OVERLAY_SIZE chars.
 */
export async function generateOverlay(cwd: string, sessionId?: string): Promise<string> {
  const [activeModes, notepadPriority, projectMemory] = await Promise.all([
    readActiveModes(cwd, sessionId),
    readNotepadPriority(cwd),
    readProjectMemorySummary(cwd),
  ]);

  // Build sections with deterministic overflow behavior.
  const sections: OverlaySection[] = [];

  // Session metadata (max 200 chars) - required
  const sessionMeta = `**Session:** ${sessionId || 'unknown'} | ${new Date().toISOString()}`;
  sections.push({ key: 'session', text: truncate(sessionMeta, 200), optional: false });

  // Active modes (max 300 chars) - optional
  if (activeModes) {
    sections.push({
      key: 'active_modes',
      text: `**Active Modes:**\n${truncate(activeModes, 600)}`,
      optional: true,
    });
  }

  // Priority notepad (max 300 chars) - optional
  if (notepadPriority) {
    sections.push({
      key: 'priority_notes',
      text: `**Priority Notes:**\n${truncate(notepadPriority, 600)}`,
      optional: true,
    });
  }

  // Project memory (max 500 chars) - optional
  if (projectMemory) {
    sections.push({
      key: 'project_context',
      text: `**Project Context:**\n${truncate(projectMemory, 1000)}`,
      optional: true,
    });
  }

  // Compaction protocol (max 400 chars) - required
  sections.push({
    key: 'compaction',
    text: `**Compaction Protocol:**\n${truncate(getCompactionInstructions(), 380)}`,
    optional: false,
  });

  const prefix = `${START_MARKER}\n<session_context>\n`;
  const suffix = `\n</session_context>\n${END_MARKER}`;
  const maxBody = Math.max(0, MAX_OVERLAY_SIZE - prefix.length - suffix.length);
  const body = capBodyToMax(sections, maxBody);

  const overlay = `${prefix}${body}${suffix}`;
  // Belt-and-suspenders: never exceed cap even if assumptions drift.
  if (overlay.length <= MAX_OVERLAY_SIZE) return overlay;

  const safeBody = capBodyToMax(
    [
      { key: 'session', text: truncate(sessionMeta, 200), optional: false },
      { key: 'compaction', text: `**Compaction Protocol:**\n${truncate(getCompactionInstructions(), 380)}`, optional: false },
    ],
    maxBody
  );
  return `${prefix}${safeBody}${suffix}`.slice(0, MAX_OVERLAY_SIZE);
}

/**
 * Apply overlay to AGENTS.md. Strips any existing overlay first (idempotent).
 * Uses file locking to prevent concurrent access corruption.
 */
export async function applyOverlay(agentsMdPath: string, overlay: string, cwd?: string): Promise<void> {
  const dir = cwd || join(agentsMdPath, '..');
  await withAgentsMdLock(dir, async () => {
    let content = '';
    if (existsSync(agentsMdPath)) {
      content = await readFile(agentsMdPath, 'utf-8');
    }

    // Strip existing overlay
    content = stripOverlayContent(content);

    // Append new overlay
    content = content.trimEnd() + '\n\n' + overlay + '\n';

    await writeFile(agentsMdPath, content);
  });
}

/**
 * Strip overlay from AGENTS.md, restoring it to clean state.
 * Uses file locking to prevent concurrent access corruption.
 */
export async function stripOverlay(agentsMdPath: string, cwd?: string): Promise<void> {
  if (!existsSync(agentsMdPath)) return;

  const dir = cwd || join(agentsMdPath, '..');
  await withAgentsMdLock(dir, async () => {
    const content = await readFile(agentsMdPath, 'utf-8');
    const stripped = stripOverlayContent(content);

    if (stripped !== content) {
      await writeFile(agentsMdPath, stripped);
    }
  });
}

/**
 * Remove overlay markers and content from a string (pure function).
 */
function stripOverlayContent(content: string): string {
  // Strip all marker-bounded segments (handles multiple overlays from corruption)
  let result = content;
  let iterations = 0;
  const MAX_STRIP_ITERATIONS = 50; // Safety bound (enough to clean up corrupt duplicates)

  while (iterations < MAX_STRIP_ITERATIONS) {
    const startIdx = result.indexOf(START_MARKER);
    if (startIdx < 0) break;

    const endIdx = result.indexOf(END_MARKER, startIdx);
    if (endIdx < 0) {
      // Malformed runtime marker block. Remove only until the next known marker
      // so unrelated overlays (e.g. worker overlay) are preserved.
      const markerCandidates = [
        result.indexOf(START_MARKER, startIdx + START_MARKER.length),
        result.indexOf(WORKER_START_MARKER, startIdx + START_MARKER.length),
        result.indexOf(WORKER_END_MARKER, startIdx + START_MARKER.length),
      ].filter(i => i >= 0);

      const nextMarkerIdx = markerCandidates.length > 0
        ? Math.min(...markerCandidates)
        : -1;

      if (nextMarkerIdx < 0) {
        result = result.slice(0, startIdx).trimEnd() + '\n';
        break;
      }

      const before = result.slice(0, startIdx).trimEnd();
      const after = result.slice(nextMarkerIdx).trimStart();
      result = after ? before + '\n' + after : before + '\n';
      iterations++;
      continue;
    }

    const before = result.slice(0, startIdx).trimEnd();
    const after = result.slice(endIdx + END_MARKER.length).trimStart();
    result = after ? before + '\n' + after : before + '\n';
    iterations++;
  }

  return result;
}

/**
 * Check if AGENTS.md currently has an overlay applied.
 */
export function hasOverlay(content: string): boolean {
  return content.includes(START_MARKER) && content.includes(END_MARKER);
}

export function sessionModelInstructionsPath(cwd: string, sessionId: string): string {
  return join(getStateDir(cwd, sessionId), 'AGENTS.md');
}

/**
 * Build a session-scoped AGENTS.md that combines project instructions (if any)
 * and the runtime overlay, without mutating <cwd>/AGENTS.md.
 */
export async function writeSessionModelInstructionsFile(
  cwd: string,
  sessionId: string,
  overlay: string,
): Promise<string> {
  const sessionPath = sessionModelInstructionsPath(cwd, sessionId);
  await mkdir(dirname(sessionPath), { recursive: true });

  const projectAgentsPath = join(cwd, 'AGENTS.md');
  let base = '';
  if (existsSync(projectAgentsPath)) {
    base = await readFile(projectAgentsPath, 'utf-8');
    base = stripOverlayContent(base);
  }

  const composed = base.trim().length > 0
    ? `${base.trimEnd()}\n\n${overlay}\n`
    : `${overlay}\n`;

  await writeFile(sessionPath, composed);
  return sessionPath;
}

/**
 * Best-effort cleanup for session-scoped model instructions file.
 */
export async function removeSessionModelInstructionsFile(cwd: string, sessionId: string): Promise<void> {
  const sessionPath = sessionModelInstructionsPath(cwd, sessionId);
  await rm(sessionPath, { force: true });
}
