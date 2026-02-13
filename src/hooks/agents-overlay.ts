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
import { join } from 'path';
import { existsSync } from 'fs';
import { omxNotepadPath, omxProjectMemoryPath } from '../utils/paths.js';
import { getBaseStateDir, getStateDir } from '../mcp/state-paths.js';

const START_MARKER = '<!-- OMX:RUNTIME:START -->';
const END_MARKER = '<!-- OMX:RUNTIME:END -->';
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

  // Build sections with priority-ordered truncation
  const sections: string[] = [];

  // Session metadata (max 200 chars)
  const sessionMeta = `**Session:** ${sessionId || 'unknown'} | ${new Date().toISOString()}`;
  sections.push(truncate(sessionMeta, 200));

  // Active modes (max 300 chars)
  if (activeModes) {
    sections.push(`**Active Modes:**\n${truncate(activeModes, 280)}`);
  }

  // Priority notepad (max 300 chars)
  if (notepadPriority) {
    sections.push(`**Priority Notes:**\n${truncate(notepadPriority, 280)}`);
  }

  // Project memory (max 500 chars)
  if (projectMemory) {
    sections.push(`**Project Context:**\n${truncate(projectMemory, 480)}`);
  }

  // Compaction protocol (max 400 chars)
  sections.push(`**Compaction Protocol:**\n${truncate(getCompactionInstructions(), 380)}`);

  // Compose final overlay
  let body = sections.join('\n\n');
  // Ensure total fits within cap (markers + body)
  const markerOverhead = START_MARKER.length + END_MARKER.length + 30; // newlines
  const maxBody = MAX_OVERLAY_SIZE - markerOverhead;
  if (body.length > maxBody) {
    body = body.slice(0, maxBody - 3) + '...';
  }

  return `${START_MARKER}\n<session_context>\n${body}\n</session_context>\n${END_MARKER}`;
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
  const MAX_STRIP_ITERATIONS = 5; // Safety bound

  while (iterations < MAX_STRIP_ITERATIONS) {
    const startIdx = result.indexOf(START_MARKER);
    if (startIdx < 0) break;

    const endIdx = result.indexOf(END_MARKER, startIdx);
    if (endIdx < 0) {
      // Malformed: remove from start marker to end of file
      result = result.slice(0, startIdx).trimEnd() + '\n';
      break;
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
