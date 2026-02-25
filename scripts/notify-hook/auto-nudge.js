/**
 * Auto-nudge: detect Codex "asking for permission" stall patterns and
 * automatically send a continuation prompt so the agent keeps working.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { asNumber, safeString } from './utils.js';
import { readJsonIfExists, getScopedStateDirsForCurrentSession, readdir } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';

export const SKILL_ACTIVE_STATE_FILE = 'skill-active-state.json';
const SKILL_PHASES = new Set(['planning', 'executing', 'reviewing', 'completing']);

function normalizeSkillPhase(phase) {
  const normalized = safeString(phase).toLowerCase().trim();
  return SKILL_PHASES.has(normalized) ? normalized : 'planning';
}

export function normalizeSkillActiveState(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const skill = safeString(raw.skill);
  if (!skill) return null;
  return {
    version: asNumber(raw.version) ?? 1,
    active: raw.active !== false,
    skill,
    keyword: safeString(raw.keyword),
    phase: normalizeSkillPhase(raw.phase),
    activated_at: safeString(raw.activated_at),
    updated_at: safeString(raw.updated_at),
    source: safeString(raw.source),
  };
}

export function inferSkillPhaseFromText(text, currentPhase = 'planning') {
  const lower = safeString(text).toLowerCase();
  if (!lower) return normalizeSkillPhase(currentPhase);

  const hasAny = (patterns) => patterns.some((p) => lower.includes(p));

  if (hasAny(['all tests pass', 'build succeeded', 'completed', 'complete', 'done', 'final summary', 'summary'])) {
    return 'completing';
  }
  if (hasAny(['verify', 'verified', 'verification', 'review', 'reviewed', 'diagnostic', 'typecheck', 'test'])) {
    return 'reviewing';
  }
  if (hasAny(['implement', 'implemented', 'apply patch', 'change', 'fix', 'update', 'refactor'])) {
    return 'executing';
  }
  if (hasAny(['plan', 'approach', 'steps', 'todo'])) {
    return 'planning';
  }
  return normalizeSkillPhase(currentPhase);
}

async function loadSkillActiveState(stateDir) {
  const raw = await readJsonIfExists(join(stateDir, SKILL_ACTIVE_STATE_FILE), null);
  return normalizeSkillActiveState(raw);
}

async function persistSkillActiveState(stateDir, state) {
  await writeFile(join(stateDir, SKILL_ACTIVE_STATE_FILE), JSON.stringify(state, null, 2)).catch(() => {});
}

export const DEFAULT_STALL_PATTERNS = [
  'if you want',
  'would you like',
  'shall i',
  'next i can',
  'do you want me to',
  'let me know if',
  'do you want',
  'want me to',
  'let me know',
  'just let me know',
  'i can also',
  'i could also',
  'ready to proceed',
  'should i',
  'whenever you',
  'say go',
  'say yes',
  'type continue',
  'and i\'ll continue',
  'and i\'ll proceed',
  'keep driving',
  'keep pushing',
  'move forward',
  'drive forward',
  'proceed from here',
  'i\'ll continue from',
];

export function normalizeAutoNudgeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: true,
      patterns: DEFAULT_STALL_PATTERNS,
      response: 'yes, proceed',
      delaySec: 3,
      maxNudgesPerSession: Infinity,
    };
  }
  return {
    enabled: raw.enabled !== false,
    patterns: Array.isArray(raw.patterns) && raw.patterns.length > 0
      ? raw.patterns.filter(p => typeof p === 'string' && p.trim() !== '')
      : DEFAULT_STALL_PATTERNS,
    response: typeof raw.response === 'string' && raw.response.trim() !== ''
      ? raw.response
      : 'yes, proceed',
    delaySec: typeof raw.delaySec === 'number' && raw.delaySec >= 0 && raw.delaySec <= 60
      ? raw.delaySec
      : 3,
    maxNudgesPerSession: typeof raw.maxNudgesPerSession === 'number' && raw.maxNudgesPerSession > 0
      ? raw.maxNudgesPerSession
      : Infinity,
  };
}

export async function loadAutoNudgeConfig() {
  const codexHomePath = process.env.CODEX_HOME || join(homedir(), '.codex');
  const configPath = join(codexHomePath, '.omx-config.json');
  const raw = await readJsonIfExists(configPath, null);
  if (!raw || typeof raw !== 'object') return normalizeAutoNudgeConfig(null);
  return normalizeAutoNudgeConfig(raw.autoNudge);
}

export function detectStallPattern(text, patterns) {
  if (!text || typeof text !== 'string') return false;
  // Broader tail window (~800 chars / ~15-20 lines) for context
  const tail = text.slice(-800).toLowerCase();
  const lowerPatterns = patterns.map(p => p.toLowerCase());
  // Focus on last few lines where stall prompts typically appear
  const lines = tail.split('\n').filter(l => l.trim());
  const hotZone = lines.slice(-3).join('\n');
  // Primary: check last few lines (highest signal)
  if (lowerPatterns.some(p => hotZone.includes(p))) return true;
  // Secondary: check broader tail window
  return lowerPatterns.some(p => tail.includes(p));
}

export async function capturePane(paneId, lines = 10) {
  try {
    const result = await runProcess('tmux', [
      'capture-pane', '-t', paneId, '-p', '-l', String(lines),
    ], 3000);
    return result.stdout || '';
  } catch {
    return '';
  }
}

export async function resolveNudgePaneTarget(stateDir) {
  // 1. Try TMUX_PANE env var (inherited from the Codex process)
  const envPane = safeString(process.env.TMUX_PANE || '');
  if (envPane) return envPane;

  // 2. Fallback: check active mode states for tmux_pane_id
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    for (const dir of scopedDirs) {
      const files = await readdir(dir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('-state.json')) continue;
        const path = join(dir, f);
        try {
          const state = JSON.parse(await readFile(path, 'utf-8'));
          if (state && state.active && state.tmux_pane_id) {
            return safeString(state.tmux_pane_id);
          }
        } catch {
          // skip malformed state
        }
      }
    }
  } catch {
    // Non-critical
  }

  return '';
}

export async function maybeAutoNudge({ cwd, stateDir, logsDir, payload }) {
  const config = await loadAutoNudgeConfig();
  if (!config.enabled) return;

  const skillState = await loadSkillActiveState(stateDir);
  const lastMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  if (skillState) {
    const inferredPhase = inferSkillPhaseFromText(lastMessage, skillState.phase);
    if (inferredPhase !== skillState.phase || skillState.active !== (inferredPhase !== 'completing')) {
      skillState.phase = inferredPhase;
      skillState.active = inferredPhase !== 'completing';
      skillState.updated_at = new Date().toISOString();
      await persistSkillActiveState(stateDir, skillState);
    }
    if (skillState.phase === 'completing') return;
  }

  // Check nudge count against session limit
  const nudgeStatePath = join(stateDir, 'auto-nudge-state.json');
  let nudgeState = await readJsonIfExists(nudgeStatePath, null);
  if (!nudgeState || typeof nudgeState !== 'object') {
    nudgeState = { nudgeCount: 0, lastNudgeAt: '' };
  }
  const nudgeCount = asNumber(nudgeState.nudgeCount) ?? 0;
  if (Number.isFinite(config.maxNudgesPerSession) && nudgeCount >= config.maxNudgesPerSession) return;

  // Resolve pane target early (needed for both capture-pane check and sending)
  const paneId = await resolveNudgePaneTarget(stateDir);

  // Check last assistant message for stall patterns (fast path)
  let detected = detectStallPattern(lastMessage, config.patterns);
  let source = 'payload';

  // Fallback: capture the last 10 lines of tmux pane output
  if (!detected && paneId) {
    const captured = await capturePane(paneId);
    detected = detectStallPattern(captured, config.patterns);
    source = 'capture-pane';
  }

  if (!detected || !paneId) return;

  // Short delay to let the agent settle before nudging
  if (config.delaySec > 0) {
    await new Promise(r => setTimeout(r, config.delaySec * 1000));
  }

  const nowIso = new Date().toISOString();
  try {
    // Send the response text as literal bytes, then submit with double C-m
    // Codex CLI needs C-m sent twice with a short delay for reliable prompt submission
    const markedResponse = `${config.response} ${DEFAULT_MARKER}`;
    await runProcess('tmux', ['send-keys', '-t', paneId, '-l', markedResponse], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', paneId, 'C-m'], 3000);
    await new Promise(r => setTimeout(r, 100));
    await runProcess('tmux', ['send-keys', '-t', paneId, 'C-m'], 3000);

    nudgeState.nudgeCount = nudgeCount + 1;
    nudgeState.lastNudgeAt = nowIso;
    await writeFile(nudgeStatePath, JSON.stringify(nudgeState, null, 2)).catch(() => {});

    if (skillState && skillState.phase === 'planning') {
      skillState.phase = 'executing';
      skillState.active = true;
      skillState.updated_at = nowIso;
      await persistSkillActiveState(stateDir, skillState);
    }

    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'auto_nudge',
      pane_id: paneId,
      response: config.response,
      source,
      nudge_count: nudgeState.nudgeCount,
    });
  } catch (err) {
    await logTmuxHookEvent(logsDir, {
      timestamp: nowIso,
      type: 'auto_nudge',
      pane_id: paneId,
      error: err instanceof Error ? err.message : safeString(err),
    }).catch(() => {});
  }
}
